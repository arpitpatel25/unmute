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
//   proc_listallpids / proc_pidpath
//                                — <libproc.h> (public, no entitlement needed)
//                                  used to find a multi-process app's sibling
//                                  pids (e.g. Chrome's helper subprocesses) —
//                                  see PidsForSameApp below.

#include <napi.h>
#import <Cocoa/Cocoa.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <mach/mach_time.h>
#include <libproc.h>
#include <string>
#include <atomic>
#include <mutex>
#include <vector>
#include <algorithm>
#include <cstring>

namespace {

AudioObjectID gTapID = kAudioObjectUnknown;
AudioObjectID gAggregateDeviceID = kAudioObjectUnknown;
AudioDeviceIOProcID gIOProcID = nullptr;
Napi::ThreadSafeFunction gTSFN;
std::atomic<bool> gCapturing{false};

/** The aggregate device's REAL sample rate, queried once per capture session
 *  in StartCapture. Was hardcoded to 48000.0, which is merely the common
 *  case — a device running at 44.1k would have had every chunk mislabelled. */
double gSampleRate = 48000.0;

/** mach_absolute_time() -> Unix-epoch-milliseconds offset, and the host
 *  timebase, both computed ONCE in StartCapture.
 *
 *  WHY NOT PER-CALLBACK: TapIOProc runs on a Core Audio REAL-TIME IO thread,
 *  which has no autorelease pool, and this file is built without ARC (matching
 *  native-ax's binding.gyp). The previous `[[NSDate date] timeIntervalSince1970]`
 *  in the callback therefore leaked one autoreleased NSDate per callback —
 *  ~90-100 leaks/second for the whole capture — on top of doing objc_msgSend
 *  work on a latency-critical thread. Caching the offset also removes the
 *  per-callback mach_absolute_time() re-derivation, which added its own drift:
 *  the timestamp is now a pure affine function of the buffer's own mHostTime. */
double gMachToWallOffsetMs = 0.0;
mach_timebase_info_data_t gTimebase = {0, 0};

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

/**
 * Every currently-running pid whose executable lives inside the SAME .app
 * bundle as targetPid — e.g. Chrome's main process together with its GPU,
 * renderer, and helper subprocesses.
 *
 * WHY THIS EXISTS: initStereoMixdownOfProcesses only captures audio actually
 * EMITTED by the given process object(s). A single resolved "target pid" (the
 * frontmost app's main process, as resolved by native-ax) is correct for a
 * single-process app, but Chrome (like every modern Chromium-family browser)
 * never emits audio from its own main process — real output happens in a
 * "Google Chrome Helper (Renderer)" or similar helper subprocess, one per
 * tab/site under Chrome's site-isolation model. Tapping only the main pid
 * therefore installs a real, error-free tap on a process that produces
 * nothing: no OSStatus ever fails, gCapturing is true, and the IOProc simply
 * never fires — which is exactly the "capture starts cleanly, zero chunks
 * ever" symptom this fix addresses. Confirmed empirically (ps -eo pid,comm):
 * every Chrome-family pid's executable path is rooted at the identical
 * "/Applications/Google Chrome.app" prefix, which is what this function
 * matches on.
 *
 * Uses only public libproc.h calls (proc_listallpids/proc_pidpath) — no
 * private API. Falls back to {targetPid} alone if the bundle root can't be
 * determined (proc_pidpath failure, or a bare non-bundled CLI process),
 * which preserves today's single-process behavior for anything that isn't
 * shaped like a browser.
 */
std::vector<pid_t> PidsForSameApp(pid_t targetPid) {
  std::vector<pid_t> fallback{targetPid};

  char targetPath[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(targetPid, targetPath, sizeof(targetPath)) <= 0) return fallback;

  std::string targetPathStr(targetPath);
  size_t appPos = targetPathStr.rfind(".app/");
  if (appPos == std::string::npos) return fallback; // not inside a bundle at all
  std::string bundleRoot = targetPathStr.substr(0, appPos + 4); // include the ".app" itself

  int bufferSize = proc_listallpids(nullptr, 0);
  if (bufferSize <= 0) return fallback;
  // Headroom: the process list can legitimately grow between the sizing
  // call above and the real one below.
  std::vector<pid_t> allPids((size_t)bufferSize * 2 / sizeof(pid_t) + 64);
  int writtenBytes = proc_listallpids(allPids.data(), (int)(allPids.size() * sizeof(pid_t)));
  if (writtenBytes <= 0) return fallback;
  size_t pidCount = std::min(allPids.size(), (size_t)writtenBytes / sizeof(pid_t));

  // A pathological process count should never turn this into a stall — cap
  // how many candidates get probed.
  const size_t kMaxCandidates = 2000;
  pidCount = std::min(pidCount, kMaxCandidates);

  std::vector<pid_t> result;
  for (size_t i = 0; i < pidCount; i++) {
    pid_t candidate = allPids[i];
    if (candidate <= 0) continue;
    char candidatePath[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(candidate, candidatePath, sizeof(candidatePath)) <= 0) continue;
    if (strncmp(candidatePath, bundleRoot.c_str(), bundleRoot.size()) == 0) {
      result.push_back(candidate);
    }
  }
  if (result.empty()) return fallback;

  // CATapDescription's mixdown array doesn't need (and shouldn't get)
  // hundreds of entries for an app with an unusual number of helpers.
  const size_t kMaxTapped = 64;
  if (result.size() > kMaxTapped) result.resize(kMaxTapped);
  return result;
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

  // The tap is created with initStereoMixdownOfProcesses, so this buffer is
  // genuinely multi-channel. Report how many channels the samples we are
  // about to hand over actually carry, rather than leaving the consumer to
  // assume mono: interleaved stereo read as mono plays at ~double speed.
  // (When the stream is NON-interleaved, Core Audio gives one buffer PER
  // channel and mNumberChannels is 1 — we read mBuffers[0] only, so 1 is
  // still the honest answer for what `samples` contains.)
  const uint32_t channels = buffer.mNumberChannels > 0 ? buffer.mNumberChannels : 1;

  const size_t sampleCount = buffer.mDataByteSize / sizeof(float);
  auto* samplesCopy = new float[sampleCount];
  memcpy(samplesCopy, buffer.mData, buffer.mDataByteSize);

  // mHostTime is in mach absolute-time units; convert to wall-clock ms via
  // the host's timebase (both the timebase and the epoch offset were cached
  // in StartCapture — see gMachToWallOffsetMs) so JS gets an ordinary
  // epoch-relative timestamp comparable to the mic stream's Date.now()-based
  // timestamps. NO Objective-C, and no allocation, on this real-time thread.
  const double timestampMs =
      gMachToWallOffsetMs +
      ((double)inInputTime->mHostTime * gTimebase.numer / gTimebase.denom / 1e6);

  struct ChunkData { float* samples; size_t count; uint32_t channels; double sampleRate; double timestampMs; };
  auto* chunk = new ChunkData{samplesCopy, sampleCount, channels, gSampleRate, timestampMs};

  gTSFN.NonBlockingCall(chunk, [](Napi::Env env, Napi::Function jsCallback, ChunkData* data) {
    Napi::Float32Array samples = Napi::Float32Array::New(env, data->count);
    memcpy(samples.Data(), data->samples, data->count * sizeof(float));
    Napi::Object chunkObj = Napi::Object::New(env);
    chunkObj.Set("samples", samples);
    chunkObj.Set("sampleRate", Napi::Number::New(env, data->sampleRate));
    chunkObj.Set("channels", Napi::Number::New(env, (double)data->channels));
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
  // Release the ThreadSafeFunction here too so every path that tears down
  // the Core Audio objects (both StartCapture's own failure branches and
  // StopCapture) also releases gTSFN — a caller can't reach a cleanup path
  // that forgets it. Napi::ThreadSafeFunction::Release() does not clear the
  // wrapper's internal handle itself, so gTSFN is explicitly reset to a
  // fresh (null) instance afterward; that keeps the `gTSFN != nullptr`
  // check further down (in StopCapture, left untouched) false, which is
  // what prevents a double Release() there.
  if (gTSFN != nullptr) {
    gTSFN.Release();
    gTSFN = Napi::ThreadSafeFunction();
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

/** startCapture(pid: number, onChunk: (chunk) => void): { tappedPids: number[], candidatePidCount: number } */
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

  // Tap every process sharing the target's .app bundle, not just the
  // resolved pid itself — see PidsForSameApp's comment for why a
  // single-pid tap silently captures nothing for Chrome and every other
  // multi-process browser.
  std::vector<pid_t> candidatePids = PidsForSameApp(targetPID);
  std::vector<AudioObjectID> processObjects;
  std::vector<pid_t> tappedPids;
  for (pid_t candidate : candidatePids) {
    AudioObjectID obj = ProcessObjectForPID(candidate);
    if (obj != kAudioObjectUnknown) {
      processObjects.push_back(obj);
      tappedPids.push_back(candidate);
    }
  }
  if (processObjects.empty()) {
    Napi::Error::New(env, "no Core Audio process object for that PID or any of its sibling processes (app may not be producing audio yet)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  NSMutableArray<NSNumber*>* processObjectNumbers = [NSMutableArray arrayWithCapacity:processObjects.size()];
  for (AudioObjectID obj : processObjects) {
    [processObjectNumbers addObject:@(obj)];
  }

  CATapDescription* tapDescription =
      [[CATapDescription alloc] initStereoMixdownOfProcesses:processObjectNumbers];
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

  // ─── Per-session constants, resolved ONCE, off the real-time thread ───
  //
  // Everything TapIOProc needs but must not compute itself. This runs on the
  // JS/main thread (a normal Cocoa context with an autorelease pool), which
  // is exactly why the NSDate call lives here and not in the callback.

  // 1 · The device's REAL sample rate. Ask the aggregate device for its input
  //     stream format; fall back to the nominal rate, then to 48k.
  {
    AudioStreamBasicDescription asbd = {};
    UInt32 asbdSize = sizeof(asbd);
    AudioObjectPropertyAddress formatAddress = {
      kAudioDevicePropertyStreamFormat,
      kAudioObjectPropertyScopeInput,
      kAudioObjectPropertyElementMain
    };
    OSStatus fmtStatus = AudioObjectGetPropertyData(
      gAggregateDeviceID, &formatAddress, 0, nullptr, &asbdSize, &asbd);
    if (fmtStatus == noErr && asbd.mSampleRate > 0.0) {
      gSampleRate = asbd.mSampleRate;
    } else {
      Float64 nominal = 0.0;
      UInt32 nominalSize = sizeof(nominal);
      AudioObjectPropertyAddress rateAddress = {
        kAudioDevicePropertyNominalSampleRate,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
      };
      if (AudioObjectGetPropertyData(gAggregateDeviceID, &rateAddress, 0, nullptr,
                                     &nominalSize, &nominal) == noErr && nominal > 0.0) {
        gSampleRate = nominal;
      } else {
        gSampleRate = 48000.0; // last resort: the overwhelmingly common rate
      }
    }
  }

  // 2 · The mach-time -> wall-clock epoch offset, so TapIOProc can turn a
  //     buffer's mHostTime into an epoch timestamp with pure arithmetic.
  if (gTimebase.denom == 0) mach_timebase_info(&gTimebase);
  {
    const double machNowMs =
        (double)mach_absolute_time() * gTimebase.numer / gTimebase.denom / 1e6;
    const double wallNowMs = (double)([[NSDate date] timeIntervalSince1970] * 1000.0);
    gMachToWallOffsetMs = wallNowMs - machNowMs;
  }

  // Defensive: gTSFN should always be null here (TeardownLocked releases
  // and resets it on every failure/stop path below), but guard against
  // overwriting a still-populated handle from any future code path that
  // might otherwise skip that cleanup — reassigning gTSFN without
  // releasing the old one first would leak a ThreadSafeFunction.
  if (gTSFN != nullptr) {
    gTSFN.Release();
    gTSFN = Napi::ThreadSafeFunction();
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

  // Diagnostics, not just success/failure — startCapture() throwing tells
  // the caller "capture never began," but every OSStatus above can also
  // succeed while tapping a set of processes that never actually emits
  // audio (the exact "clean start, zero chunks" failure mode this whole
  // multi-pid change exists to fix). Surfacing which pids actually got a
  // valid Core Audio process object lets the JS layer log something a
  // human can act on, instead of silence.
  Napi::Object result = Napi::Object::New(env);
  Napi::Array tappedArray = Napi::Array::New(env, tappedPids.size());
  for (size_t i = 0; i < tappedPids.size(); i++) {
    tappedArray.Set((uint32_t)i, Napi::Number::New(env, (double)tappedPids[i]));
  }
  result.Set("tappedPids", tappedArray);
  result.Set("candidatePidCount", Napi::Number::New(env, (double)candidatePids.size()));
  return result;
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
