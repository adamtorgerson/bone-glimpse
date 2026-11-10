// Audio sources deliver what the Even G2 SDK delivers: mono PCM, 16-bit
// quantised, in small chunks, at 16 kHz. The laptop sources (mic, file)
// emulate that so the detector code is identical, but can capture at a higher
// rate (CAPTURE_RATES) to skip the glasses' 8 kHz bandwidth limit.
import { quantize16 } from '../engine/wav';
import { StreamResampler } from '../engine/resample';

export type ChunkHandler = (pcm: Float32Array, level: number) => void;

export interface PcmSource {
  readonly name: string;
  /** Rate of the PCM handed to the ChunkHandler. */
  readonly sampleRate: number;
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

/**
 * Taps a node's output, converts to device format (`rate`, s16) and forwards chunks.
 * Uses an AudioWorklet where available; on insecure origins (e.g. the phone
 * loading the dev server over http://<LAN-IP>) `audioWorklet` is undefined, so
 * it falls back to the deprecated but universally supported ScriptProcessorNode.
 */
export const createTap = async (context: AudioContext, node: AudioNode, onChunk: ChunkHandler, rate: number): Promise<AudioNode> => {
  const resampler = context.sampleRate === rate ? undefined : new StreamResampler(context.sampleRate, rate);
  // Batch ~40 ms per chunk, roughly the cadence of BLE audio packets.
  let pending: Float32Array[] = [];
  let pendingLength = 0;
  const push = (mono: Float32Array): void => {
    const out = resampler ? resampler.push(mono) : mono;
    pending.push(out);
    pendingLength += out.length;
    if (pendingLength < rate * 0.04) return;
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

  if (context.audioWorklet) {
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(context, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    tap.port.onmessage = (e: MessageEvent<Float32Array>) => push(e.data);
    node.connect(tap);
    return tap;
  }

  // Fallback: same arithmetic-mean downmix as the worklet.
  const channels = Math.max(1, Math.min(2, node.channelCount));
  const tap = context.createScriptProcessor(4096, channels, 1);
  tap.onaudioprocess = (e) => {
    const input = e.inputBuffer;
    const n = input.length;
    const mono = new Float32Array(n);
    for (let c = 0; c < input.numberOfChannels; c++) {
      const data = input.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += data[i] / input.numberOfChannels;
    }
    push(mono);
  };
  // A ScriptProcessor only runs while connected to the destination; route it through silence.
  const mute = new GainNode(context, { gain: 0 });
  node.connect(tap);
  tap.connect(mute).connect(context.destination);
  return tap;
};
