// Test screens for keyboard drawing on the G2 (see src/web/keyboard-test.ts,
// keyboard-test.html). Each screen draws one static scale keyboard across the
// full width, fingers above (left hand) and below (right hand).
//
// Glyphs (measured in evenhub-simulator 0.9.5): rows are 27 px apart and block
// glyphs 21 px tall, so text rows stacked 20 px apart (one container each) make
// black keys and key boundaries continuous. Spaces are 5 px. The block glyphs
// advance 20 px; their ink differs: █ 0–20, ▉ 0–15, ▊ 0–13, ▌ 0–10, │ 9–11.
// Lines wrap past 576 px; a text container holds at most 999 bytes.
//
// Image screens draw the keyboard as two 288 px wide images side by side
// (images are at most 288 x 144, 4 a page). The drawing is a list of shapes
// (KeyboardDrawing) that the page renders to PNG; it stays put for the whole
// run, so only the marker (text) changes from note to note.
import { type KeyboardKey, type KeyboardView, keyboardView, type RunNote, scaleRun, type ScaleKey } from '../engine/scales';
import { type Frame, type Page } from './glasses-display';
import { keyboardText } from './keyboard-text';
import { widenedView } from './scale-views';

type BlackGlyph = '█' | '▉' | '▊' | '▌';
export type TestScreen = {
  name: string;
  octaves: 2 | 3 | 4 | 5;
  /** Fewest white keys to show (the run widened by whole key groups); 0 = just the run. */
  minWhites: number;
  /** Classic: the scale view's 3-line text keyboard (27 px rows, no outline). */
  classic?: boolean;
  black?: BlackGlyph;
  /**
   * Where fingers go. 1: one row per hand. 2: two rows per hand, black-key
   * fingers on the outer one (so nothing collides at 3 octaves). keys: black-key
   * fingers on the black keys themselves (L row above R row), white-key fingers
   * one row per hand.
   */
  tiers?: 1 | 2 | 'keys';
  /** Black-key rows (21 px each, stacked). */
  blackRows?: 2 | 3;
  /** Boundaries between white keys with no black key (E|F, B|C) also in the black-key rows (default yes; at 4 octaves they do not fit). */
  blackZoneLines?: false;
  /**
   * Styling for the stacked text keyboards (see STYLED below).
   * dim: brightness by importance (key lines, outline, status dimmer than keys and fingers);
   *   the black-key rows then have no boundary lines (a container has one brightness).
   * rail: a solid bar along the top (a box with a border thicker than half its height).
   * lip: ▂ at the front of each white key, short of its edges; below 30 px a key, _ (6 px, 1 px tall), as ▂ (20 px) would nearly touch.
   * tip: a glyph under each black key, half over its last row: ● rounds it, ▼ points it.
   * marker: the white-key marker (● clashes with ● tips).
   */
  style?: { dim?: boolean; rail?: boolean; lip?: boolean; tip?: '●' | '▼'; marker?: '●' | '◆' };
  /**
   * allKeys: text, every finger on its key (L row above R row, black and white).
   * image: the keyboard as an image, fingers in text rows. imageFingers: keyboard and fingers in the image.
   * groups / octaves: boxes (bordered list containers) outline each key group (C–E, F–B) / octave.
   */
  special?: 'allKeys' | 'image' | 'imageFingers' | 'groups' | 'octaves' | 'stacked';
  /**
   * Which keys and fingers to show, for runs wider than the screen. window: 3
   * octaves (C to C) around the note, moving by whole octaves, so the layout
   * never changes (text updates only). near: every key, fingers only on the
   * next few notes.
   */
  range?: 'window' | 'near';
};

/**
 * Grey levels 0–255 (the glasses show 16). Coordinates in keyboard pixels, 0–576 across.
 * A rect's fill may be a vertical gradient [top, bottom]; its radius one value or
 * [top-left, top-right, bottom-right, bottom-left].
 */
export type Shape =
  | {
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: number | [number, number];
      stroke?: number;
      strokeWidth?: number;
      radius?: number | [number, number, number, number];
    }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; level: number; width?: number }
  | { kind: 'text'; x: number; y: number; text: string; size: number; level: number };
/** What image containers img0, img1 show: one picture, split down the middle. */
export type KeyboardDrawing = { width: number; height: number; shapes: Shape[] };

