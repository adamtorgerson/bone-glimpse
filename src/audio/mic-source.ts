import { type ChunkHandler, createTap, type PcmSource } from './source';

/** Laptop/phone microphone via getUserMedia, with all voice processing off. */
export class MicSource implements PcmSource {
  readonly name = 'microphone';
  private context?: AudioContext;
  private stream?: MediaStream;
  private delivered = 0;

  constructor(
    private readonly deviceId: string | undefined,
    readonly sampleRate: number,
  ) {}

  get position(): number {
    return this.delivered / this.sampleRate;
  }

  async start(onChunk: ChunkHandler): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        // Speech processing destroys music: turn it all off.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.context = new AudioContext();
    const input = this.context.createMediaStreamSource(this.stream);
    await createTap(this.context, input, (pcm, level) => {
      this.delivered += pcm.length;
      onChunk(pcm, level);
    }, this.sampleRate);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.context?.close();
    this.context = undefined;
    this.stream = undefined;
  }
}

export const listMicrophones = async (): Promise<MediaDeviceInfo[]> => {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'audioinput');
};
