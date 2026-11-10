// Streaming chord detection. Audio comes in as 16 kHz mono PCM chunks (the
// format the Even G2 SDK delivers from the glasses or phone mic), is
// resampled to the model rate, and every `stepFrames` a 108-frame window
// ending at the newest audio is analysed. The chord reported is the one for
// frame (end - lookahead): more lookahead = more right-hand context = better
// accuracy, but the display lags by lookahead * ~93 ms.
import { computeCqt, type CqtPlan } from './cqt';
import { decide, type Decision, type DecisionOptions, defaultDecisionOptions, smoothedLogits, softmax } from './decision';
import { type ChordModel, HOP, N_BINS, N_CLASSES, SAMPLE_RATE, SEQ_LEN, type Vocabulary } from './model';
import { StreamResampler } from './resample';

/** Extra frames computed on the left of each window so CQT edge effects are discarded. */
export const CQT_MARGIN_FRAMES = 16;

export const DEVICE_SAMPLE_RATE = 16000; // Even G2 audioEvent: PCM s16le, 16 kHz, mono

/** Converts a little-endian s16 byte buffer (Even `audioPcm`) to floats in [-1, 1). */
export const pcm16BytesToFloat = (bytes: Uint8Array): Float32Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(2 * i, true) / 32768;
  return out;
};

/** Holds the most recent model-rate audio, indexed by absolute sample number. */
export class AudioHistory {
  private data: Float32Array;
  private start = 0; // absolute index of data[0]
  private length = 0;

  constructor(private readonly capacity: number) {
    this.data = new Float32Array(capacity * 2);
  }

  get end(): number {
    return this.start + this.length;
  }

  append(samples: Float32Array): void {
    if (this.length + samples.length > this.data.length) {
      const keep = Math.min(this.length, Math.max(0, this.capacity - samples.length));
      const drop = this.length - keep;
      this.data.copyWithin(0, drop, this.length);
      this.start += drop;
      this.length = keep;
      if (samples.length > this.data.length) samples = samples.subarray(samples.length - this.data.length);
    }
    this.data.set(samples, this.length);
    this.length += samples.length;
  }

  /** Copies absolute range [from, to); samples before 0 or not retained are zero. */
  read(from: number, to: number): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    for (let abs = Math.max(from, this.start); abs < Math.min(to, this.end); abs++) {
      out[abs - from] = this.data[abs - this.start];
    }
    return out;
  }
}

/** Samples of history needed to build a window. */
export const WINDOW_HISTORY_SAMPLES = (SEQ_LEN + CQT_MARGIN_FRAMES + 2) * HOP;

/**
 * Builds the [SEQ_LEN][N_BINS] feature window whose last frame is `endFrame`,
 * using only audio before `availableEnd` (absolute model-rate samples). Frames
 * near the right edge see zeros for the not-yet-heard future, exactly like a
 * live system would.
 */
export const buildWindow = (
  read: (from: number, to: number) => Float32Array,
  endFrame: number,
  availableEnd: number,
  plan: CqtPlan,
): Float32Array => {
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

export type DetectionEvent = {
  /** Absolute frame the decision describes, and its time from stream start (s). */
  frame: number;
  frameTime: number;
  /** Audio received when the analysis started (s from stream start). */
  audioTime: number;
  /** Wall-clock analysis time (CQT + model + decision). */
  computeMs: number;
  /** Delay between the described moment and the result being available (s). */
  delay: number;
  decision: Decision;
};

export type DetectorOptions = {
  lookaheadFrames: number;
  stepFrames: number;
  decision: DecisionOptions;
};

export const defaultDetectorOptions: DetectorOptions = {
  lookaheadFrames: 4,
  stepFrames: 3,
  decision: defaultDecisionOptions,
};

export class LiveChordDetector {
  options: DetectorOptions;
  private readonly resampler = new StreamResampler(DEVICE_SAMPLE_RATE, SAMPLE_RATE);
  private readonly history = new AudioHistory(WINDOW_HISTORY_SAMPLES + SAMPLE_RATE);
  private lastEndFrame = -Infinity;
  private busy = false;

  constructor(
    private readonly model: ChordModel,
    readonly plan: CqtPlan,
    readonly vocab: Vocabulary,
    options: Partial<DetectorOptions> = {},
  ) {
    this.options = { ...defaultDetectorOptions, ...options };
  }

  /** Seconds of device audio received so far (at model rate). */
  get audioSeconds(): number {
    return this.history.end / SAMPLE_RATE;
  }

  pushDeviceAudio(samples16k: Float32Array): void {
    this.history.append(this.resampler.push(samples16k));
  }

  /** Runs an analysis if a new step is due and none is in flight. */
  async poll(now: () => number = () => performance.now()): Promise<DetectionEvent | undefined> {
    if (this.busy) return undefined;
    const available = this.history.end;
    const endFrame = Math.floor((available - 1) / HOP);
    if (endFrame < 0 || endFrame - this.lastEndFrame < this.options.stepFrames) return undefined;
    this.busy = true;
    try {
      const started = now();
      const window = buildWindow((a, b) => this.history.read(a, b), endFrame, available, this.plan);
      const batch = new Float32Array(this.model.batch * SEQ_LEN * N_BINS);
      batch.set(window);
      const logits = await this.model.run(batch);
      const local = SEQ_LEN - 1 - this.options.lookaheadFrames;
      const probs = softmax(smoothedLogits(logits.subarray(0, SEQ_LEN * N_CLASSES), local, SEQ_LEN));
      const decision = decide(probs, this.vocab, this.options.decision);
      const computeMs = now() - started;
      this.lastEndFrame = endFrame;
      const frame = endFrame - this.options.lookaheadFrames;
      const frameTime = (frame * HOP) / SAMPLE_RATE;
      const audioTime = available / SAMPLE_RATE;
      return { frame, frameTime, audioTime, computeMs, delay: audioTime - frameTime + computeMs / 1000, decision };
    } finally {
      this.busy = false;
    }
  }
}
