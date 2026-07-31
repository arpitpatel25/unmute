// unmute-native-ax — background macOS app control via AXUIElement, in-process.
//
// Design rules (from docs/ax-mcp-brief.md — read it before touching this):
//   1. NEVER raise, activate, or focus an app. Background is the whole point.
//   2. Direct AXUIElement. No System Events, no AppleScript, no coordinates.
//   3. AXManualAccessibility must be set or Electron apps expose nothing.
//   4. Loaded in-process (native-paste lesson): child binaries get their own
//      TCC identity and AX calls silently fail. Same PID as the .app = the
//      user's one Accessibility grant covers everything.
//   5. Zero third-party dependencies. Zero network calls.
//
// Threading: every exported function is synchronous and self-contained (no
// shared mutable state). The JS side calls them from a worker thread so big
// tree walks never block the Electron main thread (dictation latency is
// sacred). AX messaging is plain mach IPC and is safe off the main thread.

#include <napi.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#import <Cocoa/Cocoa.h>
#import <Foundation/Foundation.h>
// ScreenCaptureKit (macOS 12.3+; SCScreenshotManager 14+) is WEAK-linked (see
// binding.gyp) and every use is @available-guarded, so the addon still loads and
// AX control still works on macOS < 14 — only window capture needs 14+. This
// replaces CGWindowListCreateImage, which Apple obsoleted (unavailable macOS 15+).
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <CoreImage/CoreImage.h>

#include <string>
#include <vector>
#include <functional>
#include <map>
#include <mutex>
#include <atomic>

// ───────────────────────── small helpers ─────────────────────────

static std::string toStd(NSString *s) { return s ? std::string([s UTF8String]) : std::string(); }

static NSString *toNS(const std::string &s) { return [NSString stringWithUTF8String:s.c_str()]; }

static const char *axErrName(AXError e) {
  switch (e) {
    case kAXErrorSuccess: return "success";
    case kAXErrorFailure: return "failure";
    case kAXErrorIllegalArgument: return "illegalArgument";
    case kAXErrorInvalidUIElement: return "invalidUIElement";
    case kAXErrorCannotComplete: return "cannotComplete (app not answering AX / timeout)";
    case kAXErrorAttributeUnsupported: return "attributeUnsupported";
    case kAXErrorActionUnsupported: return "actionUnsupported";
    case kAXErrorNotImplemented: return "notImplemented (app does not implement AX)";
    case kAXErrorAPIDisabled: return "apiDisabled (no Accessibility permission)";
    case kAXErrorNoValue: return "noValue";
    default: return "other";
  }
}

static CFTypeRef axAttr(AXUIElementRef el, CFStringRef key) {
  CFTypeRef v = nullptr;
  if (AXUIElementCopyAttributeValue(el, key, &v) == kAXErrorSuccess) return v;
  return nullptr;
}

static std::string axStr(AXUIElementRef el, CFStringRef key) {
  CFTypeRef v = axAttr(el, key);
  if (!v) return "";
  std::string out;
  if (CFGetTypeID(v) == CFStringGetTypeID()) out = toStd((__bridge NSString *)v);
  CFRelease(v);
  return out;
}

// children as retained CFArray; caller releases.
static NSArray *axChildren(AXUIElementRef el) {
  CFTypeRef v = axAttr(el, kAXChildrenAttribute);
  if (!v) return @[];
  if (CFGetTypeID(v) != CFArrayGetTypeID()) { CFRelease(v); return @[]; }
  return CFBridgingRelease(v); // NSArray of AXUIElementRef
}

static std::vector<std::string> axActions(AXUIElementRef el) {
  std::vector<std::string> out;
  CFArrayRef a = nullptr;
  if (AXUIElementCopyActionNames(el, &a) != kAXErrorSuccess || !a) return out;
  CFIndex n = CFArrayGetCount(a);
  for (CFIndex i = 0; i < n; i++) {
    NSString *s = (__bridge NSString *)CFArrayGetValueAtIndex(a, i);
    std::string act = toStd(s);
    // Noise filter: these two are on nearly every node and carry no signal.
    if (act == "AXShowMenu" || act == "AXScrollToVisible") continue;
    out.push_back(act);
  }
  CFRelease(a);
  return out;
}

/// The label an LLM should see. Falls back through the usual attributes.
static std::string axLabel(AXUIElementRef el) {
  static CFStringRef keys[] = {
    kAXTitleAttribute, kAXDescriptionAttribute,
    CFSTR("AXPlaceholderValue"), kAXValueAttribute, CFSTR("AXHelp")
  };
  for (CFStringRef k : keys) {
    std::string s = axStr(el, k);
    if (!s.empty()) {
      if (s.size() > 120) { s.resize(120); s += "…"; }
      return s;
    }
  }
  return "";
}

/// CRITICAL: Chromium/Electron ships its a11y tree DISABLED. Setting
/// AXManualAccessibility is what makes Notion/Slack/WhatsApp readable at all.
/// AXEnhancedUserInterface is the AppKit equivalent. Try both, ignore failures.
/// Must be re-applied on EVERY app resolution — it does not persist reliably.
static void enableAX(AXUIElementRef app) {
  AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
  AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
  usleep(250000); // give Electron a beat to build the tree
}

/// Electron apps report AXWindows = [] (err=success!) even with a window open.
/// Fall back to AXMainWindow / AXFocusedWindow. Returns retained ref or null.
static AXUIElementRef axWindow(AXUIElementRef app, long index) {
  CFTypeRef v = axAttr(app, kAXWindowsAttribute);
  if (v && CFGetTypeID(v) == CFArrayGetTypeID()) {
    CFArrayRef wins = (CFArrayRef)v;
    if (index < CFArrayGetCount(wins)) {
      AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(wins, index);
      CFRetain(w);
      CFRelease(v);
      return w;
    }
  }
  if (v) CFRelease(v);
  if (index != 0) return nullptr;
  for (CFStringRef k : { CFSTR("AXMainWindow"), CFSTR("AXFocusedWindow") }) {
    CFTypeRef w = axAttr(app, k);
    if (w) return (AXUIElementRef)w; // retained
  }
  return nullptr;
}

