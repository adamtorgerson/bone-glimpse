// Runs the selected chord detection scheme for one inference backend, off the UI thread. Audio chunks
// arrive as 16 kHz floats; while active, the detector is polled after each
// chunk and results are posted back. While on standby the worker only keeps
// the audio history up to date, so it can take over without a gap.
import { LiveChordDetector } from '../engine/detector';
import { webGpuAvailable } from './ort-model';
import { type Backend, type FromWorker, type ToWorker } from './protocol';
import { loadWebScheme } from './schemes';

let backend: Backend = 'wasm';
let active = false;
let detector: LiveChordDetector | undefined;
const post = (message: FromWorker): void => self.postMessage(message);

let scheduled = false;

// Analysis is deferred to a fresh task so that every audio message already
// queued (e.g. while the previous analysis was running) is ingested first and
// each analysis always uses the newest audio instead of working through a backlog.
const schedule = (): void => {
  if (scheduled || !active) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    void pump();
  }, 0);
};

const pump = async (): Promise<void> => {
  if (!detector || !active) return;
  try {
    const event = await detector.poll();
    if (event) {
      post({ type: 'detection', event, backend });
      schedule(); // more audio may have arrived while busy
    }
  } catch (error) {
    post({ type: 'error', message: String(error) });
  }
};

// Audio that arrives while the model is still loading is buffered, so a
// standby worker has history by the time it's ready.
const early: Float32Array[] = [];

self.onmessage = async (e: MessageEvent<ToWorker>): Promise<void> => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': {
        backend = msg.backend;
        active = msg.active;
        const started = performance.now();
        try {
          if (backend === 'webgpu' && !webGpuAvailable()) throw new Error('this browser has no WebGPU');
          const { scheme, threads } = await loadWebScheme(msg.scheme, msg.modelsBase, backend);
          detector = new LiveChordDetector(scheme, msg.options);
          for (const chunk of early.splice(0)) detector.pushDeviceAudio(chunk);
          post({ type: 'ready', backend, threads, loadMs: performance.now() - started });
          schedule();
        } catch (error) {
          post({ type: 'unavailable', backend, error: error instanceof Error ? error.message : String(error) });
        }
        break;
      }
      case 'active':
        active = msg.active;
        schedule();
        break;
      case 'options':
        if (detector) detector.options = msg.options;
        break;
      case 'reset':
        early.length = 0;
        if (detector) detector = new LiveChordDetector(detector.scheme, detector.options);
        break;
      case 'audio':
        if (detector) detector.pushDeviceAudio(msg.pcm);
        else {
          early.push(msg.pcm);
          // keep at most ~12 s while loading
          while (early.reduce((n, c) => n + c.length, 0) > 16000 * 12) early.shift();
        }
        schedule();
        break;
    }
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
