// Classic DSP chord recognition: fold the ChordMini CQT (C1..B6, 24 bins per
// octave) into treble and bass chroma, score binary chord templates and decode
// a sticky HMM. No model, about a millisecond per frame.
import { computeCqt, type CqtPlan } from '../cqt';
import { HOP, N_BINS, type Vocabulary } from '../model';
import { type ChordScheme, type SampleReader, type WindowRequest } from '../scheme';
import { CQT_MARGIN_FRAMES } from './chordmini';
import { defaultTemplateOptions, normaliseMax, type PitchProfile, TemplateDecoder, type TemplateOptions } from './templates';

/** Frames of history the HMM sees in streaming mode (~2.2 s). */
export const CHROMA_CONTEXT_FRAMES = 24;

const SEMITONES = N_BINS / 2; // 72: C1..B6
const BASS_RANGE: [number, number] = [4, 28]; // E1..E3
const TREBLE_FROM = 12; // C2 upwards

export type ChromaOptions = {
  /** Fraction of a note's level removed from the octave above (2nd harmonic). */
  harmonicSuppression: number;
  /** Fraction removed from the twelfth above (3rd harmonic: C -> G, E -> B). */
  thirdHarmonicSuppression: number;
  /** Log compression strength applied to max-normalised semitone levels. */
  compression: number;
  template: TemplateOptions;
};

export const defaultChromaOptions: ChromaOptions = {
  harmonicSuppression: 0.4,
  thirdHarmonicSuppression: 0.25,
  compression: 20,
  template: { ...defaultTemplateOptions },
};

/** Converts one CQT frame (log or linear magnitudes) into pitch-class profiles. */
export const cqtFrameToProfile = (frame: Float32Array, logInput: boolean, options: ChromaOptions): PitchProfile => {
  const mag = new Float64Array(N_BINS);
  for (let b = 0; b < N_BINS; b++) mag[b] = logInput ? Math.max(0, Math.exp(frame[b]) - 1e-6) : frame[b];
  // Semitone levels from the on-pitch bins only. Folding in the quarter-tone
  // bins leaks a strong root into the semitone below and turns most triads
  // into maj7 / minmaj7 (synthetic set: exact accuracy 15% -> 92%).
  const semis = new Float64Array(SEMITONES);
  let energy = 0;
  for (let s = 0; s < SEMITONES; s++) {
    semis[s] = mag[2 * s];
    energy += semis[s];
  }
  energy /= SEMITONES;
  // Crude harmonic suppression: a note's 2nd and 3rd partials land 12 and 19
  // semitones higher and otherwise read as extra chord tones (C -> G, E -> B).
  const h2 = options.harmonicSuppression;
  const h3 = options.thirdHarmonicSuppression;
  const clean = new Float64Array(SEMITONES);
  for (let s = 0; s < SEMITONES; s++) {
    const below = h2 * (s >= 12 ? semis[s - 12] : 0) + h3 * (s >= 19 ? semis[s - 19] : 0);
    clean[s] = Math.max(0, semis[s] - below);
  }
  let max = 0;
  for (const v of clean) max = Math.max(max, v);
  const treble = new Float64Array(12);
  const bass = new Float64Array(12);
  if (max > 0) {
    for (let s = 0; s < SEMITONES; s++) {
      const v = Math.log1p((options.compression * clean[s]) / max);
      if (s >= TREBLE_FROM) treble[s % 12] += v;
      if (s >= BASS_RANGE[0] && s < BASS_RANGE[1]) bass[s % 12] += v;
    }
  }
  return { treble, bass: normaliseMax(bass), energy };
};

export class ChromaScheme implements ChordScheme {
  readonly id = 'chroma' as const;
  readonly batch = 1;
  readonly historySamples = (CHROMA_CONTEXT_FRAMES + CQT_MARGIN_FRAMES + 2) * HOP;
  private readonly decoder: TemplateDecoder;

  constructor(
    readonly plan: CqtPlan,
    readonly vocab: Vocabulary,
    readonly options: ChromaOptions = defaultChromaOptions,
  ) {
    this.decoder = new TemplateDecoder(vocab, options.template);
  }

  private profiles(samples: Float32Array, fromFrame = 0): PitchProfile[] {
    const { frameCount, data } = computeCqt(samples, this.plan);
    const out: PitchProfile[] = [];
    for (let f = fromFrame; f < frameCount; f++) {
      out.push(cqtFrameToProfile(data.subarray(f * N_BINS, (f + 1) * N_BINS), this.plan.logOutput, this.options));
    }
    return out;
  }

  async analyzeWindows(read: SampleReader, windows: WindowRequest[], lookaheads: number[]): Promise<Float64Array[][]> {
    return windows.map(({ endFrame, availableEnd }) => {
      const firstFrame = endFrame - (CHROMA_CONTEXT_FRAMES - 1);
      const segment = read((firstFrame - CQT_MARGIN_FRAMES) * HOP, availableEnd);
      const frames = this.profiles(segment, CQT_MARGIN_FRAMES).slice(0, CHROMA_CONTEXT_FRAMES);
      const last = frames.length - 1;
      return this.decoder.posteriors(
        frames,
        lookaheads.map((l) => last - l),
      );
    });
  }

  async analyzeSong(samples: Float32Array): Promise<Float64Array[]> {
    const frames = this.profiles(samples);
    return this.decoder.posteriors(
      frames,
      frames.map((_, i) => i),
    );
  }
}
