// Minimal radix-2 real FFT with numpy.fft.rfft conventions (e^{-i...}, no scaling).

export type RealFft = {
  size: number;
  /** Writes size/2+1 complex bins interleaved [re0, im0, re1, im1, ...] into `out`. */
  forward: (input: Float32Array | Float64Array, out: Float64Array) => void;
};

export const createRealFft = (size: number): RealFft => {
  if (size < 2 || (size & (size - 1)) !== 0) throw new RangeError('FFT size must be a power of two');
  const levels = Math.log2(size);
  const reverse = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);

  const forward = (input: Float32Array | Float64Array, out: Float64Array): void => {
    for (let i = 0; i < size; i++) {
      re[reverse[i]] = input[i];
      im[reverse[i]] = 0;
    }
    for (let half = 1; half < size; half <<= 1) {
      const step = size / (half << 1);
      for (let start = 0; start < size; start += half << 1) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= size / 2; k++) {
      out[2 * k] = re[k];
      out[2 * k + 1] = im[k];
    }
  };
  return { size, forward };
};
