// A chord detection scheme turns audio into per-frame probabilities over the
// shared 170-class vocabulary. Everything downstream (smoothing-free decision
// and fallback, scoring, display, prediction) works on those probabilities, so
// schemes can be swapped without touching the rest of the engine.
//
// All schemes use the same time grid as the ChordMini model: 22.05 kHz audio,
// frame f is centred on sample f * HOP (~93 ms per frame).
import { HOP, N_CLASSES, type Vocabulary } from './model';
import { parseChord, PITCH_NAMES, toVocabLabel } from './theory';

export const SCHEME_IDS = ['chordmini', 'chroma', 'essentia', 'basicpitch'] as const;
export type SchemeId = (typeof SCHEME_IDS)[number];

export const SCHEME_LABELS: Record<SchemeId, string> = {
  chordmini: 'ChordMini (transformer)',
  chroma: 'Chroma templates + HMM',
  essentia: 'Essentia HPCP chords',
  basicpitch: 'Basic Pitch notes → chord',
};

export const isSchemeId = (value: unknown): value is SchemeId => SCHEME_IDS.includes(value as SchemeId);

/** Reads absolute model-rate samples [from, to); outside the available audio is zero. */
export type SampleReader = (from: number, to: number) => Float32Array;

/** One streaming analysis: audio before `availableEnd` is known, `endFrame` is the newest frame. */
export type WindowRequest = { endFrame: number; availableEnd: number };

export interface ChordScheme {
  readonly id: SchemeId;
  readonly vocab: Vocabulary;
  /** Model-rate samples before the end of the audio that a window needs. */
  readonly historySamples: number;
  /** Windows per analyzeWindows call that cost about the same as one (batching). */
  readonly batch: number;
  /**
   * Streaming analysis with a truncated future, exactly as a live system
   * sees it. Returns, per window, one probability vector per lookahead, for
   * frame endFrame - lookahead.
   */
  analyzeWindows(read: SampleReader, windows: WindowRequest[], lookaheads: number[]): Promise<Float64Array[][]>;
  /** Whole song visible (non-causal upper bound). One probability vector per frame. */
  analyzeSong(samples: Float32Array, onProgress?: (done: number, total: number) => void): Promise<Float64Array[]>;
}

/** Frames in a song of `sampleCount` model-rate samples (frame f centred on f * HOP). */
export const songFrameCount = (sampleCount: number): number => Math.floor((sampleCount - 1) / HOP) + 1;

const QUALITY_ORDER = ['min', 'maj', 'dim', 'aug', 'min6', 'maj6', 'min7', 'minmaj7', 'maj7', '7', 'dim7', 'hdim7', 'sus2', 'sus4'];

/**
 * The 170-class vocabulary (12 roots x 14 qualities, X, N) in ChordMini's
 * order, so non-ChordMini schemes don't depend on the model download.
 */
export const standardVocabulary = (): Vocabulary => {
  const labels: string[] = [];
  for (const root of PITCH_NAMES) for (const q of QUALITY_ORDER) labels.push(q === 'maj' ? root : `${root}:${q}`);
  labels.push('X', 'N');
  if (labels.length !== N_CLASSES) throw new Error('vocabulary size mismatch');
  return { labels, chords: labels.map(parseChord) };
};

/** Index of a chord in the vocabulary (by canonical label), or -1. */
export const vocabIndex = (vocab: Vocabulary, label: string): number => {
  const canonical = toVocabLabel(parseChord(label));
  return canonical === undefined ? -1 : vocab.labels.indexOf(canonical);
};

/** Reader over a whole in-memory song (zeros outside it). */
export const arrayReader =
  (samples: Float32Array): SampleReader =>
  (from, to) => {
    const out = new Float32Array(Math.max(0, to - from));
    const a = Math.max(0, from);
    const b = Math.min(samples.length, to);
    if (b > a) out.set(samples.subarray(a, b), a - from);
    return out;
  };
