// Essentia's classic chord detector: HPCP (harmonic pitch class profile) per
// frame -> ChordsDetection (24 major/minor templates over a ~2 s centred
// window). The Essentia instance is injected, so this file stays free of
// runtime-specific loading.
//
// essentia.js is AGPL-3.0: the harness (scripts/lib/node-model.ts) and the
// dev server (src/web/essentia.ts) load it; production builds must not.
//
// ChordsDetection only reports a label and a correlation "strength"; the
// probability vector puts max(strength, 0) on that label and spreads the rest,
// so the shared decision logic treats weak correlations as uncertain.
import { HOP, N_CLASSES, type Vocabulary } from '../model';
import { arrayReader, type ChordScheme, type SampleReader, type WindowRequest, songFrameCount, vocabIndex } from '../scheme';
import { parseNote, PITCH_NAMES } from '../theory';

/** Minimal slice of the essentia.js core API used here. */
type Vector = { size(): number; get(i: number): unknown; delete(): void; push_back(v: unknown): void };
export type EssentiaApi = {
  arrayToVector(a: Float32Array): Vector;
  vectorToArray(v: Vector): Float32Array;
  Windowing(frame: Vector, normalized?: boolean, size?: number, type?: string): { frame: Vector };
  Spectrum(frame: Vector, size?: number): { spectrum: Vector };
  SpectralPeaks(
    spectrum: Vector, magnitudeThreshold?: number, maxFrequency?: number, maxPeaks?: number,
    minFrequency?: number, orderBy?: string, sampleRate?: number,
  ): { frequencies: Vector; magnitudes: Vector };
  HPCP(
    frequencies: Vector, magnitudes: Vector, bandPreset?: boolean, bandSplitFrequency?: number, harmonics?: number,
    maxFrequency?: number, maxShifted?: boolean, minFrequency?: number, nonLinear?: boolean, normalized?: string,
    referenceFrequency?: number, sampleRate?: number, size?: number, weightType?: string, windowSize?: number,
  ): { hpcp: Vector };
  ChordsDetection(pcp: Vector, hopSize?: number, sampleRate?: number, windowSize?: number): { chords: Vector; strength: Vector };
};
/** Constructor for essentia.js VectorVectorFloat. */
export type VectorVectorCtor = new () => Vector;

const SR = 22050;
const FRAME = 4096; // 186 ms, Essentia's tonal default at this rate
export const ESSENTIA_CONTEXT_FRAMES = 24;
const WINDOW_SECONDS = 2;
const SILENCE_RMS = 1e-3;

/** "Am" / "C#" / "Bbm" -> vocabulary label ("A:min", "C#", "A#:min"). */
export const essentiaLabel = (label: string): string => {
  const note = parseNote(label);
  if (!note) return 'N';
  const minor = label.slice(note.length).startsWith('m');
  return minor ? `${PITCH_NAMES[note.pc]}:min` : PITCH_NAMES[note.pc];
};

type Frame = { hpcp: Vector; rms: number };

export class EssentiaScheme implements ChordScheme {
  readonly id = 'essentia' as const;
  readonly batch = 1;
  readonly historySamples = (ESSENTIA_CONTEXT_FRAMES + 2) * HOP + FRAME;
  private readonly noChord: number;

  constructor(
    private readonly essentia: EssentiaApi,
    private readonly VectorVectorFloat: VectorVectorCtor,
    readonly vocab: Vocabulary,
  ) {
    this.noChord = vocab.labels.indexOf('N');
  }

  /** HPCP of the frame centred on sample `centre` (zeros outside the audio). */
  private frame(read: SampleReader, centre: number): Frame {
    const samples = read(centre - FRAME / 2, centre + FRAME / 2);
    let sq = 0;
    for (const v of samples) sq += v * v;
    const e = this.essentia;
    const input = e.arrayToVector(samples);
    const windowed = e.Windowing(input, true, FRAME, 'blackmanharris62');
    const spectrum = e.Spectrum(windowed.frame, FRAME);
    const peaks = e.SpectralPeaks(spectrum.spectrum, 0.00001, 5000, 100, 40, 'magnitude', SR);
    const { hpcp } = e.HPCP(peaks.frequencies, peaks.magnitudes, true, 500, 0, 5000, false, 40, false, 'unitMax', 440, SR, 12, 'squaredCosine', 1);
    for (const v of [input, windowed.frame, spectrum.spectrum, peaks.frequencies, peaks.magnitudes]) v.delete();
    return { hpcp, rms: Math.sqrt(sq / samples.length) };
  }

  private detect(frames: Frame[]): Float64Array[] {
    const pcp = new this.VectorVectorFloat();
    for (const f of frames) pcp.push_back(f.hpcp);
    const result = this.essentia.ChordsDetection(pcp, HOP, SR, WINDOW_SECONDS);
    const strength = this.essentia.vectorToArray(result.strength);
    const probs = frames.map((f, i) => {
      const p = new Float64Array(N_CLASSES);
      const s = Number.isFinite(strength[i]) ? Math.max(0, Math.min(1, strength[i])) : 0;
      const index = f.rms < SILENCE_RMS ? this.noChord : vocabIndex(this.vocab, essentiaLabel(String(result.chords.get(i))));
      const top = f.rms < SILENCE_RMS ? 0.9 : s;
      p.fill((1 - top) / (N_CLASSES - 2)); // spread over everything except X and the winner
      p[this.vocab.labels.indexOf('X')] = 0;
      p[index < 0 ? this.noChord : index] = top;
      return p;
    });
    result.chords.delete();
    result.strength.delete();
    pcp.delete();
    for (const f of frames) f.hpcp.delete();
    return probs;
  }

  async analyzeWindows(read: SampleReader, windows: WindowRequest[], lookaheads: number[]): Promise<Float64Array[][]> {
    return windows.map(({ endFrame, availableEnd }) => {
      const limited: SampleReader = (from, to) => {
        const out = read(from, Math.min(to, availableEnd));
        if (out.length >= to - from) return out;
        const padded = new Float32Array(to - from);
        padded.set(out);
        return padded;
      };
      const frames: Frame[] = [];
      for (let f = endFrame - ESSENTIA_CONTEXT_FRAMES + 1; f <= endFrame; f++) frames.push(this.frame(limited, f * HOP));
      const probs = this.detect(frames);
      return lookaheads.map((l) => probs[Math.max(0, probs.length - 1 - l)]);
    });
  }

  async analyzeSong(samples: Float32Array, onProgress?: (done: number, total: number) => void): Promise<Float64Array[]> {
    const total = songFrameCount(samples.length);
    const read = arrayReader(samples);
    const frames: Frame[] = [];
    for (let f = 0; f < total; f++) frames.push(this.frame(read, f * HOP));
    onProgress?.(total, total);
    return this.detect(frames);
  }
}