export const TEST_SCREENS: TestScreen[] = [
  { name: '2 oct · classic text (current view)', octaves: 2, minWhites: 0, classic: true },
  { name: '2 oct · solid, tonic to tonic', octaves: 2, minWhites: 0, black: '█', tiers: 1, blackRows: 2 },
  { name: '2 oct · solid, whole key groups', octaves: 2, minWhites: 17, black: '█', tiers: 1, blackRows: 2 },
  { name: '2 oct · slim blacks, whole key groups', octaves: 2, minWhites: 17, black: '▊', tiers: 1, blackRows: 2 },
  { name: '2 oct · tall slim blacks', octaves: 2, minWhites: 17, black: '▉', tiers: 1, blackRows: 3 },
  { name: '3 oct · solid, 2 finger rows', octaves: 3, minWhites: 0, black: '█', tiers: 2, blackRows: 2 },
  { name: '3 oct · slim blacks, whole groups, 2 finger rows', octaves: 3, minWhites: 22, black: '▊', tiers: 2, blackRows: 2 },
  { name: '3 oct · fingers on black keys', octaves: 3, minWhites: 22, black: '▌', tiers: 'keys', blackRows: 3 },
  { name: '3 oct · fingers on all keys', octaves: 3, minWhites: 22, black: '▊', special: 'allKeys' },
  { name: '3 oct · image keyboard, text fingers', octaves: 3, minWhites: 22, special: 'image' },
  { name: '3 oct · image keyboard, fingers drawn in', octaves: 3, minWhites: 22, special: 'imageFingers' },
  { name: '3 oct · box per key group', octaves: 3, minWhites: 22, black: '▊', special: 'groups' },
  { name: '3 oct · box per octave, framed fingers', octaves: 3, minWhites: 22, black: '▊', special: 'octaves' },
  { name: '4 oct · text, thin blacks', octaves: 4, minWhites: 0, black: '▌', tiers: 2, blackRows: 2, blackZoneLines: false },
  { name: '4 oct · 3 oct window, moves by octaves', octaves: 4, minWhites: 0, black: '▊', tiers: 2, blackRows: 2, range: 'window' },
  { name: '4 oct · two keyboards, low above high', octaves: 4, minWhites: 0, special: 'stacked' },
  { name: '4 oct · fingers for the next notes only', octaves: 4, minWhites: 0, black: '▌', tiers: 2, blackRows: 2, blackZoneLines: false, range: 'near' },
  { name: '5 oct · image, fingers drawn in', octaves: 5, minWhites: 0, special: 'imageFingers' },
  // STYLED: the same text keyboards with the cheap styling tricks.
  { name: '2 oct · styled, round tips', octaves: 2, minWhites: 17, black: '█', tiers: 1, blackRows: 2, style: { dim: true, rail: true, lip: true, tip: '●', marker: '◆' } },
  { name: '2 oct · styled, pointed tips', octaves: 2, minWhites: 17, black: '█', tiers: 1, blackRows: 2, style: { dim: true, rail: true, lip: true, tip: '▼', marker: '●' } },
  { name: '3 oct · styled', octaves: 3, minWhites: 22, black: '▊', tiers: 2, blackRows: 2, style: { dim: true, rail: true, lip: true, marker: '◆' } },
  { name: '4 oct · text, dimmed lines', octaves: 4, minWhites: 0, black: '▌', tiers: 2, blackRows: 2, blackZoneLines: false, style: { dim: true } },
];

const W = 576;
/** Glyph top below a text container's y when its padding is 0. */
const TOP = 4;
const ROW = 27;
const GLYPH = 21;
/** Pitch of stacked key rows: 1 px overlap hides the dim antialiased edge between them. */
const STACK = 20;
const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
/** Ink centre of a glyph within its 20 px advance. */
const INK_CENTRE: Record<string, number> = { '█': 10, '▉': 7.5, '▊': 6.5, '▌': 5, '│': 10, _: 3 };

const SPACE = 5;
/**
 * Advance widths measured here (simulator 0.9.5), not the shared table in
 * keyboard-text.ts: spaces are 5 px, and digits spaced out in a finger row
 * are wider than next to each other (they kern there). Other glyphs used: 20 px.
 */
const WIDTH: Record<string, number> = { ' ': SPACE, _: 9, '1': 8.125, '2': 12, '3': 12.875, '4': 12, '5': 12.875, R: 12.875, L: 9 };
export const textWidth = (text: string): number => [...text].reduce((w, ch) => w + (WIDTH[ch] ?? 20), 0);
/** Rightmost x a line may reach: lines wrap past 576 px. */
const LINE_END = 574;
/** The same for finger rows, with a little room for the digits' fractional widths. */
const FINGER_LINE_END = 572;

