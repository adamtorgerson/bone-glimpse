// Turns per-frame model logits into a displayable decision, including the
// "fall back when confidence is low" rule from DESIGN.md:
//   1. full chord if its probability >= fullThreshold
//   2. otherwise the triad family (e.g. Am7 -> Am) if the family's summed
//      probability >= familyThreshold
//   3. otherwise "uncertain" (the best guess is still reported, flagged).
import { N_CLASSES, SMOOTHING_KERNEL, type Vocabulary } from './model';
import { type Chord, displayName, simplify, toVocabLabel } from './theory';

export type DecisionLevel = 'full' | 'simplified' | 'uncertain' | 'none';

export type Decision = {
  /** What to show. */
  chord: Chord;
  display: string;
  level: DecisionLevel;
  /** Probability supporting what is shown (full chord or summed family). */
  confidence: number;
  /** Raw model argmax (after smoothing). */
  best: { label: string; display: string; probability: number };
  top: { label: string; probability: number }[];
};

export type DecisionOptions = {
  fullThreshold: number;
  familyThreshold: number;
};

export const defaultDecisionOptions: DecisionOptions = { fullThreshold: 0.5, familyThreshold: 0.5 };

/** Mean of logits over a centred kernel, clipped to the window (as in the reference runtime). */
export const smoothedLogits = (
  windowLogits: Float32Array, // [seqLen][N_CLASSES]
  frame: number,
  seqLen: number,
  kernel = SMOOTHING_KERNEL,
): Float64Array => {
  const radius = (kernel - 1) / 2;
  const out = new Float64Array(N_CLASSES);
  let count = 0;
  for (let f = Math.max(0, frame - radius); f <= Math.min(seqLen - 1, frame + radius); f++) {
    const base = f * N_CLASSES;
    for (let c = 0; c < N_CLASSES; c++) out[c] += windowLogits[base + c];
    count++;
  }
  for (let c = 0; c < N_CLASSES; c++) out[c] /= count;
  return out;
};

export const softmax = (logits: Float64Array): Float64Array => {
  let max = -Infinity;
  for (const v of logits) max = Math.max(max, v);
  const out = new Float64Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max);
    sum += out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
};

export const decide = (
  probabilities: Float64Array,
  vocab: Vocabulary,
  options: DecisionOptions = defaultDecisionOptions,
): Decision => {
  const order = Array.from(probabilities.keys()).sort((a, b) => probabilities[b] - probabilities[a]);
  const bestIndex = order[0];
  const bestChord = vocab.chords[bestIndex];
  const best = {
    label: vocab.labels[bestIndex],
    display: displayName(bestChord),
    probability: probabilities[bestIndex],
  };
  const top = order.slice(0, 5).map((i) => ({ label: vocab.labels[i], probability: probabilities[i] }));
  const base = { best, top };

  if (bestChord.kind === 'none' && best.probability >= options.fullThreshold) {
    return { ...base, chord: bestChord, display: 'N.C.', level: 'none', confidence: best.probability };
  }
  if (bestChord.kind === 'chord' && best.probability >= options.fullThreshold) {
    return { ...base, chord: bestChord, display: best.display, level: 'full', confidence: best.probability };
  }

  // Sum probability mass per simplified chord (root + triad family).
  const families = new Map<string, { chord: Chord; p: number }>();
  for (let i = 0; i < probabilities.length; i++) {
    const chord = vocab.chords[i];
    if (chord.kind !== 'chord') continue;
    const simple = simplify(chord);
    const key = toVocabLabel(simple) ?? '?';
    const entry = families.get(key) ?? { chord: simple, p: 0 };
    entry.p += probabilities[i];
    families.set(key, entry);
  }
  let bestFamily: { chord: Chord; p: number } | undefined;
  for (const entry of families.values()) if (!bestFamily || entry.p > bestFamily.p) bestFamily = entry;
  if (bestFamily && bestFamily.p >= options.familyThreshold) {
    return {
      ...base,
      chord: bestFamily.chord,
      display: displayName(bestFamily.chord),
      level: 'simplified',
      confidence: bestFamily.p,
    };
  }
  return { ...base, chord: bestChord, display: best.display, level: 'uncertain', confidence: best.probability };
};
