import { describe, expect, it } from 'vitest';
import { keysFor } from '../src/engine/scales';
import { TEST_SCREENS, testFrame, textWidth } from '../src/even/keyboard-test-screens';

describe('keyboard test screens', () => {
  it('stay within the G2 limits for every screen, key and note', () => {
    for (let screen = 0; screen < TEST_SCREENS.length; screen++) {
      for (const key of keysFor('major')) {
        for (let step = 0; step < 14 * TEST_SCREENS[screen].octaves + 1; step++) {
          const { frame, drawing } = testFrame({ screen, key, step });
          const { page } = frame;
          const specs = Object.values(page);
          expect(specs.length).toBeLessThanOrEqual(12);
          expect(specs.filter((s) => !s.kind || s.kind === 'text').length).toBeLessThanOrEqual(8);
          const images = specs.filter((s) => s.kind === 'image');
          expect(images.length).toBeLessThanOrEqual(4);
          for (const image of images) {
            expect(image.width).toBeGreaterThanOrEqual(20);
            expect(image.width).toBeLessThanOrEqual(288);
            expect(image.height).toBeGreaterThanOrEqual(20);
            expect(image.height).toBeLessThanOrEqual(144);
          }
          // Image screens: two halves of one drawing.
          if (images.length) expect(drawing && images.every((i) => i.height === drawing.height)).toBe(true);
          expect(specs.filter((s) => s.capture)).toHaveLength(1);
          for (const [name, spec] of Object.entries(page)) {
            expect(new TextEncoder().encode(spec.content).length).toBeLessThanOrEqual(999);
            expect(spec.y + spec.height).toBeLessThanOrEqual(288 + 8);
            // The host rejects non-integer positions and sizes.
            for (const v of [spec.x ?? 0, spec.y, spec.width ?? 0, spec.height]) expect(Number.isInteger(v)).toBe(true);
            // Key and finger lines only (no words: not in this width table); the classic screen is the shared keyboard text with its own table.
            if (screen > 0)
              for (const line of spec.content.split('\n').filter((l) => !/[a-z]/i.test(l))) expect(textWidth(line), name).toBeLessThanOrEqual(576);
          }
        }
      }
    }
  }, 30_000); // ~6000 frames: slow when the whole suite runs in parallel
});