/**
 * One line with each glyph's ink (not its advance box) centred on x, to the
 * nearest space (5 px), kept within the line. (Glyphs the font lacks draw as
 * a 4 px gap, which could place to 1 px, but the wrapper miscounts them.)
 */
export const place = (items: { x: number; text: string }[], end = LINE_END): string => {
  let line = '';
  let cursor = 0;
  for (const { x, text } of [...items].sort((a, b) => a.x - b.x)) {
    const w = textWidth(text);
    const start = Math.min(end - w, x - (INK_CENTRE[text] ?? w / 2));
    const spaces = Math.max(0, Math.round((start - cursor) / SPACE));
    line += ' '.repeat(spaces) + text;
    cursor += spaces * SPACE + w;
  }
  return line || ' ';
};

const text = (y: number, lines: string[], color = 4, extra: Partial<Page[string]> = {}): Page[string] => ({
  x: 0, width: W, y: Math.round(y), height: lines.length * ROW + 6, padding: 0, content: lines.join('\n'), color, ...extra,
});

export type TestState = { screen: number; key: ScaleKey; step: number };

export type TestFrame = { frame: Frame; dump: string; drawing?: KeyboardDrawing };

export const testFrame = ({ screen, key, step }: TestState): TestFrame => {
  const s = TEST_SCREENS[screen];
  const run = scaleRun(key, { octaves: s.octaves, hands: 'both' });
  const note: RunNote = run[step % run.length];
  const base = keyboardView(run);
  const current = note.right!.midi;
  const full: KeyboardView = s.minWhites ? widenedView(base, s.minWhites) : base;
  const window = s.range === 'window' ? octaveWindow(full, current) : undefined;
  const view: KeyboardView = window?.view ?? (s.range === 'near' ? nearFingers(full, run, step % run.length) : full);
  const title = s.name;
  const info = `${screen + 1}/${TEST_SCREENS.length} ${key.display} · ${view.whites.length} keys${window ? ` ${window.overview}` : ''} · now ${note.name} R${note.right!.finger} L${note.left!.finger}`;
  if (s.special === 'stacked') return stackedFrame(screen, view, current, title, info);

  if (s.classic) {
    const t = keyboardText(view, current, W - 8);
    const page: Page = {
      left: { x: 0, width: W, y: 0, height: 62, content: `L\n${t.left}`, color: 4 },
      keys: { x: 0, width: W, y: 56, height: 92, content: t.keys, color: 2 },
      right: { x: 0, width: W, y: 139, height: 62, content: `${t.right}\nR`, color: 4 },
      status: { x: 0, width: W, y: 214, height: 62, content: `${title}\n${info}`, color: 3, capture: true },
    };
    return { frame: { layout: `s${screen}`, page }, dump: [t.left, t.keys, t.right].join('\n') };
  }

  if (s.special) return specialFrame(s, { screen, key, step }, view, note, title, info);

  // White key i spans edge(i)..edge(i+1); the outline box draws the outer edges.
  const n = view.whites.length;
  const kw = W / n;
  const edge = (i: number): number => kw * i;
  const whiteX = (i: number): number => edge(i + 0.5);
  const blackX = (b: KeyboardKey): number => edge(b.afterWhite! + 1);
  const blackAt = new Set(view.blacks.map((b) => b.afterWhite! + 1));
  const inner = Array.from({ length: n - 1 }, (_, i) => i + 1);

  const black = s.black!;
  const onKeys = s.tiers === 'keys';
  const style = s.style ?? {};
  // Black-key rows, top to bottom. The current black key: ○ at its tip, or on
  // the top row when the lower rows carry fingers (L, then R).
  const blackRow = (r: number): string => {
    const glyph = (b: KeyboardKey): string => {
      const hand = onKeys ? ([undefined, 'left', 'right'] as const)[r] : undefined;
      if (hand) return b[hand] ? CIRCLED[b[hand]!] : black;
      return b.midi === current && !style.tip && r === (onKeys ? 0 : s.blackRows! - 1) ? '○' : black;
    };
    return place([
      ...view.blacks.map((b) => ({ x: blackX(b), text: glyph(b) })),
      ...(s.blackZoneLines === false || style.dim ? [] : inner.filter((i) => !blackAt.has(i)).map((i) => ({ x: edge(i), text: '│' }))),
    ]);
  };
  // Tips: the current key's tip is hollow.
  const hollow = { '●': '○', '▼': '▽' } as const;
  const tipRow = style.tip ? place(view.blacks.map((b) => ({ x: blackX(b), text: b.midi === current ? hollow[style.tip!] : style.tip! }))) : undefined;
  const currentWhite = view.whites.findIndex((w) => w.midi === current);
  // Below 20 px a key, │ glyphs (20 px advances) do not fit side by side: every
  // other boundary goes on a second row laid over the first.
  const split = kw < 20.5;
  const whiteRow = place(inner.filter((i) => !split || i % 2 === 0).map((i) => ({ x: edge(i), text: '│' })));
  const whiteRow2 = split ? place(inner.filter((i) => i % 2 === 1).map((i) => ({ x: edge(i), text: '│' }))) : undefined;
  // The ● goes on a row of its own laid over the white-key row: at 3 octaves it
  // and the boundary lines either side (20 px advances each) do not fit in one line.
  // With lips, the marker takes the current key's lip (one row for both).
  const markerGlyph = style.marker ?? '●';
  const markerRow = style.lip
    ? place(view.whites.map((_, i) => ({ x: whiteX(i), text: i === currentWhite ? markerGlyph : kw >= 30 ? '▂' : '_' })))
    : currentWhite >= 0
      ? place([{ x: whiteX(currentWhite), text: markerGlyph }])
      : ' ';
  const whiteFingers = (hand: 'left' | 'right'): string =>
    place(view.whites.flatMap((w, i) => (w[hand] ? [{ x: whiteX(i), text: String(w[hand]) }] : [])), FINGER_LINE_END);
  const blackFingers = (hand: 'left' | 'right'): string =>
    place(view.blacks.flatMap((b) => (b[hand] ? [{ x: blackX(b), text: CIRCLED[b[hand]!] }] : [])), FINGER_LINE_END);
  const bothFingers = (hand: 'left' | 'right'): string =>
    place([
      ...view.whites.flatMap((w, i) => (w[hand] ? [{ x: whiteX(i), text: String(w[hand]) }] : [])),
      ...view.blacks.flatMap((b) => (b[hand] ? [{ x: blackX(b), text: CIRCLED[b[hand]!] }] : [])),
    ], FINGER_LINE_END);
  // Black-key fingers on the outer row: L above them, R below them.
  const leftLines =
    s.tiers === 2 ? ['L', blackFingers('left'), whiteFingers('left')] : onKeys ? ['L', whiteFingers('left')] : ['L', bothFingers('left')];
  const rightLines =
    s.tiers === 2 ? [whiteFingers('right'), blackFingers('right'), 'R'] : onKeys ? [whiteFingers('right'), 'R'] : [bothFingers('right'), 'R'];

  const page: Page = {};
  const kbTop = TOP + (leftLines.length - 1) * ROW + GLYPH + 5; // outline top
  const rows = [...Array.from({ length: s.blackRows! }, (_, r) => blackRow(r)), whiteRow];
  const kbBottom = kbTop + 3 + (rows.length - 1) * STACK + GLYPH + 3;
  page.outline = { kind: 'box', x: 0, width: W, y: kbTop, height: kbBottom - kbTop, content: '', color: 0, border: { width: 2, color: style.dim ? 6 : 15, radius: style.dim ? 6 : 3 } };
  if (style.rail) page.rail = { kind: 'box', x: 0, width: W, y: kbTop, height: 4, content: '', color: 0, border: { width: 2, color: 12, radius: 1 } };
  page.left = text(0, leftLines);
  const lineColour = style.dim ? 2 : 4;
  rows.forEach((row, r) => {
    page[`row${r}`] = text(kbTop + 3 + r * STACK - TOP, [row], r === rows.length - 1 ? lineColour : 4, { height: GLYPH + 6 });
  });
  if (whiteRow2) page.row2b = text(kbTop + 3 + (rows.length - 1) * STACK - TOP, [whiteRow2], lineColour, { height: GLYPH + 6 });
  if (tipRow) page.tip = text(kbTop + 3 + (rows.length - 1) * STACK - 10 - TOP, [tipRow], 4, { height: GLYPH + 6 });
  page.marker = text(kbTop + 3 + (rows.length - 1) * STACK - TOP, [markerRow], 4, { height: GLYPH + 6 });
  const rightY = kbBottom + 5 - TOP;
  page.right = text(rightY, rightLines);
  // Status at the bottom: two lines when they fit, else just the key and the note.
  const free = rightY + rightLines.length * ROW;
  const statusLines = free <= 288 - 2 * ROW - 6 ? [title, info] : [info];
  page.status = text(Math.max(free, 288 - statusLines.length * ROW - 6), statusLines, style.dim ? 2 : 3, { capture: true });
  return {
    frame: { layout: `s${screen}`, page },
    dump: [...leftLines, ...rows, ...(whiteRow2 ? [whiteRow2] : []), ...(tipRow ? [tipRow] : []), markerRow, ...rightLines].join('\n'),
  };
};


