// Single-note detection: "which one note stands out right now, and how
// clearly?". Independent of the chord model (which only knows chord labels):
// it works on the raw 16 kHz device audio with its own FFT, so it updates
// every 64 ms instead of once per model run and covers E1-C8 instead of the
// model CQT's C1-B6.
//
// Per frame: spectral peaks -> harmonic salience for every semitone
// candidate (Klapuri-style weighting, which keeps the fundamental ahead of its
// octaves) -> the best note, then its partials are removed and salience is
// recomputed to find the strongest *other* note. Confidence combines
//   share     = fraction of the frame's energy in the best note's partials
//   dominance = how far the best note's salience is ahead of the next note
// so a solo note scores high, a note over quieter accompaniment medium and an
// even chord or noise low.
import { createRealFft } from './fft';
import { PITCH_NAMES } from './theory';

export const NOTE_SAMPLE_RATE = 16000; // device audio (see detector.ts)
export const NOTE_WINDOW = 4096; // 256 ms: long enough to separate bass partials
export const NOTE_HOP = 1024; // a reading every 64 ms
export const LOWEST_NOTE = 28; // E1, 41 Hz (bass guitar low E)
/** C8, 4186 Hz (piano top). Above ~C7 only the fundamental fits below 8 kHz, so confidence there is weaker. */
export const HIGHEST_NOTE = 108;
const HARMONICS = 12;
const MAX_FREQ = 7600; // the 16 kHz resampler rolls off above this
const MIN_FREQ = 35;
const PEAK_FLOOR_DB = -45; // peaks this far below the strongest are ignored
const MAX_PEAKS = 48;
const MISSING_FUNDAMENTAL_PENALTY = 0.3;

