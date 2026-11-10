// CPU implementation of the precomputed CQT "plan" shipped with the ChordMini
// ONNX export (musetric/chordmini-onnx, cqt-plan.bin). The plan reproduces
// librosa 0.11 `cqt(sr=22050, hop=2048, fmin=C1, n_bins=144, bpo=24)`:
// repeated half-band FIR downsampling, centred zero-padded frames, a 512-point
// rFFT per octave and a sparse complex projection onto the CQT basis.
// Binary layout and algorithm ported from musetric packages/cqt (MIT).
import { createRealFft } from './fft';

export type CqtOctave = {
  index: number;
  sampleRate: number;
  hopLength: number;
  fftSize: number;
  binStart: number;
  binCount: number;
};

export type CqtPlan = {
  sampleRate: number;
  hopLength: number;
  nBins: number;
  binsPerOctave: number;
  fmin: number;
  logOutput: boolean;
  earlyDownsampleCount: number;
  octaves: CqtOctave[];
  rowOffsets: Uint32Array;
  fftBins: Uint32Array;
  coefficients: Float32Array;
  downsampleHalf: Float32Array;
  downsampleTaps: number;
  generator: string;
};

const MAGIC = 0x5451434d;
const HEADER_BYTES = 128;
const OCTAVE_BYTES = 32;

export const decodeCqtPlan = (artifact: Uint8Array): CqtPlan => {
  const bytes = artifact.slice(); // own, aligned buffer
  const view = new DataView(bytes.buffer);
  if (bytes.byteLength < HEADER_BYTES || view.getUint32(0, true) !== MAGIC) {
    throw new RangeError('Not a CQT plan artifact');
  }
  if (view.getUint32(8, true) !== HEADER_BYTES) throw new RangeError('Unsupported CQT plan header');
  if (HEADER_BYTES + view.getUint32(60, true) !== bytes.byteLength) {
    throw new RangeError('CQT plan payload size mismatch');
  }
  const nBins = view.getUint32(28, true);
  const octaveCount = view.getUint32(48, true);
  const tapCount = view.getUint32(52, true);
  const coefficientCount = view.getUint32(56, true);
  const generatorLength = view.getUint32(64, true);
  const generatorOffset = view.getUint32(68, true);
  const octavesOffset = view.getUint32(72, true);
  const rowOffsetsOffset = view.getUint32(76, true);
  const fftBinsOffset = view.getUint32(80, true);
  const coefficientsOffset = view.getUint32(84, true);
  const downsampleOffset = view.getUint32(92, true);

  const octaves: CqtOctave[] = [];
  for (let i = 0; i < octaveCount; i++) {
    const base = octavesOffset + i * OCTAVE_BYTES;
    octaves.push({
      index: view.getUint32(base, true),
      sampleRate: view.getFloat64(base + 4, true),
      hopLength: view.getUint32(base + 12, true),
      fftSize: view.getUint32(base + 16, true),
      binStart: view.getUint32(base + 20, true),
      binCount: view.getUint32(base + 24, true),
    });
  }
  let generator = '';
  for (let i = 0; i < generatorLength; i++) generator += String.fromCharCode(bytes[generatorOffset + i]);

  const plan: CqtPlan = {
    sampleRate: view.getFloat64(16, true),
    hopLength: view.getUint32(24, true),
    nBins,
    binsPerOctave: view.getUint32(32, true),
    fmin: view.getFloat64(40, true),
    logOutput: view.getUint32(12, true) === 1,
    earlyDownsampleCount: view.getUint32(36, true),
    octaves,
    rowOffsets: new Uint32Array(bytes.buffer, rowOffsetsOffset, nBins + 1),
    fftBins: new Uint32Array(bytes.buffer, fftBinsOffset, coefficientCount),
    coefficients: new Float32Array(bytes.buffer, coefficientsOffset, coefficientCount * 2),
    downsampleHalf: new Float32Array(bytes.buffer, downsampleOffset, (tapCount + 1) / 2),
    downsampleTaps: tapCount,
    generator,
  };
  if (plan.rowOffsets[nBins] !== coefficientCount) throw new RangeError('CQT plan row offsets are inconsistent');
  return plan;
};

