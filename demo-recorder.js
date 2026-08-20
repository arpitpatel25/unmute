const UNSUPPORTED_MESSAGE = 'This browser does not support microphone recording. Try the latest Chrome or Safari.';

export function createRecorder({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderClass = globalThis.MediaRecorder,
  now = () => globalThis.performance?.now?.() ?? Date.now()
} = {}) {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;

  function assertSupport() {
    if (!mediaDevices?.getUserMedia || !MediaRecorderClass) throw new Error(UNSUPPORTED_MESSAGE);
  }

  async function requestPermission() {
    assertSupport();
    if (!stream) stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    return stream;
  }

  async function start() {
    assertSupport();
    const activeStream = await requestPermission();
    const preferred = 'audio/webm;codecs=opus';
    const supportsPreferred = typeof MediaRecorderClass.isTypeSupported !== 'function'
      || MediaRecorderClass.isTypeSupported(preferred);
    recorder = new MediaRecorderClass(activeStream, supportsPreferred ? { mimeType: preferred } : undefined);
    chunks = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    startedAt = now();
    recorder.start(250);
  }

  function stopTracks() {
    stream?.getTracks?.().forEach((track) => track.stop());
    stream = null;
  }

  async function stop() {
    if (!recorder || recorder.state !== 'recording') throw new Error('No microphone recording is active.');
    const durationSeconds = Math.max(0, (now() - startedAt) / 1000);
    return new Promise((resolve, reject) => {
      recorder.addEventListener('stop', () => {
        const type = chunks[0]?.type || recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type: type.split(';')[0] });
        recorder = null;
        stopTracks();
        if (!blob.size) {
          reject(new Error('No audio was recorded. Try again.'));
          return;
        }
        resolve({ blob, durationSeconds });
      }, { once: true });
      recorder.addEventListener('error', () => {
        recorder = null;
        stopTracks();
        reject(new Error('The microphone recording failed. Try again.'));
      }, { once: true });
      recorder.stop();
    });
  }

  function cancel() {
    if (recorder?.state === 'recording') recorder.stop();
    recorder = null;
    chunks = [];
    stopTracks();
  }

  return { requestPermission, start, stop, cancel };
}
