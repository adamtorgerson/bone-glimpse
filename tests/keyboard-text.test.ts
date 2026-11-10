import { describe, expect, it } from 'vitest';
import { keyboardGeometry, keyboardText, textWidth } from '../src/even/keyboard-text';
import { keyboardView, scaleKey, scaleRun } from '../src/engine/scales';

/** Glyphs of a rendered line with the x of their centres, using the same width table. */
const glyphs = (line: string): { ch: string; x: number }[] => {
  const out: { ch: string; x: number }[] = [];
  let x = 0;
  for (const ch of line) {
    const w = textWidth(ch);
    if (ch !== ' ') out.push({ ch, x: x + w / 2 });
    x += w;
  }
  return out;
};

describe('G2 keyboard text', () => {
  const width = 568;
  const run = scaleRun(scaleKey('major', 2), { octaves: 1, hands: 'both' }); // D major: F# and C# are black
  const view = keyboardView(run);
  const { whiteX, edgeX } = keyboardGeometry(view, width);

  it('puts every finger within 3 px of its key and fits the width', () => {
    const text = keyboardText(view, undefined, width);
    const right = glyphs(text.right);
    const expected = [whiteX(0), whiteX(1), edgeX(3), whiteX(3), whiteX(4), whiteX(5), edgeX(7), whiteX(7)];
    expect(right.map((g) => g.ch).join('')).toBe('12③123④5'); // F# and C# are black: circled
    right.forEach((g, i) => expect(Math.abs(g.x - expected[i])).toBeLessThan(3));
    expect(glyphs(text.left).map((g) => g.ch).join('')).toBe('54③213②1');
    for (const line of [text.right, text.left, ...text.keys.split('\n')]) expect(textWidth(line)).toBeLessThanOrEqual(width);
  });

  it('draws black keys on the white-key boundaries and marks the current key', () => {
    const [upper, , lower] = keyboardText(view, run[2].right!.midi, width).keys.split('\n'); // F#: black
    const blacks = glyphs(upper).filter((g) => g.ch !== '│');
    expect(blacks.map((g) => g.ch).join('')).toBe('█○███'); // D#, F# (now), G#, A#, C#
    expect(blacks).toHaveLength(view.blacks.length);
    blacks.forEach((g, i) => expect(Math.abs(g.x - edgeX(view.blacks[i].afterWhite! + 1))).toBeLessThan(3));
    expect(glyphs(lower).filter((g) => g.ch === '│')).toHaveLength(view.whites.length + 1);
    const onWhite = keyboardText(view, run[1].right!.midi, width).keys.split('\n')[2]; // E: white
    const dot = glyphs(onWhite).find((g) => g.ch === '●')!;
    expect(Math.abs(dot.x - whiteX(1))).toBeLessThan(3);
  });

  it('leaves the other hand blank for one-hand runs', () => {
    const rh = scaleRun(scaleKey('major', 0), { octaves: 2, hands: 'right' });
    const text = keyboardText(keyboardView(rh), undefined, width);
    expect(text.left.trim()).toBe('');
    expect(glyphs(text.right)).toHaveLength(15);
  });
});
