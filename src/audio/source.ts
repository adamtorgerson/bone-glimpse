// Audio sources deliver what the Even G2 SDK delivers: 16 kHz mono PCM,
// 16-bit quantised, in small chunks. The laptop sources (mic, file) emulate
// that so the detector code is identical; a future EvenSource will wrap
// bridge.audioControl(...) + audioEvent.audioPcm (see pcm16BytesToFloat).
import { quantize16 } from '../engine/wav';
import { StreamResampler } from '../engine/resample';
import { DEVICE_SAMPLE_RATE } from '../engine/detector';

export type ChunkHandler = (pcm16k: Float32Array, level: number) => void;

export interface PcmSource {
  readonly name: string;
  start(onChunk: ChunkHandler): Promise<void>;
  /** Resolves once capture has really stopped (so a restart can't race it). */
  stop(): void | Promise<void>;
  /** Seconds of source audio delivered so far (file sources: playback position). */
  readonly position: number;
}

const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const n = input[0].length;
      const mono = new Float32Array(n);
      for (const ch of input) for (let i = 0; i < n; i++) mono[i] += ch[i] / input.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-tap', Tap);
`;

/** Taps a node's output, converts to device format (16 kHz, s16) and forwards chunks. */
export const createTap = async (context: AudioContext, node: AudioNode, onChunk: ChunkHandler): Promise<AudioWorkletNode> => {
  const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const tap = new AudioWorkletNode(context, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
  const resampler = new StreamResampler(context.sampleRate, DEVICE_SAMPLE_RATE);
  // Batch ~40 ms per chunk, roughly the cadence of BLE audio packets.
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    const out = resampler.push(e.data);
    pending.push(out);
    pendingLength += out.length;
    if (pendingLength < DEVICE_SAMPLE_RATE * 0.04) return;
    const chunk = new Float32Array(pendingLength);
    let o = 0;
    for (const p of pending) {
      chunk.set(p, o);
      o += p.length;
    }
    pending = [];
    pendingLength = 0;
    let sum = 0;
    for (const v of chunk) sum += v * v;
    onChunk(quantize16(chunk), Math.sqrt(sum / chunk.length));
  };
  node.connect(tap);
  return tap;
};
