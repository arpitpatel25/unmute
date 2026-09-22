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
//                                //        | 'right-command-down' | 'right-command-up'
//                                //        | 'right-command-chord'
//                                //        | 'left-control-down' | 'left-control-up'
//                                //        | 'left-command-down' | 'left-command-up'
//                                //        | 'left-command-chord-spoil'
//                                //        | 'notes-chord-spoil'
//   fn.stop()
//   fn.isInputMonitoringTrusted() // true when global modifier events are allowed
//   fn.requestInputMonitoring()   // asks macOS for that grant

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
/** RAW flags, device bits intact. `g_previousFlags` is masked with
 *  DeviceIndependentFlagsMask, which strips exactly the left/right bits we need
 *  to tell one Command key from the other. */
static NSEventModifierFlags g_previousRawFlags = 0;
// Whether the RIGHT Command key specifically is down. NSEventModifierFlagCommand
// cannot distinguish left from right, so the flagsChanged handler tracks it and
// the keyDown handler reads it.
static bool g_rightCommandDown = false;
/** THE POCKET CHORD — right Command held, right Option tapped.
 *
 *  ORDER IS THE WHOLE DESIGN. Right Option starts a Remote capture on its own
 *  key-DOWN, with no deferral, because push-to-talk that hesitates clips the
 *  first syllable. So a chord that had to WAIT to see whether Command was
 *  coming would put that hesitation on the busiest key in the product.
 *
 *  Requiring Command FIRST costs nothing: by the time Option lands we already
 *  know Command is held, so the decision is a lookup, not a timer. Option
 *  pressed alone is still a plain Remote capture, byte for byte as before.
 *
 *  Latched so the RELEASE is swallowed too. Emitting the down as a chord and
 *  the up as a Remote key would hand the Remote lane an unmatched `up` — a
 *  capture stopping that never started. */
static bool g_optionChorded = false;
/** Whether left-Control is down right now — the meeting notetaker's trigger
 *  key. Read by the keyDown handler so any other key (or modifier) pressed
 *  while it is held can spoil the gesture, exactly as g_rightCommandDown does
 *  for the Agent's right-Command gesture. Left-Control alone is a common base
 *  for real Ctrl+key bindings in terminals/editors and for the OS's own
 *  Ctrl+Click (secondary click) and Ctrl+scroll (zoom) gestures, so "the user
 *  is holding this key" is a weak signal on its own; "holding it and pressing
 *  nothing else" is the signal the trigger actually needs. */
