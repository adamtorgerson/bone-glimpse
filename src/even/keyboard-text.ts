// Draws a scale keyboard as G2 text. The G2 font is proportional, so glyphs
// are placed at pixel positions by padding with spaces (5.05 px each), using
// advance widths measured from evenhub-simulator screenshots (v0.9.5; the
// hardware may differ slightly). Block and box glyphs are a fixed 20 px.
//
//   L                                 (hand labels on their own lines: the keyboard gets the full width)
//     5     4           ③  2     1     3           ②  1       left-hand fingers (circled = black key)
//   │  █  █  │  ○  █  █  │  █  │        black keys (○ = current black key)
//   │  █  █  │  ○  █  █  │  █  │
//   │  │  │  │  │  ●  │  │  │  │        white keys (● = current white key)
//     1     2           ③  1     2     3           ④  5       right-hand fingers
//   R
import { type KeyboardView } from '../engine/scales';

/** Advance widths in px. Unknown glyphs render as an invisible 4 px placeholder on the G2. */
const WIDTH: Record<string, number> = {
  ' ': 5.05, '1': 7, '2': 11, '3': 12, '4': 12, '5': 12, R: 12, L: 9,
  A: 12.9, B: 12, C: 11, D: 12, E: 10, F: 10, G: 12, '#': 13.9, b: 11,
  '│': 20, '█': 20, '○': 20, '●': 20, '①': 20, '②': 20, '③': 20, '④': 20, '⑤': 20,
};
/** Black-key fingers are circled: they read apart from a neighbouring white-key finger ("1②", not "12"). */
const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
export const textWidth = (text: string): number => [...text].reduce((w, ch) => w + (WIDTH[ch] ?? 12), 0);

/** Builds one line with each glyph centred as close as possible to its x (px). */
export const placeGlyphs = (items: { x: number; text: string }[]): string => {
  let line = '';
  let x = 0;
  for (const item of [...items].sort((a, b) => a.x - b.x)) {
    const w = textWidth(item.text);
    const spaces = Math.max(0, Math.round((item.x - w / 2 - x) / WIDTH[' ']));
    line += ' '.repeat(spaces) + item.text;
    x += spaces * WIDTH[' '] + w;
  }
  return line || ' ';
};

/** `text` padded with leading spaces to sit centred in `width` px. */
export const centreText = (text: string, width: number): string =>
  ' '.repeat(Math.max(0, Math.round((width - textWidth(text)) / 2 / WIDTH[' ']))) + text;

export type KeyboardText = { right: string; keys: string; left: string };

/**
 * Key positions (px centres) when `view` is spread over `width` px, with the
 * outer key edges (20 px glyphs) kept inside the width so no line wraps.
 */
export const keyboardGeometry = (view: KeyboardView, width: number) => {
  const x0 = 11;
  const keyWidth = (width - 13 - x0) / view.whites.length; // 10 px half glyph + space rounding
  const edgeX = (i: number): number => x0 + keyWidth * i; // left edge of white key i
  return { whiteX: (i: number): number => edgeX(i + 0.5), edgeX, blackX: (afterWhite: number): number => edgeX(afterWhite + 1) };
};

/** The keyboard of `view` spread over `width` px, with the current key marked. Rows for a hand not playing are blank. */
export const keyboardText = (view: KeyboardView, current: number | undefined, width = 568): KeyboardText => {
  const { whiteX, edgeX, blackX } = keyboardGeometry(view, width);
  const hasBlackAt = new Set(view.blacks.map((b) => b.afterWhite! + 1)); // edges covered by a black key

  const upper = [
    ...view.blacks.map((b) => ({ x: blackX(b.afterWhite!), text: b.midi === current ? '○' : '█' })),
    ...Array.from({ length: view.whites.length + 1 }, (_, i) => i).filter((i) => !hasBlackAt.has(i)).map((i) => ({ x: edgeX(i), text: '│' })),
  ];
  const lower = [
    ...Array.from({ length: view.whites.length + 1 }, (_, i) => ({ x: edgeX(i), text: '│' })),
    ...view.whites.flatMap((w, i) => (w.midi === current ? [{ x: whiteX(i), text: '●' }] : [])),
  ];
  const fingers = (hand: 'right' | 'left'): string => {
    const items = [
      ...view.whites.flatMap((w, i) => (w[hand] ? [{ x: whiteX(i), text: String(w[hand]) }] : [])),
      ...view.blacks.flatMap((b) => (b[hand] ? [{ x: blackX(b.afterWhite!), text: CIRCLED[b[hand]] }] : [])),
    ];
    return placeGlyphs(items);
  };
  const upperLine = placeGlyphs(upper);
  return { right: fingers('right'), keys: `${upperLine}\n${upperLine}\n${placeGlyphs(lower)}`, left: fingers('left') };
};
