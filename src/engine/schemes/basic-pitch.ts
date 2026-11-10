// Spotify Basic Pitch (Apache-2.0): a small CNN that transcribes polyphonic
// notes (88 piano keys, ~86 frames/s) from 2 s windows of 22.05 kHz audio.
// The note activations are folded into pitch-class profiles and named by the
// same template HMM as the chroma scheme, so any voicing works and octave
// harmonics are not mistaken for chord tones.
//
// The runtime (tfjs in the browser and Node) is injected as a NoteModel.
import { HOP, type Vocabulary } from '../model';
import { arrayReader, type ChordScheme, type SampleReader, type WindowRequest, songFrameCount } from '../scheme';
import { defaultTemplateOptions, normaliseMax, type PitchProfile, TemplateDecoder, type TemplateOptions } from './templates';

export const BP_WINDOW = 43844; // samples per model run (2 s - one hop)
export const BP_HOP = 256;
export const BP_FRAMES = 172;
export const BP_NOTES = 88; // MIDI 21 (A0) .. 108 (C8)
const MIDI_LOW = 21;
/** Frames at each end of a window that see padding and are unreliable (as in the reference code). */
const BP_EDGE = 15;
const BP_PER_FRAME = HOP / BP_HOP; // 8 note frames per chord frame

export interface NoteModel {
  readonly batch: number;
  /** audio: [n][BP_WINDOW] -> note activations [n][BP_FRAMES][BP_NOTES] in 0..1. */
  run(audio: Float32Array, n: number): Promise<Float32Array>;
}

export type BasicPitchOptions = {
  /** Notes below this MIDI number feed the bass profile. */
  bassBelow: number;
  /** Activations below this are ignored (noise floor). */
  floor: number;
  template: TemplateOptions;
};

export const defaultBasicPitchOptions: BasicPitchOptions = {
  bassBelow: 55, // G3
  floor: 0.1,
  template: { ...defaultTemplateOptions, silenceEnergy: 0.3, noChordScore: 0.5, bassWeight: 0.2 },
};

/**
 * Note activations sampled on the chord grid: `activations` is
 * [bpFrames][BP_NOTES] whose frame j is centred on sample `start + j * BP_HOP`.
 */
const profileAt = (
  activations: Float32Array,
  bpFrames: number,
  start: number,
  centre: number,
  options: BasicPitchOptions,
  firstValid = 0,
): PitchProfile => {
  const mid = Math.round((centre - start) / BP_HOP);
  const from = Math.max(firstValid, mid - BP_PER_FRAME / 2);
  const to = Math.min(bpFrames, mid + BP_PER_FRAME / 2);
  const treble = new Float64Array(12);
  const bass = new Float64Array(12);
  let energy = 0;
  if (to > from) {
    const mean = new Float64Array(BP_NOTES);
    for (let j = from; j < to; j++) for (let n = 0; n < BP_NOTES; n++) mean[n] += activations[j * BP_NOTES + n];
    for (let n = 0; n < BP_NOTES; n++) {
      const a = mean[n] / (to - from);
      energy = Math.max(energy, a);
      if (a < options.floor) continue;
      const midi = MIDI_LOW + n;
      treble[midi % 12] += a;
      if (midi < options.bassBelow) bass[midi % 12] += a;
    }
  }
  return { treble, bass: normaliseMax(bass), energy };
};

export class BasicPitchScheme implements ChordScheme {
  readonly id = 'basicpitch' as const;
  readonly historySamples = BP_WINDOW + 2 * HOP;
  private readonly decoder: TemplateDecoder;

  constructor(
    readonly model: NoteModel,
    readonly vocab: Vocabulary,
    readonly options: BasicPitchOptions = defaultBasicPitchOptions,
  ) {
    this.decoder = new TemplateDecoder(vocab, options.template);
  }

  get batch(): number {
    return this.model.batch;
  }

  private async runAll(chunks: Float32Array[], onProgress?: (done: number, total: number) => void): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    const per = BP_FRAMES * BP_NOTES;
    for (let i = 0; i < chunks.length; i += this.model.batch) {
      const n = Math.min(this.model.batch, chunks.length - i);
      const input = new Float32Array(n * BP_WINDOW);
      for (let k = 0; k < n; k++) input.set(chunks[i + k], k * BP_WINDOW);
      const result = await this.model.run(input, n);
      for (let k = 0; k < n; k++) out.push(result.slice(k * per, (k + 1) * per));
      onProgress?.(i + n, chunks.length);
    }
    return out;
  }

  async analyzeWindows(read: SampleReader, windows: WindowRequest[], lookaheads: number[]): Promise<Float64Array[][]> {
    const starts = windows.map((w) => w.availableEnd - BP_WINDOW);
    const activations = await this.runAll(starts.map((s, i) => read(s, windows[i].availableEnd)));
    return windows.map(({ endFrame }, i) => {
      const start = starts[i];
      // Chord frames whose centre lies in the reliable part of the window.
      const firstFrame = Math.ceil((start + BP_EDGE * BP_HOP) / HOP);
      const frames: PitchProfile[] = [];
      for (let f = firstFrame; f <= endFrame; f++) frames.push(profileAt(activations[i], BP_FRAMES, start, f * HOP, this.options, BP_EDGE));
      const last = frames.length - 1;
      return this.decoder.posteriors(
        frames,
        lookaheads.map((l) => last - l),
      );
    });
  }

  async analyzeSong(samples: Float32Array, onProgress?: (done: number, total: number) => void): Promise<Float64Array[]> {
    // Overlapping windows, keeping only the reliable middle of each, so the
    // kept frames tile the song: global note frame g is centred on g * BP_HOP.
    const kept = BP_FRAMES - 2 * BP_EDGE;
    const totalBp = Math.ceil(samples.length / BP_HOP);
    const read = arrayReader(samples);
    const chunks: Float32Array[] = [];
    for (let k = 0; k * kept < totalBp; k++) {
      const start = (k * kept - BP_EDGE) * BP_HOP;
      chunks.push(read(start, start + BP_WINDOW));
    }
    const results = await this.runAll(chunks, onProgress);
    const all = new Float32Array(chunks.length * kept * BP_NOTES);
    results.forEach((r, k) => all.set(r.subarray(BP_EDGE * BP_NOTES, (BP_EDGE + kept) * BP_NOTES), k * kept * BP_NOTES));
    const frameCount = songFrameCount(samples.length);
    const frames: PitchProfile[] = [];
    for (let f = 0; f < frameCount; f++) frames.push(profileAt(all, chunks.length * kept, 0, f * HOP, this.options));
    return this.decoder.posteriors(
      frames,
      frames.map((_, i) => i),
    );
  }
}
