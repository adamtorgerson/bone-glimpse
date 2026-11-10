// The G2 HUD. Text containers only: they update in place
// (textContainerUpgrade) much faster than images (~800 ms full refresh).
// One page per mode; switching rebuilds the page. The chord-detection page:
//
//   ┌───────────────────────────────────────────┐  576 x 288
//   │ chord Am · 70% · maybe Am7                │  chord   (brightness = confidence; "?" = unsure,
//   │                                           │           "maybe" = fell back to the triad)
//   │ tones A C E · next F in 2s                │  detail  (chord tones, next-chord prediction,
//   │ key C · note E5 80%                       │           key, the one note that stands out)
//   │ last G* 12s · Cx 8s · Am* 5s · F* 2s      │  status  (last 4 chords + age, * / x = predicted?,
//   │ mic glasses · lag 1.1s · look 372 ms ·    │           mic, lag, lookahead, prediction hit
//   │ hits 75%                                  │           rate; captures input)
//   └───────────────────────────────────────────┘
import {
  CreateStartUpPageContainer,
  type EvenAppBridge,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';

type Slot = { id: number; name: string; content: string; color: number; sent?: { content: string; color: number } };

/**
 * A container on a page: position (x 12, width 552 unless given), initial
 * text and brightness (0–4), optional border (colour = brightness 0–15). One
 * text container per page captures input. Limits: 12 containers, 8 of them text.
 *
 * kind "box" is an empty list container: just its border, no text (content
 * and colour are ignored). It is how key outlines are drawn without images.
 * Containers are transparent and stack in page order (later = in front).
 */
export type SlotSpec = {
  kind?: 'text' | 'box';
  y: number;
  height: number;
  content: string;
  color: number;
  capture?: boolean;
  x?: number;
  width?: number;
  padding?: number;
  border?: { width: number; color: number; radius?: number };
};
export type Page<N extends string = string> = Record<N, SlotSpec>;

/**
 * A whole page with its content. `layout` names the geometry (positions,
 * sizes, borders): frames with the same layout are sent as text updates, a
 * different layout rebuilds the page.
 */
export type Frame = { layout: string; page: Page };

/** The live chord-detection page (see the diagram above). */
export const CHORD_PAGE = {
  chord: { y: 8, height: 56, content: 'BoneGlimpse', color: 4 },
  detail: { y: 64, height: 110, content: 'loading chord model…', color: 2 },
  status: { y: 186, height: 100, content: ' ', color: 2, capture: true },
} satisfies Page;
export type ChordSlot = keyof typeof CHORD_PAGE;

const box = (slot: Slot, spec: SlotSpec, z?: number): ListContainerProperty =>
  new ListContainerProperty({
    xPosition: spec.x ?? 12,
    yPosition: spec.y,
    width: spec.width ?? 552,
    height: spec.height,
    borderWidth: spec.border?.width ?? 1,
    borderColor: spec.border?.color ?? 8,
    borderRadius: spec.border?.radius ?? 0,
    paddingLength: 0,
    containerID: slot.id,
    containerName: slot.name,
    itemContainer: new ListItemContainerProperty({ itemCount: 0 }),
    isEventCapture: 0,
    zOrderIndex: z,
  });

const container = (slot: Slot, spec: SlotSpec, z?: number): TextContainerProperty =>
  new TextContainerProperty({
    zOrderIndex: z,
    xPosition: spec.x ?? 12,
    yPosition: spec.y,
    width: spec.width ?? 552,
    height: spec.height,
    borderWidth: spec.border?.width ?? 0,
    borderColor: spec.border?.color ?? 0,
    borderRadius: spec.border?.radius ?? 0,
    paddingLength: spec.padding ?? 4,
    containerID: slot.id,
    containerName: slot.name,
    content: slot.content,
    textColor: slot.color,
    isEventCapture: spec.capture ? 1 : 0,
  });

export class GlassesDisplay {
  private slots = new Map<string, Slot>();
  /** Layout of the page on the glasses (see Frame); undefined for pages shown without one. */
  private layout?: string;
  private flushing = false;
  private dirty = false;

  constructor(private readonly bridge: EvenAppBridge) {}

  private build(page: Page): { containerTotalNum: number; textObject: TextContainerProperty[]; listObject?: ListContainerProperty[] } {
    const entries = Object.entries(page);
    // Text slots only: boxes have no content to update.
    this.slots = new Map(
      entries.flatMap(([name, spec], i) => (spec.kind === 'box' ? [] : [[name, { id: i + 1, name, content: spec.content || ' ', color: spec.color }] as const])),
    );
    const boxes = entries.some(([, spec]) => spec.kind === 'box');
    // z-order is all-or-nothing per page; only pages with boxes need it (later entries in front).
    const z = (i: number): number | undefined => (boxes ? i + 1 : undefined);
    const textObject = entries.flatMap(([name, spec], i) => (spec.kind === 'box' ? [] : [container(this.slots.get(name)!, spec, z(i))]));
    const listObject = entries.flatMap(([name, spec], i) =>
      spec.kind === 'box' ? [box({ id: i + 1, name, content: '', color: 0 }, spec, z(i))] : [],
    );
    return { containerTotalNum: entries.length, textObject, ...(listObject.length ? { listObject } : {}) };
  }

  /**
   * Must run before the glasses mic can be opened. If the page already exists
   * (e.g. after a WebView reload), the start-up page is rejected and we rebuild instead.
   */
  async create(page: Page = CHORD_PAGE, layout?: string): Promise<void> {
    const built = this.build(page);
    this.layout = layout;
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(built));
    if (result !== StartUpPageCreateResult.success) {
      const rebuilt = await this.bridge.rebuildPageContainer(new RebuildPageContainer(built));
      if (!rebuilt) throw new Error(`creating the glasses page failed (${StartUpPageCreateResult[result] ?? result})`);
    }
    this.markSent(page);
  }

  /** The page's initial content is on the glasses; anything set since then goes out next. */
  private markSent(page: Page): void {
    for (const [name, spec] of Object.entries(page)) {
      const slot = this.slots.get(name);
      if (slot) slot.sent = { content: spec.content || ' ', color: spec.color };
    }
    this.dirty = true;
    void this.flush();
  }

  /** Replaces the whole page (e.g. chord mode ↔ scale mode). Updates for slots not on it are ignored. */
  async show(page: Page, layout?: string): Promise<void> {
    const built = this.build(page);
    this.layout = layout;
    const slots = this.slots;
    if (!(await this.bridge.rebuildPageContainer(new RebuildPageContainer(built)))) throw new Error('switching the glasses page failed');
    if (this.slots === slots) this.markSent(page); // unless another show() overtook this one
  }

  /** Shows a frame: text updates when the layout is unchanged, otherwise a page rebuild. */
  showFrame(frame: Frame): void {
    if (frame.layout !== this.layout) {
      this.show(frame.page, frame.layout).catch(() => {
        this.layout = undefined; // try again with the next frame
      });
      return;
    }
    for (const [name, spec] of Object.entries(frame.page)) this.set(name, spec.content, spec.color);
  }

  set(name: string, content: string, color?: number): void {
    const slot = this.slots.get(name);
    if (!slot) return;
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
        for (const slot of this.slots.values()) {
          if (!slot.sent || (slot.sent.content === slot.content && slot.sent.color === slot.color)) continue;
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
