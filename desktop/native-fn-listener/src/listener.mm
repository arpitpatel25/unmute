// In-process Fn / Caps Lock / Right Option modifier-key listener.
//
// Why this exists: the OSS engine ships a Swift Mach-O binary
// (`globe-listener`) at .app/Contents/Resources/bin/ that Electron's main
// process spawns as a CHILD. macOS TCC keys Accessibility / Input Monitoring
// grants by per-binary code-signature identity. The child binary has its
// own identity, which the user has never seen in System Settings — so even
// when they grant the .app, the child silently fails to receive keyboard
// events. ~50% of OSS users report Fn not working.
//
// This addon loads via require() into Electron's main process — same PID,
// same code-signature identity as the .app bundle. Whatever Input Monitoring
// grant the user gives the .app, this code inherits automatically.
//
// Same trick we used for unmute-native-paste. Proven pattern.
//
// API
//   const fn = require('unmute-native-fn-listener')
//   fn.start((event) => { … })   // event = 'fn-down' | 'fn-up' | 'caps-down'
//                                //        | 'caps-up' | 'right-option-down'
//                                //        | 'right-option-up' | 'command-v'
//   fn.stop()

#import <napi.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>  // AXIsProcessTrustedWithOptions

// Monitor handles + JS callback live for the lifetime of the addon.
// The Electron main process is the Cocoa main thread, and NSEvent
// monitor handlers fire on that same thread — so the JS callback is
// invoked on the same thread that V8 owns. ThreadSafeFunction is still
// used for safety (and to keep the JS callback alive across the event
// loop).

static id g_globalMonitor = nil;
static id g_localMonitor = nil;
static NSEventModifierFlags g_previousFlags = 0;
// Whether the RIGHT Command key specifically is down. NSEventModifierFlagCommand
// cannot distinguish left from right, so the flagsChanged handler tracks it and
// the keyDown handler reads it.
static bool g_rightCommandDown = false;
static Napi::ThreadSafeFunction g_tsfn;
static bool g_started = false;

static void emit_event(const char* name) {
  if (!g_started) return;
  std::string ev(name);
  // BlockingCall queues onto the JS thread. Since handlers already run on
  // the main thread, this becomes effectively synchronous — but the API
  // contract is what we want regardless.
  g_tsfn.BlockingCall([ev](Napi::Env env, Napi::Function jsCallback) {
    jsCallback.Call({ Napi::String::New(env, ev) });
  });
}

static void handle_flags_changed(NSEvent* event) {
  NSEventModifierFlags mods =
    event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;

  // Fn / Globe key — same physical key on Apple Silicon.
  bool hadFn = (g_previousFlags & NSEventModifierFlagFunction) != 0;
  bool hasFn = (mods & NSEventModifierFlagFunction) != 0;
  if (!hadFn && hasFn) emit_event("fn-down");
  if (hadFn && !hasFn) emit_event("fn-up");

  // Caps Lock — used for instruction mode.
  bool hadCaps = (g_previousFlags & NSEventModifierFlagCapsLock) != 0;
  bool hasCaps = (mods & NSEventModifierFlagCapsLock) != 0;
  if (!hadCaps && hasCaps) emit_event("caps-down");
  if (hadCaps && !hasCaps) emit_event("caps-up");

  // Right Option specifically (keyCode 61). Left Option (58) is ignored
  // so we don't trample on system-level shortcuts. This matches the OSS
  // globe-listener behavior.
  if (event.keyCode == 61) {
    bool hadOpt = (g_previousFlags & NSEventModifierFlagOption) != 0;
    bool hasOpt = (mods & NSEventModifierFlagOption) != 0;
    if (!hadOpt && hasOpt) emit_event("right-option-down");
    if (hadOpt && !hasOpt) emit_event("right-option-up");
  }

  // Right Command specifically (keyCode 54) — the Unmute Agent key. Left
  // Command (55) is ignored for the same reason left Option is: it is where
  // every system shortcut lives, and claiming it would trample all of them.
  //
  // Command was chosen over the remaining modifiers because it composes NO
  // character. Holding Option produces dead keys and accents; holding Shift
  // or Control is load-bearing in editors and terminals. Held alone, Command
  // does nothing on macOS — which is exactly what a push-to-talk key needs.
  if (event.keyCode == 54) {
    bool hadCmd = (g_previousFlags & NSEventModifierFlagCommand) != 0;
    bool hasCmd = (mods & NSEventModifierFlagCommand) != 0;
    if (!hadCmd && hasCmd) { g_rightCommandDown = true;  emit_event("right-command-down"); }
    if (hadCmd && !hasCmd) { g_rightCommandDown = false; emit_event("right-command-up"); }
  }

  g_previousFlags = mods;
}

