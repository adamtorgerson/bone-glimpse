// Offline analysis used by the evaluation harness, for any ChordScheme:
//  - analyzeFullSong: non-causal reference (whole song visible), the
//    "analyse first, then play along" upper bound.
//  - simulateStreaming: exactly the live detector's computation (same
//    windows, same truncated future), replayed over a file, with every
//    lookahead evaluated from the same windows.
import { decide, type Decision, type DecisionOptions, defaultDecisionOptions } from './decision';
import { HOP } from './model';
import { arrayReader, type ChordScheme, songFrameCount } from './scheme';

export const analyzeFullSong = async (
  samples: Float32Array,
  scheme: ChordScheme,
  options: DecisionOptions = defaultDecisionOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<Decision[]> => {
  const probs = await scheme.analyzeSong(samples, onProgress);
  return probs.map((p) => decide(p, scheme.vocab, options));
};

export type StreamStep = {
  /** Last frame of the analysed window; audio up to sample endFrame*HOP (inclusive) was available. */
  endFrame: number;
  /** decisions[i] is for frame endFrame - lookaheads[i]. */
  decisions: Decision[];
};

export const simulateStreaming = async (
  samples: Float32Array,
  scheme: ChordScheme,
  config: { stepFrames: number; lookaheads: number[]; decision?: DecisionOptions },
  onProgress?: (done: number, total: number) => void,
): Promise<StreamStep[]> => {
  const totalFrames = songFrameCount(samples.length);
  const read = arrayReader(samples);
  const endFrames: number[] = [];
  for (let e = config.stepFrames; e < totalFrames; e += config.stepFrames) endFrames.push(e);
  const steps: StreamStep[] = [];
  // Windows are built per batch to bound memory on long songs.
  for (let start = 0; start < endFrames.length; start += scheme.batch) {
    const group = endFrames.slice(start, start + scheme.batch);
    const probs = await scheme.analyzeWindows(
      read,
      group.map((e) => ({ endFrame: e, availableEnd: e * HOP + 1 })),
      config.lookaheads,
    );
    group.forEach((endFrame, i) =>
      steps.push({ endFrame, decisions: probs[i].map((p) => decide(p, scheme.vocab, config.decision)) }),
    );
    onProgress?.(Math.min(start + scheme.batch, endFrames.length), endFrames.length);
  }
  return steps;
};
