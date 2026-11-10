// Predicts the next chord change from the chords heard so far and the key.
//
// 1. Segmentation: detections are merged into chord segments by triad family
//    (Am / Am7 flicker stays one segment). A new chord only starts a segment
//    once it has held for `minHoldSeconds`, so one-step blips are ignored.
// 2. Pattern matching (songs repeat): every earlier place where the last 1–4
//    segments occurred votes for the chord that followed it, longer matches
//    and more recent ones weighing more (a small variable-order Markov model).
// 3. Key prior: common functional moves in the detected key (V→I, IV→V,
//    vi→IV, …) fill in before the song has repeated, and are blended out as
//    pattern evidence grows.
// Timing: the current chord is expected to last as long as it did in the
// matched earlier occurrences (or the song's median chord length), giving an
// estimated time of the change.
import { type KeyEstimate } from './key';
import { type Chord, chordFamily, displayName } from './theory';

export type ChordPrediction = {
  chord: Chord;
  display: string;
  /** 0..1 share of the vote for this chord. */
  probability: number;
  /** Stream time (s) the change is expected at; undefined if timing is unknown. */
  changeAt?: number;
  /** Whether repeated patterns in this song contributed (vs. key prior only). */
  fromPattern: boolean;
};

export type PredictOptions = {
  minHoldSeconds: number;
  maxOrder: number;
  /** Pattern weight at which the key prior is ignored completely. */
  patternTrust: number;
};

export const defaultPredictOptions: PredictOptions = { minHoldSeconds: 0.6, maxOrder: 4, patternTrust: 8 };

type Segment = {
  id: string;
  start: number;
  end: number;
  /** Time spent on each full chord (by display name) within the segment. */
  variants: Map<string, { chord: Chord; seconds: number }>;
};

/** Segment identity: root + triad family, so 7ths/extensions don't split a chord. */
const chordId = (chord: Chord): string | undefined => {
  if (chord.kind !== 'chord') return undefined;
  const family = chordFamily(chord);
  return `${chord.root}:${family === 'other' || !family ? chord.quality : family}`;
};

const triad = (id: string): Chord => {
  const [root, quality] = id.split(':');
  return { kind: 'chord', root: Number(root), quality: quality === 'sus' ? 'sus4' : quality };
};

// Common moves between diatonic triads: [from degree, family] -> [to degree, family, weight].
type Move = [number, string, number];
const MAJOR_MOVES: Record<string, Move[]> = {
  '0:maj': [[5, 'maj', 3], [7, 'maj', 3], [9, 'min', 2], [2, 'min', 1], [4, 'min', 0.5]],
  '2:min': [[7, 'maj', 6], [5, 'maj', 1], [0, 'maj', 1], [9, 'min', 1]],
  '4:min': [[9, 'min', 4], [5, 'maj', 4], [2, 'min', 1]],
  '5:maj': [[7, 'maj', 3.5], [0, 'maj', 3.5], [2, 'min', 1], [9, 'min', 1]],
  '7:maj': [[0, 'maj', 5.5], [9, 'min', 2.5], [5, 'maj', 1.5]],
  '9:min': [[5, 'maj', 4.5], [2, 'min', 2], [7, 'maj', 2], [0, 'maj', 1]],
  '11:dim': [[0, 'maj', 6], [4, 'min', 1]],
};
const MINOR_MOVES: Record<string, Move[]> = {
  '0:min': [[8, 'maj', 2.5], [5, 'min', 2.5], [10, 'maj', 2], [7, 'maj', 1.5], [3, 'maj', 1]],
  '2:dim': [[7, 'maj', 6], [0, 'min', 1]],
  '3:maj': [[8, 'maj', 3], [10, 'maj', 2], [5, 'min', 2], [0, 'min', 1]],
  '5:min': [[7, 'maj', 3], [0, 'min', 3], [10, 'maj', 2]],
  '7:maj': [[0, 'min', 7], [8, 'maj', 2]],
  '7:min': [[0, 'min', 5], [8, 'maj', 3]],
  '8:maj': [[10, 'maj', 3.5], [3, 'maj', 2], [5, 'min', 2], [7, 'maj', 1.5], [0, 'min', 1]],
  '10:maj': [[3, 'maj', 3.5], [0, 'min', 3.5], [8, 'maj', 1.5]],
};

/** Key-based distribution over the next chord id, given the current one. */
export const keyPrior = (currentId: string, key: Pick<KeyEstimate, 'tonic' | 'mode'>): Map<string, number> => {
  const [root, family] = currentId.split(':');
  const degree = (((Number(root) - key.tonic) % 12) + 12) % 12;
  const moves = (key.mode === 'major' ? MAJOR_MOVES : MINOR_MOVES)[`${degree}:${family}`];
  const out = new Map<string, number>();
  if (!moves) return out;
  const total = moves.reduce((s, m) => s + m[2], 0);
  for (const [to, fam, w] of moves) out.set(`${(key.tonic + to) % 12}:${fam}`, w / total);
  return out;
};

