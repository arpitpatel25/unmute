// unmute-native-audio-tap — background macOS system-audio capture via Core
// Audio Process Taps, in-process.
//
// Loaded in-process (not a spawned child) from Electron's main process for
// the same TCC-identity reason as native-ax and native-fn-listener: a
// spawned child binary gets its own bundle identity and the "System Audio
// Recording Only" TCC grant the user approves for the signed .app would not
// apply to it.
//
// API surface confirmed against the macOS 26.2 SDK (targets 14.2+):
//   CATapDescription            — CoreAudio.framework/Headers/CATapDescription.h
//   AudioHardwareCreateProcessTap — .../AudioHardwareTapping.h
//   kAudioAggregateDeviceTapListKey / kAudioSubTapUIDKey / kAudioSubTapDriftCompensationKey
//                                — .../AudioHardware.h
//   kAudioHardwarePropertyTranslatePIDToProcessObject
//                                — .../AudioHardware.h (pid_t -> AudioObjectID)

#include <napi.h>
#import <Cocoa/Cocoa.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <mach/mach_time.h>
#include <string>
#include <atomic>
#include <mutex>

namespace {

AudioObjectID gTapID = kAudioObjectUnknown;
AudioObjectID gAggregateDeviceID = kAudioObjectUnknown;
AudioDeviceIOProcID gIOProcID = nullptr;
Napi::ThreadSafeFunction gTSFN;
std::atomic<bool> gCapturing{false};

/** Resolves a pid_t to its Core Audio "process object" AudioObjectID. */
AudioObjectID ProcessObjectForPID(pid_t pid) {
  AudioObjectID processObjectID = kAudioObjectUnknown;
  UInt32 dataSize = sizeof(processObjectID);
  AudioObjectPropertyAddress address = {
    kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyElementMain
  };
  OSStatus status = AudioObjectGetPropertyData(
    kAudioObjectSystemObject, &address, sizeof(pid), &pid, &dataSize, &processObjectID);
  if (status != noErr) return kAudioObjectUnknown;
  return processObjectID;
}

OSStatus TapIOProc(AudioObjectID inDevice,
                    const AudioTimeStamp* inNow,
                    const AudioBufferList* inInputData,
                    const AudioTimeStamp* inInputTime,
                    AudioBufferList* outOutputData,
                    const AudioTimeStamp* inOutputTime,
                    void* inClientData) {
  (void)inDevice; (void)inNow; (void)outOutputData;
  if (!gCapturing.load() || inInputData == nullptr || inInputData->mNumberBuffers == 0) return noErr;

  const AudioBuffer& buffer = inInputData->mBuffers[0];
  if (buffer.mData == nullptr || buffer.mDataByteSize == 0) return noErr;

  const size_t sampleCount = buffer.mDataByteSize / sizeof(float);
  auto* samplesCopy = new float[sampleCount];
  memcpy(samplesCopy, buffer.mData, buffer.mDataByteSize);

  // mHostTime is in mach absolute-time units; convert to wall-clock ms via
  // the host's timebase so JS gets an ordinary epoch-relative timestamp
  // comparable to the mic stream's Date.now()-based timestamps.
  static mach_timebase_info_data_t timebase = {0, 0};
  if (timebase.denom == 0) mach_timebase_info(&timebase);
  const double machNowNs = (double)inInputTime->mHostTime * timebase.numer / timebase.denom;
  const double machNowMs = machNowNs / 1e6;
  const double wallNowMs = (double)([[NSDate date] timeIntervalSince1970] * 1000.0);
  const double timestampMs = wallNowMs - ((double)mach_absolute_time() * timebase.numer / timebase.denom / 1e6 - machNowMs);

  struct ChunkData { float* samples; size_t count; double sampleRate; double timestampMs; };
  auto* chunk = new ChunkData{samplesCopy, sampleCount, buffer.mDataByteSize > 0 ? 48000.0 : 0.0, timestampMs};

  gTSFN.NonBlockingCall(chunk, [](Napi::Env env, Napi::Function jsCallback, ChunkData* data) {
    Napi::Float32Array samples = Napi::Float32Array::New(env, data->count);
    memcpy(samples.Data(), data->samples, data->count * sizeof(float));
    Napi::Object chunkObj = Napi::Object::New(env);
    chunkObj.Set("samples", samples);
    chunkObj.Set("sampleRate", Napi::Number::New(env, data->sampleRate));
    chunkObj.Set("timestampMs", Napi::Number::New(env, data->timestampMs));
    jsCallback.Call({chunkObj});
    delete[] data->samples;
    delete data;
  });

  return noErr;
}

void TeardownLocked() {
  if (gIOProcID != nullptr && gAggregateDeviceID != kAudioObjectUnknown) {
    AudioDeviceStop(gAggregateDeviceID, gIOProcID);
    AudioDeviceDestroyIOProcID(gAggregateDeviceID, gIOProcID);
    gIOProcID = nullptr;
  }
  if (gAggregateDeviceID != kAudioObjectUnknown) {
    AudioHardwareDestroyAggregateDevice(gAggregateDeviceID);
    gAggregateDeviceID = kAudioObjectUnknown;
  }
  if (gTapID != kAudioObjectUnknown) {
    AudioHardwareDestroyProcessTap(gTapID);
    gTapID = kAudioObjectUnknown;
  }
  gCapturing.store(false);
}

} // namespace

