// ChordMini: CQT (librosa-equivalent) -> 108-frame windows -> transformer
// logits -> 9-frame logit smoothing -> softmax.
import { computeCqt, type CqtPlan } from '../cqt';
import { smoothedLogits, softmax } from '../decision';
import { type ChordModel, HOP, N_BINS, N_CLASSES, SEQ_LEN, type Vocabulary } from '../model';
import { type ChordScheme, type SampleReader, type WindowRequest } from '../scheme';

/** Extra frames computed on the left of each window so CQT edge effects are discarded. */
export const CQT_MARGIN_FRAMES = 16;

/** Samples of history needed to build a window. */
export const WINDOW_HISTORY_SAMPLES = (SEQ_LEN + CQT_MARGIN_FRAMES + 2) * HOP;

/**
 * Builds the [SEQ_LEN][N_BINS] feature window whose last frame is `endFrame`,
 * using only audio before `availableEnd` (absolute model-rate samples). Frames
 * near the right edge see zeros for the not-yet-heard future, exactly like a
 * live system would.
 */
export const buildWindow = (read: SampleReader, endFrame: number, availableEnd: number, plan: CqtPlan): Float32Array => {
  const firstFrame = endFrame - (SEQ_LEN - 1);
  const segmentFrame = firstFrame - CQT_MARGIN_FRAMES;
  const segmentStart = segmentFrame * HOP; // may be negative: zeros before the stream starts
  const segment = read(segmentStart, availableEnd);
  const { frameCount, data } = computeCqt(segment, plan);
  const window = new Float32Array(SEQ_LEN * N_BINS);
  const offset = CQT_MARGIN_FRAMES;
  if (frameCount < offset + SEQ_LEN) throw new RangeError('Not enough audio for the requested window');
  window.set(data.subarray(offset * N_BINS, (offset + SEQ_LEN) * N_BINS));
  return window;
};

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

export class ChordMiniScheme implements ChordScheme {
  readonly id = 'chordmini' as const;
  readonly historySamples = WINDOW_HISTORY_SAMPLES;

  constructor(
    readonly model: ChordModel,
    readonly plan: CqtPlan,
    readonly vocab: Vocabulary,
  ) {}

  get batch(): number {
    return this.model.batch;
  }

  async analyzeWindows(read: SampleReader, windows: WindowRequest[], lookaheads: number[]): Promise<Float64Array[][]> {
    const features = windows.map((w) => buildWindow(read, w.endFrame, w.availableEnd, this.plan));
    const out: Float64Array[][] = new Array(windows.length);
    await runBatched(this.model, features, (i, logits) => {
      out[i] = lookaheads.map((l) => softmax(smoothedLogits(logits, SEQ_LEN - 1 - l, SEQ_LEN)));
    });
    return out;
  }

  async analyzeSong(samples: Float32Array, onProgress?: (done: number, total: number) => void): Promise<Float64Array[]> {
    const { frameCount, data } = computeCqt(samples, this.plan);
    const windowCount = Math.ceil(frameCount / SEQ_LEN);
    const windows: Float32Array[] = [];
    for (let w = 0; w < windowCount; w++) {
      const win = new Float32Array(SEQ_LEN * N_BINS); // zero padded past the end, like the reference
      const from = w * SEQ_LEN;
      win.set(data.subarray(from * N_BINS, Math.min(frameCount, from + SEQ_LEN) * N_BINS));
      windows.push(win);
    }
    const probs: Float64Array[] = new Array(frameCount);
    await runBatched(
      this.model,
      windows,
      (w, logits) => {
        for (let local = 0; local < SEQ_LEN; local++) {
          const frame = w * SEQ_LEN + local;
          if (frame >= frameCount) break;
          probs[frame] = softmax(smoothedLogits(logits, local, SEQ_LEN));
        }
      },
      onProgress,
    );
    return probs;
  }
}
