// Model contract and vocabulary for the ChordMini network. Runtimes
// (onnxruntime-web in the browser, onnxruntime-node in the harness) implement
// ChordModel; nothing in the engine depends on a specific runtime or device.
import { type Chord, parseChord } from './theory';

export const SEQ_LEN = 108; // frames per model window (~10 s)
export const N_BINS = 144;
export const N_CLASSES = 170;
export const SAMPLE_RATE = 22050;
export const HOP = 2048;
export const FRAME_SECONDS = HOP / SAMPLE_RATE; // ~92.9 ms
export const SMOOTHING_KERNEL = 9;

export interface ChordModel {
  /** Fixed number of windows per run (the shipped export is static at 16). */
  readonly batch: number;
  /**
   * features: [batch][SEQ_LEN][N_BINS] unnormalised log-CQT (normalisation is in the graph).
   * returns logits: [batch][SEQ_LEN][N_CLASSES].
   */
  run(features: Float32Array): Promise<Float32Array>;
}

export type ModelConfig = {
  chordVocab: string[];
  seqLen: number;
  nBins: number;
  numChords: number;
  sampleRate: number;
  hopLength: number;
  smoothingKernel: number;
};

export type Vocabulary = {
  labels: string[];
  chords: Chord[];
};

export const loadVocabulary = (config: ModelConfig): Vocabulary => {
  const mismatch =
    config.seqLen !== SEQ_LEN ||
    config.nBins !== N_BINS ||
    config.numChords !== N_CLASSES ||
    config.sampleRate !== SAMPLE_RATE ||
    config.hopLength !== HOP ||
    config.chordVocab.length !== N_CLASSES;
  if (mismatch) throw new Error('Model config does not match the engine constants');
  return { labels: config.chordVocab, chords: config.chordVocab.map(parseChord) };
};
