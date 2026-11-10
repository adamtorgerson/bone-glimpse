// The G2 HUD for live chord detection. Text containers only: they update in
// place (textContainerUpgrade) much faster than images (~800 ms full refresh).
//
//   ┌───────────────────────────────────────────┐  576 x 288
//   │ Am7                                       │  chord   (brightness = confidence)
//   │ A  C  E  G  → next F in 2s                │  detail  (tones, next-chord prediction,
//   │ 80% · maybe Am7 · key C                   │           confidence, key)
//   │                                           │
//   │ G 12s · C 8s · Am 5s · F 2s               │  status  (last 4 chords + age, mic, lag; captures input)
//   │ glasses mic · ~1.1 s behind · tap=pause   │
//   └───────────────────────────────────────────┘
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';

type Slot = { id: number; name: string; content: string; color: number; sent?: { content: string; color: number } };

const container = (slot: Slot, y: number, height: number, capture: boolean): TextContainerProperty =>
  new TextContainerProperty({
    xPosition: 12,
    yPosition: y,
    width: 552,
    height,
    borderWidth: 0,
    paddingLength: 4,
    containerID: slot.id,
    containerName: slot.name,
    content: slot.content,
    textColor: slot.color,
    isEventCapture: capture ? 1 : 0,
  });

export class GlassesDisplay {
  private readonly slots = {
    chord: { id: 1, name: 'chord', content: 'BoneGlimpse', color: 4 } as Slot,
    detail: { id: 2, name: 'detail', content: 'loading chord model…', color: 2 } as Slot,
    status: { id: 3, name: 'status', content: ' ', color: 2 } as Slot,
  };
  private flushing = false;
  private dirty = false;

  constructor(private readonly bridge: EvenAppBridge) {}

  /**
   * Must run before the glasses mic can be opened. If the page already exists
   * (e.g. after a WebView reload), the start-up page is rejected and we rebuild instead.
   */
  async create(): Promise<void> {
    const { chord, detail, status } = this.slots;
    const page = {
      containerTotalNum: 3,
      textObject: [container(chord, 8, 56, false), container(detail, 64, 110, false), container(status, 186, 100, true)],
    };
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page));
    if (result !== StartUpPageCreateResult.success) {
      const rebuilt = await this.bridge.rebuildPageContainer(new RebuildPageContainer(page));
      if (!rebuilt) throw new Error(`creating the glasses page failed (${StartUpPageCreateResult[result] ?? result})`);
    }
    for (const slot of Object.values(this.slots)) slot.sent = { content: slot.content, color: slot.color };
  }

  set(name: keyof GlassesDisplay['slots'], content: string, color?: number): void {
    const slot = this.slots[name];
    slot.content = content || ' ';
    if (color !== undefined) slot.color = Math.max(0, Math.min(4, Math.round(color)));
    this.dirty = true;
    void this.flush();
  }

  /** Sends changed containers one call at a time, always with the latest content. */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.dirty) {
        this.dirty = false;
        for (const slot of Object.values(this.slots)) {
          if (slot.sent && slot.sent.content === slot.content && slot.sent.color === slot.color) continue;
          const next = { content: slot.content, color: slot.color };
          const ok = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: slot.id,
              containerName: slot.name,
              content: next.content,
              textColor: next.color,
            }),
          );
          if (ok) slot.sent = next;
          else this.scheduleRetry();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private retryTimer?: ReturnType<typeof setTimeout>;
  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.dirty = true;
      void this.flush();
    }, 500);
  }
}