// ───────────────────────── app resolution ─────────────────────────

struct ResolvedApp {
  AXUIElementRef el = nullptr; // retained; caller releases
  pid_t pid = 0;
  std::string name;
  std::string bundleId;
  bool ok = false;
};

/// Match by localized name OR bundle identifier, case-insensitive.
/// Applies the messaging timeout + Electron unlock on every resolution.
static ResolvedApp resolveApp(const std::string &query) {
  ResolvedApp r;
  @autoreleasepool {
    NSString *want = [toNS(query) lowercaseString];
    for (NSRunningApplication *a in [[NSWorkspace sharedWorkspace] runningApplications]) {
      if (a.activationPolicy != NSApplicationActivationPolicyRegular) continue;
      NSString *name = a.localizedName ?: @"";
      NSString *bid = a.bundleIdentifier ?: @"";
      if ([[name lowercaseString] isEqualToString:want] ||
          [[bid lowercaseString] isEqualToString:want]) {
        r.el = AXUIElementCreateApplication(a.processIdentifier);
        AXUIElementSetMessagingTimeout(r.el, 8.0); // Electron is slow to answer
        enableAX(r.el);
        r.pid = a.processIdentifier;
        r.name = toStd(name);
        r.bundleId = toStd(bid);
        r.ok = true;
        return r;
      }
    }
  }
  return r;
}

// ───────────────────────── tree walk ─────────────────────────

struct Node {
  int id;
  int depth;
  AXUIElementRef el; // borrowed during walk; retained copies kept in vector
  std::string role;
  std::string label;
  std::vector<std::string> actions;
};

/// Flatten the tree depth-first with positional ids. Caller must release
/// each node's element via releaseNodes().
static std::vector<Node> walkTree(AXUIElementRef root, int maxDepth, int maxNodes) {
  std::vector<Node> out;
  int n = 0;
  std::function<void(AXUIElementRef, int)> rec = [&](AXUIElementRef el, int d) {
    if (d > maxDepth || n >= maxNodes) return;
    Node node;
    node.id = n++;
    node.depth = d;
    CFRetain(el);
    node.el = el;
    node.role = axStr(el, kAXRoleAttribute);
    node.label = axLabel(el);
    node.actions = axActions(el);
    out.push_back(node);
    @autoreleasepool {
      NSArray *kids = axChildren(el);
      for (id k in kids) rec((__bridge AXUIElementRef)k, d + 1);
    }
  };
  rec(root, 0);
  return out;
}

static void releaseNodes(std::vector<Node> &nodes) {
  for (auto &n : nodes) CFRelease(n.el);
  nodes.clear();
}

/// Drop the noise. Electron trees are ~80% unlabeled AXGroup wrappers.
static bool isInteresting(const Node &n) {
  if (!n.actions.empty()) return true;
  if (n.label.empty()) return false;
  static const char *roles[] = { "AXStaticText", "AXTextField", "AXTextArea", "AXHeading",
                                 "AXWindow", "AXRow", "AXCell", "AXLink", "AXImage" };
  for (const char *r : roles) if (n.role == r) return true;
  return false;
}

// ───────────────────────── N-API surface ─────────────────────────

static Napi::Value IsTrusted(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), AXIsProcessTrusted() == true);
}

static Napi::Value ProcessInfoFn(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("pid", Napi::Number::New(env, (double)getpid()));
  @autoreleasepool {
    NSString *exe = [[NSBundle mainBundle] executablePath];
    NSString *bid = [[NSBundle mainBundle] bundleIdentifier];
    if (exe) out.Set("executablePath", Napi::String::New(env, [exe UTF8String]));
    if (bid) out.Set("bundleIdentifier", Napi::String::New(env, [bid UTF8String]));
  }
  return out;
}