/** Key positions for `view` spread across the screen: white key i spans edge(i)..edge(i + 1). */
const geometry = (view: KeyboardView) => {
  const n = view.whites.length;
  const kw = W / n;
  const edge = (i: number): number => kw * i;
  return {
    n,
    kw,
    edge,
    whiteX: (i: number): number => edge(i + 0.5),
    blackX: (b: KeyboardKey): number => edge(b.afterWhite! + 1),
    blackAt: new Set(view.blacks.map((b) => b.afterWhite! + 1)),
    inner: Array.from({ length: n - 1 }, (_, i) => i + 1),
  };
};

type Hand = 'left' | 'right';

const specialFrame = (s: TestScreen, { screen, key }: TestState, view: KeyboardView, note: RunNote, title: string, info: string): TestFrame => {
  const { kw, edge, whiteX, blackX, blackAt, inner } = geometry(view);
  const current = note.right!.midi;
  const currentKey = view.byMidi.get(current);
  /** x of the key to play: a white key's centre, or a black key's (on the boundary under it). */
  const currentX = !currentKey ? undefined : currentKey.black ? blackX(currentKey) : whiteX(view.whites.indexOf(currentKey));
  const markerRow = currentX === undefined ? ' ' : place([{ x: currentX, text: '●' }]);
  const whiteFingers = (hand: Hand): string =>
    place(view.whites.flatMap((w, i) => (w[hand] ? [{ x: whiteX(i), text: String(w[hand]) }] : [])), FINGER_LINE_END);
  const blackFingers = (hand: Hand): string =>
    place(view.blacks.flatMap((b) => (b[hand] ? [{ x: blackX(b), text: CIRCLED[b[hand]!] }] : [])), FINGER_LINE_END);
  const page: Page = {};

  if (s.special === 'allKeys') {
    // Black zone: body row (○ = to play), L fingers, R fingers. White zone: boundary
    // lines in three stacked rows, with the L and R digits laid over them (a digit
    // between two │ does not fit in one line at 3 octaves). The ● under the keyboard
    // points at the key to play, black or white.
    const body = s.black!;
    const separators = (all: boolean): { x: number; text: string }[] =>
      inner.filter((i) => all || !blackAt.has(i)).map((i) => ({ x: edge(i), text: '│' }));
    const blackRow = (hand?: Hand): string =>
      place([
        ...view.blacks.map((b) => ({ x: blackX(b), text: hand ? (b[hand] ? CIRCLED[b[hand]!] : body) : b.midi === current ? '○' : body })),
        ...separators(false),
      ]);
    const kbTop = 2;
    const rowTop = (r: number): number => kbTop + 3 + r * STACK;
    const rows = [blackRow(), blackRow('left'), blackRow('right'), ...[0, 1, 2].map(() => place(separators(true)))];
    rows.forEach((row, r) => {
      page[`row${r}`] = text(rowTop(r) - TOP, [row], 4, { height: GLYPH + 6 });
    });
    const digits = [whiteFingers('left'), whiteFingers('right')];
    page.digits = text(rowTop(3) + 2 - TOP, digits);
    const kbBottom = rowTop(5) + GLYPH + 3;
    page.outline = { kind: 'box', x: 0, width: W, y: kbTop, height: kbBottom - kbTop, content: '', color: 0, border: { width: 2, color: 15, radius: 3 } };
    page.status = text(kbBottom + 2 - TOP, [markerRow, `${title} · L above R`, info], 3, { capture: true });
    return { frame: { layout: `s${screen}`, page }, dump: [...rows, ...digits, markerRow].join('\n') };
  }

  if (s.special === 'groups' || s.special === 'octaves') return boxFrame(s, screen, view, note, title, info);

  // Image keyboards: white keys outlined, black keys filled, real proportions.
  const shapes: Shape[] = [];
  const drawKeys = (height: number, blackHeight: number): void => {
    // A rail across the top, then each white key on its own: an outline rounded
    // at the bottom, 2 px from the next, with a lit front lip. No gradients: the
    // glasses show grey in a few steps, brightened (34 of 255 already reads as
    // mid grey), so a gradient bands and swamps the digits.
    const rail = 3;
    shapes.push({ kind: 'rect', x: 0, y: 0, w: W, h: rail, fill: 170, radius: 1 });
    const round = Math.max(2, Math.round(kw / 6));
    const lip = 5;
    view.whites.forEach((_, i) => {
      const x0 = Math.round(edge(i)) + 1;
      const x1 = Math.round(edge(i + 1)) - 1;
      shapes.push({ kind: 'rect', x: x0, y: rail + 1, w: x1 - x0, h: height - rail - 2, stroke: 130, radius: [0, 0, round, round] });
      shapes.push({ kind: 'rect', x: x0 + 1, y: height - 1 - lip, w: x1 - x0 - 2, h: lip, fill: 60, radius: [0, 0, round, round] });
    });
    // Black keys: 60% of a white key wide, rounded tips, outlined in black to
    // stand off the white keys, a dark line setting off the tip.
    const bw = Math.round(kw * 0.6);
    for (const b of view.blacks) {
      const x = Math.round(blackX(b) - bw / 2);
      shapes.push({ kind: 'rect', x: x - 1, y: rail, w: bw + 2, h: blackHeight + 1, fill: 0, radius: [0, 0, round, round] });
      shapes.push({ kind: 'rect', x, y: rail, w: bw, h: blackHeight - 1, fill: 255, radius: [0, 0, round, round] });
      shapes.push({ kind: 'line', x1: x + 1, y1: blackHeight - 7, x2: x + bw - 2, y2: blackHeight - 7, level: 0 });
    }
  };
  const images = (y: number, height: number): void => {
    page.img0 = { kind: 'image', x: 0, width: 288, y, height, content: '', color: 0 };
    page.img1 = { kind: 'image', x: 288, width: 288, y, height, content: '', color: 0 };
  };
  const layout = `s${screen}:${key.type}:${key.tonic}`; // a new key redraws the images

  if (s.special === 'image') {
    // L: black-key fingers (outer), white-key fingers; the keyboard; R: white, black.
    // The ● sits in the white zone: on a white key, or under a black key's tip.
    const height = 110;
    const blackHeight = 66;
    const leftLines = [blackFingers('left'), whiteFingers('left')];
    const rightLines = [whiteFingers('right'), blackFingers('right')];
    page.left = text(0, leftLines);
    const kbY = TOP + ROW + GLYPH + 4;
    images(kbY, height);
    drawKeys(height, blackHeight);
    page.marker = text(kbY + blackHeight + (height - blackHeight - GLYPH) / 2 - TOP, [markerRow], 4, { height: GLYPH + 6 });
    page.right = text(kbY + height + 4 - TOP, rightLines);
    page.status = text(288 - 2 * ROW - 6, [`${title} · L above, R below`, info], 3, { capture: true });
    return { frame: { layout, page }, dump: [...leftLines, markerRow, ...rightLines].join('\n'), drawing: { width: W, height, shapes } };
  }

  // Fingers drawn in: on each key, L above R. Digits on black keys are dark on the key.
  const height = 144;
  const blackHeight = 88;
  drawKeys(height, blackHeight);
  const size = Math.min(17, Math.round(kw * 0.75)); // digits narrower than the keys
  view.whites.forEach((w, i) => {
    if (w.left) shapes.push({ kind: 'text', x: whiteX(i), y: blackHeight + 16, text: String(w.left), size, level: 255 });
    if (w.right) shapes.push({ kind: 'text', x: whiteX(i), y: height - 18, text: String(w.right), size, level: 255 });
  });
  for (const b of view.blacks) {
    if (b.left) shapes.push({ kind: 'text', x: blackX(b), y: 22, text: String(b.left), size, level: 0 });
    if (b.right) shapes.push({ kind: 'text', x: blackX(b), y: blackHeight - 20, text: String(b.right), size, level: 0 });
  }
  page.title = text(0, [`${title} · L above R`], 3);
  const kbY = TOP + GLYPH + 6;
  images(kbY, height);
  page.marker = text(kbY + height + 2 - TOP, [markerRow], 4, { height: GLYPH + 6 });
  page.status = text(kbY + height + ROW, [info], 3, { capture: true });
  return { frame: { layout, page }, dump: markerRow, drawing: { width: W, height, shapes } };
};