export const midiToFrequency = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
const frequencyToMidi = (f: number): number => 69 + 12 * Math.log2(f / 440);
/** "A4", "C#3" (scientific pitch notation, middle C = C4). */
export const noteName = (midi: number): string => `${PITCH_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

export type NoteEstimate = {
  midi: number;
  name: string;
  /** Measured pitch (Hz) and its offset from equal temperament (A4 = 440 Hz), in cents. */
  frequency: number;
  cents: number;
  /** 0-1: how clearly this one note stands out. */
  confidence: number;
  share: number;
  dominance: number;
};

export type NoteOptions = {
  /** At or above: shown as the note. */
  clearThreshold: number;
  /** At or above (and below clear): shown with a "?". Below: no note. */
  weakThreshold: number;
  /** Frames quieter than this RMS are silence. */
  minRms: number;
};

export const defaultNoteOptions: NoteOptions = { clearThreshold: 0.7, weakThreshold: 0.45, minRms: 0.002 };

type Peak = { freq: number; amp: number; energy: number };

const N_CANDIDATES = HIGHEST_NOTE - LOWEST_NOTE + 1;
const CANDIDATE_FREQ = Float64Array.from({ length: N_CANDIDATES }, (_, i) => midiToFrequency(LOWEST_NOTE + i));
const LOWEST_F0 = midiToFrequency(LOWEST_NOTE - 0.5);

const fft = createRealFft(NOTE_WINDOW);
const hann = Float64Array.from({ length: NOTE_WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NOTE_WINDOW));
const windowed = new Float64Array(NOTE_WINDOW);
const spectrum = new Float64Array(NOTE_WINDOW + 2);
const power = new Float64Array(NOTE_WINDOW / 2 + 1);

/** Local maxima of the magnitude spectrum, parabolically interpolated (log domain). */
const findPeaks = (binHz: number): { peaks: Peak[]; total: number } => {
  const lo = Math.ceil(MIN_FREQ / binHz);
  const hi = Math.min(power.length - 2, Math.floor(MAX_FREQ / binHz));
  let total = 0;
  let max = 0;
  for (let k = lo; k <= hi; k++) {
    total += power[k];
    if (power[k] > max) max = power[k];
  }
  const floor = max * 10 ** (PEAK_FLOOR_DB / 10);
  const peaks: Peak[] = [];
  for (let k = Math.max(lo, 1); k <= hi; k++) {
    const p = power[k];
    if (p < floor || p <= power[k - 1] || p < power[k + 1]) continue;
    const a = Math.log(power[k - 1] + 1e-30);
    const b = Math.log(p + 1e-30);
    const c = Math.log(power[k + 1] + 1e-30);
    const denom = a - 2 * b + c;
    const offset = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
    const peakPower = Math.exp(b - 0.25 * (a - c) * offset);
    let energy = 0;
    for (let j = Math.max(lo, k - 2); j <= Math.min(hi, k + 2); j++) energy += power[j];
    peaks.push({ freq: (k + offset) * binHz, amp: Math.sqrt(peakPower), energy });
  }
  peaks.sort((x, y) => y.amp - x.amp);
  return { peaks: peaks.slice(0, MAX_PEAKS), total };
};

type Salience = { salience: Float64Array; owner: Int32Array; weight: Float64Array };

/**
 * Harmonic salience of every candidate from the peaks not in `removed`. Each
 * (candidate, harmonic) slot takes its single strongest matching peak, so one
 * loud partial can't count twice.
 */
const harmonicSalience = (peaks: Peak[], removed?: Set<number>): Salience => {
  const slots = N_CANDIDATES * HARMONICS;
  const weight = new Float64Array(slots);
  const owner = new Int32Array(slots).fill(-1);
  for (let i = 0; i < peaks.length; i++) {
    if (removed?.has(i)) continue;
    const { freq, amp } = peaks[i];
    for (let h = 1; h <= HARMONICS; h++) {
      const f0 = freq / h;
      if (f0 < LOWEST_F0) break;
      const c = Math.round(frequencyToMidi(f0)) - LOWEST_NOTE;
      if (c < 0 || c >= N_CANDIDATES) continue;
      const fc = CANDIDATE_FREQ[c];
      const v = (amp * (fc + 52)) / (h * fc + 320);
      const slot = c * HARMONICS + h - 1;
      if (v > weight[slot]) {
        weight[slot] = v;
        owner[slot] = i;
      }
    }
  }
  const salience = new Float64Array(N_CANDIDATES);
  for (let c = 0; c < N_CANDIDATES; c++) {
    let s = 0;
    for (let h = 0; h < HARMONICS; h++) s += weight[c * HARMONICS + h];
    // No energy at the fundamental: most likely a "virtual root" that the
    // partials of a chord happen to fit (C-E-G fits C2's series), not a played
    // note. Penalised rather than excluded: small mics roll off bass fundamentals.
    salience[c] = owner[c * HARMONICS] < 0 ? s * MISSING_FUNDAMENTAL_PENALTY : s;
  }
  return { salience, owner, weight };
};

const argmax = (values: Float64Array): number => {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
};

/**
 * Analyses one NOTE_WINDOW-sample frame of 16 kHz mono audio. Returns the most
 * prominent note with its confidence, or undefined for silence.
 */
export const analyseNoteFrame = (frame: Float32Array, minRms = defaultNoteOptions.minRms): NoteEstimate | undefined => {
  if (frame.length !== NOTE_WINDOW) throw new RangeError(`Note frames must be ${NOTE_WINDOW} samples`);
  let sum = 0;
  for (let i = 0; i < NOTE_WINDOW; i++) sum += frame[i] * frame[i];
  if (Math.sqrt(sum / NOTE_WINDOW) < minRms) return undefined;

  for (let i = 0; i < NOTE_WINDOW; i++) windowed[i] = frame[i] * hann[i];
  fft.forward(windowed, spectrum);
  for (let k = 0; k < power.length; k++) power[k] = spectrum[2 * k] ** 2 + spectrum[2 * k + 1] ** 2;
  const { peaks, total } = findPeaks(NOTE_SAMPLE_RATE / NOTE_WINDOW);
  if (!peaks.length || total <= 0) return undefined;

  const first = harmonicSalience(peaks);
  const c = argmax(first.salience);
  const s1 = first.salience[c];
  if (s1 <= 0) return undefined;

  // The best note's partials: their energy, and a pitch estimate from them.
  const matched = new Set<number>();
  let centsSum = 0;
  let centsWeight = 0;
  for (let h = 1; h <= HARMONICS; h++) {
    const slot = c * HARMONICS + h - 1;
    const i = first.owner[slot];
    if (i < 0) continue;
    matched.add(i);
    // Low partials are the most reliable (piano strings stretch the upper ones sharp).
    const w = first.weight[slot] / h;
    centsSum += w * 100 * (frequencyToMidi(peaks[i].freq / h) - (LOWEST_NOTE + c));
    centsWeight += w;
  }
  let matchedEnergy = 0;
  for (const i of matched) matchedEnergy += peaks[i].energy;

  const second = harmonicSalience(peaks, matched);
  const s2 = Math.max(...second.salience);

  const share = Math.min(1, matchedEnergy / total);
  const dominance = Math.max(0, 1 - s2 / s1);
  const midi = LOWEST_NOTE + c;
  const cents = centsWeight > 0 ? centsSum / centsWeight : 0;
  return {
    midi,
    name: noteName(midi),
    frequency: midiToFrequency(midi + cents / 100),
    cents,
    confidence: Math.sqrt(share * dominance),
    share,
    dominance,
  };
};

export type NoteLevel = 'clear' | 'weak' | 'none';

export type NoteReading = {
  /** Centre of the newest frame, seconds from stream start. */
  time: number;
  level: NoteLevel;
  /** The note shown (present unless level is 'none'), confidence after smoothing. */
  note?: NoteEstimate;
};

/**
 * Streaming wrapper: feed 16 kHz chunks, get a reading every NOTE_HOP samples.
 * A note is only reported once it wins 2 of the last 3 frames, and its
 * confidence is averaged over those 3 (a frame that disagrees counts as 0),
 * so single-frame flickers don't reach the display.
 */
export class LiveNoteDetector {
  options: NoteOptions;
  private buffer = new Float32Array(NOTE_WINDOW * 2);
  private length = 0;
  private consumed = 0; // absolute index of buffer[0]
  private recent: (NoteEstimate | undefined)[] = [];

  constructor(options: Partial<NoteOptions> = {}) {
    this.options = { ...defaultNoteOptions, ...options };
  }

  push(samples: Float32Array): NoteReading[] {
    if (this.length + samples.length > this.buffer.length) {
      const grown = new Float32Array(Math.max(this.buffer.length * 2, this.length + samples.length));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(samples, this.length);
    this.length += samples.length;

    const readings: NoteReading[] = [];
    while (this.length >= NOTE_WINDOW) {
      const estimate = analyseNoteFrame(this.buffer.subarray(0, NOTE_WINDOW), this.options.minRms);
      readings.push(this.smooth(estimate, (this.consumed + NOTE_WINDOW / 2) / NOTE_SAMPLE_RATE));
      this.buffer.copyWithin(0, NOTE_HOP, this.length);
      this.length -= NOTE_HOP;
      this.consumed += NOTE_HOP;
    }
    return readings;
  }

  reset(): void {
    this.length = 0;
    this.consumed = 0;
    this.recent = [];
  }

  private smooth(estimate: NoteEstimate | undefined, time: number): NoteReading {
    this.recent.push(estimate);
    if (this.recent.length > 3) this.recent.shift();
    const votes = new Map<number, NoteEstimate[]>();
    for (const e of this.recent) if (e) votes.set(e.midi, [...(votes.get(e.midi) ?? []), e]);
    let winner: NoteEstimate[] | undefined;
    for (const v of votes.values()) if (v.length >= 2 && (!winner || v.length > winner.length)) winner = v;
    if (!winner) return { time, level: 'none' };
    const latest = winner[winner.length - 1];
    const confidence = winner.reduce((s, e) => s + e.confidence, 0) / 3;
    const note = { ...latest, confidence };
    const { clearThreshold, weakThreshold } = this.options;
    const level: NoteLevel = confidence >= clearThreshold ? 'clear' : confidence >= weakThreshold ? 'weak' : 'none';
    return level === 'none' ? { time, level } : { time, level, note };
  }
}
