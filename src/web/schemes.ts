// Loads the selected chord detection scheme inside a detector worker. Only
// ChordMini uses onnxruntime (and so WebGPU); the others run on the CPU and
// their libraries load on demand, so unused schemes cost nothing. Essentia
// (AGPL) exists only on the dev server, see build-flags.d.ts.
import { decodeCqtPlan } from '../engine/cqt';
import { type ChordScheme, type SchemeId, standardVocabulary } from '../engine/scheme';
import { ChordMiniScheme } from '../engine/schemes/chordmini';
import { ChromaScheme } from '../engine/schemes/chroma';
import { createSession, fetchBytes, loadWebAssets, WebModel } from './ort-model';
import { type Backend } from './protocol';

export type LoadedScheme = { scheme: ChordScheme; threads: number };

/** modelsBase: absolute URL of public/models/ (resolved by the page). */
export const loadWebScheme = async (id: SchemeId, modelsBase: string, backend: Backend): Promise<LoadedScheme> => {
  if (id !== 'chordmini' && backend !== 'wasm') throw new Error('only ChordMini runs on WebGPU');
  switch (id) {
    case 'chordmini': {
      const base = new URL('chordmini/', modelsBase).href;
      const assets = await loadWebAssets(base, backend);
      const scheme = new ChordMiniScheme(new WebModel(await createSession(assets.modelBytes, backend)), assets.plan, assets.vocab);
      return { scheme, threads: assets.threads };
    }
    case 'chroma': {
      const plan = decodeCqtPlan(await fetchBytes(new URL('chordmini/', modelsBase).href, 'cqt-plan.bin'));
      return { scheme: new ChromaScheme(plan, standardVocabulary()), threads: 1 };
    }
    case 'essentia': {
      // A compile-time constant: `vite build` removes this import and the chunk.
      if (__WITH_ESSENTIA__) {
        const { loadEssentiaScheme } = await import('./essentia');
        return { scheme: await loadEssentiaScheme(), threads: 1 };
      }
      throw new Error('Essentia is only available on the dev server (AGPL-3.0)');
    }
    case 'basicpitch': {
      const [{ setupTfWasm }, { createTfjsNoteModel }, { BasicPitchScheme }] = await Promise.all([
        import('./tf-wasm'),
        import('../runtime/basic-pitch-tfjs'),
        import('../engine/schemes/basic-pitch'),
      ]);
      const threads = await setupTfWasm();
      const base = new URL('basic-pitch/', modelsBase).href;
      const [json, weights] = await Promise.all([fetchBytes(base, 'model.json'), fetchBytes(base, 'group1-shard1of1.bin')]);
      const model = await createTfjsNoteModel(JSON.parse(new TextDecoder().decode(json)), weights.slice().buffer, 1);
      return { scheme: new BasicPitchScheme(model, standardVocabulary()), threads };
    }
  }
};
