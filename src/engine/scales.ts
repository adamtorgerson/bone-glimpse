// Scales for scale mode: spelling, standard piano fingerings and the note
// sequence of a practice run. Device independent, like the rest of the engine.
//
// Fingerings are the standard ones from the usual scale books (one octave,
// ascending, as printed), e.g. C major RH 1 2 3 1 2 3 4 5, LH 5 4 3 2 1 3 2 1.
// Over several octaves the end fingers change: the right hand's top tonic is
// played with the printed last finger only at the very top (in between it is
// the printed first finger, the thumb in C), the left hand's bottom tonic with
// the printed first finger only at the very bottom (in between, the printed last).
import { PITCH_NAMES } from './theory';

export type ScaleType = 'major' | 'naturalMinor' | 'harmonicMinor';
export type Hand = 'right' | 'left';
export type Hands = Hand | 'both';
export const HANDS: readonly Hands[] = ['right', 'left', 'both'];

export const SCALE_TYPES: Record<ScaleType, { label: string; suffix: string; intervals: readonly number[] }> = {
  major: { label: 'major', suffix: 'major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  naturalMinor: { label: 'natural minor', suffix: 'minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { label: 'harmonic minor', suffix: 'harm. minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
};
export const SCALE_TYPE_IDS = Object.keys(SCALE_TYPES) as ScaleType[];
export const isScaleType = (value: unknown): value is ScaleType => typeof value === 'string' && value in SCALE_TYPES;

/** Tonic spellings in circle-of-fifths order (sharps up, flats down): the order of the "next key" progression. */
const MAJOR_TONICS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'] as const;
const MINOR_TONICS = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'Eb', 'Bb', 'F', 'C', 'G', 'D'] as const;

/** Printed one-octave fingerings [right hand, left hand], ascending, tonic to tonic. */
type Fingering = readonly [string, string];
const MAJOR_FINGERINGS: Record<(typeof MAJOR_TONICS)[number], Fingering> = {
  C: ['12312345', '54321321'],
  G: ['12312345', '54321321'],
  D: ['12312345', '54321321'],
  A: ['12312345', '54321321'],
  E: ['12312345', '54321321'],
  B: ['12312345', '43214321'],
  'F#': ['23412312', '43213214'],
  Db: ['23123412', '32143213'],
  Ab: ['34123123', '32143213'],
  Eb: ['31234123', '32143213'],
  Bb: ['41231234', '32143213'],
  F: ['12341234', '54321321'],
};
const HARMONIC_MINOR_FINGERINGS: Record<(typeof MINOR_TONICS)[number], Fingering> = {
  A: ['12312345', '54321321'],
  E: ['12312345', '54321321'],
  B: ['12312345', '43214321'],
  'F#': ['34123123', '43213214'],
  'C#': ['34123123', '32143213'],
  'G#': ['34123123', '32143213'],
  Eb: ['31234123', '21432132'],
  Bb: ['41231234', '21321432'],
  F: ['12341234', '54321321'],
  C: ['12312345', '54321321'],
  G: ['12312345', '54321321'],
  D: ['12312345', '54321321'],
};
// Natural minor uses the harmonic-minor fingering, except where the lowered
// 7th turns black under a thumb (G# minor LH: F## is white, F# is black).
const NATURAL_MINOR_FINGERINGS: Record<(typeof MINOR_TONICS)[number], Fingering> = {
  ...HARMONIC_MINOR_FINGERINGS,
  'G#': ['34123123', '32132143'],
};

export type ScaleKey = {
  type: ScaleType;
  /** Tonic pitch class 0–11. */
  tonic: number;
  /** Tonic as spelled for this key ("F#", "Eb"). */
  tonicName: string;
  /** "D major", "Eb harm. minor". */
  display: string;
};

const tonicsFor = (type: ScaleType): readonly string[] => (type === 'major' ? MAJOR_TONICS : MINOR_TONICS);
const fingeringsFor = (type: ScaleType): Record<string, Fingering> =>
  type === 'major' ? MAJOR_FINGERINGS : type === 'harmonicMinor' ? HARMONIC_MINOR_FINGERINGS : NATURAL_MINOR_FINGERINGS;

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];
const pcOf = (name: string): number => {
  let pc = LETTER_PCS[LETTERS.indexOf(name[0] as (typeof LETTERS)[number])];
  for (const ch of name.slice(1)) pc += ch === '#' ? 1 : -1;
  return ((pc % 12) + 12) % 12;
};

/** The 12 keys of a scale type in circle-of-fifths order. */
export const keysFor = (type: ScaleType): ScaleKey[] =>
  tonicsFor(type).map((tonicName) => ({ type, tonic: pcOf(tonicName), tonicName, display: `${tonicName} ${SCALE_TYPES[type].suffix}` }));

/** The key of `type` on tonic pitch class `tonic` (enharmonic spelling from the table). */
export const scaleKey = (type: ScaleType, tonic: number): ScaleKey => keysFor(type).find((k) => k.tonic === ((tonic % 12) + 12) % 12)!;

/** The next key around the circle of fifths (C → G → D …, F → C). */
export const nextKey = (key: ScaleKey): ScaleKey => {
  const keys = keysFor(key.type);
  return keys[(keys.findIndex((k) => k.tonic === key.tonic) + 1) % keys.length];
};

