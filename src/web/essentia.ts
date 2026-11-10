// Browser loader for the Essentia scheme. Dev server only: schemes.ts imports
// this file behind __WITH_ESSENTIA__, so production builds drop it entirely.
import { standardVocabulary } from '../engine/scheme';
import { EssentiaScheme } from '../engine/schemes/essentia';
import { essentiaReady } from '../runtime/essentia-ready';
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js';
import Essentia from 'essentia.js/dist/essentia.js-core.es.js';

export const loadEssentiaScheme = async (): Promise<EssentiaScheme> => {
  await essentiaReady(EssentiaWASM);
  return new EssentiaScheme(new Essentia(EssentiaWASM), EssentiaWASM.VectorVectorFloat, standardVocabulary());
};
