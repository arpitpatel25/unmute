#include <napi.h>

Napi::Value NotAvailable(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "native-audio-tap is only available on macOS").ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pidForBundleId", Napi::Function::New(env, NotAvailable));
  exports.Set("startCapture", Napi::Function::New(env, NotAvailable));
  exports.Set("stopCapture", Napi::Function::New(env, NotAvailable));
  return exports;
}

NODE_API_MODULE(native_audio_tap, Init)
