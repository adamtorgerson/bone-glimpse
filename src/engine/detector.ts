// Streaming chord detection. Audio comes in as 16 kHz mono PCM chunks (the
// format the Even G2 SDK delivers from the glasses or phone mic), is
// resampled to the model rate, and every `stepFrames` the selected scheme
// analyses a window ending at the newest audio. The chord reported is the one
// for frame (end - lookahead): more lookahead = more right-hand context =
// better accuracy, but the display lags by lookahead * ~93 ms.
import { decide, type Decision, type DecisionOptions, defaultDecisionOptions } from './decision';
import { HOP, SAMPLE_RATE, type Vocabulary } from './model';
import { StreamResampler } from './resample';
import { type ChordScheme } from './scheme';

export { buildWindow, CQT_MARGIN_FRAMES, WINDOW_HISTORY_SAMPLES } from './schemes/chordmini';

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
  private readonly history: AudioHistory;
  private lastEndFrame = -Infinity;
  private busy = false;

  constructor(
    readonly scheme: ChordScheme,
    options: Partial<DetectorOptions> = {},
  ) {
    this.options = { ...defaultDetectorOptions, ...options };
    this.history = new AudioHistory(scheme.historySamples + SAMPLE_RATE);
  }

  get vocab(): Vocabulary {
    return this.scheme.vocab;
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
      const [[probs]] = await this.scheme.analyzeWindows(
        (a, b) => this.history.read(a, b),
        [{ endFrame, availableEnd: available }],
        [this.options.lookaheadFrames],
      );
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
