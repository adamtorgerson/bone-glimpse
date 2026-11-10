// Offline analysis used by the evaluation harness:
//  - analyzeFullSong: non-causal reference (whole song visible), the
//    "analyse first, then play along" upper bound.
//  - simulateStreaming: exactly the live detector's computation (same window
//    builder, same truncated future), replayed over a file, with every
//    lookahead evaluated from the same windows.
import { computeCqt, type CqtPlan } from './cqt';
import { decide, type Decision, type DecisionOptions, defaultDecisionOptions, smoothedLogits, softmax } from './decision';
import { buildWindow } from './detector';
import { type ChordModel, HOP, N_BINS, N_CLASSES, SEQ_LEN, type Vocabulary } from './model';

const runBatched = async (
  model: ChordModel,
  windows: Float32Array[],
  onLogits: (windowIndex: number, logits: Float32Array) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<void> => {
  const windowFloats = SEQ_LEN * N_BINS;
  const logitFloats = SEQ_LEN * N_CLASSES;
  for (let start = 0; start < windows.length; start += model.batch) {
    const batch = new Float32Array(model.batch * windowFloats);
    const count = Math.min(model.batch, windows.length - start);
    for (let i = 0; i < count; i++) batch.set(windows[start + i], i * windowFloats);
    const logits = await model.run(batch);
    for (let i = 0; i < count; i++) onLogits(start + i, logits.subarray(i * logitFloats, (i + 1) * logitFloats));
    onProgress?.(start + count, windows.length);
  }
};

export const analyzeFullSong = async (
  samples: Float32Array,
  model: ChordModel,
  plan: CqtPlan,
  vocab: Vocabulary,
  options: DecisionOptions = defaultDecisionOptions,
): Promise<Decision[]> => {
  const { frameCount, data } = computeCqt(samples, plan);
  const windowCount = Math.ceil(frameCount / SEQ_LEN);
  const windows: Float32Array[] = [];
  for (let w = 0; w < windowCount; w++) {
    const win = new Float32Array(SEQ_LEN * N_BINS); // zero padded past the end, like the reference
    const from = w * SEQ_LEN;
    win.set(data.subarray(from * N_BINS, Math.min(frameCount, from + SEQ_LEN) * N_BINS));
    windows.push(win);
  }
  const decisions: Decision[] = new Array(frameCount);
  await runBatched(model, windows, (w, logits) => {
    for (let local = 0; local < SEQ_LEN; local++) {
      const frame = w * SEQ_LEN + local;
      if (frame >= frameCount) break;
      decisions[frame] = decide(softmax(smoothedLogits(logits, local, SEQ_LEN)), vocab, options);
    }
  });
  return decisions;
};

export type StreamStep = {
  /** Last frame of the analysed window; audio up to sample endFrame*HOP (inclusive) was available. */
  endFrame: number;
  /** decisions[i] is for frame endFrame - lookaheads[i]. */
  decisions: Decision[];
};

export const simulateStreaming = async (
  samples: Float32Array,
  model: ChordModel,
  plan: CqtPlan,
  vocab: Vocabulary,
  config: { stepFrames: number; lookaheads: number[]; decision?: DecisionOptions },
  onProgress?: (done: number, total: number) => void,
): Promise<StreamStep[]> => {
  const totalFrames = Math.floor((samples.length - 1) / HOP) + 1;
  const read = (from: number, to: number): Float32Array => {
    const out = new Float32Array(Math.max(0, to - from));
    const a = Math.max(0, from);
    const b = Math.min(samples.length, to);
    if (b > a) out.set(samples.subarray(a, b), a - from);
    return out;
  };
  const endFrames: number[] = [];
  for (let e = config.stepFrames; e < totalFrames; e += config.stepFrames) endFrames.push(e);
  const steps: StreamStep[] = [];
  // Build windows lazily per batch to bound memory on long songs.
  for (let start = 0; start < endFrames.length; start += model.batch) {
    const group = endFrames.slice(start, start + model.batch);
    const windows = group.map((e) => buildWindow(read, e, e * HOP + 1, plan));
    await runBatched(model, windows, (i, logits) => {
      steps.push({
        endFrame: group[i],
        decisions: config.lookaheads.map((l) =>
          decide(softmax(smoothedLogits(logits, SEQ_LEN - 1 - l, SEQ_LEN)), vocab, config.decision),
        ),
      });
    });
    onProgress?.(Math.min(start + model.batch, endFrames.length), endFrames.length);
  }
  return steps;
};
