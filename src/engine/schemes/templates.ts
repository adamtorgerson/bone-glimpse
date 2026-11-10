// Shared back end for the "features -> chord" schemes (chroma, Basic Pitch):
// per-frame pitch-class profiles are scored against binary chord templates,
// then an HMM (sticky self-transition) is decoded with forward-backward over
// the frames available, giving a posterior over the 170 classes.
//
// Emission score for chord c at a frame:
//   cos(treble chroma, template_c) + bassWeight * bass[root_c] + prior(quality)
// "N" scores a constant, plus a bonus when the frame is near silent.
import { N_CLASSES, type Vocabulary } from '../model';
import { QUALITY_INTERVALS } from '../theory';

/** One frame of features: 12-bin pitch-class profiles (index 0 = C). */
export type PitchProfile = {
  treble: Float64Array;
  /** Low-register profile, normalised to max 1 (or all zero). */
  bass: Float64Array;
  /** Loudness-like level used for the silence gate (scheme specific scale). */
  energy: number;
};

export type TemplateOptions = {
  /** Sharpness of the emission distribution (log-likelihood per unit score). */
  beta: number;
  /** Probability of staying on the same chord from one frame to the next. */
  selfTransition: number;
  bassWeight: number;
  /** Score of "no chord" for a frame that isn't silent. */
  noChordScore: number;
  /** Frames with energy below this are treated as silence. */
  silenceEnergy: number;
  /** Additive score per quality: favours common triads/7ths over rarer chords. */
  qualityPrior: Record<string, number>;
};

export const defaultTemplateOptions: TemplateOptions = {
  beta: 25,
  selfTransition: 0.93,
  bassWeight: 0.15,
  noChordScore: 0.55,
  silenceEnergy: 1e-3,
  qualityPrior: {
    maj: 0, min: 0, '7': -0.02, min7: -0.02, maj7: -0.03, dim: -0.06, aug: -0.08, maj6: -0.05, min6: -0.05,
    minmaj7: -0.08, dim7: -0.06, hdim7: -0.05, sus2: -0.06, sus4: -0.05,
  },
};

type Template = { kind: 'chord'; root: number; weights: Float64Array; prior: number } | { kind: 'none' } | { kind: 'unknown' };

export class TemplateDecoder {
  private readonly templates: Template[];

  constructor(
    readonly vocab: Vocabulary,
    readonly options: TemplateOptions = defaultTemplateOptions,
  ) {
    this.templates = vocab.chords.map((chord) => {
      if (chord.kind !== 'chord') return { kind: chord.kind };
      const weights = new Float64Array(12);
      for (const iv of QUALITY_INTERVALS[chord.quality] ?? [0]) weights[(chord.root + iv) % 12] = 1;
      let norm = 0;
      for (const w of weights) norm += w * w;
      norm = Math.sqrt(norm);
      for (let i = 0; i < 12; i++) weights[i] /= norm;
      return { kind: 'chord', root: chord.root, weights, prior: options.qualityPrior[chord.quality] ?? -0.1 };
    });
  }

  /** Emission scores (not yet exponentiated) for one frame. */
  scores(frame: PitchProfile): Float64Array {
    const { treble, bass } = frame;
    let norm = 0;
    for (const v of treble) norm += v * v;
    norm = Math.sqrt(norm);
    const silent = frame.energy < this.options.silenceEnergy || norm === 0;
    const out = new Float64Array(N_CLASSES);
    this.templates.forEach((t, i) => {
      if (t.kind === 'unknown') out[i] = -Infinity;
      else if (t.kind === 'none') out[i] = silent ? 2 : this.options.noChordScore;
      else if (silent) out[i] = 0;
      else {
        let dot = 0;
        for (let k = 0; k < 12; k++) dot += treble[k] * t.weights[k];
        out[i] = dot / norm + this.options.bassWeight * bass[t.root] + t.prior;
      }
    });
    return out;
  }

  /**
   * Posterior over classes at frame `target` given all `frames` (an HMM with
   * a uniform switch to any other chord). Frames after the target act as
   * lookahead; with target = last frame this is pure forward filtering.
   */
  posteriorAt(frames: PitchProfile[], target: number): Float64Array {
    return this.posteriors(frames, [target])[0];
  }

  posteriors(frames: PitchProfile[], targets: number[]): Float64Array[] {
    const T = frames.length;
    const K = N_CLASSES;
    const p = this.options.selfTransition;
    const q = (1 - p) / (K - 1);
    const emissions = frames.map((f) => {
      const s = this.scores(f);
      let max = -Infinity;
      for (const v of s) max = Math.max(max, v);
      const e = new Float64Array(K);
      for (let k = 0; k < K; k++) e[k] = Math.exp(this.options.beta * (s[k] - max));
      return e;
    });
    // Forward (normalised per step).
    const alpha: Float64Array[] = new Array(T);
    let prev = new Float64Array(K).fill(1 / K);
    for (let t = 0; t < T; t++) {
      const a = new Float64Array(K);
      let sumPrev = 0;
      for (const v of prev) sumPrev += v;
      let sum = 0;
      for (let k = 0; k < K; k++) {
        a[k] = emissions[t][k] * (t === 0 ? prev[k] : p * prev[k] + q * (sumPrev - prev[k]));
        sum += a[k];
      }
      for (let k = 0; k < K; k++) a[k] /= sum || 1;
      alpha[t] = a;
      prev = a;
    }
    // Backward from the end, only as far back as the earliest target.
    const earliest = Math.min(...targets);
    const beta: Float64Array[] = new Array(T);
    beta[T - 1] = new Float64Array(K).fill(1);
    for (let t = T - 2; t >= earliest; t--) {
      const next = beta[t + 1];
      const x = new Float64Array(K);
      let sumX = 0;
      for (let k = 0; k < K; k++) {
        x[k] = emissions[t + 1][k] * next[k];
        sumX += x[k];
      }
      const b = new Float64Array(K);
      let sum = 0;
      for (let k = 0; k < K; k++) {
        b[k] = p * x[k] + q * (sumX - x[k]);
        sum += b[k];
      }
      for (let k = 0; k < K; k++) b[k] /= sum || 1;
      beta[t] = b;
    }
    return targets.map((target) => {
      const t = Math.max(0, Math.min(T - 1, target));
      const post = new Float64Array(K);
      let sum = 0;
      for (let k = 0; k < K; k++) {
        post[k] = alpha[t][k] * beta[t][k];
        sum += post[k];
      }
      for (let k = 0; k < K; k++) post[k] /= sum || 1;
      return post;
    });
  }
}

/** Normalises a profile to max 1 in place (all-zero stays zero). */
export const normaliseMax = (v: Float64Array): Float64Array => {
  let max = 0;
  for (const x of v) max = Math.max(max, x);
  if (max > 0) for (let i = 0; i < v.length; i++) v[i] /= max;
  return v;
};
