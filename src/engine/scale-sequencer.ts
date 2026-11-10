// Steps through scale-mode practice: a count-in bar, then the run of the
// current key (up and down), rests to the end of the bar, then the next key
// around the circle of fifths (or the same key again). Pure logic, one call
// per step; the caller owns timing (step length = 60 / bpm / notesPerBeat s).
import { type Hands, keyboardView, type KeyboardView, nextKey, type RunNote, type ScaleKey, scaleRun } from './scales';

export type AfterRun = 'next' | 'repeat';

export type SequencerSettings = {
  key: ScaleKey;
  hands: Hands;
  octaves: number;
  /** Notes per metronome beat (1 = quarter notes, 2 = eighths, 4 = sixteenths). */
  notesPerBeat: number;
  after: AfterRun;
};

export const BEATS_PER_BAR = 4;

/** Steps in a run of `notes` notes: whole bars, with at least one rest at the end. */
export const runLength = (notes: number, stepsPerBar: number): number => Math.ceil((notes + 1) / stepsPerBar) * stepsPerBar;

export type SequencerStep = {
  /** count = count-in step, note = play `note`, rest = rest before the next run. */
  kind: 'count' | 'note' | 'rest';
  key: ScaleKey;
  /** Run note being played (kind "note"). */
  note?: RunNote;
  /** Step within the run: this one, or for a count-in the one it leads to. */
  position: number;
  /** Count-in beats left including this one, 4 … 1 (kind "count"). */
  countdown?: number;
  /** Metronome click on this step; accent = first beat of a bar. */
  click: boolean;
  accent: boolean;
  /** First step of a new run (the keyboard and fingers change). */
  newRun: boolean;
  /** Notes in the run (for "3/15"). */
  runNotes: number;
};

export type SequencerSnapshot = { key: ScaleKey; position: number; counting: number; freshRun: boolean };

export class ScaleSequencer {
  private settings: SequencerSettings;
  key: ScaleKey;
  run: RunNote[] = [];
  view!: KeyboardView;
  /** Next step within the run. */
  private position = 0;
  /** Count-in steps still to play before `position`. */
  private counting = 0;
  private freshRun = true;

  constructor(settings: SequencerSettings) {
    this.settings = { ...settings };
    this.key = settings.key;
    this.load(settings.key);
    this.countIn();
  }

  private load(key: ScaleKey): void {
    this.key = key;
    this.run = scaleRun(key, { octaves: this.settings.octaves, hands: this.settings.hands });
    this.view = keyboardView(this.run);
    this.position = 0;
    this.freshRun = true;
  }

  private get stepsPerBar(): number {
    return BEATS_PER_BAR * this.settings.notesPerBeat;
  }

  /** The run step that plays next (after any count-in). */
  get runStep(): number {
    return this.position;
  }

  /** Puts a count-in bar before the next step (start, resume after a pause). */
  countIn(): void {
    this.counting = this.stepsPerBar;
  }

  /**
   * Changes settings. A different key, hand or range restarts the run (with a
   * count-in); tempo-like changes (notes per beat, what follows a run) apply at once.
   */
  update(settings: Partial<SequencerSettings>): void {
    const before = this.settings;
    this.settings = { ...before, ...settings };
    const s = this.settings;
    if (s.key.tonic !== before.key.tonic || s.key.type !== before.key.type || s.hands !== before.hands || s.octaves !== before.octaves) {
      this.load(s.key);
      this.countIn();
    }
  }

  /** Skips to the start of the next key (or the same key, when repeating). */
  skipKey(): void {
    this.load(this.settings.after === 'next' ? nextKey(this.key) : this.key);
    this.settings.key = this.key;
    this.countIn();
  }

  /** Where the sequence is; restore() returns to it (to undo steps fetched ahead but never played). */
  snapshot(): SequencerSnapshot {
    return { key: this.key, position: this.position, counting: this.counting, freshRun: this.freshRun };
  }

  restore(snap: SequencerSnapshot): void {
    if (snap.key.tonic !== this.key.tonic || snap.key.type !== this.key.type) {
      this.load(snap.key);
      this.settings.key = snap.key;
    }
    this.position = snap.position;
    this.counting = snap.counting;
    this.freshRun = snap.freshRun;
  }

  /** The step to play now; advances to the following one. */
  next(): SequencerStep {
    const npb = this.settings.notesPerBeat;
    if (this.counting > 0) {
      const left = this.counting--;
      return {
        kind: 'count', key: this.key, position: this.position, countdown: Math.ceil(left / npb), click: left % npb === 0, accent: left === this.stepsPerBar,
        newRun: this.freshRun && left === this.stepsPerBar, runNotes: this.run.length,
      };
    }
    if (this.position >= runLength(this.run.length, this.stepsPerBar)) {
      this.load(this.settings.after === 'next' ? nextKey(this.key) : this.key);
      this.settings.key = this.key;
    }
    const step = this.position++;
    const newRun = this.freshRun;
    this.freshRun = false;
    const note = this.run[step];
    return {
      kind: note ? 'note' : 'rest', key: this.key, note, position: step, click: step % npb === 0, accent: step % this.stepsPerBar === 0,
      newRun, runNotes: this.run.length,
    };
  }
}
