// Streaming Kaiser-windowed-sinc resampler. Output sample n is computed from
// its absolute time n/outRate, so the result is identical whether the input
// arrives in one block or many small chunks (needed to compare live runs with
// offline evaluation).

const TABLE_STEPS = 512;

const besselI0 = (x: number): number => {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
};

export class StreamResampler {
  readonly ratio: number; // inRate / outRate
  private readonly cutoff: number; // in cycles per input sample
  private readonly halfWidth: number; // in input samples
  private readonly table: Float64Array; // kernel(|x|) sampled TABLE_STEPS per input sample
  private buffer = new Float32Array(0);
  private bufferStart = 0; // absolute input index of buffer[0]
  private inputCount = 0; // absolute input samples received
  private outputCount = 0; // absolute output samples produced

  constructor(
    readonly inRate: number,
    readonly outRate: number,
    zeroCrossings = 16,
  ) {
    this.ratio = inRate / outRate;
    const scale = Math.min(1, outRate / inRate);
    this.cutoff = 0.5 * scale * 0.94; // leave a small transition band below Nyquist
    this.halfWidth = Math.ceil(zeroCrossings / (2 * this.cutoff) / 2) * 2;
    const beta = 8.6;
    const i0Beta = besselI0(beta);
    this.table = new Float64Array(this.halfWidth * TABLE_STEPS + 2);
    for (let i = 0; i < this.table.length; i++) {
      const x = i / TABLE_STEPS;
      const r = x / this.halfWidth;
      if (r >= 1) continue;
      const arg = 2 * this.cutoff * x;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      this.table[i] = 2 * this.cutoff * sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / i0Beta);
    }
  }

  get latencyInputSamples(): number {
    return this.halfWidth;
  }

  /** Pushes input samples and returns every output sample now fully determined. */
  push(input: Float32Array): Float32Array {
    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer);
    merged.set(input, this.buffer.length);
    this.buffer = merged;
    this.inputCount += input.length;
    return this.drain(this.inputCount - 1 - this.halfWidth);
  }

  /** Flushes the tail as if the input were followed by silence. */
  flush(): Float32Array {
    const silence = new Float32Array(this.halfWidth + 1);
    const total = this.inputCount;
    const merged = new Float32Array(this.buffer.length + silence.length);
    merged.set(this.buffer);
    this.buffer = merged;
    this.inputCount += silence.length;
    const end = Math.ceil(total / this.ratio);
    const out = this.drain(Infinity, end);
    this.inputCount = total;
    return out;
  }

  private drain(maxCentre: number, maxOutputs = Infinity): Float32Array {
    const out: number[] = [];
    const { halfWidth, table } = this;
    while (this.outputCount < maxOutputs) {
      const t = this.outputCount * this.ratio;
      if (t > maxCentre) break;
      const first = Math.max(Math.ceil(t - halfWidth), this.bufferStart, 0);
      const last = Math.min(Math.floor(t + halfWidth), this.bufferStart + this.buffer.length - 1);
      let acc = 0;
      for (let k = first; k <= last; k++) {
        const pos = Math.abs(t - k) * TABLE_STEPS;
        const i = Math.floor(pos);
        const frac = pos - i;
        acc += this.buffer[k - this.bufferStart] * (table[i] + (table[i + 1] - table[i]) * frac);
      }
      out.push(acc);
      this.outputCount++;
    }
    // Drop input no longer needed by future outputs.
    const keepFrom = Math.floor(this.outputCount * this.ratio - halfWidth) - 1;
    const drop = Math.min(keepFrom - this.bufferStart, this.buffer.length);
    if (drop > 0) {
      this.buffer = this.buffer.slice(drop);
      this.bufferStart += drop;
    }
    return Float32Array.from(out);
  }
}

export const resampleAll = (input: Float32Array, inRate: number, outRate: number): Float32Array => {
  if (inRate === outRate) return input.slice();
  const r = new StreamResampler(inRate, outRate);
  const a = r.push(input);
  const b = r.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
