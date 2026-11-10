// Audio from the Even G2 four-mic array (or the phone mic, routed by the Even
// app): bridge.audioControl(true, source) starts capture and PCM arrives on
// event.audioEvent.audioPcm as 16 kHz signed 16-bit little-endian mono.
import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { pcm16BytesToFloat } from '../engine/detector';
import { type ChunkHandler, type PcmSource } from './source';

/** The host may hand over PCM as Uint8Array, number[] or base64 depending on version. */
const toBytes = (raw: unknown): Uint8Array | undefined => {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  if (typeof raw === 'string' && raw.length) {
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return undefined;
};

const STOP_SETTLE_MS = 400;

export class EvenSource implements PcmSource {
  readonly name: string;
  private unsubscribe?: () => void;
  private delivered = 0;
  private oddByte?: number; // s16 samples can straddle packets in theory

  constructor(
    private readonly bridge: EvenAppBridge,
    readonly input: AudioInputSource,
    private readonly debug = false,
  ) {
    this.name = input === AudioInputSource.Glasses ? 'G2 glasses mic' : 'phone mic (via Even app)';
  }

  get position(): number {
    return this.delivered / 16000;
  }

  async start(onChunk: ChunkHandler): Promise<void> {
    this.unsubscribe = this.bridge.onEvenHubEvent((event) => {
      const audio = event.audioEvent;
      if (!audio) return;
      let bytes = toBytes(audio.audioPcm);
      if (!bytes?.length) return;
      if (this.oddByte !== undefined) {
        const joined = new Uint8Array(bytes.length + 1);
        joined[0] = this.oddByte;
        joined.set(bytes, 1);
        bytes = joined;
        this.oddByte = undefined;
      }
      if (bytes.length % 2) {
        this.oddByte = bytes[bytes.length - 1];
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      const pcm = pcm16BytesToFloat(bytes);
      let sum = 0;
      for (const v of pcm) sum += v * v;
      this.delivered += pcm.length;
      onChunk(pcm, Math.sqrt(sum / Math.max(1, pcm.length)));
    });
    await this.rearm();
  }

  /** (Re)opens the mic: needed after the WebView was suspended (Android). */
  async rearm(): Promise<void> {
    const ok = await this.bridge.audioControl(true, this.input);
    if (this.debug) console.log(`[mic] audioControl(true, ${this.input}) -> ${ok}`);
    if (!ok) throw new Error(`audioControl(true, ${this.input}) was refused`);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // A start sent right after a stop can cancel the stop on the host side,
    // leaving two streams running (duplicated audio). The returned boolean is
    // not reliable (the simulator reports false even when capture stopped), so
    // give the host a moment to settle before anyone reopens the mic.
    const ok = await this.bridge.audioControl(false, this.input);
    if (this.debug) console.log(`[mic] audioControl(false, ${this.input}) -> ${ok}`);
    await new Promise((r) => setTimeout(r, STOP_SETTLE_MS));
  }
}
