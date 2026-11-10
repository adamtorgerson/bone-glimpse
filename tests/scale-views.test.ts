import { describe, expect, it } from 'vitest';
import { keyboardView, type Hands, scaleKey, scaleRun } from '../src/engine/scales';
import { textWidth } from '../src/even/keyboard-text';
import { SCALE_VIEW_IDS, scaleFrame, type ScaleScreen, widenedView } from '../src/even/scale-views';

const screen = (hands: Hands, step: number | undefined, tonic = 2, octaves = 1): ScaleScreen => {
  const run = scaleRun(scaleKey('major', tonic), { octaves, hands });
  const note = step === undefined ? undefined : run[step];
  return { title: 'D major', now: 'now', next: 'next', active: !!note, hands, view: keyboardView(run), run, note, position: step ?? 0 };
};

describe('scale views', () => {
  it.each(SCALE_VIEW_IDS)('%s stays within the G2 page limits', (id) => {
    for (const tonic of [0, 1, 6]) {
      for (const octaves of [1, 2]) {
        for (const hands of ['right', 'left', 'both'] as const) {
          for (const step of [undefined, 0, 3, 7, 12]) {
            const slots = Object.values(scaleFrame(id, screen(hands, step, tonic, octaves)).page);
            expect(slots.length).toBeLessThanOrEqual(12);
            expect(slots.filter((s) => s.kind !== 'box').length).toBeLessThanOrEqual(8);
            expect(slots.filter((s) => s.capture)).toHaveLength(1);
            for (const s of slots) {
              expect((s.x ?? 12) + (s.width ?? 552)).toBeLessThanOrEqual(576);
              expect(s.y + s.height).toBeLessThanOrEqual(288);
              if (s.kind !== 'box') for (const line of s.content.split('\n')) expect(textWidth(line)).toBeLessThanOrEqual((s.width ?? 552) - 8);
            }
          }
        }
      }
    }
  });

  it('keyboard: L label and fingers above the keys, R fingers and label below', () => {
    const page = scaleFrame('keyboard', screen('both', undefined)).page; // D major
    expect(page.scaleLeft.content.split('\n')[0]).toBe('L');
    expect(page.scaleLeft.content.split('\n')[1].replace(/[^1-5①-⑤]/g, '')).toBe('54③213②1');
    expect(page.scaleRight.content.split('\n')[0].replace(/[^1-5①-⑤]/g, '')).toBe('12③123④5');
    expect(page.scaleRight.content.split('\n')[1]).toBe('R');
    expect(page.scaleLeft.y).toBeLessThan(page.scaleKeys.y);
    expect(page.scaleRight.y).toBeGreaterThan(page.scaleKeys.y);
    const rh = scaleFrame('keyboard', screen('right', undefined)).page;
    expect(rh.scaleLeft.content.trim()).toBe('');
  });

  it('groups: widens to whole key groups and at least 15 white keys, one box per group', () => {
    const s = screen('both', 2); // D major, D4–D5, F# now
    const view = widenedView(s.view, 15);
    expect(view.whites.length).toBeGreaterThanOrEqual(15);
    expect([0, 5]).toContain(view.whites[0].midi % 12); // starts on a C or F
    expect([4, 11]).toContain(view.whites[view.whites.length - 1].midi % 12); // ends on an E or B
    expect(view.byMidi.get(62)!.right).toBe(1); // the run keeps its fingers
    const page = scaleFrame('groups', s).page;
    const boxes = Object.values(page).filter((p) => p.kind === 'box');
    expect(boxes.length).toBe(view.whites.filter((w) => w.midi % 12 === 0 || w.midi % 12 === 5).length);
    const rows = page.scaleKeys.content.split('\n');
    expect(rows[0]).toBe('L');
    expect(rows[1].replace(/[^1-5①-⑤]/g, '')).toBe('54③213②1'); // L fingers above
    expect([...rows[2]].filter((c) => c === '█' || c === '○')).toHaveLength(view.blacks.length);
    expect(rows[2]).toContain('○'); // F# is the note to play
    expect([...rows[5]].filter((c) => c === '│')).toHaveLength(view.blacks.length);
    expect(rows[6].replace(/[^1-5①-⑤]/g, '')).toBe('12③123④5'); // R fingers below
    expect(rows[7]).toBe('R');
    // Two-octave runs fit without widening further.
    expect(widenedView(screen('right', 0, 0, 2).view, 15).whites).toHaveLength(17); // C4–E6
  });

  it('hands: one keyboard per hand with its own fingers, L above R, one marker row between them', () => {
    const page = scaleFrame('hands', screen('both', 2)).page; // D major, F#: R3 L3
    const rows = page.scaleKeys.content.split('\n');
    expect(rows).toHaveLength(9);
    expect(rows[0]).toBe('L');
    expect(rows[8]).toBe('R');
    expect(Object.values(page).filter((p) => p.kind === 'box').length).toBe(10); // 5 groups per keyboard
    expect(rows[1]).toContain('○');
    expect(rows[5]).toContain('○');
    expect(rows[2].replace(/[^①-⑤]/g, '')).toBe('③②'); // L on F#, C#
    expect(rows[6].replace(/[^①-⑤]/g, '')).toBe('③④'); // R
    expect(rows[3].replace(/[^1-5]/g, '')).toBe('542131'); // L on D E G A B D
    expect(rows[7].replace(/[^1-5]/g, '')).toBe('121235'); // R
    expect([...rows[4]].filter((c) => c === '●')).toHaveLength(1);
    const one = scaleFrame('hands', screen('left', 0)).page;
    expect(one.scaleKeys.content.split('\n')).toHaveLength(5);
    expect(scaleFrame('hands', screen('right', 0)).page.scaleKeys.content.split('\n')[4]).toBe('R');
    expect(Object.values(one).filter((p) => p.kind === 'box').length).toBe(5);
  });
});
