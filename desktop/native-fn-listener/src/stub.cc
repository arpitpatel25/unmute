// Non-macOS stub. Lets the JS-side `require()` succeed on Linux / Windows
// dev installs (electron-builder rebuild target) and return harmless no-ops.

#include <napi.h>

Napi::Value Start(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), true);
}

Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isAccessibilityTrusted",
              Napi::Function::New(env, IsAccessibilityTrusted));
  return exports;
}

NODE_API_MODULE(native_fn_listener, Init)
