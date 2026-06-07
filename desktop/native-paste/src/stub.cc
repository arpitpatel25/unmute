// Non-macOS stub. Lets the JS-side `require()` succeed everywhere and
// surface a uniform "unsupported platform" result instead of throwing.

#include <napi.h>

Napi::Value IsAccessibilityTrusted(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), false);
}

Napi::Value PostCmdV(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("ok", Napi::Boolean::New(env, false));
  out.Set("stepFailed", Napi::String::New(env, "platform"));
  out.Set("error", Napi::String::New(env,
    "native-paste is macOS-only"));
  return out;
}

Napi::Value ProcessInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object out = Napi::Object::New(env);
  out.Set("pid", Napi::Number::New(env, (double)0));
  return out;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isAccessibilityTrusted",
              Napi::Function::New(env, IsAccessibilityTrusted));
  exports.Set("postCmdV", Napi::Function::New(env, PostCmdV));
  exports.Set("processInfo", Napi::Function::New(env, ProcessInfo));
  return exports;
}

NODE_API_MODULE(native_paste, Init)
