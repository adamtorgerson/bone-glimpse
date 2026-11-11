// Stacked-row text keyboards for the G2: black keys and key boundaries drawn
// as glyph rows, one text container each, inside an outline box, with finger
// rows above (left hand) and below (right hand). Used by scale mode's thin
// views and by the keyboard test screens (src/even/keyboard-test-screens.ts).
//
// Glyphs (measured in evenhub-simulator 0.9.5): rows are 27 px apart and block
// glyphs 21 px tall, so text rows stacked 20 px apart (one container each) make
// black keys and key boundaries continuous. Spaces are 5 px. The block glyphs
// advance 20 px; their ink differs: █ 0–20, ▉ 0–15, ▊ 0–13, ▌ 0–10, │ 9–11.
// Lines wrap past 576 px; a text container holds at most 999 bytes.
import { type KeyboardKey, type KeyboardView } from '../engine/scales';
import { type Page } from './glasses-display';

export const W = 576;
/** Glyph top below a text container's y when its padding is 0. */
export const TOP = 4;
export const ROW = 27;
export const GLYPH = 21;
/** Pitch of stacked key rows: 1 px overlap hides the dim antialiased edge between them. */
export const STACK = 20;
export const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
/** Ink centre of a glyph within its 20 px advance. */
const INK_CENTRE: Record<string, number> = { '█': 10, '▉': 7.5, '▊': 6.5, '▌': 5, '│': 10, _: 3 };

export const SPACE = 5;
/**
 * Advance widths measured here (simulator 0.9.5), not the shared table in
 * keyboard-text.ts: spaces are 5 px, and digits spaced out in a finger row
 * are wider than next to each other (they kern there). Other glyphs used: 20 px.
 */
const WIDTH: Record<string, number> = { ' ': SPACE, _: 9, '1': 8.125, '2': 12, '3': 12.875, '4': 12, '5': 12.875, R: 12.875, L: 9 };
export const textWidth = (text: string): number => [...text].reduce((w, ch) => w + (WIDTH[ch] ?? 20), 0);
/** Rightmost x a line may reach: lines wrap past 576 px. */
export const LINE_END = 574;
/** The same for finger rows, with a little room for the digits' fractional widths. */
export const FINGER_LINE_END = 572;

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

/** A full-width, padding-0 text container of `lines` at `y`. */
export const text = (y: number, lines: string[], color = 4, extra: Partial<Page[string]> = {}): Page[string] => ({
  x: 0, width: W, y: Math.round(y), height: lines.length * ROW + 6, padding: 0, content: lines.join('\n'), color, ...extra,
});

export type BlackGlyph = '█' | '▉' | '▊' | '▌';

export type RowsSpec = {
  black: BlackGlyph;
  /**
   * Where fingers go. 1: one row per hand. 2: two rows per hand, black-key
   * fingers on the outer one (so nothing collides at 3 octaves). keys: black-key
   * fingers on the black keys themselves (L row above R row), white-key fingers
   * one row per hand.
   */
  tiers: 1 | 2 | 'keys';
  /** Black-key rows (21 px each, stacked). */
  blackRows: 2 | 3;
  /** Boundaries between white keys with no black key (E|F, B|C) also in the black-key rows (default yes; at 4 octaves they do not fit). */
  blackZoneLines?: false;
  /**
   * dim: brightness by importance (key lines, outline, status dimmer than keys and fingers);
   *   the black-key rows then have no boundary lines (a container has one brightness).
   * rail: a solid bar along the top (a box with a border thicker than half its height).
   * lip: ▂ at the front of each white key, short of its edges; below 30 px a key, _ (6 px, 1 px tall), as ▂ (20 px) would nearly touch.
   * tip: a glyph under each black key, half over its last row: ● rounds it, ▼ points it.
   * marker: the white-key marker (● clashes with ● tips).
   */
  style?: { dim?: boolean; rail?: boolean; lip?: boolean; tip?: '●' | '▼'; marker?: '●' | '◆' };
};

export type RowsKeyboard = {
  /** Finger rows, outline and key rows (prefix + left, outline, rail, row0 …, marker, tip, right). */
  page: Page;
  /** First y below the keyboard and the R fingers, for a status. */
  free: number;
  /** The text lines, for debugging. */
  dump: string;
};

/**
 * `view` across the full width as stacked text rows, the key `current` marked
 * (○ on a black key, the marker under a white one). Fingers for the hands in
 * `hands`; a hand left out gets no rows (the keyboard moves up when L is out).
 */
