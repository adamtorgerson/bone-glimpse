import { describe, expect, it } from 'vitest';
import { runLength, ScaleSequencer, type SequencerStep } from '../src/engine/scale-sequencer';
import { scaleKey } from '../src/engine/scales';

const take = (seq: ScaleSequencer, n: number): SequencerStep[] => Array.from({ length: n }, () => seq.next());
const brief = (s: SequencerStep): string => (s.kind === 'count' ? `${s.countdown}` : s.kind === 'note' ? s.note!.name : '-');

describe('scale sequencer', () => {
  it('pads runs to whole bars with at least one rest', () => {
    expect(runLength(15, 4)).toBe(16);
    expect(runLength(29, 4)).toBe(32);
    expect(runLength(16, 4)).toBe(20);
    expect(runLength(15, 16)).toBe(16);
    expect(runLength(29, 8)).toBe(32);
  });

  it('counts in one bar, plays the run up and down, rests, then moves round the circle of fifths', () => {
    const seq = new ScaleSequencer({ key: scaleKey('major', 0), hands: 'right', octaves: 1, notesPerBeat: 1, after: 'next' });
    const steps = take(seq, 4 + 16 + 2);
    expect(steps.map(brief).join(' ')).toBe('4 3 2 1 C D E F G A B C B A G F E D C - G A');
    expect(steps.every((s) => s.click)).toBe(true);
    expect(steps.map((s) => (s.accent ? 'A' : '.')).join('')).toBe('A...A...A...A...A...A.');
    expect(steps[4].newRun && steps[20].newRun && !steps[5].newRun).toBe(true);
    expect(steps[21].key.display).toBe('G major');
  });

  it('clicks once per beat with several notes per beat', () => {
    const seq = new ScaleSequencer({ key: scaleKey('major', 7), hands: 'both', octaves: 1, notesPerBeat: 2, after: 'repeat' });
    const steps = take(seq, 8 + 16 + 1);
    expect(steps.slice(0, 8).map(brief).join('')).toBe('44332211');
    expect(steps.map((s) => (s.click ? 'x' : '.')).join('')).toBe('x.x.x.x.x.x.x.x.x.x.x.x.x');
    expect(steps[24].key.display).toBe('G major'); // repeat: same key again
    expect(steps[24].newRun).toBe(true);
  });

  it('counts in again on resume and restarts the run when the key changes', () => {
    const seq = new ScaleSequencer({ key: scaleKey('naturalMinor', 9), hands: 'left', octaves: 1, notesPerBeat: 1, after: 'next' });
    take(seq, 4 + 3);
    seq.countIn();
    expect(take(seq, 5).map(brief).join(' ')).toBe('4 3 2 1 D');
    seq.update({ key: scaleKey('harmonicMinor', 4) });
    expect(take(seq, 5).map(brief).join(' ')).toBe('4 3 2 1 E');
    seq.skipKey();
    expect(take(seq, 5).map(brief).join(' ')).toBe('4 3 2 1 B');
  });

  it('rewinds to a snapshot, across a key change', () => {
    const seq = new ScaleSequencer({ key: scaleKey('major', 0), hands: 'right', octaves: 1, notesPerBeat: 1, after: 'next' });
    take(seq, 4 + 15);
    const snap = seq.snapshot();
    expect(take(seq, 3).map(brief).join(' ')).toBe('- G A');
    seq.restore(snap);
    expect(take(seq, 3).map(brief).join(' ')).toBe('- G A');
  });
});
