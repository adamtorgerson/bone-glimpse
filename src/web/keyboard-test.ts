// Standalone G2 test screens for keyboard drawing (keyboard-test.html). No
// audio, no scale player: each screen draws one static scale keyboard, full
// width, with finger rows above (left hand) and below (right hand).
//
//   tap         next screen          double tap   next key (circle of fifths)
//   scroll up   marker one note on   scroll down  marker one note back
//
// Run: npm run dev, then npm run sim:keys (or open /keyboard-test.html in the
// Even app). In a plain browser the page lists the screens and their text.
//
// The screens themselves: src/even/keyboard-test-screens.ts.
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { nextKey, scaleKey } from '../engine/scales';
import { detectEvenBridge } from '../even/bridge';
import { GlassesDisplay } from '../even/glasses-display';
import { type KeyboardDrawing, TEST_SCREENS, testFrame, type TestFrame, type TestState } from '../even/keyboard-test-screens';

/** Draws `drawing` on a canvas (black background, grey shapes). */
const paint = (drawing: KeyboardDrawing): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = drawing.width;
  canvas.height = drawing.height;
  const g = canvas.getContext('2d')!;
  const grey = (level: number): string => `rgb(${level},${level},${level})`;
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (const s of drawing.shapes) {
    if (s.kind === 'rect') {
      // Whole pixels, strokes on pixel centres: crisp edges, no grey fringes.
      const [x, y, w, h] = [Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.round(s.h)];
      const inset = s.stroke === undefined ? 0 : 0.5;
      g.beginPath();
      g.roundRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset, s.radius ?? 0);
      if (s.fill !== undefined) {
        if (typeof s.fill === 'number') g.fillStyle = grey(s.fill);
        else {
          const gradient = g.createLinearGradient(0, y, 0, y + h);
          gradient.addColorStop(0, grey(s.fill[0]));
          gradient.addColorStop(1, grey(s.fill[1]));
          g.fillStyle = gradient;
        }
        g.fill();
      }
      if (s.stroke !== undefined) {
        g.strokeStyle = grey(s.stroke);
        g.lineWidth = s.strokeWidth ?? 1;
        g.stroke();
      }
    } else if (s.kind === 'line') {
      g.strokeStyle = grey(s.level);
      g.lineWidth = s.width ?? 1;
      g.beginPath();
      // Vertical lines on pixel column centres, horizontal ones on row centres.
      const vertical = Math.round(s.x1) === Math.round(s.x2);
      g.moveTo(Math.round(s.x1) + (vertical ? 0.5 : 0), Math.round(s.y1) + (vertical ? 0 : 0.5));
      g.lineTo(Math.round(s.x2) + (vertical ? 0.5 : 0), Math.round(s.y2) + (vertical ? 0 : 0.5));
      g.stroke();
    } else {
      g.fillStyle = grey(s.level);
      g.font = `bold ${s.size}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(s.text, Math.round(s.x), Math.round(s.y));
    }
  }
  return canvas;
};

/** A slice of `canvas` as PNG bytes. */
const png = async (canvas: HTMLCanvasElement, x: number, width: number): Promise<number[]> => {
  const part = document.createElement('canvas');
  part.width = width;
  part.height = canvas.height;
  part.getContext('2d')!.drawImage(canvas, x, 0, width, canvas.height, 0, 0, width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) => part.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'));
  return [...new Uint8Array(await blob.arrayBuffer())];
};

/** Fills in the frame's images (img0 = left half, img1 = right half), cached per layout. */
const images = new Map<string, Promise<{ canvas: HTMLCanvasElement; halves: number[][] }>>();
const withImages = async (test: TestFrame): Promise<HTMLCanvasElement | undefined> => {
  if (!test.drawing) return undefined;
  const drawing = test.drawing;
  let entry = images.get(test.frame.layout);
  if (!entry) {
    entry = (async () => {
      const canvas = paint(drawing);
      return { canvas, halves: await Promise.all([png(canvas, 0, 288), png(canvas, 288, 288)]) };
    })();
    images.set(test.frame.layout, entry);
  }
  const { canvas, halves } = await entry;
  test.frame.page.img0.image = halves[0];
  test.frame.page.img1.image = halves[1];
  return canvas;
};

const main = async (): Promise<void> => {
  const statusEl = document.getElementById('status')!;
  const list = document.getElementById('screens')!;
  const pre = document.getElementById('dump')!;
  const state: TestState = { screen: 0, key: scaleKey('major', 4), step: 0 }; // E major: black keys next to white ones
  let glasses: GlassesDisplay | undefined;

  const preview = document.getElementById('preview')!;
  let renders = 0;
  const render = async (): Promise<void> => {
    const test = testFrame(state);
    const n = ++renders;
    const canvas = await withImages(test);
    if (n !== renders) return; // a later render overtook this one
    glasses?.showFrame(test.frame);
    pre.textContent = test.dump;
    preview.replaceChildren(...(canvas ? [canvas] : []));
    [...list.children].forEach((li, i) => li.classList.toggle('current', i === state.screen));
  };
  const runLength = (): number => 14 * TEST_SCREENS[state.screen].octaves + 1;
  const act = (what: 'next' | 'key' | 'up' | 'down'): void => {
    if (what === 'next') state.screen = (state.screen + 1) % TEST_SCREENS.length;
    else if (what === 'key') state.key = nextKey(state.key);
    else state.step = (state.step + (what === 'up' ? 1 : runLength() - 1)) % runLength();
    void render();
  };

  TEST_SCREENS.forEach((s, i) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.textContent = s.name;
    button.addEventListener('click', () => {
      state.screen = i;
      void render();
    });
    li.append(button);
    list.append(li);
  });
  document.getElementById('next-key')!.addEventListener('click', () => act('key'));
  document.getElementById('step-up')!.addEventListener('click', () => act('up'));
  document.getElementById('step-down')!.addEventListener('click', () => act('down'));
  // ?screen=3&step=1&key=7: start on screen 3, the run's second note, G major.
  const params = new URLSearchParams(location.search);
  const screen = Number(params.get('screen'));
  if (screen >= 1 && screen <= TEST_SCREENS.length) state.screen = screen - 1;
  state.step = Number(params.get('step')) || 0;
  if (params.has('key')) state.key = scaleKey('major', Number(params.get('key')));
  void render();

  const bridge = await detectEvenBridge();
  if (!bridge) {
    statusEl.textContent = 'No glasses: open this page in the Even app or the simulator (npm run sim:keys).';
    return;
  }
  glasses = new GlassesDisplay(bridge);
  const first = testFrame(state);
  await withImages(first);
  await glasses.create(first.frame.page, first.frame.layout);
  statusEl.textContent = 'Connected: tap = next screen, double tap = next key, scroll = move the marker.';
  bridge.onEvenHubEvent((event) => {
    const gesture = event.textEvent ?? event.sysEvent;
    if (!gesture) return;
    const type = gesture.eventType ?? OsEventTypeList.CLICK_EVENT; // the SDK turns CLICK_EVENT (0) into undefined
    if (type === OsEventTypeList.CLICK_EVENT) act('next');
    else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) act('key');
    else if (type === OsEventTypeList.SCROLL_TOP_EVENT) act('down');
    else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) act('up');
  });
};
void main();