/** White-key index ranges [first, last] of each key group (C–E, F–B) or octave (C–B) in `view`. */
const spans = (view: KeyboardView, ends: (midi: number) => boolean): [number, number][] => {
  const out: [number, number][] = [];
  view.whites.forEach((_, i) => {
    if (i === 0 || ends(view.whites[i - 1].midi)) out.push([i, i]);
    else out[out.length - 1][1] = i;
  });
  return out;
};

/**
 * Keyboards outlined with boxes: list containers with only a border, placed to
 * the pixel. The boxes draw the boundaries text does badly (long, continuous,
 * exactly placed); text draws the black keys, the short boundaries under them,
 * the marker and the fingers. A page holds 12 containers, 8 of them text.
 *
 * groups   one rounded box per C–E / F–B group, 2 px apart (up to 7 boxes);
 *          the boundaries under the black keys are short │ lines, left out
 *          next to the ● so it fits (5 text containers).
 * octaves  one rounded box per octave (C–B), the E|F boundary in text; the
 *          finger rows in bordered text containers (bands), the ● on a row of
 *          its own (7 text containers).
 */
const boxFrame = (s: TestScreen, screen: number, view: KeyboardView, note: RunNote, title: string, info: string): TestFrame => {
  const { edge, whiteX, blackX, blackAt, inner } = geometry(view);
  const current = note.right!.midi;
  const currentKey = view.byMidi.get(current);
  const currentWhite = currentKey && !currentKey.black ? view.whites.indexOf(currentKey) : -1;
  const whiteFingers = (hand: Hand): string =>
    place(view.whites.flatMap((w, i) => (w[hand] ? [{ x: whiteX(i), text: String(w[hand]) }] : [])), FINGER_LINE_END);
  const blackFingers = (hand: Hand): string =>
    place(view.blacks.flatMap((b) => (b[hand] ? [{ x: blackX(b), text: CIRCLED[b[hand]!] }] : [])), FINGER_LINE_END);
  const octaves = s.special === 'octaves';
  /** Boundaries drawn as text: under the black keys, plus E|F inside an octave box. */
  const textEdges = (inBlackZone: boolean): number[] =>
    inner.filter((i) => (octaves && view.whites[i - 1].midi % 12 === 4) || (!inBlackZone && blackAt.has(i)));

  const page: Page = {};
  // Fingers: L black-key row (outer), L white-key row; keyboard; R white, R black.
  const leftLines = [blackFingers('left'), whiteFingers('left')];
  const rightLines = [whiteFingers('right'), blackFingers('right')];
  const band = octaves ? { border: { width: 1, color: 6, radius: 6 } } : {};
  page.left = text(0, leftLines, 4, band);
  const kbTop = TOP + ROW + GLYPH + 6;
  const rowTop = (r: number): number => kbTop + 3 + r * STACK;
  const blackRows = octaves ? 3 : 2; // groups: 7 boxes leave room for 5 text containers
  const kbBottom = rowTop(blackRows) + GLYPH + 3;

  const boxes = spans(view, octaves ? (m) => m % 12 === 11 : (m) => m % 12 === 4 || m % 12 === 11);
  boxes.forEach(([first, last], g) => {
    const x0 = Math.round(edge(first)) + (first === 0 ? 0 : 1);
    const x1 = Math.round(edge(last + 1)) - (last === view.whites.length - 1 ? 0 : 1);
    page[`box${g}`] = { kind: 'box', x: x0, width: x1 - x0, y: kbTop, height: kbBottom - kbTop, content: '', color: 0, border: { width: 2, color: 12, radius: 4 } };
  });

  const blackRow = (tip: boolean): string =>
    place([
      ...view.blacks.map((b) => ({ x: blackX(b), text: tip && b.midi === current ? '○' : s.black! })),
      ...textEdges(true).map((i) => ({ x: edge(i), text: '│' })),
    ]);
  const marker = currentWhite >= 0 ? [{ x: whiteX(currentWhite), text: '●' }] : [];
  const rows = Array.from({ length: blackRows }, (_, r) => blackRow(r === blackRows - 1));
  if (octaves) {
    rows.push(place(textEdges(false).map((i) => ({ x: edge(i), text: '│' }))));
    page.marker = text(rowTop(blackRows) - TOP, [marker.length ? place(marker) : ' '], 4, { height: GLYPH + 6 });
  } else {
    // Short lines under the black keys, except either side of the ●: no room for both.
    const nearMarker = (i: number): boolean => i === currentWhite || i === currentWhite + 1;
    rows.push(place([...textEdges(false).filter((i) => !nearMarker(i)).map((i) => ({ x: edge(i), text: '│' })), ...marker]));
  }
  rows.forEach((row, r) => {
    page[`row${r}`] = text(rowTop(r) - TOP, [row], 4, { height: GLYPH + 6 });
  });
  const rightY = kbBottom + 4 - TOP;
  if (octaves) {
    page.right = text(rightY, rightLines, 4, band);
    page.status = text(288 - 2 * ROW - 6, [`${title} · L above, R below`, info], 3, { capture: true });
  } else {
    // Status shares the R container (12 containers: 7 boxes, 5 text).
    page.right = text(rightY, [...rightLines, `${title} · L above, R below`, info], 4, { capture: true });
  }
  return { frame: { layout: `s${screen}:${boxes.map(([a, b]) => `${a}-${b}`).join(',')}`, page }, dump: [...leftLines, ...rows, ...rightLines].join('\n') };
};

