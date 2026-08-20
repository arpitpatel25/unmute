import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../demo-recorder.js';

class FakeMediaRecorder {
  static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = 'inactive';
    this.listeners = new Map();
  }
  addEventListener(type, listener, options = {}) {
    this.listeners.set(type, { listener, once: options.once });
  }
  emit(type, event = {}) {
    const item = this.listeners.get(type);
    item?.listener(event);
    if (item?.once) this.listeners.delete(type);
  }
  start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }
  stop() {
    this.emit('dataavailable', { data: new Blob(['real-audio'], { type: 'audio/webm' }) });
    this.state = 'inactive';
    this.emit('stop');
  }
}

test('requestPermission asks only for microphone audio', async () => {
  let constraint;
  const stream = { getTracks: () => [] };
  const recorder = createRecorder({
    mediaDevices: { getUserMedia: async (value) => { constraint = value; return stream; } },
    MediaRecorderClass: FakeMediaRecorder,
    now: () => 0
  });

  await recorder.requestPermission();
  assert.deepEqual(constraint, { audio: true, video: false });
});

test('start and stop return the visitor audio with measured duration and release the microphone', async () => {
  let stopped = false;
  let clock = 1000;
  const stream = { getTracks: () => [{ stop: () => { stopped = true; } }] };
  const recorder = createRecorder({
    mediaDevices: { getUserMedia: async () => stream },
    MediaRecorderClass: FakeMediaRecorder,
    now: () => clock
  });

  await recorder.requestPermission();
  await recorder.start();
  clock = 4250;
  const result = await recorder.stop();

  assert.equal(result.blob.type, 'audio/webm');
  assert.ok(result.blob.size > 0);
  assert.equal(result.durationSeconds, 3.25);
  assert.equal(stopped, true);
});

test('unsupported recording APIs produce an actionable error', async () => {
  const recorder = createRecorder({ mediaDevices: undefined, MediaRecorderClass: undefined });
  await assert.rejects(recorder.requestPermission(), /does not support microphone recording/i);
});
