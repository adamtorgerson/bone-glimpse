// Scoring against reference annotations (.lab: "start end label" per line,
// Harte chord syntax, as used by Isophonics/Billboard/MIREX).
import { type Chord, chordFamily, parseChord, toVocabLabel } from './theory';

export type LabSegment = { start: number; end: number; label: string; chord: Chord };

export const parseLab = (text: string): LabSegment[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [start, end, ...rest] = line.split(/\s+/);
      const label = rest.join(' ');
      return { start: Number(start), end: Number(end), label, chord: parseChord(label) };
    })
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);

export const referenceAt = (segments: LabSegment[], time: number): Chord | undefined => {
  // Segments are sorted; binary search.
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time < segments[mid].start) hi = mid - 1;
    else if (time >= segments[mid].end) lo = mid + 1;
    else return segments[mid].chord;
  }
  return undefined;
};

/** MIREX "majmin" reduction: root + maj|min, N; undefined = excluded from scoring. */
export const majmin = (chord: Chord): string | undefined => {
  if (chord.kind === 'none') return 'N';
  if (chord.kind === 'unknown') return undefined;
  const family = chordFamily(chord);
  if (family === 'maj' || family === 'min') return `${chord.root}:${family}`;
  return undefined;
};

export const rootOf = (chord: Chord): string | undefined =>
  chord.kind === 'none' ? 'N' : chord.kind === 'chord' ? String(chord.root) : undefined;

export type Metric = 'root' | 'majmin' | 'exact';

const reduce = (metric: Metric, chord: Chord): string | undefined => {
  if (metric === 'root') return rootOf(chord);
  if (metric === 'majmin') return majmin(chord);
  if (chord.kind === 'chord' && chord.quality === 'other') return undefined;
  return toVocabLabel({ ...chord, ...(chord.kind === 'chord' ? { bass: undefined } : {}) } as Chord);
};

export class Score {
  private hits: Record<Metric, number> = { root: 0, majmin: 0, exact: 0 };
  private totals: Record<Metric, number> = { root: 0, majmin: 0, exact: 0 };

  add(reference: Chord | undefined, estimate: Chord): void {
    if (!reference) return;
    for (const metric of ['root', 'majmin', 'exact'] as const) {
      const ref = reduce(metric, reference);
      if (ref === undefined) continue;
      this.totals[metric]++;
      if (reduce(metric, estimate) === ref) this.hits[metric]++;
    }
  }

  get(metric: Metric): number {
    return this.totals[metric] ? this.hits[metric] / this.totals[metric] : NaN;
  }

  get count(): number {
    return this.totals.root;
  }
}

/**
 * Lag to recognise each chord change: for every reference segment with a
 * majmin-scorable chord, the time from its start until the on-screen chord
 * first matches it (majmin). Segments never matched count as misses.
 */
export const changeLags = (
  segments: LabSegment[],
  shown: (time: number) => Chord | undefined,
  resolution: number,
): { lags: number[]; missed: number; scored: number } => {
  const lags: number[] = [];
  let missed = 0;
  let scored = 0;
  for (const seg of segments) {
    const target = majmin(seg.chord);
    if (target === undefined || target === 'N' || seg.end - seg.start < 0.5) continue;
    scored++;
    let found = false;
    for (let t = seg.start; t < seg.end; t += resolution) {
      const est = shown(t);
      if (est && majmin(est) === target) {
        lags.push(t - seg.start);
        found = true;
        break;
      }
    }
    if (!found) missed++;
  }
  return { lags, missed, scored };
};

export const median = (values: number[]): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
