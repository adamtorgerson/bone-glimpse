import { describe, expect, it } from 'vitest';
import { ChordPredictor, keyPrior } from '../src/engine/predict';
import { parseChord } from '../src/engine/theory';

const STEP = 0.28;

/** Feeds chords, each held `steps` detections; returns the end time. */
const play = (p: ChordPredictor, chords: string[], steps = 8, t = 0): number => {
  for (const c of chords) for (let i = 0; i < steps; i++) p.add(parseChord(c), (t += STEP));
  return t;
};

describe('chord prediction', () => {
  it('merges extensions and ignores short blips', () => {
    const p = new ChordPredictor();
    p.add(parseChord('A:min'), 0.28);
    p.add(parseChord('A:min7'), 0.56);
    p.add(parseChord('E'), 0.84); // one-step blip
    p.add(parseChord('A:min'), 1.12);
    play(p, ['F'], 4, 1.12);
    expect(p.sequence).toEqual(['9:min', '5:maj']);
  });

  it('reports a chord change once it is confirmed', () => {
    const p = new ChordPredictor();
    play(p, ['C'], 4);
    expect(p.add(parseChord('G:7'), 1.4)).toBeUndefined(); // not held long enough yet
    expect(p.add(parseChord('G:7'), 1.7)).toBeUndefined();
    expect(p.add(parseChord('G:7'), 2.0)).toEqual({ id: '7:maj', start: 1.4 });
    expect(p.add(parseChord('G:7'), 2.3)).toBeUndefined();
  });

  it('predicts a repeated loop from the pattern, with the song voicing', () => {
    const p = new ChordPredictor();
    play(p, ['C', 'G:7', 'A:min', 'F', 'C', 'G:7', 'A:min', 'F', 'C']);
    const next = p.predict();
    expect(next?.display).toBe('G7');
    expect(next?.fromPattern).toBe(true);
    expect(next?.probability).toBeGreaterThan(0.9);
  });

  it('uses the longer context to disambiguate', () => {
    // After C, the loop goes to G the first time and F the second time.
    const loop = ['C', 'G', 'C', 'F'];
    const p = new ChordPredictor();
    const t = play(p, [...loop, ...loop, 'C', 'G']);
    play(p, ['C'], 8, t);
    expect(p.predict()?.display).toBe('F');
  });

  it('estimates when the change happens from earlier chord lengths', () => {
    const p = new ChordPredictor();
    play(p, ['C', 'G', 'A:min', 'F', 'C']);
    const next = p.predict()!;
    // Each chord lasted 8 steps; the current C started at the 33rd detection.
    expect(next.changeAt).toBeCloseTo((33 + 8) * STEP, 5);
  });

  it('falls back to the key before the song repeats', () => {
    const p = new ChordPredictor();
    play(p, ['G', 'D']);
    expect(p.predict({ tonic: 7, mode: 'major' })?.display).toBe('G'); // V -> I
    expect(p.predict()).toBeUndefined();
  });

  it('knows common moves in minor keys', () => {
    const prior = keyPrior('4:maj', { tonic: 9, mode: 'minor' }); // E in A minor
    expect([...prior].sort((a, b) => b[1] - a[1])[0][0]).toBe('9:min');
  });
});