static bool g_leftControlDown = false;
// Left Command is reserved for the screenshot gesture only when pressed by
// itself. Any key/modifier joining it spoils the gesture, preserving every
// normal macOS Command shortcut.
static bool g_leftCommandDown = false;
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

  // ─── Side-specific Option / Control ───────────────────────────────
  //
  // DEVICE-DEPENDENT BITS, NOT THE COALESCED FLAG. NSEventModifierFlagOption
  // and NSEventModifierFlagControl mean "SOME device with this role is down"
  // — they cannot tell left from right, and the masked `mods` above has the
  // side bits stripped entirely. Testing the coalesced flag left a real hole:
  // right-Option already held, then left-Option released elsewhere, or vice
  // versa — the shared bit stays set from the OTHER side, so the side-specific
  // down/up pair goes out of sync with reality and can stick "held" FOREVER.
  // A permanently-stuck held-key state means a later bare tap of that key
  // reads as still-chorded and can start a system-audio recording (and its
  // TCC prompt) the user never asked for — a privacy bug, not a papercut.
  // (Same recipe already proven for right Command below.)
  //
  // Read from event.modifierFlags — the RAW flags — because these low-level
  // NX_DEVICE* bits live outside NSEventModifierFlagDeviceIndependentFlagsMask.
  const NSEventModifierFlags kRightOption  = 0x00000040;  // NX_DEVICERALTKEYMASK
  const NSEventModifierFlags kLeftControl  = 0x00000001;  // NX_DEVICELCTLKEYMASK
  const NSEventModifierFlags kRightControl = 0x00002000;  // NX_DEVICERCTLKEYMASK
  const NSEventModifierFlags kLeftCommand = 0x00000008;   // NX_DEVICELCMDKEYMASK

  // Right Option specifically (keyCode 61). This matches the OSS
  // globe-listener behavior.
  if (event.keyCode == 61) {
    bool hadOpt = (g_previousRawFlags & kRightOption) != 0;
    bool hasOpt = (event.modifierFlags & kRightOption) != 0;
    if (!hadOpt && hasOpt) {
      if (g_rightCommandDown) { g_optionChorded = true; emit_event("pocket-chord"); }
      else emit_event("right-option-down");
    }
    if (hadOpt && !hasOpt) {
      // A chord that began under Command stays a chord for its whole life, even
      // if Command is let go first.
      if (g_optionChorded) g_optionChorded = false;
      else emit_event("right-option-up");
    }
  }

  // Left Control specifically (keyCode 59) — the meeting notetaker's trigger
  // key: double-tap to start, single tap to stop (see keyboard.ts).
  if (event.keyCode == 59) {
    bool hadCtrl = (g_previousRawFlags & kLeftControl) != 0;
    bool hasCtrl = (event.modifierFlags & kLeftControl) != 0;
    if (!hadCtrl && hasCtrl) emit_event("left-control-down");
    if (hadCtrl && !hasCtrl) emit_event("left-control-up");
  }

  // ─── The notetaker trigger's spoil signal ───────────────────────────
  //
  // Left-Control alone is a common base for real Ctrl+key bindings
  // (terminals, editors) and for the OS's own Ctrl+Click (secondary click)
  // and Ctrl+scroll (zoom) gestures. The double-tap recogniser cannot tell
  // "pressed Control twice to start a meeting note" from "pressed Control
  // to Ctrl+Click something, twice" on timing alone — which would start a
  // system-audio capture (and its TCC prompt) nobody asked for.
  //
  // Same answer the Agent's right-Command gesture already uses: a hold with
  // ANY other key or modifier in it is a shortcut, never a tap. This is the
  // flags-changed half (another MODIFIER joins — ⌃⇧, ⌃⌥, ⌃⌘); handle_key_down
  // below covers ordinary keys (Ctrl+C, Ctrl+A, …).
  const bool leftControlDown = (event.modifierFlags & kLeftControl) != 0;
  if (leftControlDown) {
    const NSEventModifierFlags kSpoilers =
      NSEventModifierFlagShift | NSEventModifierFlagCommand | NSEventModifierFlagOption |
      NSEventModifierFlagFunction | kRightControl;
    bool hadSpoiler = (g_previousRawFlags & kSpoilers) != 0;
    bool hasSpoiler = (event.modifierFlags & kSpoilers) != 0;
    if (!hadSpoiler && hasSpoiler) emit_event("notes-chord-spoil");
  }
  g_leftControlDown = leftControlDown;

  // Left Command is intentionally separate from the Agent's right Command.
  // It is a gesture key only while held alone; keyboard shortcuts always win.
  {
    bool hadLeft = (g_previousRawFlags & kLeftCommand) != 0;
    bool hasLeft = (event.modifierFlags & kLeftCommand) != 0;
    if (!hadLeft && hasLeft) emit_event("left-command-down");
    if (hadLeft && !hasLeft) emit_event("left-command-up");
    const NSEventModifierFlags kOther = NSEventModifierFlagShift | NSEventModifierFlagControl |
      NSEventModifierFlagOption | NSEventModifierFlagFunction | kRightControl | 0x10;
    if (hasLeft && (event.modifierFlags & kOther) != 0) emit_event("left-command-chord-spoil");
    g_leftCommandDown = hasLeft;
  }

  // Right Command specifically (keyCode 54) — the Unmute Agent key. Left
  // Command (55) is ignored because it is where every system shortcut
  // lives, and claiming it would trample all of them.
  //
  // Command was chosen over the remaining modifiers because it composes NO
  // character. Holding Option produces dead keys and accents; holding Shift
  // or Control is load-bearing in editors and terminals. Held alone, Command
  // does nothing on macOS — which is exactly what a push-to-talk key needs.
  // RIGHT Command specifically, tested against the DEVICE-DEPENDENT bit rather
  // than NSEventModifierFlagCommand.
  //
  // The shared flag cannot tell left from right, and that left a hole: press
  // right Command, then left Command, then release RIGHT — the shared flag is
  // still set because left is held, so the up branch never ran and
  // g_rightCommandDown stayed true permanently. Every keystroke thereafter
  // emitted right-command-chord, each one a BlockingCall onto the main thread.
  // NX_DEVICERCMDKEYMASK (0x10) is set only while the right key itself is down,
  // so the state cannot survive its own release.
  const NSEventModifierFlags kRightCommand = 0x10;  // NX_DEVICERCMDKEYMASK
  {
    // RAW flags on both sides — the masked ones have this bit removed.
    bool hadRight = (g_previousRawFlags & kRightCommand) != 0;
    bool hasRight = (event.modifierFlags & kRightCommand) != 0;
    if (!hadRight && hasRight) { g_rightCommandDown = true;  emit_event("right-command-down"); }
    if (hadRight && !hasRight) { g_rightCommandDown = false; emit_event("right-command-up"); }

    // A MODIFIER JOINING IS A CHORD TOO.
    //
    // handle_key_down below spoils the gesture when a KEY is pressed while
    // right Command is held, which covers ⌘C. It cannot cover ⌘⇧4 or ⌘⌃⇧4:
    // Shift, Control and Option arrive here through flagsChanged and never
    // reach keyDown, so holding right Command and adding ⇧ produced no spoil
    // signal at all — and the release then read as a clean single tap, which
    // SUBMITTED the Agent capture the user was still speaking into. Taking a
    // screenshot mid-utterance sent it.
    //
    // Emitting on every qualifying flags change is fine: the receiver treats
    // the signal as a latch, so repeats are idempotent.
    //
    // OVERLAP, NOT ARRIVAL ORDER. This asked `!hadOther && hasOther` — "did the
    // other modifier JUST arrive, while right Command was already held". That is
    // an edge, and it can only ever see one of the two orders. Press Control
    // FIRST and right Command second and neither branch fires: on Control's own
    // flagsChanged `hasRight` is false so the block is skipped, and on Command's
    // `hadOther` is already true so `!hadOther` is false. The chord was real and
    // completely invisible, so the release read as a clean single tap.
    //
    // Field incident 2026-08-26 07:31:10Z: left Control down, right Command down
    // 89ms later, released 3.2s after that — and the Agent capture the user was
    // still speaking into was SUBMITTED by a Ctrl+Cmd shortcut. The same two keys
    // in the opposite order, 24s later in the same log, spoiled correctly. That
    // asymmetry is this expression.
    //
    // The question is not which key arrived second. It is whether both are held
    // at once, which is a STATE and has no order to get wrong. Note the emit
    // order this relies on: right-command-down is emitted ABOVE, so the receiver
    // sees 'down' then 'other' and latches spoiled — 'down' RESETS spoiled, so a
    // chord emitted before it would be wiped.
    if (hasRight) {
      const NSEventModifierFlags kOtherChord =
        NSEventModifierFlagShift | NSEventModifierFlagControl | NSEventModifierFlagOption;
      if ((event.modifierFlags & kOtherChord) != 0) emit_event("right-command-chord");
    }
  }

  g_previousFlags = mods;
  g_previousRawFlags = event.modifierFlags;
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

  // Same rule for the notetaker trigger: a key pressed while left-Control is
  // held makes this Ctrl+C, Ctrl+A, or some other real Control shortcut — not
  // a request to start recording a meeting. Observation only; the event is
  // still delivered.
  if (g_leftControlDown) {
    emit_event("notes-chord-spoil");
  }
  if (g_leftCommandDown) {
    emit_event("left-command-chord-spoil");
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
  // The side-specific handlers above compare against the RAW flags, so this
  // must be cleared alongside g_previousFlags — otherwise a stop()/start()
  // cycle would leave stale device bits and swallow the first transition.
  g_previousRawFlags = 0;
  g_rightCommandDown = false;
  g_leftControlDown = false;
  g_leftCommandDown = false;

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

Napi::Value IsInputMonitoringTrusted(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), CGPreflightListenEventAccess());
}

Napi::Value RequestInputMonitoring(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), CGRequestListenEventAccess());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isAccessibilityTrusted",
              Napi::Function::New(env, IsAccessibilityTrusted));
  exports.Set("isInputMonitoringTrusted",
              Napi::Function::New(env, IsInputMonitoringTrusted));
  exports.Set("requestInputMonitoring",
              Napi::Function::New(env, RequestInputMonitoring));
  return exports;
}

NODE_API_MODULE(native_fn_listener, Init)