/** pidForBundleId(bundleId: string) -> number | null */
Napi::Value PidForBundleId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "pidForBundleId(bundleId: string)").ThrowAsJavaScriptException();
    return env.Null();
  }
  std::string bundleId = info[0].As<Napi::String>().Utf8Value();
  NSArray<NSRunningApplication*>* apps = [[NSWorkspace sharedWorkspace] runningApplications];
  for (NSRunningApplication* app in apps) {
    if (app.bundleIdentifier != nil &&
        [app.bundleIdentifier isEqualToString:[NSString stringWithUTF8String:bundleId.c_str()]]) {
      return Napi::Number::New(env, (double)app.processIdentifier);
    }
  }
  return env.Null();
}

/** startCapture(pid: number, onChunk: (chunk) => void): void */
Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (gCapturing.load()) {
    Napi::Error::New(env, "capture already in progress — call stopCapture() first").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
    Napi::TypeError::New(env, "startCapture(pid: number, onChunk: (chunk) => void)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  pid_t targetPID = (pid_t)info[0].As<Napi::Number>().Int32Value();
  AudioObjectID processObjectID = ProcessObjectForPID(targetPID);
  if (processObjectID == kAudioObjectUnknown) {
    Napi::Error::New(env, "no Core Audio process object for that PID (process may not be producing audio yet)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  CATapDescription* tapDescription =
      [[CATapDescription alloc] initStereoMixdownOfProcesses:@[ @(processObjectID) ]];
  tapDescription.name = @"UnmuteNotetakerTap";
  tapDescription.muteBehavior = CATapUnmuted; // spec §2: the user's other audio keeps playing normally
  tapDescription.privateTap = YES;

  OSStatus status = AudioHardwareCreateProcessTap(tapDescription, &gTapID);
  if (status != noErr) {
    Napi::Error::New(env, "AudioHardwareCreateProcessTap failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  NSDictionary* aggregateDescription = @{
    @(kAudioAggregateDeviceNameKey) : @"Unmute Notetaker Aggregate",
    @(kAudioAggregateDeviceUIDKey) : [[NSUUID UUID] UUIDString],
    @(kAudioAggregateDeviceIsPrivateKey) : @YES,
    @(kAudioAggregateDeviceTapAutoStartKey) : @YES,
    @(kAudioAggregateDeviceSubDeviceListKey) : @[],
    @(kAudioAggregateDeviceTapListKey) : @[ @{
      @(kAudioSubTapUIDKey) : tapDescription.UUID.UUIDString,
      @(kAudioSubTapDriftCompensationKey) : @YES,
    } ],
  };

  status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregateDescription, &gAggregateDeviceID);
  if (status != noErr) {
    AudioHardwareDestroyProcessTap(gTapID);
    gTapID = kAudioObjectUnknown;
    Napi::Error::New(env, "AudioHardwareCreateAggregateDevice failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  gTSFN = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "NotetakerAudioChunk", 0, 1);

  status = AudioDeviceCreateIOProcID(gAggregateDeviceID, TapIOProc, nullptr, &gIOProcID);
  if (status != noErr) {
    TeardownLocked();
    Napi::Error::New(env, "AudioDeviceCreateIOProcID failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // This is the call that actually triggers the "System Audio Recording
  // Only" TCC prompt on first use (spec §8) — there is no separate
  // requestAuthorization-style API.
  status = AudioDeviceStart(gAggregateDeviceID, gIOProcID);
  if (status != noErr) {
    TeardownLocked();
    Napi::Error::New(env, "AudioDeviceStart failed, OSStatus=" + std::to_string(status)).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  gCapturing.store(true);
  return env.Undefined();
}

/** stopCapture(): void */
Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  TeardownLocked();
  if (gTSFN != nullptr) {
    gTSFN.Release();
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("pidForBundleId", Napi::Function::New(env, PidForBundleId));
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  return exports;
}

NODE_API_MODULE(native_audio_tap, Init)