/// listApps() → [{name, bundleId, pid, windowsHere, windowsAnywhere}]
/// Window counts come from CGWindowList, NOT the AX tree, because (a) Electron
/// lies via AX until AXManualAccessibility is set (and enabling it on every
/// running app would cost 250ms each), and (b) CGWindowList can also tell us
/// about windows on OTHER Spaces: onScreenOnly excludes them, optionAll counts
/// them. windowsAnywhere>0 with windowsHere==0 ⇒ "parked on another Space".
static Napi::Value ListApps(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Array arr = Napi::Array::New(env);
  @autoreleasepool {
    // pid → [here, anywhere]
    NSMutableDictionary<NSNumber *, NSMutableArray<NSNumber *> *> *counts = [NSMutableDictionary new];
    auto tally = [&](CFArrayRef list, int slot) {
      if (!list) return;
      NSArray *infos = (__bridge NSArray *)list;
      for (NSDictionary *w in infos) {
        NSNumber *layer = w[(__bridge NSString *)kCGWindowLayer];
        NSNumber *alpha = w[(__bridge NSString *)kCGWindowAlpha];
        NSNumber *pid = w[(__bridge NSString *)kCGWindowOwnerPID];
        if (!pid || layer.intValue != 0 || alpha.doubleValue <= 0) continue;
        NSMutableArray *c = counts[pid];
        if (!c) { c = [NSMutableArray arrayWithObjects:@0, @0, nil]; counts[pid] = c; }
        c[slot] = @([c[slot] intValue] + 1);
      }
    };
    CFArrayRef onScreen = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    CFArrayRef all = CGWindowListCopyWindowInfo(
        kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    tally(onScreen, 0);
    tally(all, 1);
    if (onScreen) CFRelease(onScreen);
    if (all) CFRelease(all);

    uint32_t i = 0;
    for (NSRunningApplication *a in [[NSWorkspace sharedWorkspace] runningApplications]) {
      if (a.activationPolicy != NSApplicationActivationPolicyRegular) continue;
      Napi::Object o = Napi::Object::New(env);
      o.Set("name", Napi::String::New(env, toStd(a.localizedName ?: @"?")));
      o.Set("bundleId", Napi::String::New(env, toStd(a.bundleIdentifier ?: @"")));
      o.Set("pid", Napi::Number::New(env, a.processIdentifier));
      NSArray *c = counts[@(a.processIdentifier)];
      o.Set("windowsHere", Napi::Number::New(env, c ? [c[0] intValue] : 0));
      o.Set("windowsAnywhere", Napi::Number::New(env, c ? [c[1] intValue] : 0));
      arr.Set(i++, o);
    }
  }
  return arr;
}

static Napi::Value FrontmostApp(const Napi::CallbackInfo &info) {
  @autoreleasepool {
    NSRunningApplication *f = [[NSWorkspace sharedWorkspace] frontmostApplication];
    return Napi::String::New(info.Env(), toStd(f.localizedName ?: @"?"));
  }
}

/// Shared entry: resolve app + window, walk, then hand nodes to `fn`.
/// Guarantees cleanup. Returns whatever `fn` returns.
static Napi::Value withNodes(Napi::Env env, const std::string &app, long winIndex,
                             int maxDepth, int maxNodes,
                             const std::function<Napi::Value(ResolvedApp &, std::vector<Node> &)> &fn) {
  ResolvedApp r = resolveApp(app);
  if (!r.ok) {
    Napi::Object o = Napi::Object::New(env);
    o.Set("error", Napi::String::New(env, "app '" + app + "' is not running"));
    return o;
  }
  AXUIElementRef win = axWindow(r.el, winIndex);
  if (!win) {
    CFRelease(r.el);
    Napi::Object o = Napi::Object::New(env);
    o.Set("error", Napi::String::New(env,
        "no reachable window for '" + r.name + "'. If the app is on another macOS Space, "
        "it is unreachable — the user must move it to the current Space."));
    return o;
  }
  std::vector<Node> nodes = walkTree(win, maxDepth, maxNodes);
  Napi::Value out = fn(r, nodes);
  releaseNodes(nodes);
  CFRelease(win);
  CFRelease(r.el);
  return out;
}

static Napi::Object nodeToJs(Napi::Env env, const Node &n) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("id", Napi::Number::New(env, n.id));
  o.Set("depth", Napi::Number::New(env, n.depth));
  o.Set("role", Napi::String::New(env, n.role));
  o.Set("label", Napi::String::New(env, n.label));
  Napi::Array acts = Napi::Array::New(env);
  for (uint32_t i = 0; i < n.actions.size(); i++)
    acts.Set(i, Napi::String::New(env, n.actions[i]));
  o.Set("actions", acts);
  return o;
}

/// find(app, label?, role?) → {app, nodes: [...]}  (interesting-only when unfiltered)
static Napi::Value Find(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  std::string label = info.Length() > 1 && info[1].IsString() ? std::string(info[1].As<Napi::String>()) : "";
  std::string role = info.Length() > 2 && info[2].IsString() ? std::string(info[2].As<Napi::String>()) : "";
  std::string labelLower = label;
  for (auto &c : labelLower) c = (char)tolower((unsigned char)c);

  return withNodes(env, app, 0, 14, 4000, [&](ResolvedApp &r, std::vector<Node> &nodes) -> Napi::Value {
    Napi::Object out = Napi::Object::New(env);
    out.Set("app", Napi::String::New(env, r.name));
    Napi::Array hits = Napi::Array::New(env);
    uint32_t k = 0;
    for (auto &n : nodes) {
      if (!role.empty() && n.role != role) continue;
      if (!labelLower.empty()) {
        std::string nl = n.label;
        for (auto &c : nl) c = (char)tolower((unsigned char)c);
        if (nl.find(labelLower) == std::string::npos) continue;
      }
      if (labelLower.empty() && role.empty() && !isInteresting(n)) continue;
      if (n.label.empty() && n.actions.empty()) continue;
      if (k >= 80) break; // context discipline: cap output
      hits.Set(k++, nodeToJs(env, n));
    }
    out.Set("nodes", hits);
    out.Set("total", Napi::Number::New(env, (double)nodes.size()));
    return out;
  });
}

/// getTree(app, windowIndex, rolesCsv, maxDepth, includeAll) → {app, window, nodes}
static Napi::Value GetTree(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  long winIndex = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().Int64Value() : 0;
  std::string rolesCsv = info.Length() > 2 && info[2].IsString() ? std::string(info[2].As<Napi::String>()) : "";
  int maxDepth = info.Length() > 3 && info[3].IsNumber() ? info[3].As<Napi::Number>().Int32Value() : 14;
  bool all = info.Length() > 4 && info[4].IsBoolean() ? info[4].As<Napi::Boolean>().Value() : false;

  std::vector<std::string> roleFilter;
  if (!rolesCsv.empty()) {
    size_t p = 0;
    while (p != std::string::npos) {
      size_t q = rolesCsv.find(',', p);
      std::string tok = rolesCsv.substr(p, q == std::string::npos ? std::string::npos : q - p);
      while (!tok.empty() && tok.front() == ' ') tok.erase(tok.begin());
      while (!tok.empty() && tok.back() == ' ') tok.pop_back();
      if (!tok.empty()) roleFilter.push_back(tok);
      p = q == std::string::npos ? q : q + 1;
    }
  }

  return withNodes(env, app, winIndex, maxDepth, 4000, [&](ResolvedApp &r, std::vector<Node> &nodes) -> Napi::Value {
    Napi::Object out = Napi::Object::New(env);
    out.Set("app", Napi::String::New(env, r.name));
    out.Set("window", Napi::String::New(env, nodes.empty() ? "" : nodes[0].label));
    Napi::Array arr = Napi::Array::New(env);
    uint32_t k = 0;
    for (auto &n : nodes) {
      if (!roleFilter.empty()) {
        bool hit = false;
        for (auto &rf : roleFilter) if (n.role == rf) { hit = true; break; }
        if (!hit) continue;
      } else if (!all && !isInteresting(n)) {
        continue;
      }
      arr.Set(k++, nodeToJs(env, n));
    }
    out.Set("nodes", arr);
    out.Set("total", Napi::Number::New(env, (double)nodes.size()));
    return out;
  });
}

