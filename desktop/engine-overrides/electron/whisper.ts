// On-device STT is now NVIDIA Parakeet v3 (sherpa-onnx), not whisper.cpp.
//
// This override REPLACES the engine's whisper.ts and re-exports ParakeetManager
// as `whisperManager`. Every existing caller — api.ts pipelineTranscribe's
// on-device fallback (the path real dictations actually take), main.ts, the
// whisper:model-status / whisper:download-model IPC handlers — therefore routes
// to Parakeet with ZERO caller changes. The whisper-server binary is no longer
// started (Parakeet runs in-process via sherpa-onnx).
//
// ParakeetManager exposes the exact interface callers use:
//   transcribe(Buffer)->Promise<string>, isAvailable, isModelReady,
//   isBinaryReady, stopServer, downloadModel (+ startServer/isServerRunning).
export { parakeetManager as whisperManager } from './parakeet'
