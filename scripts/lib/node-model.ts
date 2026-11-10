// Chord schemes for the laptop evaluation harness: ChordMini on
// onnxruntime-node, Basic Pitch on tfjs (WASM), Essentia via essentia.js.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { decodeCqtPlan, type CqtPlan } from '../../src/engine/cqt';
import { type ChordModel, loadVocabulary, type ModelConfig, N_BINS, SEQ_LEN, type Vocabulary } from '../../src/engine/model';
import { type ChordScheme, type SchemeId, standardVocabulary } from '../../src/engine/scheme';
import { BasicPitchScheme } from '../../src/engine/schemes/basic-pitch';
import { ChordMiniScheme } from '../../src/engine/schemes/chordmini';
import { ChromaScheme } from '../../src/engine/schemes/chroma';
import { type EssentiaApi, EssentiaScheme, type VectorVectorCtor } from '../../src/engine/schemes/essentia';
import { essentiaReady } from '../../src/runtime/essentia-ready';

export const MODELS_DIR = join(import.meta.dirname, '../../public/models');
export const MODEL_DIR = join(MODELS_DIR, 'chordmini');

export type LoadedModel = { model: ChordModel; plan: CqtPlan; vocab: Vocabulary };

const missing = (path: string): Error => new Error(`${path} not found (did you run "npm run setup"?)`);
const read = (path: string): Buffer => {
  try {
    return readFileSync(path);
  } catch {
    throw missing(path);
  }
};

export const loadPlan = (): CqtPlan => decodeCqtPlan(new Uint8Array(read(join(MODEL_DIR, 'cqt-plan.bin'))));

export const loadNodeModel = async (threads = 4): Promise<LoadedModel> => {
  ort.env.logLevel = 'error';
  const session = await ort.InferenceSession.create(join(MODEL_DIR, 'chordnet.onnx'), {
    intraOpNumThreads: threads,
    logSeverityLevel: 3,
  });
  const batch = 16;
  const model: ChordModel = {
    batch,
    run: async (features) => {
      const input = new ort.Tensor('float32', features, [batch, SEQ_LEN, N_BINS]);
      const result = await session.run({ features: input });
      return result.logits.data as Float32Array;
    },
  };
  const config = JSON.parse(read(join(MODEL_DIR, 'config.json')).toString('utf8')) as ModelConfig;
  return { model, plan: loadPlan(), vocab: loadVocabulary(config) };
};

export const loadNodeScheme = async (id: SchemeId, threads = 4): Promise<ChordScheme> => {
  switch (id) {
    case 'chordmini': {
      const { model, plan, vocab } = await loadNodeModel(threads);
      return new ChordMiniScheme(model, plan, vocab);
    }
    case 'chroma':
      return new ChromaScheme(loadPlan(), standardVocabulary());
    case 'essentia': {
      const require = createRequire(import.meta.url);
      const { Essentia, EssentiaWASM } = require('essentia.js') as {
        Essentia: new (wasm: unknown) => EssentiaApi;
        EssentiaWASM: { calledRun?: boolean; VectorVectorFloat: VectorVectorCtor };
      };
      await essentiaReady(EssentiaWASM);
      return new EssentiaScheme(new Essentia(EssentiaWASM), EssentiaWASM.VectorVectorFloat, standardVocabulary());
    }
    case 'basicpitch': {
      const { createTfjsNoteModel, useTfWasm } = await import('../../src/runtime/basic-pitch-tfjs');
      await useTfWasm();
      const dir = join(MODELS_DIR, 'basic-pitch');
      const json = JSON.parse(read(join(dir, 'model.json')).toString('utf8'));
      const bin = read(join(dir, 'group1-shard1of1.bin'));
      const weights = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
      return new BasicPitchScheme(await createTfjsNoteModel(json, weights), standardVocabulary());
    }
  }
};