/// press(app, id) → {ok, role, label} | {error}
/// press(app, id, maxDepth?)
///
/// maxDepth MUST match the depth of the walk the caller took the id from.
/// Node ids are POSITIONAL within a walk, so a walk of a different depth
/// produces different ids for the same elements — pressing id 42 from a
/// depth-40 read against this default-14 walk silently actuates a DIFFERENT
/// control, or reports out-of-range. Deep Electron UIs make this routine
/// rather than exotic: Claude Desktop's Send button sits at depth 28 and its
/// permission buttons around 20, so a depth-14 walk cannot even see them.
/// Defaulted to 14 so existing callers are unaffected.
static Napi::Value Press(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  int target = info[1].As<Napi::Number>().Int32Value();
  int maxDepth = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().Int32Value() : 14;
  return withNodes(env, app, 0, maxDepth, 4000, [&](ResolvedApp &r, std::vector<Node> &nodes) -> Napi::Value {
    Napi::Object out = Napi::Object::New(env);
    if (target < 0 || target >= (int)nodes.size()) {
      out.Set("error", Napi::String::New(env, "id out of range (max " + std::to_string(nodes.size() - 1) + "). The tree may have changed — re-run find."));
      return out;
    }
    Node &n = nodes[target];
    AXError e = AXUIElementPerformAction(n.el, kAXPressAction);
    out.Set("ok", Napi::Boolean::New(env, e == kAXErrorSuccess));
    out.Set("role", Napi::String::New(env, n.role));
    out.Set("label", Napi::String::New(env, n.label));
    if (e != kAXErrorSuccess) out.Set("error", Napi::String::New(env, std::string("AXPress failed: ") + axErrName(e)));
    return out;
  });
}

/// Write text into an editable element the way native AND Chromium/Electron
/// honor — the core of background typing (no synthetic keystrokes, no focus
/// steal). Strategy, in order:
///   1. FOCUS the element. Chromium only routes edits to the focused node, and
///      AppKit fields accept AXValue reliably once focused.
///   2. Direct AXValue set. Native fields + Electron (with a11y enabled) take
///      this. We read the value back to VERIFY it actually landed — Chromium
///      often returns success while ignoring the write.
///   3. If it didn't land, AXSelectedText insertion at the caret. This is the
///      path Chromium's contenteditable/textarea bridge honors, translating to
///      real DOM input events. `replace` clears first so it overwrites.
/// Returns kAXErrorSuccess if any strategy took.
static AXError axTypeInto(AXUIElementRef el, const std::string &text, bool replace) {
  NSString *ns = toNS(text);
  AXUIElementSetAttributeValue(el, kAXFocusedAttribute, kCFBooleanTrue);
  usleep(40000); // let focus + Chromium's a11y bridge settle

  std::string before = axStr(el, kAXValueAttribute);
  if (replace) {
    // Select-all + clear so the write overwrites rather than appends.
    AXUIElementSetAttributeValue(el, kAXValueAttribute, (__bridge CFTypeRef)@"");
    AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute, (__bridge CFTypeRef)@"");
  }

  // Strategy 2: direct value set, then verify it changed.
  AXError e1 = AXUIElementSetAttributeValue(el, kAXValueAttribute, (__bridge CFTypeRef)ns);
  if (e1 == kAXErrorSuccess) {
    std::string after = axStr(el, kAXValueAttribute);
    if (!after.empty() && after != before && after.find(text) != std::string::npos)
      return kAXErrorSuccess; // took (native field / cooperative Electron)
  }

  // Strategy 3: caret insertion — Chromium contenteditable / textarea path.
  AXError e2 = AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute, (__bridge CFTypeRef)ns);
  if (e2 == kAXErrorSuccess) return kAXErrorSuccess;

  // If value-set at least returned success (even if we couldn't verify), accept it.
  return e1 == kAXErrorSuccess ? kAXErrorSuccess : (e2 != kAXErrorSuccess ? e1 : e2);
}

/// setValue(app, id, text) → {ok, role, label} | {error}
/// setValue(app, id, text, maxDepth?) — see the note on Press about maxDepth;
/// the same positional-id hazard applies, and writing text into the wrong
/// element is just as damaging as pressing the wrong button.
static Napi::Value SetValue(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  int target = info[1].As<Napi::Number>().Int32Value();
  std::string text = info[2].As<Napi::String>();
  int maxDepth = info.Length() > 3 && info[3].IsNumber() ? info[3].As<Napi::Number>().Int32Value() : 14;
  return withNodes(env, app, 0, maxDepth, 4000, [&](ResolvedApp &r, std::vector<Node> &nodes) -> Napi::Value {
    Napi::Object out = Napi::Object::New(env);
    if (target < 0 || target >= (int)nodes.size()) {
      out.Set("error", Napi::String::New(env, "id out of range. The tree may have changed — re-run find."));
      return out;
    }
    Node &n = nodes[target];
    AXError e = axTypeInto(n.el, text, /*replace=*/true);
    out.Set("ok", Napi::Boolean::New(env, e == kAXErrorSuccess));
    out.Set("role", Napi::String::New(env, n.role));
    out.Set("label", Napi::String::New(env, n.label));
    if (e != kAXErrorSuccess)
      out.Set("error", Napi::String::New(env,
          std::string("setValue failed: ") + axErrName(e) +
          ". The field may need focus or reject AXValue writes — try menu_action or press instead."));
    return out;
  });
}

