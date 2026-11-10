// ChordModel backed by onnxruntime-web, one backend per worker (each worker
// has its own runtime, so preloading WebGPU never stalls WASM inference).
import * as ort from 'onnxruntime-web';
import { decodeCqtPlan, type CqtPlan } from '../engine/cqt';
import { type ChordModel, loadVocabulary, type ModelConfig, N_BINS, SEQ_LEN, type Vocabulary } from '../engine/model';
import { type Backend } from './protocol';

const BATCH = 16; // the shipped export is static at 16 windows per run

export type WebAssets = { modelBytes: Uint8Array; plan: CqtPlan; vocab: Vocabulary; threads: number };

export const fetchBytes = async (base: string, name: string): Promise<Uint8Array> => {
  const response = await fetch(new URL(name, base));
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} (did you run "npm run setup"?)`);
  return new Uint8Array(await response.arrayBuffer());
};

/** modelBase: absolute URL of the model folder (resolved by the page, since the worker lives under assets/). */
export const loadWebAssets = async (modelBase: string, backend: Backend): Promise<WebAssets> => {
  // The WASM runtime is resolved and bundled by Vite from node_modules.
  // Multi-threaded WASM needs cross-origin isolation (set by the dev server).
  // The WebGPU worker only needs CPU threads for the odd unsupported op.
  const threads = self.crossOriginIsolated && backend === 'wasm' ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.numThreads = threads;
  const [modelBytes, planBytes, configBytes] = await Promise.all([
    fetchBytes(modelBase, 'chordnet.onnx'),
    fetchBytes(modelBase, 'cqt-plan.bin'),
    fetchBytes(modelBase, 'config.json'),
  ]);
  const config = JSON.parse(new TextDecoder().decode(configBytes)) as ModelConfig;
  return { modelBytes, plan: decodeCqtPlan(planBytes), vocab: loadVocabulary(config), threads };
};

export const webGpuAvailable = (): boolean => 'gpu' in navigator && !!(navigator as { gpu?: unknown }).gpu;

/**
 * Creates a session for exactly one backend. No silent WASM fallback for
 * WebGPU: if WebGPU can't run the model, this rejects and the UI says so.
 */
export const createSession = async (bytes: Uint8Array, backend: Backend): Promise<ort.InferenceSession> => {
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
  });
  // Warm-up run: the first WebGPU run compiles shaders (seconds), which would
  // otherwise stall the first live update after switching.
  if (backend === 'webgpu') await session.run({ features: new ort.Tensor('float32', new Float32Array(BATCH * SEQ_LEN * N_BINS), [BATCH, SEQ_LEN, N_BINS]) });
  return session;
};

export class WebModel implements ChordModel {
  readonly batch = BATCH;
  constructor(private readonly session: ort.InferenceSession) {}

  async run(features: Float32Array): Promise<Float32Array> {
    const result = await this.session.run({ features: new ort.Tensor('float32', features, [BATCH, SEQ_LEN, N_BINS]) });
    return (await result.logits.getData()) as Float32Array;
  }
}
