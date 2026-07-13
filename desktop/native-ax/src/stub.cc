// Non-mac stub: the .node loads but every call reports unavailability,
// so callers can treat absence and unavailability identically.
#include <napi.h>

static Napi::Value NotAvailable(const Napi::CallbackInfo& info) {
  Napi::Object out = Napi::Object::New(info.Env());
  out.Set("error", Napi::String::New(info.Env(), "native-ax is macOS-only"));
  return out;
}

static Napi::Value False(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isTrusted", Napi::Function::New(env, False));
  for (const char* name : {"processInfo", "listApps", "frontmostApp", "find", "getTree",
                           "press", "setValue", "fillForm", "menuAction", "captureWindow"}) {
    exports.Set(name, Napi::Function::New(env, NotAvailable));
  }
  return exports;
}

NODE_API_MODULE(native_ax, Init)