/// typeText(app, text, replace?, submit?) → {ok, target} | {error}
/// The high-level background-typing entry: the caller need NOT locate a field.
/// We resolve the app, enable its a11y tree, find the best editable target
/// (the app's focused element, else the first text field/area in the main
/// window), type into it via axTypeInto, and optionally submit (AXConfirm).
static Napi::Value TypeText(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  std::string text = info[1].As<Napi::String>();
  bool replace = info.Length() > 2 && info[2].IsBoolean() ? info[2].As<Napi::Boolean>().Value() : false;
  bool submit  = info.Length() > 3 && info[3].IsBoolean() ? info[3].As<Napi::Boolean>().Value() : false;
  Napi::Object out = Napi::Object::New(env);

  ResolvedApp r = resolveApp(app);
  if (!r.ok) { out.Set("error", Napi::String::New(env, "app '" + app + "' is not running")); return out; }

  std::string targetLabel;
  AXUIElementRef target = nullptr;
  // 1. The app's currently-focused element (the compose/search box the user or
  //    a prior nav step left active) — the most reliable target.
  CFTypeRef focused = axAttr(r.el, kAXFocusedUIElementAttribute);
  if (focused && CFGetTypeID(focused) == AXUIElementGetTypeID()) {
    target = (AXUIElementRef)focused; // retained
    targetLabel = axStr(target, kAXRoleAttribute);
  } else if (focused) {
    CFRelease(focused);
  }
  // 2. Else scan the main window for the first editable text element.
  if (!target) {
    AXUIElementRef win = axWindow(r.el, 0);
    if (win) {
      std::vector<Node> nodes = walkTree(win, 20, 6000);
      for (auto &n : nodes) {
        if (n.role == "AXTextField" || n.role == "AXTextArea" || n.role == "AXComboBox") {
          CFRetain(n.el); target = n.el; targetLabel = n.role + " \"" + n.label + "\""; break;
        }
      }
      releaseNodes(nodes);
      CFRelease(win);
    }
  }
  if (!target) {
    CFRelease(r.el);
    out.Set("error", Napi::String::New(env, "no editable text field found (open/click the field first, or the app exposes none via AX)"));
    return out;
  }

  AXError e = axTypeInto(target, text, replace);
  bool ok = (e == kAXErrorSuccess);
  if (ok && submit) {
    // Generic submit: AXConfirm fires for search fields + many compose boxes.
    AXUIElementPerformAction(target, kAXConfirmAction);
  }
  CFRelease(target);
  CFRelease(r.el);

  out.Set("ok", Napi::Boolean::New(env, ok));
  out.Set("target", Napi::String::New(env, targetLabel));
  if (!ok) out.Set("error", Napi::String::New(env, std::string("typeText failed: ") + axErrName(e)));
  return out;
}

/// fillForm(app, idsJson: {"12": "text", ...}) → {results: [{id, ok, label, error?}]}
static Napi::Value FillForm(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  Napi::Object fields = info[1].As<Napi::Object>();
  Napi::Array keys = fields.GetPropertyNames();
  return withNodes(env, app, 0, 14, 4000, [&](ResolvedApp &r, std::vector<Node> &nodes) -> Napi::Value {
    Napi::Object out = Napi::Object::New(env);
    Napi::Array results = Napi::Array::New(env);
    for (uint32_t i = 0; i < keys.Length(); i++) {
      std::string key = keys.Get(i).As<Napi::String>();
      std::string val = fields.Get(key).ToString();
      Napi::Object res = Napi::Object::New(env);
      res.Set("id", Napi::String::New(env, key));
      int idx = -1;
      try { idx = std::stoi(key); } catch (...) {}
      if (idx < 0 || idx >= (int)nodes.size()) {
        res.Set("ok", Napi::Boolean::New(env, false));
        res.Set("error", Napi::String::New(env, "bad id"));
      } else {
        Node &n = nodes[idx];
        AXError e = AXUIElementSetAttributeValue(n.el, kAXValueAttribute, (__bridge CFTypeRef)toNS(val));
        res.Set("ok", Napi::Boolean::New(env, e == kAXErrorSuccess));
        res.Set("label", Napi::String::New(env, n.label));
        if (e != kAXErrorSuccess) res.Set("error", Napi::String::New(env, axErrName(e)));
      }
      results.Set(i, res);
    }
    out.Set("results", results);
    return out;
  });
}

/// menuAction(app, "File > Save") → {ok} | {error, available?}
static Napi::Value MenuAction(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  std::string path = info[1].As<Napi::String>();
  Napi::Object out = Napi::Object::New(env);

  ResolvedApp r = resolveApp(app);
  if (!r.ok) { out.Set("error", Napi::String::New(env, "app '" + app + "' is not running")); return out; }

  CFTypeRef menubar = axAttr(r.el, kAXMenuBarAttribute);
  if (!menubar) {
    CFRelease(r.el);
    out.Set("error", Napi::String::New(env, "no menu bar reachable"));
    return out;
  }

  // Split "File > Save As…" on '>'
  std::vector<std::string> parts;
  {
    size_t p = 0;
    while (p != std::string::npos) {
      size_t q = path.find('>', p);
      std::string tok = path.substr(p, q == std::string::npos ? std::string::npos : q - p);
      while (!tok.empty() && tok.front() == ' ') tok.erase(tok.begin());
      while (!tok.empty() && tok.back() == ' ') tok.pop_back();
      if (!tok.empty()) parts.push_back(tok);
      p = q == std::string::npos ? q : q + 1;
    }
  }

  AXUIElementRef cur = (AXUIElementRef)menubar; // retained (from axAttr)
  bool done = false;
  @autoreleasepool {
    for (size_t i = 0; i < parts.size() && !done; i++) {
      NSString *want = [toNS(parts[i]) lowercaseString];
      NSArray *kids = axChildren(cur);
      AXUIElementRef hit = nullptr;
      NSMutableArray *avail = [NSMutableArray new];
      for (id k in kids) {
        AXUIElementRef kel = (__bridge AXUIElementRef)k;
        std::string l = axLabel(kel);
        if (!l.empty()) [avail addObject:toNS(l)];
        NSString *ll = [toNS(l) lowercaseString];
        if ([ll isEqualToString:want]) { hit = kel; break; }
      }
      if (!hit) {
        out.Set("error", Napi::String::New(env,
            "menu item '" + parts[i] + "' not found. Available: " + toStd([avail componentsJoinedByString:@", "])));
        done = true;
        break;
      }
      if (i == parts.size() - 1) {
        AXError e = AXUIElementPerformAction(hit, kAXPressAction);
        out.Set("ok", Napi::Boolean::New(env, e == kAXErrorSuccess));
        if (e != kAXErrorSuccess) out.Set("error", Napi::String::New(env, std::string("menu press failed: ") + axErrName(e)));
        done = true;
        break;
      }
      // descend into the submenu container (first child of the item)
      NSArray *sub = axChildren(hit);
      AXUIElementRef next = sub.count > 0 ? (__bridge AXUIElementRef)sub[0] : hit;
      CFRetain(next);
      CFRelease(cur);
      cur = next;
    }
  }
  if (!done) out.Set("error", Napi::String::New(env, "empty menu path"));
  CFRelease(cur);
  CFRelease(r.el);
  return out;
}