/** The keys of `view` from `low` to `high` (white keys), keeping their fingers; keys outside `view` carry none. */
const rangeView = (view: KeyboardView, low: number, high: number): KeyboardView => {
  const whites: KeyboardKey[] = [];
  const blacks: KeyboardKey[] = [];
  const byMidi = new Map<number, KeyboardKey>();
  for (let midi = low; midi <= high; midi++) {
    const own = view.byMidi.get(midi);
    const key: KeyboardKey = { ...(own ?? { midi, black: [1, 3, 6, 8, 10].includes(midi % 12) }) };
    if (key.black) key.afterWhite = whites.length - 1;
    (key.black ? blacks : whites).push(key);
    byMidi.set(midi, key);
  }
  return { whites, blacks, byMidi };
};

/**
 * Three octaves, C to C, with the note in the middle one where the run allows.
 * Every window has the same key pattern, so moving it changes text, not layout.
 * The overview has a ■ per octave shown and a □ per octave of the run hidden.
 */
const octaveWindow = (view: KeyboardView, current: number): { view: KeyboardView; overview: string } => {
  const low = Math.floor(view.whites[0].midi / 12) * 12;
  const top = view.whites[view.whites.length - 1].midi;
  const start = Math.max(low, Math.min(Math.floor(current / 12) * 12 - 12, Math.ceil(top / 12) * 12 - 36));
  const octaves = Array.from({ length: Math.ceil((top + 1 - low) / 12) }, (_, i) => low + 12 * i);
  return {
    view: rangeView(view, start, start + 36),
    overview: octaves.map((c) => (c >= start && c < start + 36 ? '■' : '□')).join(''),
  };
};

