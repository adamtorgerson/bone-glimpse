import { type ChunkHandler, createTap, type PcmSource } from './source';

const withTimeout = <T,>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

/**
 * Plays an audio file in real time (optionally audible) and feeds the
 * detector the same stream a mic would (at `sampleRate`), so timing behaves like live.
 * Any format the browser can decode works (wav, mp3, m4a, flac, ogg).
 *
 * start() must be called from a user gesture (a tap): mobile browsers and
 * WebViews keep an AudioContext created outside one suspended, which
 * plays silence forever.
 */
export class FileSource implements PcmSource {
  readonly name: string;
  private context?: AudioContext;
  private node?: AudioBufferSourceNode;
  private startedAt = 0;

  constructor(
    private readonly file: File,
    private readonly audible: boolean,
    readonly sampleRate: number,
    private readonly onEnded?: () => void,
  ) {
    this.name = file.name;
  }

  get position(): number {
    return this.context ? this.context.currentTime - this.startedAt : 0;
  }

  async start(onChunk: ChunkHandler): Promise<void> {
    // Create and resume synchronously, while the tap's user activation is still live.
    const context = new AudioContext();
    this.context = context;
    const resumed = context.resume();
    const bytes = await this.file.arrayBuffer();
    // Callback form: some WebKit WebViews never settle the promise form on failure.
    const buffer = await withTimeout(
      new Promise<AudioBuffer>((resolve, reject) =>
        context.decodeAudioData(bytes, resolve, (e) => reject(new Error(`can't decode ${this.file.type || 'this file'}: ${e?.message ?? 'unsupported format'}`))),
      ),
      30_000,
      'decoding timed out',
    );
    await withTimeout(resumed, 3000, 'audio is blocked by the browser; tap Start again').catch(() => undefined);
    if (context.state !== 'running') throw new Error('audio is blocked by the browser (context suspended); tap Start again');
    this.node = new AudioBufferSourceNode(context, { buffer });
    // Arithmetic-mean downmix happens in the tap (matches the model's training).
    await createTap(context, this.node, onChunk, this.sampleRate);
    if (this.audible) this.node.connect(context.destination);
    this.node.onended = () => this.onEnded?.();
    this.startedAt = context.currentTime;
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
