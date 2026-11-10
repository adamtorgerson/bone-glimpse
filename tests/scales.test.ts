import { describe, expect, it } from 'vitest';
import {
  fingerAt,
  isBlackKey,
  keyboardView,
  keysFor,
  midiName,
  nextKey,
  printedFingering,
  SCALE_TYPE_IDS,
  scaleKey,
  scaleRun,
  spellScale,
  viewKey,
} from '../src/engine/scales';

const allKeys = SCALE_TYPE_IDS.flatMap(keysFor);

describe('scale spelling', () => {
  it.each([
    ['major', 2, 'D E F# G A B C#'],
    ['major', 1, 'Db Eb F Gb Ab Bb C'],
    ['major', 6, 'F# G# A# B C# D# E#'],
    ['harmonicMinor', 8, 'G# A# B C# D# E F##'],
    ['harmonicMinor', 3, 'Eb F Gb Ab Bb Cb D'],
    ['naturalMinor', 9, 'A B C D E F G'],
  ] as const)('%s on %i = %s', (type, tonic, expected) => {
    expect(spellScale(scaleKey(type, tonic)).join(' ')).toBe(expected);
  });

  it('uses each letter once in every key', () => {
    for (const key of allKeys) expect(new Set(spellScale(key).map((n) => n[0])).size, key.display).toBe(7);
  });

  it('walks the circle of fifths through all 12 keys', () => {
    for (const type of SCALE_TYPE_IDS) {
      let key = keysFor(type)[0];
      const seen = new Set<number>();
      for (let i = 0; i < 12; i++) {
        seen.add(key.tonic);
        const next = nextKey(key);
        expect((next.tonic - key.tonic + 12) % 12, key.display).toBe(7);
        key = next;
      }
      expect(seen.size).toBe(12);
      expect(key.tonic).toBe(keysFor(type)[0].tonic);
    }
  });
});

describe('fingerings', () => {
  it('never puts a thumb on a black key, in any key, hand or octave count', () => {
    for (const key of allKeys) {
      for (const octaves of [1, 2]) {
        for (const note of scaleRun(key, { octaves, hands: 'both' })) {
          for (const hand of [note.right!, note.left!]) {
            if (hand.finger === 1) expect(isBlackKey(hand.midi), `${key.display} ${midiName(hand.midi)}`).toBe(false);
          }
        }
      }
    }
  });

  it('crosses only thumb-under / finger-over, and only uses 5 at the ends', () => {
    for (const key of allKeys) {
      for (const hand of ['right', 'left'] as const) {
        const fingers = Array.from({ length: 15 }, (_, i) => fingerAt(key, hand, i, 2));
        // Walking away from the hand's outer end (RH upward, LH downward), fingers count up except at a thumb.
        const walk = hand === 'right' ? fingers : [...fingers].reverse();
        for (let i = 1; i < walk.length; i++) {
          const ok = walk[i] === walk[i - 1] + 1 || walk[i] === 1 || (i === walk.length - 1 && walk[i] === 5);
          expect(ok, `${key.display} ${hand}: ${walk.join('')}`).toBe(true);
        }
        expect(walk.slice(1, -1).includes(5), `${key.display} ${hand}`).toBe(false);
      }
    }
  });

  it('matches the printed fingering over one octave and continues over two', () => {
    const c = scaleKey('major', 0);
    expect(printedFingering(c, 'right').join('')).toBe('12312345');
    expect(Array.from({ length: 15 }, (_, i) => fingerAt(c, 'right', i, 2)).join('')).toBe('123123412312345');
    expect(Array.from({ length: 15 }, (_, i) => fingerAt(c, 'left', i, 2)).join('')).toBe('543213214321321');
    const bb = scaleKey('major', 10);
    expect(Array.from({ length: 15 }, (_, i) => fingerAt(bb, 'right', i, 2)).join('')).toBe('412312341231234');
  });
});

describe('scale runs', () => {
  it('goes up and back down, top note once, hands an octave apart', () => {
    const run = scaleRun(scaleKey('major', 2), { octaves: 1, hands: 'both' });
    expect(run.map((n) => n.name).join(' ')).toBe('D E F# G A B C# D C# B A G F# E D');
    expect(run.map((n) => n.direction.at(0)).join('')).toBe('uuuuuuuuddddddd');
    expect(midiName(run[0].right!.midi)).toBe('D4');
    expect(midiName(run[0].left!.midi)).toBe('D3');
    expect(run.map((n) => n.right!.finger).join('')).toBe('123123454321321');
    expect(run.map((n) => n.left!.finger).join('')).toBe('543213212312345');
  });

  it('includes only the selected hand', () => {
    const run = scaleRun(scaleKey('major', 0), { octaves: 2, hands: 'left' });
    expect(run).toHaveLength(29);
    expect(run.every((n) => n.left && !n.right)).toBe(true);
  });

});

describe('keyboard view', () => {
  it('spans white key to white key and marks both hands on each scale key', () => {
    const run = scaleRun(scaleKey('major', 1), { octaves: 1, hands: 'both' }); // Db: starts on a black key
    const view = keyboardView(run);
    expect(view.whites.map((k) => midiName(k.midi)).join(' ')).toBe('C4 D4 E4 F4 G4 A4 B4 C5 D5');
    expect(view.blacks.map((k) => `${midiName(k.midi)}@${k.afterWhite}`).join(' ')).toBe('C#4@0 D#4@1 F#4@3 G#4@4 A#4@5 C#5@7');
    const db = viewKey(view, run[0])!;
    expect([db.name, db.right, db.left]).toEqual(['Db', 2, 3]);
    expect(view.whites[1].name).toBeUndefined(); // D is not in Db major
  });
});
