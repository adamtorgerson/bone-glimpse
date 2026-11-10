// ChordModel backed by onnxruntime-node, for the laptop evaluation harness.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { decodeCqtPlan, type CqtPlan } from '../../src/engine/cqt';
import { type ChordModel, loadVocabulary, type ModelConfig, N_BINS, SEQ_LEN, type Vocabulary } from '../../src/engine/model';

export const MODEL_DIR = join(import.meta.dirname, '../../public/models/chordmini');

export type LoadedModel = { model: ChordModel; plan: CqtPlan; vocab: Vocabulary };

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
  const plan = decodeCqtPlan(new Uint8Array(readFileSync(join(MODEL_DIR, 'cqt-plan.bin'))));
  const config = JSON.parse(readFileSync(join(MODEL_DIR, 'config.json'), 'utf8')) as ModelConfig;
  return { model, plan, vocab: loadVocabulary(config) };
};
