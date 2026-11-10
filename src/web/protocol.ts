// Messages between the UI thread and a detector worker. There is one worker
// per inference backend (each has its own onnxruntime instance, so loading
// one never stalls the other); only the active worker analyses. Every worker
// runs the same detection scheme; switching scheme replaces the workers.
import { type DetectionEvent, type DetectorOptions } from '../engine/detector';
import { type SchemeId } from '../engine/scheme';

export type Backend = 'wasm' | 'webgpu';

export type BackendState = 'loading' | 'ready' | 'unavailable';

export type ToWorker =
  | { type: 'init'; scheme: SchemeId; backend: Backend; active: boolean; options: DetectorOptions; modelsBase: string }
  /** Standby workers keep ingesting audio (so they can take over instantly) but don't analyse. */
  | { type: 'active'; active: boolean }
  | { type: 'options'; options: DetectorOptions }
  | { type: 'audio'; pcm: Float32Array } // 16 kHz mono, already 16-bit quantised
  | { type: 'reset' };

export type FromWorker =
  | { type: 'ready'; backend: Backend; threads: number; loadMs: number }
  | { type: 'unavailable'; backend: Backend; error: string }
  | { type: 'detection'; event: DetectionEvent; backend: Backend }
  | { type: 'error'; message: string };