/** `view` with fingers only on the keys of the run's next few notes (two back, five on). */
const nearFingers = (view: KeyboardView, run: RunNote[], step: number): KeyboardView => {
  const near = new Set(run.slice(Math.max(0, step - 2), step + 6).map((n) => n.right!.midi));
  const copy = (k: KeyboardKey): KeyboardKey => (near.has(k.midi) ? { ...k } : { ...k, right: undefined, left: undefined });
  const whites = view.whites.map(copy);
  const blacks = view.blacks.map(copy);
  return { whites, blacks, byMidi: new Map([...whites, ...blacks].map((k) => [k.midi, k])) };
};

/**
 * The run's keyboard in two halves, the low half above the high one, sharing
 * the middle key; each is the current view's text keyboard (fingers L above,
 * R below), half as many keys per row, so twice as wide.
 */
const stackedFrame = (screen: number, view: KeyboardView, current: number, title: string, info: string): TestFrame => {
  const n = view.whites.length;
  const half = Math.ceil((n + 1) / 2);
  const halves = [rangeView(view, view.whites[0].midi, view.whites[half - 1].midi), rangeView(view, view.whites[n - half].midi, view.whites[n - 1].midi)];
  const page: Page = {};
  const dump: string[] = [];
  halves.forEach((h, r) => {
    const t = keyboardText(h, current, W);
    const y = r * 128;
    page[`left${r}`] = text(y, [t.left]);
    page[`keys${r}`] = text(y + 24, t.keys.split('\n'), 3);
    page[`right${r}`] = text(y + 101, [t.right]);
    dump.push(t.left, t.keys, t.right);
  });
  page.status = text(256, [`${info} · L above, R below`], 3, { capture: true });
  return { frame: { layout: `s${screen}:${n}`, page }, dump: [title, ...dump].join('\n') };
};
