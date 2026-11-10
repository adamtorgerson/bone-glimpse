// Song key estimation from the stream of detected chords.
//
// Each detection adds its chord tones to a 12-bin pitch-class histogram
// (root counted double), weighted by confidence and by how long it was held.
// Older evidence decays (half-life `halfLifeSeconds`) so modulations are
// followed. The histogram is correlated against the Krumhansl–Kessler
// major/minor key profiles in all 12 transpositions; the best of the 24 keys
// wins. A shown key only changes when another key beats it by `switchMargin`,
// so the display doesn't flicker between close candidates (e.g. relative
// major/minor).
import { type Chord, chordTones, noteName, prefersFlats } from './theory';

export type Mode = 'major' | 'minor';

export type KeyEstimate = {
  tonic: number;
  mode: Mode;
  /** e.g. "G", "Ebm", "F#m". */
  display: string;
  /** Pearson correlation of the best key with the evidence (−1..1). */
  correlation: number;
  /** Correlation lead over the runner-up key; small = ambiguous. */
  margin: number;
};

export type KeyOptions = {
  halfLifeSeconds: number;
  /** Seconds of (confidence-weighted) chord evidence before a key is reported. */
  minEvidence: number;
  switchMargin: number;
};

export const defaultKeyOptions: KeyOptions = { halfLifeSeconds: 60, minEvidence: 8, switchMargin: 0.04 };

// Krumhansl & Kessler (1982) probe-tone ratings, tonic first.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const correlate = (x: readonly number[], profile: readonly number[], tonic: number): number => {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 12; i++) {
    mx += x[i];
    my += profile[i];
  }
  mx /= 12;
  my /= 12;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < 12; i++) {
    const dx = x[(tonic + i) % 12] - mx;
    const dy = profile[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
};

export const keyName = (tonic: number, mode: Mode): string =>
  noteName(tonic, prefersFlats({ kind: 'chord', root: tonic, quality: mode === 'major' ? 'maj' : 'min' })) + (mode === 'minor' ? 'm' : '');

/** Scores all 24 keys against a pitch-class histogram, best first. */
export const rankKeys = (histogram: readonly number[]): { tonic: number; mode: Mode; correlation: number }[] => {
  const out: { tonic: number; mode: Mode; correlation: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    out.push({ tonic, mode: 'major', correlation: correlate(histogram, MAJOR_PROFILE, tonic) });
    out.push({ tonic, mode: 'minor', correlation: correlate(histogram, MINOR_PROFILE, tonic) });
  }
  return out.sort((a, b) => b.correlation - a.correlation);
};

export class KeyEstimator {
  private histogram = new Array<number>(12).fill(0);
  private evidence = 0;
  private lastTime?: number;
  private current?: { tonic: number; mode: Mode };

  constructor(readonly options: KeyOptions = defaultKeyOptions) {}

  reset(): void {
    this.histogram.fill(0);
    this.evidence = 0;
    this.lastTime = undefined;
    this.current = undefined;
  }

  /**
   * Adds a detection: `chord` was heard at `time` (s, stream time) with the
   * given confidence (0..1). Its duration is the gap since the previous call.
   */
  add(chord: Chord, time: number, confidence = 1): void {
    const dt = this.lastTime === undefined ? 0 : Math.max(0, Math.min(2, time - this.lastTime));
    this.lastTime = time;
    if (dt === 0) return;
    const decay = Math.pow(0.5, dt / this.options.halfLifeSeconds);
    for (let i = 0; i < 12; i++) this.histogram[i] *= decay;
    this.evidence *= decay;
    const tones = chordTones(chord);
    if (!tones.length) return; // N.C. / unknown: time passes, no evidence
    const w = dt * Math.max(0, Math.min(1, confidence));
    for (const pc of new Set(tones)) this.histogram[pc] += w;
    this.histogram[tones[0]] += w; // root again: the tonic chord's root is the strongest cue
    if (chord.kind === 'chord' && chord.bass !== undefined) this.histogram[chord.bass] += w * 0.5;
    this.evidence += w;
  }

  /** The current key, or undefined while there isn't enough evidence yet. */
  estimate(): KeyEstimate | undefined {
    if (this.evidence < this.options.minEvidence) return undefined;
    const ranked = rankKeys(this.histogram);
    const best = ranked[0];
    const held = this.current && ranked.find((k) => k.tonic === this.current!.tonic && k.mode === this.current!.mode);
    const pick = held && best.correlation - held.correlation < this.options.switchMargin ? held : best;
    this.current = { tonic: pick.tonic, mode: pick.mode };
    const runnerUp = ranked.find((k) => k !== pick)!;
    return {
      tonic: pick.tonic,
      mode: pick.mode,
      display: keyName(pick.tonic, pick.mode),
      correlation: pick.correlation,
      margin: pick.correlation - runnerUp.correlation,
    };
  }
}