/// The MAIN content window for a pid = the largest on-screen, layer-0, visible
/// window it owns. Electron/Chromium apps own several windows per pid (tiny
/// helper/menubar strips among them); picking the FIRST match grabbed those
/// strips (the "capture only shows the menu strip" bug). Largest-area wins.
static CGWindowID largestWindowForPid(pid_t pid) {
  CGWindowID best = 0;
  double bestArea = 0;
  @autoreleasepool {
    CFArrayRef list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (list) {
      for (NSDictionary *w in (__bridge NSArray *)list) {
        if ([w[(__bridge NSString *)kCGWindowOwnerPID] intValue] != pid) continue;
        if ([w[(__bridge NSString *)kCGWindowLayer] intValue] != 0) continue;
        if ([w[(__bridge NSString *)kCGWindowAlpha] doubleValue] <= 0) continue;
        NSDictionary *b = w[(__bridge NSString *)kCGWindowBounds];
        double area = b ? [b[@"Width"] doubleValue] * [b[@"Height"] doubleValue] : 0;
        if (area > bestArea) {
          bestArea = area;
          best = [w[(__bridge NSString *)kCGWindowNumber] unsignedIntValue];
        }
      }
      CFRelease(list);
    }
  }
  return best;
}

/// Synchronously capture one window (by CGWindowID) via ScreenCaptureKit.
/// Returns a +1 CGImageRef (caller CGImageRelease) or nullptr with `err` set.
/// SCK captures a window's FULL content even when occluded / behind others /
/// not frontmost, without raising it — the no-steal-focus property we need.
/// SCK's API is async; we block THIS worker thread on a semaphore while SCK's
/// internal queues do the work — safe because this never runs on the main queue.
/// Downscaling is done by SCK itself (config.width/height), not a second pass.
API_AVAILABLE(macos(14.0))
static CGImageRef scCaptureImage(CGWindowID wid, double maxW, std::string &errOut) {
  // MRC (no ARC): do ALL ObjC work INSIDE the completion blocks and only carry
  // out a CFRetain'd CGImageRef + an error string. If we stashed the ObjC
  // objects (SCShareableContent/SCWindow) and touched them after the async
  // callback returned, MRC would have already deallocated them → use-after-free
  // segfault (the crash this replaces). CF types and __block std::string are
  // safe to cross the boundary.
  __block CGImageRef image = nullptr;
  __block std::string err;
  dispatch_semaphore_t sem = dispatch_semaphore_create(0);

  [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                            onScreenWindowsOnly:NO
                                              completionHandler:^(SCShareableContent *content, NSError *listErr) {
    if (!content) {
      err = listErr ? toStd(listErr.localizedDescription)
                    : "could not enumerate windows — grant Screen Recording permission";
      dispatch_semaphore_signal(sem);
      return;
    }
    SCWindow *target = nil;
    for (SCWindow *w in content.windows) {
      if (w.windowID == wid) { target = w; break; }
    }
    if (!target) {
      err = "window not capturable (it may be minimized or on another Space)";
      dispatch_semaphore_signal(sem);
      return;
    }

    SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
    SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
    CGFloat pxScale = 1.0;
  if (@available(macOS 14.0, *)) { if (filter.pointPixelScale > 0) pxScale = filter.pointPixelScale; }
    size_t fullW = (size_t)(target.frame.size.width * pxScale);
    size_t fullH = (size_t)(target.frame.size.height * pxScale);
    double dscale = (maxW > 0 && (double)fullW > maxW) ? (maxW / (double)fullW) : 1.0;
    cfg.width = (size_t)((double)fullW * dscale);
    cfg.height = (size_t)((double)fullH * dscale);
    cfg.showsCursor = NO;
    cfg.ignoreShadowsSingleWindow = YES;
    cfg.scalesToFit = YES;

    // Nested async capture; signal the semaphore only when THIS inner callback
    // completes, so the whole pipeline finishes before we return.
    [SCScreenshotManager captureImageWithFilter:filter
                                  configuration:cfg
                              completionHandler:^(CGImageRef img, NSError *capErr) {
      if (img) image = (CGImageRef)CFRetain(img);
      else err = capErr ? toStd(capErr.localizedDescription)
                        : "capture failed — grant Screen Recording permission";
      dispatch_semaphore_signal(sem);
    }];
    [filter release];
    [cfg release];
  }];

  if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC))) != 0) {
    errOut = "capture timed out (grant Screen Recording permission in System Settings → Privacy & Security)";
    return nullptr;
  }
  if (!image) { errOut = err.empty() ? "capture failed" : err; return nullptr; }
  return image;
}