/** Half-band Kaiser FIR decimation by 2, zero boundary, output length ceil(n/2). */
export const downsample2 = (input: Float32Array, plan: CqtPlan): Float32Array => {
  const half = plan.downsampleHalf;
  const delay = (plan.downsampleTaps - 1) / 2;
  const n = input.length;
  const out = new Float32Array(Math.ceil(n / 2));
  for (let o = 0; o < out.length; o++) {
    const c = 2 * o;
    let acc = half[0] * input[c];
    const dMax = Math.min(delay, Math.max(c, n - 1 - c));
    for (let d = 1; d <= dMax; d++) {
      const l = c - d;
      const r = c + d;
      const left = l >= 0 ? input[l] : 0;
      const right = r < n ? input[r] : 0;
      acc += half[d] * (left + right);
    }
    out[o] = acc * Math.SQRT2;
  }
  return out;
};

export const cqtFrameCount = (sampleCount: number, plan: CqtPlan): number => {
  let frames = Infinity;
  for (const octave of plan.octaves) {
    let n = sampleCount;
    for (let i = 0; i < plan.earlyDownsampleCount + octave.index; i++) n = Math.ceil(n / 2);
    frames = Math.min(frames, 1 + Math.floor(n / octave.hopLength));
  }
  return frames;
};

export type CqtResult = {
  frameCount: number;
  /** Row-major [frameCount][nBins]; log(|CQT|+1e-6) when the plan says so. */
  data: Float32Array;
};

/**
 * Computes the CQT of `samples` (mono, plan.sampleRate). Frame i is centred on
 * sample i * plan.hopLength. For streaming, pass segments whose start is a
 * multiple of plan.hopLength so frames stay on the global grid.
 */
export const computeCqt = (samples: Float32Array, plan: CqtPlan): CqtResult => {
  const frameCount = cqtFrameCount(samples.length, plan);
  const data = new Float32Array(frameCount * plan.nBins);
  const fft = createRealFft(plan.octaves[0].fftSize);
  const frame = new Float64Array(fft.size);
  const spectrum = new Float64Array(fft.size + 2);
  const { rowOffsets, fftBins, coefficients } = plan;

  let level = samples;
  for (let i = 0; i < plan.earlyDownsampleCount; i++) level = downsample2(level, plan);

  for (const octave of plan.octaves) {
    if (octave.index > 0) level = downsample2(level, plan);
    if (octave.fftSize !== fft.size) throw new RangeError('Mixed FFT sizes are not supported');
    const n = level.length;
    const halfFft = fft.size / 2;
    for (let f = 0; f < frameCount; f++) {
      const start = f * octave.hopLength - halfFft;
      for (let s = 0; s < fft.size; s++) {
        const idx = start + s;
        frame[s] = idx >= 0 && idx < n ? level[idx] : 0;
      }
      fft.forward(frame, spectrum);
      const rowBase = f * plan.nBins;
      for (let b = octave.binStart; b < octave.binStart + octave.binCount; b++) {
        let sr = 0;
        let si = 0;
        for (let c = rowOffsets[b]; c < rowOffsets[b + 1]; c++) {
          const k = 2 * fftBins[c];
          const cr = coefficients[2 * c];
          const ci = coefficients[2 * c + 1];
          const xr = spectrum[k];
          const xi = spectrum[k + 1];
          sr += cr * xr - ci * xi;
          si += cr * xi + ci * xr;
        }
        const magnitude = Math.sqrt(sr * sr + si * si);
        data[rowBase + b] = plan.logOutput ? Math.log(magnitude + 1e-6) : magnitude;
      }
    }
  }
  return { frameCount, data };
};