/** The 7 degrees spelled with consecutive letters: D major = D E F# G A B C#, G# harm. minor = … F## G#. */
export const spellScale = (key: ScaleKey): string[] => {
  const start = LETTERS.indexOf(key.tonicName[0] as (typeof LETTERS)[number]);
  return SCALE_TYPES[key.type].intervals.map((iv, degree) => {
    const letter = (start + degree) % 7;
    const pc = (key.tonic + iv) % 12;
    const diff = ((((pc - LETTER_PCS[letter]) % 12) + 18) % 12) - 6; // −6..5
    return LETTERS[letter] + (diff >= 0 ? '#'.repeat(diff) : 'b'.repeat(-diff));
  });
};

/** Printed one-octave fingering of one hand, as 8 finger numbers. */
export const printedFingering = (key: ScaleKey, hand: Hand): number[] =>
  [...fingeringsFor(key.type)[key.tonicName][hand === 'right' ? 0 : 1]].map(Number);

/** Finger for note `index` (0 = bottom tonic) of an ascending scale spanning `octaves`. */
export const fingerAt = (key: ScaleKey, hand: Hand, index: number, octaves: number): number => {
  const f = printedFingering(key, hand);
  const degree = index % 7;
  if (hand === 'right') return index === 7 * octaves ? f[7] : f[degree];
  if (index === 0) return f[0];
  return degree === 0 ? f[7] : f[degree];
};

export const isBlackKey = (midi: number): boolean => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

/** Middle C = 60. The right hand starts on the tonic at or above middle C, the left an octave lower. */
const RIGHT_HAND_BASE = 60;

export type RunOptions = { octaves: number; hands: Hands };

export type RunNote = {
  /** Position in the run (0-based). */
  step: number;
  /** Index on the ascending scale (0 = bottom tonic … 7·octaves = top tonic). */
  index: number;
  direction: 'up' | 'down';
  /** Spelled note name ("F#"). */
  name: string;
  /** Key played by each active hand (MIDI note numbers) and its finger. */
  right?: { midi: number; finger: number };
  left?: { midi: number; finger: number };
};

/** MIDI note of scale index `index` for a hand. */
const midiAt = (key: ScaleKey, hand: Hand, index: number): number =>
  RIGHT_HAND_BASE + (hand === 'left' ? -12 : 0) + key.tonic + 12 * Math.floor(index / 7) + SCALE_TYPES[key.type].intervals[index % 7];

/**
 * One practice run: up `octaves` octaves and back down, top note played once
 * (14·octaves + 1 notes). "both" plays the hands in parallel an octave apart.
 */
export const scaleRun = (key: ScaleKey, { octaves, hands }: RunOptions): RunNote[] => {
  const names = spellScale(key);
  const top = 7 * octaves;
  const indices = [...Array(top + 1).keys(), ...Array.from({ length: top }, (_, i) => top - 1 - i)];
  return indices.map((index, step) => {
    const note: RunNote = { step, index, direction: step <= top ? 'up' : 'down', name: names[index % 7] };
    for (const hand of ['right', 'left'] as const) {
      if (hands === hand || hands === 'both') note[hand] = { midi: midiAt(key, hand, index), finger: fingerAt(key, hand, index, octaves) };
    }
    return note;
  });
};

// ---------------------------------------------------------------------------
// Keyboard model: which keys to draw and the fingers to mark on them.

export type KeyboardKey = {
  midi: number;
  black: boolean;
  /** For black keys: index of the white key to its left. */
  afterWhite?: number;
  right?: number;
  left?: number;
  /** Spelled name, when the key is in the scale. */
  name?: string;
};

export type KeyboardView = {
  whites: KeyboardKey[];
  blacks: KeyboardKey[];
  /** MIDI note → key, in "view" coordinates (see keyboardView). */
  byMidi: Map<number, KeyboardKey>;
};

/**
 * The keyboard for a run, from the white key at or below its lowest note to
 * the white key at or above its highest. Both hands play the same keys an
 * octave apart, so the view is drawn in right-hand pitch (left-hand-only runs
 * in left-hand pitch) and each key carries both hands' fingers.
 */
export const keyboardView = (run: RunNote[]): KeyboardView => {
  const viewMidi = (n: RunNote): number => n.right?.midi ?? n.left!.midi;
  const midis = run.map(viewMidi);
  let low = Math.min(...midis);
  let high = Math.max(...midis);
  if (isBlackKey(low)) low--;
  if (isBlackKey(high)) high++;
  const whites: KeyboardKey[] = [];
  const blacks: KeyboardKey[] = [];
  const byMidi = new Map<number, KeyboardKey>();
  for (let midi = low; midi <= high; midi++) {
    const key: KeyboardKey = isBlackKey(midi) ? { midi, black: true, afterWhite: whites.length - 1 } : { midi, black: false };
    (key.black ? blacks : whites).push(key);
    byMidi.set(midi, key);
  }
  for (const n of run) {
    const key = byMidi.get(viewMidi(n))!;
    key.name = n.name;
    if (n.right) key.right = n.right.finger;
    if (n.left) key.left = n.left.finger;
  }
  return { whites, blacks, byMidi };
};

/** The key a run note is shown on. */
export const viewKey = (view: KeyboardView, note: RunNote): KeyboardKey | undefined => view.byMidi.get(note.right?.midi ?? note.left!.midi);

/** Scientific pitch name of a MIDI note with sharps (for tests and debugging). */
export const midiName = (midi: number): string => `${PITCH_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
