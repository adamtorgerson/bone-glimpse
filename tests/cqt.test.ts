import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeCqt, cqtFrameCount, decodeCqtPlan } from '../src/engine/cqt';
import { createRealFft } from '../src/engine/fft';

const plan = decodeCqtPlan(new Uint8Array(readFileSync('public/models/chordmini/cqt-plan.bin')));

// librosa 0.11 peak magnitudes for a 0.5-amplitude, 4 s sine at each CQT bin
// centre (reference values from musetric packages/cqt, MIT).
const toneReferences = [
  [0, 38.211262], [12, 32.11541], [23, 27.398172], [24, 27.019209], [47, 19.373188],
  [48, 19.105656], [71, 13.699096], [72, 13.50953], [95, 9.686647], [96, 9.552778],
  [119, 6.849493], [120, 6.754834], [143, 4.843322],
] as const;

const tone = (frequency: number, amplitude = 0.5, seconds = 4): Float32Array => {
  const out = new Float32Array(Math.round(plan.sampleRate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / plan.sampleRate);
  return out;
};

describe('CQT plan', () => {
  it('decodes the shipped plan', () => {
    expect(plan.sampleRate).toBe(22050);
    expect(plan.hopLength).toBe(2048);
    expect(plan.nBins).toBe(144);
    expect(plan.octaves.map((o) => o.binStart)).toEqual([120, 96, 72, 48, 24, 0]);
    expect(plan.generator).toContain('librosa==0.11.0');
  });

  it('matches librosa frame counts', () => {
    // librosa: 1 + n // hop for centred frames
    expect(cqtFrameCount(22050 * 4, plan)).toBe(1 + Math.floor((22050 * 4) / 2048));
  });
});

describe('FFT', () => {
  it('matches a direct DFT', () => {
    const fft = createRealFft(16);
    const x = Float64Array.from({ length: 16 }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
    const out = new Float64Array(18);
    fft.forward(x, out);
    for (let k = 0; k <= 8; k++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < 16; n++) {
        re += x[n] * Math.cos((2 * Math.PI * k * n) / 16);
        im -= x[n] * Math.sin((2 * Math.PI * k * n) / 16);
      }
      expect(out[2 * k]).toBeCloseTo(re, 9);
      expect(out[2 * k + 1]).toBeCloseTo(im, 9);
    }
  });
});

describe('CQT tones', () => {
  for (const [bin, peak] of toneReferences) {
    it(`bin ${bin} peaks at its own bin with librosa's magnitude`, () => {
      const frequency = plan.fmin * 2 ** (bin / plan.binsPerOctave);
      const { frameCount, data } = computeCqt(tone(frequency), plan);
      const mid = Math.floor(frameCount / 2);
      const row = Array.from(data.subarray(mid * 144, (mid + 1) * 144), (v) => Math.exp(v) - 1e-6);
      const argmax = row.indexOf(Math.max(...row));
      expect(argmax).toBe(bin);
      expect(row[bin]).toBeCloseTo(peak, 2);
    });
  }

  it('gives identical interior frames for a hop-aligned segment (streaming invariant)', () => {
    const signal = tone(220, 0.3, 12);
    const full = computeCqt(signal, plan);
    const offsetFrames = 20;
    const seg = computeCqt(signal.subarray(offsetFrames * plan.hopLength), plan);
    // Frames far from both segment edges must match the full-signal CQT.
    for (const f of [30, 40, 60]) {
      for (let b = 0; b < 144; b += 7) {
        expect(seg.data[(f - offsetFrames) * 144 + b]).toBeCloseTo(full.data[f * 144 + b], 3);
      }
    }
  });
});
