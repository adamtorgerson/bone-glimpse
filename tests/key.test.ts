import { describe, expect, it } from 'vitest';
import { KeyEstimator, keyName } from '../src/engine/key';
import { parseChord } from '../src/engine/theory';

/** Feeds a progression (each chord ~2.2 s, 0.28 s steps) `reps` times, starting at `t`. */
const play = (k: KeyEstimator, chords: string[], reps = 4, t = 0): number => {
  for (let r = 0; r < reps; r++) for (const c of chords) for (let i = 0; i < 8; i++) k.add(parseChord(c), (t += 0.28));
  return t;
};

describe('key estimation', () => {
  it.each([
    [['G', 'C', 'D', 'G'], 'G'],
    [['C', 'G', 'A:min', 'F'], 'C'],
    [['A:min', 'D:min', 'E', 'A:min'], 'Am'],
    [['A:min', 'G', 'F', 'E:7'], 'Am'],
    [['C:min7', 'F:7', 'A#:maj7', 'A#:maj7'], 'Bb'],
    [['E:7', 'A:7', 'E:7', 'B:7'], 'E'],
  ])('%j is in %s', (chords, key) => {
    const k = new KeyEstimator();
    play(k, chords);
    expect(k.estimate()?.display).toBe(key);
  });

  it('waits for enough evidence', () => {
    const k = new KeyEstimator();
    play(k, ['G', 'C'], 1);
    expect(k.estimate()).toBeUndefined();
  });

  it('ignores N.C. and follows a modulation', () => {
    const k = new KeyEstimator();
    let t = play(k, ['C', 'F', 'G', 'C']);
    t = play(k, ['N'], 2, t);
    expect(k.estimate()?.display).toBe('C');
    play(k, ['D', 'G', 'A', 'D'], 12, t);
    expect(k.estimate()?.display).toBe('D');
  });

  it('spells keys conventionally', () => {
    expect(keyName(3, 'major')).toBe('Eb');
    expect(keyName(6, 'minor')).toBe('F#m');
    expect(keyName(10, 'minor')).toBe('Bbm');
  });
});