/// captureWindow(app, maxWidth?) → {ok, base64, width, height} | {error}
/// Per-window capture: works while the window is BEHIND other windows.
/// Requires Screen Recording permission. Never brings the app forward.
static Napi::Value CaptureWindow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  std::string app = info[0].As<Napi::String>();
  double maxW = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 1400.0;
  Napi::Object out = Napi::Object::New(env);

  ResolvedApp r = resolveApp(app);
  if (!r.ok) { out.Set("error", Napi::String::New(env, "app '" + app + "' is not running")); return out; }
  pid_t pid = r.pid;
  CFRelease(r.el);

  @autoreleasepool {
    CGWindowID wid = largestWindowForPid(pid);
    if (wid == 0) {
      out.Set("error", Napi::String::New(env, "no capturable window (app may be on another Space)"));
      return out;
    }

    // ScreenCaptureKit path (replaces the obsoleted CGWindowListCreateImage).
    // SCScreenshotManager needs macOS 14+; on older macOS we degrade with a
    // clear message rather than failing to load the whole addon.
    if (@available(macOS 14.0, *)) {
      std::string err;
      CGImageRef img = scCaptureImage(wid, maxW, err);
      if (!img) {
        out.Set("error", Napi::String::New(env, err));
        return out;
      }
      size_t fw = CGImageGetWidth(img), fh = CGImageGetHeight(img);
      NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:img];
      NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      CGImageRelease(img);
      if (!png) {
        out.Set("error", Napi::String::New(env, "png encode failed"));
        return out;
      }
      NSString *b64 = [png base64EncodedStringWithOptions:0];
      out.Set("ok", Napi::Boolean::New(env, true));
      out.Set("base64", Napi::String::New(env, toStd(b64)));
      out.Set("width", Napi::Number::New(env, (double)fw));
      out.Set("height", Napi::Number::New(env, (double)fh));
    } else {
      out.Set("error", Napi::String::New(env, "window capture requires macOS 14 or later"));
    }
  }
  return out;
}

// ───────────────────── Live window capture (SCStream) ─────────────────────
// startCapture(app, maxWidth, fps, onFrame) → {ok, handle} | {error}
// stopCapture(handle) → {ok} | {error}
//
// A continuous per-window video feed for the UI's live preview pane — the
// Codex-parity "watch the agent drive the app" view. Same SCK properties as the
// single-shot path: captures the window in the BACKGROUND, even occluded, no
// focus steal. Frames are delivered on a background dispatch queue, JPEG-encoded,
// and marshalled to the JS `onFrame` callback via a Napi ThreadSafeFunction
// (NonBlockingCall, so a slow renderer drops frames rather than backing up).

struct FrameData { std::string b64; int w; int h; };

struct StreamCtx {
  Napi::ThreadSafeFunction tsfn;
  SCStream *stream = nil;   // +1 retained until stopCapture
  id output = nil;          // AxStreamOutput +1 retained until stopCapture
  std::atomic<bool> stopped{false};
};

static std::mutex gStreamMx;
static std::map<uint32_t, StreamCtx *> gStreams;
static uint32_t gStreamSeq = 0;
static CIContext *gCIContext = nil; // shared frame encoder

static NSData *pixelBufferToJPEG(CVImageBufferRef pb) {
  if (!pb) return nil;
  CIImage *ci = [CIImage imageWithCVPixelBuffer:pb];
  if (!ci) return nil;
  if (!gCIContext) gCIContext = [[CIContext alloc] initWithOptions:nil];
  CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
  NSData *jpeg = [gCIContext JPEGRepresentationOfImage:ci colorSpace:cs options:@{}];
  CGColorSpaceRelease(cs);
  return jpeg; // autoreleased
}

API_AVAILABLE(macos(12.3))
@interface AxStreamOutput : NSObject <SCStreamOutput, SCStreamDelegate> {
@public
  StreamCtx *ctx;
}
@end

@implementation AxStreamOutput
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sb ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeScreen) return;
  if (!ctx || ctx->stopped.load()) return;
  if (!sb || !CMSampleBufferIsValid(sb) || !CMSampleBufferDataIsReady(sb)) return;
  @autoreleasepool {
    CVImageBufferRef pb = CMSampleBufferGetImageBuffer(sb);
    if (!pb) return;
    int w = (int)CVPixelBufferGetWidth(pb);
    int h = (int)CVPixelBufferGetHeight(pb);
    NSData *jpeg = pixelBufferToJPEG(pb);
    if (!jpeg) return;
    NSString *b64 = [jpeg base64EncodedStringWithOptions:0];
    FrameData *fd = new FrameData{ toStd(b64), w, h };
    napi_status st = ctx->tsfn.NonBlockingCall(fd, [](Napi::Env env, Napi::Function cb, FrameData *d) {
      Napi::HandleScope scope(env);
      Napi::Object o = Napi::Object::New(env);
      o.Set("base64", Napi::String::New(env, d->b64));
      o.Set("width", Napi::Number::New(env, d->w));
      o.Set("height", Napi::Number::New(env, d->h));
      cb.Call({ o });
      delete d;
    });
    if (st != napi_ok) delete fd; // queue full or closing — drop this frame
  }
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
  if (ctx) ctx->stopped.store(true);
}
@end

