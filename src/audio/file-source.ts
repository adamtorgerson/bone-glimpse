import { type ChunkHandler, createTap, type PcmSource } from './source';

/**
 * Plays an audio file in real time (optionally audible) and feeds the
 * detector the same 16 kHz stream a mic would, so timing behaves like live.
 * Any format the browser can decode works (wav, mp3, m4a, flac, ogg).
 */
export class FileSource implements PcmSource {
  readonly name: string;
  private context?: AudioContext;
  private node?: AudioBufferSourceNode;
  private startedAt = 0;

  constructor(
    private readonly file: File,
    private readonly audible: boolean,
    private readonly onEnded?: () => void,
  ) {
    this.name = file.name;
  }

  get position(): number {
    return this.context ? this.context.currentTime - this.startedAt : 0;
  }

  async start(onChunk: ChunkHandler): Promise<void> {
    this.context = new AudioContext();
    const buffer = await this.context.decodeAudioData(await this.file.arrayBuffer());
    this.node = new AudioBufferSourceNode(this.context, { buffer });
    // Arithmetic-mean downmix happens in the tap (matches the model's training).
    await createTap(this.context, this.node, onChunk);
    if (this.audible) this.node.connect(this.context.destination);
    this.node.onended = () => this.onEnded?.();
    this.startedAt = this.context.currentTime;
    this.node.start();
  }

  stop(): void {
    try {
      this.node?.stop();
    } catch {
      // already stopped
    }
    void this.context?.close();
    this.context = undefined;
  }
}