const weightedMedian = (items: { value: number; weight: number }[]): number | undefined => {
  if (!items.length) return undefined;
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((s, i) => s + i.weight, 0) / 2;
  let acc = 0;
  for (const i of sorted) if ((acc += i.weight) >= half) return i.value;
  return sorted[sorted.length - 1].value;
};

export class ChordPredictor {
  private segments: Segment[] = []; // completed, oldest first
  private current?: Segment;
  private candidate?: Segment;
  private lastTime?: number;
  /** Per chord id, total time on each full-chord variant over the whole song. */
  private variants = new Map<string, Map<string, { chord: Chord; seconds: number }>>();

  constructor(readonly options: PredictOptions = defaultPredictOptions) {}

  reset(): void {
    this.segments = [];
    this.current = this.candidate = undefined;
    this.lastTime = undefined;
    this.variants.clear();
  }

  /** The chord segments so far (completed + current), for inspection/tests. */
  get sequence(): string[] {
    return [...this.segments, ...(this.current ? [this.current] : [])].map((s) => s.id);
  }

  /** Adds a confident detection (skip uncertain ones) at stream time `time`. */
  add(chord: Chord, time: number): void {
    const dt = this.lastTime === undefined ? 0 : Math.max(0, Math.min(2, time - this.lastTime));
    this.lastTime = time;
    const id = chordId(chord);
    if (!id) return; // N.C./unknown: neither extends nor breaks a segment
    const note = (seg: Segment): void => {
      const name = displayName(chord);
      const v = seg.variants.get(name) ?? { chord, seconds: 0 };
      v.seconds += dt;
      seg.variants.set(name, v);
    };
    if (!this.current) {
      this.current = { id, start: time, end: time, variants: new Map() };
      return;
    }
    if (id === this.current.id) {
      this.current.end = time;
      this.candidate = undefined;
      note(this.current);
      return;
    }
    if (this.candidate?.id !== id) this.candidate = { id, start: time, end: time, variants: new Map() };
    this.candidate.end = time;
    note(this.candidate);
    if (time - this.candidate.start >= this.options.minHoldSeconds) {
      this.current.end = this.candidate.start;
      this.finish(this.current);
      this.current = this.candidate;
      this.candidate = undefined;
    }
  }

  private finish(seg: Segment): void {
    this.segments.push(seg);
    const all = this.variants.get(seg.id) ?? new Map<string, { chord: Chord; seconds: number }>();
    for (const [name, v] of seg.variants) {
      const t = all.get(name) ?? { chord: v.chord, seconds: 0 };
      t.seconds += v.seconds;
      all.set(name, t);
    }
    this.variants.set(seg.id, all);
  }

  /** The song's usual voicing of a chord id (e.g. G7 rather than G), else the plain triad. */
  private voicing(id: string): Chord {
    const all = this.variants.get(id);
    if (!all?.size) return triad(id);
    return [...all.values()].sort((a, b) => b.seconds - a.seconds)[0].chord;
  }

  /** Predicts the next chord; `key` enables the key prior. */
  predict(key?: Pick<KeyEstimate, 'tonic' | 'mode'>): ChordPrediction | undefined {
    if (!this.current) return undefined;
    const seq = [...this.segments, this.current];
    const ids = seq.map((s) => s.id);
    const last = ids.length - 1;

    const votes = new Map<string, number>();
    const durations: { value: number; weight: number }[] = [];
    let patternWeight = 0;
    for (let n = 1; n <= Math.min(this.options.maxOrder, last); n++) {
      // Earlier occurrences of the last n segments, ending at i (with a known successor).
      for (let i = n - 1; i < last; i++) {
        let match = true;
        for (let k = 0; k < n && match; k++) match = ids[i - k] === ids[last - k];
        if (!match) continue;
        const w = n * n * Math.pow(0.95, last - 1 - i);
        const next = ids[i + 1];
        votes.set(next, (votes.get(next) ?? 0) + w);
        durations.push({ value: seq[i].end - seq[i].start, weight: w });
        patternWeight += w;
      }
    }

    const scores = new Map<string, number>();
    const trust = Math.min(1, patternWeight / this.options.patternTrust);
    for (const [id, w] of votes) scores.set(id, (trust * w) / patternWeight);
    if (key && trust < 1) {
      for (const [id, p] of keyPrior(this.current.id, key)) scores.set(id, (scores.get(id) ?? 0) + (1 - trust) * p);
    }
    scores.delete(this.current.id);
    if (!scores.size) return undefined;
    const total = [...scores.values()].reduce((a, b) => a + b, 0);
    const [bestId, bestScore] = [...scores].sort((a, b) => b[1] - a[1])[0];

    // How long the current chord usually lasts: matched occurrences, else recent chords.
    const typical =
      weightedMedian(durations) ??
      weightedMedian(this.segments.slice(-8).map((s) => ({ value: s.end - s.start, weight: 1 })));
    const changeAt = typical !== undefined && typical > 0 ? this.current.start + typical : undefined;

    const chord = this.voicing(bestId);
    return { chord, display: displayName(chord), probability: bestScore / total, changeAt, fromPattern: patternWeight > 0 };
  }
}