static Napi::Value StartCapture(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  std::string app = info[0].As<Napi::String>();
  double maxW = info.Length() > 1 && info[1].IsNumber() ? info[1].As<Napi::Number>().DoubleValue() : 1000.0;
  double fps = info.Length() > 2 && info[2].IsNumber() ? info[2].As<Napi::Number>().DoubleValue() : 10.0;
  if (info.Length() < 4 || !info[3].IsFunction()) {
    out.Set("error", Napi::String::New(env, "startCapture requires an onFrame callback"));
    return out;
  }
  if (fps < 1) fps = 1; if (fps > 60) fps = 60;

  if (@available(macOS 12.3, *)) {
    // Resolve the app's front window id (same approach as CaptureWindow).
    ResolvedApp r = resolveApp(app);
    if (!r.ok) { out.Set("error", Napi::String::New(env, "app '" + app + "' is not running")); return out; }
    pid_t pid = r.pid;
    CFRelease(r.el);
    CGWindowID wid = largestWindowForPid(pid);
    if (wid == 0) { out.Set("error", Napi::String::New(env, "no capturable window (app may be on another Space)")); return out; }

    StreamCtx *ctx = new StreamCtx();
    ctx->tsfn = Napi::ThreadSafeFunction::New(env, info[3].As<Napi::Function>(), "ax-capture", 0, 1);

    __block std::string err;
    __block bool ok = false;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                              onScreenWindowsOnly:NO
                                                completionHandler:^(SCShareableContent *content, NSError *listErr) {
      if (!content) { err = listErr ? toStd(listErr.localizedDescription) : "could not enumerate windows — grant Screen Recording permission"; dispatch_semaphore_signal(sem); return; }
      SCWindow *target = nil;
      for (SCWindow *w in content.windows) { if (w.windowID == wid) { target = w; break; } }
      if (!target) { err = "window not capturable (minimized or on another Space)"; dispatch_semaphore_signal(sem); return; }

      SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:target];
      SCStreamConfiguration *cfg = [[SCStreamConfiguration alloc] init];
      CGFloat pxScale = 1.0;
  if (@available(macOS 14.0, *)) { if (filter.pointPixelScale > 0) pxScale = filter.pointPixelScale; }
      size_t fullW = (size_t)(target.frame.size.width * pxScale);
      size_t fullH = (size_t)(target.frame.size.height * pxScale);
      double dscale = (maxW > 0 && (double)fullW > maxW) ? (maxW / (double)fullW) : 1.0;
      cfg.width = (size_t)((double)fullW * dscale);
      cfg.height = (size_t)((double)fullH * dscale);
      cfg.minimumFrameInterval = CMTimeMake(1, (int32_t)fps);
      cfg.showsCursor = NO;
      cfg.queueDepth = 5;
      cfg.scalesToFit = YES;

      AxStreamOutput *output = [[AxStreamOutput alloc] init];
      output->ctx = ctx;
      SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:cfg delegate:output];
      [filter release];
      [cfg release];

      NSError *addErr = nil;
      dispatch_queue_t q = dispatch_queue_create("com.unmute.ax.capture", DISPATCH_QUEUE_SERIAL);
      BOOL added = [stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:q error:&addErr];
      if (!added) { err = addErr ? toStd(addErr.localizedDescription) : "addStreamOutput failed"; [stream release]; [output release]; dispatch_semaphore_signal(sem); return; }

      ctx->stream = stream;   // keep +1
      ctx->output = output;   // keep +1
      [stream startCaptureWithCompletionHandler:^(NSError *startErr) {
        if (startErr) err = toStd(startErr.localizedDescription);
        else ok = true;
        dispatch_semaphore_signal(sem);
      }];
    }];

    if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(10 * NSEC_PER_SEC))) != 0) {
      out.Set("error", Napi::String::New(env, "startCapture timed out (grant Screen Recording permission)"));
      ctx->tsfn.Release();
      if (ctx->stream) { [ctx->stream release]; } if (ctx->output) { [ctx->output release]; }
      delete ctx;
      return out;
    }
    if (!ok) {
      out.Set("error", Napi::String::New(env, err.empty() ? "startCapture failed" : err));
      ctx->tsfn.Release();
      if (ctx->stream) { [ctx->stream release]; } if (ctx->output) { [ctx->output release]; }
      delete ctx;
      return out;
    }

    uint32_t handle;
    { std::lock_guard<std::mutex> lk(gStreamMx); handle = ++gStreamSeq; gStreams[handle] = ctx; }
    out.Set("ok", Napi::Boolean::New(env, true));
    out.Set("handle", Napi::Number::New(env, (double)handle));
    return out;
  } else {
    out.Set("error", Napi::String::New(env, "live capture requires macOS 12.3 or later"));
    return out;
  }
}

static Napi::Value StopCapture(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  uint32_t handle = info.Length() > 0 && info[0].IsNumber() ? (uint32_t)info[0].As<Napi::Number>().Uint32Value() : 0;
  StreamCtx *ctx = nullptr;
  { std::lock_guard<std::mutex> lk(gStreamMx); auto it = gStreams.find(handle); if (it != gStreams.end()) { ctx = it->second; gStreams.erase(it); } }
  if (!ctx) { out.Set("error", Napi::String::New(env, "unknown capture handle")); return out; }

  ctx->stopped.store(true); // stop frames marshalling first
  if (@available(macOS 12.3, *)) {
    if (ctx->stream) {
      [ctx->stream stopCaptureWithCompletionHandler:^(NSError *e) { (void)e; }];
    }
  }
  ctx->tsfn.Release(); // let the JS callback be GC'd
  if (ctx->stream) { [ctx->stream release]; ctx->stream = nil; }
  if (ctx->output) { [ctx->output release]; ctx->output = nil; }
  delete ctx;
  out.Set("ok", Napi::Boolean::New(env, true));
  return out;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isTrusted", Napi::Function::New(env, IsTrusted));
  exports.Set("processInfo", Napi::Function::New(env, ProcessInfoFn));
  exports.Set("listApps", Napi::Function::New(env, ListApps));
  exports.Set("frontmostApp", Napi::Function::New(env, FrontmostApp));
  exports.Set("find", Napi::Function::New(env, Find));
  exports.Set("getTree", Napi::Function::New(env, GetTree));
  exports.Set("press", Napi::Function::New(env, Press));
  exports.Set("setValue", Napi::Function::New(env, SetValue));
  exports.Set("typeText", Napi::Function::New(env, TypeText));
  exports.Set("fillForm", Napi::Function::New(env, FillForm));
  exports.Set("menuAction", Napi::Function::New(env, MenuAction));
  exports.Set("captureWindow", Napi::Function::New(env, CaptureWindow));
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  return exports;
}

NODE_API_MODULE(native_ax, Init)
