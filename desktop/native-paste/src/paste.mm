// unmute-native-paste — macOS CGEvent paste from inside the main Electron
// process so it inherits the signed .app bundle's TCC Accessibility grant.
//
// Why this exists:
//   key-poster / globe-listener are *child* binaries inside Contents/Resources.
//   When they call CGEventPost, macOS TCC checks the CHILD binary's code
//   identity for Accessibility, not the parent .app's. The child has its own
//   identity hash and is NOT in the user's Accessibility list — so CGEventPost
//   silently drops the event (returns void, no error). Text never pastes.
//
//   A Node native addon loaded via require() from the main process runs
//   IN-PROCESS — same PID, same memory, same code-signature identity. TCC
//   checks the .app bundle's identity, which IS in the Accessibility list,
//   and CGEventPost actually delivers the keystroke.
//
// Every step returns a labeled boolean in the result object so JS can log
// exactly which step failed and why. No silent failure modes.

#include <napi.h>
#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>
#include <Foundation/Foundation.h>

// ────────────────────────────────────────────────────────────────────
// isAccessibilityTrusted() — diagnostic
//
// Returns whether THIS process is trusted to post events. If false, the
// CGEvent post will silently drop. JS can log this proactively so the user
// knows why paste didn't land.
// ────────────────────────────────────────────────────────────────────
Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Boolean trusted = AXIsProcessTrusted();
  return Napi::Boolean::New(env, trusted == true);
}

// ────────────────────────────────────────────────────────────────────
// processInfo() — diagnostic dump for the failure-case log
//
// Returns the executable path, bundle identifier, and PID. Lets us confirm
// the addon is running in the expected process (the signed unmute.app's
// main process) rather than something unexpected (a helper, a subprocess,
// dev-mode bare Electron).
// ────────────────────────────────────────────────────────────────────
Napi::Value ProcessInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);

  // PID
  out.Set("pid", Napi::Number::New(env, (double)getpid()));

  // Executable path
  @autoreleasepool {
    NSString *exePath = [[NSBundle mainBundle] executablePath];
    if (exePath != nil) {
      out.Set("executablePath", Napi::String::New(env, [exePath UTF8String]));
    }
    NSString *bundleId = [[NSBundle mainBundle] bundleIdentifier];
    if (bundleId != nil) {
      out.Set("bundleIdentifier", Napi::String::New(env, [bundleId UTF8String]));
    }
    NSString *bundlePath = [[NSBundle mainBundle] bundlePath];
    if (bundlePath != nil) {
      out.Set("bundlePath", Napi::String::New(env, [bundlePath UTF8String]));
    }
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────
// postCmdV() — the actual paste
//
// Returns an object with one boolean per step taken, plus `ok` overall.
// On any failure, `error` is set to a human-readable description of the
// step that failed. Order of fields mirrors execution order for log
// readability.
//
// Result schema:
//   {
//     ax_trusted:      bool,    // AXIsProcessTrusted() check
//     source_created:  bool,    // CGEventSourceCreate succeeded
//     events_created:  bool,    // both keyDown and keyUp CGEvents created
//     posted:          bool,    // CGEventPost ran without crashing
//     ok:              bool,    // overall success
//     error?:          string,  // present only when ok=false
//     stepFailed?:     string,  // present only when ok=false
//   }
// ────────────────────────────────────────────────────────────────────
Napi::Value PostCmdV(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  result.Set("ax_trusted", Napi::Boolean::New(env, false));
  result.Set("source_created", Napi::Boolean::New(env, false));
  result.Set("events_created", Napi::Boolean::New(env, false));
  result.Set("posted", Napi::Boolean::New(env, false));
  result.Set("ok", Napi::Boolean::New(env, false));

  // ─── Step 1: AXIsProcessTrusted ────────────────────────────────
  bool trusted = AXIsProcessTrusted();
  result.Set("ax_trusted", Napi::Boolean::New(env, trusted));
  if (!trusted) {
    result.Set("stepFailed", Napi::String::New(env, "ax_trusted"));
    result.Set("error", Napi::String::New(env,
      "AXIsProcessTrusted() returned false — Accessibility permission is not "
      "granted to this process bundle. Add the .app to System Settings → "
      "Privacy & Security → Accessibility."));
    return result;
  }

  // ─── Step 2: CGEventSourceCreate ──────────────────────────────
  // combinedSessionState targets the user's current login session — the same
  // session the focused app is running in. Other states (hidSystemState,
  // privateState) won't deliver to GUI apps reliably.
  CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
  if (src == NULL) {
    result.Set("stepFailed", Napi::String::New(env, "source_created"));
    result.Set("error", Napi::String::New(env,
      "CGEventSourceCreate returned NULL — usually means TCC denied "
      "the source-create call. Check Console.app for TCC denials."));
    return result;
  }
  result.Set("source_created", Napi::Boolean::New(env, true));

  // ─── Step 3: Build keyDown + keyUp events ──────────────────────
  // kVK_ANSI_V = 9 from Carbon's Events.h
  CGEventRef keyDown = CGEventCreateKeyboardEvent(src, (CGKeyCode)kVK_ANSI_V, true);
  CGEventRef keyUp = CGEventCreateKeyboardEvent(src, (CGKeyCode)kVK_ANSI_V, false);
  if (keyDown == NULL || keyUp == NULL) {
    if (keyDown) CFRelease(keyDown);
    if (keyUp) CFRelease(keyUp);
    CFRelease(src);
    result.Set("stepFailed", Napi::String::New(env, "events_created"));
    result.Set("error", Napi::String::New(env,
      "CGEventCreateKeyboardEvent returned NULL for V keyDown or keyUp"));
    return result;
  }
  result.Set("events_created", Napi::Boolean::New(env, true));

  // ─── Step 4: Set Cmd flag and post ─────────────────────────────
  CGEventSetFlags(keyDown, kCGEventFlagMaskCommand);
  CGEventSetFlags(keyUp, kCGEventFlagMaskCommand);

  // CGEventPost returns void — there is no in-band way to know if delivery
  // succeeded. The JS side verifies by checking if the focused app received
  // the keystroke (a clipboard-readback check is unreliable since paste
  // doesn't change the clipboard).
  CGEventPost(kCGSessionEventTap, keyDown);
  CGEventPost(kCGSessionEventTap, keyUp);
  result.Set("posted", Napi::Boolean::New(env, true));

  CFRelease(keyDown);
  CFRelease(keyUp);
  CFRelease(src);

  result.Set("ok", Napi::Boolean::New(env, true));
  return result;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isAccessibilityTrusted",
              Napi::Function::New(env, IsAccessibilityTrusted));
  exports.Set("postCmdV", Napi::Function::New(env, PostCmdV));
  exports.Set("processInfo", Napi::Function::New(env, ProcessInfo));
  return exports;
}

NODE_API_MODULE(native_paste, Init)
