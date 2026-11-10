// Basic Pitch NoteModel on TensorFlow.js (WASM backend), shared by the browser
// worker and the Node harness. Callers set up the backend first (wasm file
// locations differ between Vite and Node).
import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import '@tensorflow/tfjs-backend-wasm';
import { BP_FRAMES, BP_NOTES, BP_WINDOW, type NoteModel } from '../engine/schemes/basic-pitch';

/** Output holding note (frame) activations; the others are onsets and pitch contours. */
const NOTES_OUTPUT = 'Identity_1';

type ModelJson = {
  modelTopology: unknown;
  weightsManifest: { weights: tf.io.WeightsManifestEntry[] }[];
};

export const useTfWasm = async (): Promise<string> => {
  await tf.setBackend('wasm');
  await tf.ready();
  return tf.getBackend();
};

export const createTfjsNoteModel = async (modelJson: ModelJson, weights: ArrayBuffer, batch = 8): Promise<NoteModel> => {
  const graph = await loadGraphModel(
    tf.io.fromMemory({
      modelTopology: modelJson.modelTopology as tf.io.ModelJSON['modelTopology'],
      weightSpecs: modelJson.weightsManifest.flatMap((g) => g.weights),
      weightData: weights,
    }),
  );
  return {
    batch,
    run: async (audio, n) => {
      const input = tf.tensor3d(audio, [n, BP_WINDOW, 1]);
      const output = graph.execute(input, NOTES_OUTPUT) as tf.Tensor;
      const data = (await output.data()) as Float32Array;
      input.dispose();
      output.dispose();
      if (data.length !== n * BP_FRAMES * BP_NOTES) throw new Error(`Basic Pitch output has ${data.length} values`);
      return data;
    },
  };
};