static void handle_key_down(NSEvent* event) {
  NSEventModifierFlags mods =
    event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
  // V is keyCode 9 on the macOS hardware-independent key map. Observe only;
  // returning the event from the local monitor (and global monitors being
  // observation-only by definition) lets the destination paste text normally.
  NSEventModifierFlags otherChordModifiers =
    NSEventModifierFlagShift | NSEventModifierFlagControl | NSEventModifierFlagOption;
  if (event.keyCode == 9 &&
      (mods & NSEventModifierFlagCommand) != 0 &&
      (mods & otherChordModifiers) == 0) {
    emit_event("command-v");
  }

  // Any key pressed while right Command is held makes this a SHORTCUT, not a
  // tap. The Agent gesture is a double-tap of right Command alone; without this
  // signal there would be no way to tell ⌘C from someone invoking the Agent,
  // and the only alternative is starting a capture speculatively on every ⌘
  // press and cancelling it a moment later. Observation only — the event is
  // still delivered, so the shortcut works exactly as before.
  if (g_rightCommandDown) {
    emit_event("right-command-chord");
  }
}

// ─── start(callback) — install global + local NSEvent monitors ─────

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_started) {
    // Idempotent — second start is a no-op rather than a crash.
    return Napi::Boolean::New(env, true);
  }
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "start(callback) — callback must be a function")
      .ThrowAsJavaScriptException();
    return env.Null();
  }

  Napi::Function callback = info[0].As<Napi::Function>();
  g_tsfn = Napi::ThreadSafeFunction::New(
    env, callback,
    "unmute-fn-listener", // resource name
    0,                    // unlimited queue
    1                     // single thread (us)
  );

  g_previousFlags = 0;

  // Global monitor — fires for events from OTHER apps (when our app
  // isn't focused). Standard Cocoa pattern.
  NSEventMask mask = NSEventMaskFlagsChanged | NSEventMaskKeyDown;
  g_globalMonitor = [NSEvent
    addGlobalMonitorForEventsMatchingMask:mask
    handler:^(NSEvent* event) {
      if (event.type == NSEventTypeFlagsChanged) handle_flags_changed(event);
      else if (event.type == NSEventTypeKeyDown) handle_key_down(event);
    }];

  // Local monitor — fires when OUR app is focused. Different code path
  // in AppKit; we need both to cover all cases.
  g_localMonitor = [NSEvent
    addLocalMonitorForEventsMatchingMask:mask
    handler:^NSEvent*(NSEvent* event) {
      if (event.type == NSEventTypeFlagsChanged) handle_flags_changed(event);
      else if (event.type == NSEventTypeKeyDown) handle_key_down(event);
      return event;
    }];

  g_started = true;
  return Napi::Boolean::New(env, true);
}

// ─── stop() — remove monitors, release TSFN ────────────────────────

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g_started) return Napi::Boolean::New(env, true);

  if (g_globalMonitor) {
    [NSEvent removeMonitor:g_globalMonitor];
    g_globalMonitor = nil;
  }
  if (g_localMonitor) {
    [NSEvent removeMonitor:g_localMonitor];
    g_localMonitor = nil;
  }
  g_tsfn.Release();
  g_started = false;
  return Napi::Boolean::New(env, true);
}

// ─── isAccessibilityTrusted() — diagnostic, same as native-paste ───
// Note: NSEvent global monitors actually need Input Monitoring (not
// Accessibility) on macOS 10.15+. We expose this only as a quick
// readiness probe; the onboarding flow should request Input Monitoring
// via TCC's standard prompt.

Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSDictionary* options = @{ (__bridge id)kAXTrustedCheckOptionPrompt: @NO };
  bool trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
  return Napi::Boolean::New(env, trusted);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isAccessibilityTrusted",
              Napi::Function::New(env, IsAccessibilityTrusted));
  return exports;
}

NODE_API_MODULE(native_fn_listener, Init)