export const rowsKeyboard = (
  spec: RowsSpec,
  view: KeyboardView,
  current: number | undefined,
  hands: { left: boolean; right: boolean } = { left: true, right: true },
  prefix = '',
): RowsKeyboard => {
  // White key i spans edge(i)..edge(i+1); the outline box draws the outer edges.
  const n = view.whites.length;
  const kw = W / n;
  const edge = (i: number): number => kw * i;
  const whiteX = (i: number): number => edge(i + 0.5);
  const blackX = (b: KeyboardKey): number => edge(b.afterWhite! + 1);
  const blackAt = new Set(view.blacks.map((b) => b.afterWhite! + 1));
  const inner = Array.from({ length: n - 1 }, (_, i) => i + 1);

  const black = spec.black;
  const onKeys = spec.tiers === 'keys';
  const style = spec.style ?? {};
  // Black-key rows, top to bottom. The current black key: ○ at its tip, or on
  // the top row when the lower rows carry fingers (L, then R).
  const blackRow = (r: number): string => {
    const glyph = (b: KeyboardKey): string => {
      const hand = onKeys ? ([undefined, 'left', 'right'] as const)[r] : undefined;
      if (hand) return b[hand] ? CIRCLED[b[hand]!] : black;
      return b.midi === current && !style.tip && r === (onKeys ? 0 : spec.blackRows - 1) ? '○' : black;
    };
    return place([
      ...view.blacks.map((b) => ({ x: blackX(b), text: glyph(b) })),
      ...(spec.blackZoneLines === false || style.dim ? [] : inner.filter((i) => !blackAt.has(i)).map((i) => ({ x: edge(i), text: '│' }))),
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
  const leftLines = !hands.left
    ? []
    : spec.tiers === 2 ? ['L', blackFingers('left'), whiteFingers('left')] : onKeys ? ['L', whiteFingers('left')] : ['L', bothFingers('left')];
  const rightLines = !hands.right
    ? []
    : spec.tiers === 2 ? [whiteFingers('right'), blackFingers('right'), 'R'] : onKeys ? [whiteFingers('right'), 'R'] : [bothFingers('right'), 'R'];

  const page: Page = {};
  const kbTop = leftLines.length ? TOP + (leftLines.length - 1) * ROW + GLYPH + 5 : 0; // outline top
  const rows = [...Array.from({ length: spec.blackRows }, (_, r) => blackRow(r)), whiteRow];
  const kbBottom = kbTop + 3 + (rows.length - 1) * STACK + GLYPH + 3;
  page[`${prefix}outline`] = { kind: 'box', x: 0, width: W, y: kbTop, height: kbBottom - kbTop, content: '', color: 0, border: { width: 2, color: style.dim ? 6 : 15, radius: style.dim ? 6 : 3 } };
  if (style.rail) page[`${prefix}rail`] = { kind: 'box', x: 0, width: W, y: kbTop, height: 4, content: '', color: 0, border: { width: 2, color: 12, radius: 1 } };
  if (leftLines.length) page[`${prefix}left`] = text(0, leftLines);
  const lineColour = style.dim ? 2 : 4;
  rows.forEach((row, r) => {
    page[`${prefix}row${r}`] = text(kbTop + 3 + r * STACK - TOP, [row], r === rows.length - 1 ? lineColour : 4, { height: GLYPH + 6 });
  });
  if (whiteRow2) page[`${prefix}row2b`] = text(kbTop + 3 + (rows.length - 1) * STACK - TOP, [whiteRow2], lineColour, { height: GLYPH + 6 });
  if (tipRow) page[`${prefix}tip`] = text(kbTop + 3 + (rows.length - 1) * STACK - 10 - TOP, [tipRow], 4, { height: GLYPH + 6 });
  page[`${prefix}marker`] = text(kbTop + 3 + (rows.length - 1) * STACK - TOP, [markerRow], 4, { height: GLYPH + 6 });
  const rightY = kbBottom + 5 - TOP;
  if (rightLines.length) page[`${prefix}right`] = text(rightY, rightLines);
  return {
    page,
    free: rightLines.length ? rightY + rightLines.length * ROW : kbBottom + 4,
    dump: [...leftLines, ...rows, ...(whiteRow2 ? [whiteRow2] : []), ...(tipRow ? [tipRow] : []), markerRow, ...rightLines].join('\n'),
  };
};
