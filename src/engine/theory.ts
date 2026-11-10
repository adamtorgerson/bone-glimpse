// Chord theory independent of any model or device: parsing Harte-style labels
// ("C#:min7", "Bb:maj/5", "N"), chord tones, display names and simplification.

export const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Intervals in semitones above the root for each supported quality shorthand. */
export const QUALITY_INTERVALS: Record<string, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  maj6: [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  minmaj7: [0, 3, 7, 11],
  dim7: [0, 3, 6, 9],
  hdim7: [0, 3, 6, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  '11': [0, 4, 7, 10, 14, 17],
  min11: [0, 3, 7, 10, 14, 17],
  '13': [0, 4, 7, 10, 14, 21],
  maj13: [0, 4, 7, 11, 14, 21],
  min13: [0, 3, 7, 10, 14, 21],
  '5': [0, 7],
  '1': [0],
};

/** Short, musician-friendly suffixes ("C:min7" -> "Cm7"). */
const DISPLAY_SUFFIX: Record<string, string> = {
  maj: '', min: 'm', dim: 'dim', aug: 'aug', maj6: '6', min6: 'm6', '7': '7', maj7: 'maj7',
  min7: 'm7', minmaj7: 'm(maj7)', dim7: 'dim7', hdim7: 'm7b5', sus2: 'sus2', sus4: 'sus4',
  '9': '9', maj9: 'maj9', min9: 'm9', '11': '11', min11: 'm11', '13': '13', maj13: 'maj13',
  min13: 'm13', '5': '5', '1': '',
};

export type Family = 'maj' | 'min' | 'dim' | 'aug' | 'sus' | 'other';

export type Chord =
  | { kind: 'none' } // N: no chord / silence
  | { kind: 'unknown' } // X: chord outside the vocabulary
  | { kind: 'chord'; root: number; quality: string; bass?: number };

const NOTE_RE = /^([A-G])([#b]*)/;

export const parseNote = (text: string): { pc: number; length: number } | undefined => {
  const m = NOTE_RE.exec(text);
  if (!m) return undefined;
  let pc = PITCH_NAMES.indexOf(m[1] as (typeof PITCH_NAMES)[number]);
  for (const ch of m[2]) pc += ch === '#' ? 1 : -1;
  return { pc: ((pc % 12) + 12) % 12, length: m[0].length };
};

// Harte interval degree -> semitones, e.g. "b3" -> 3, "#11" -> 18.
const DEGREE_SEMITONES = [0, 0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21];
const parseDegree = (text: string): number | undefined => {
  const m = /^([#b]*)(\d+)$/.exec(text.trim());
  if (!m) return undefined;
  const degree = Number(m[2]);
  if (degree < 1 || degree > 13) return undefined;
  let semis = DEGREE_SEMITONES[degree];
  for (const ch of m[1]) semis += ch === '#' ? 1 : -1;
  return semis;
};

const intervalsToQuality = (intervals: number[]): string => {
  const set = [...new Set(intervals.map((i) => i % 12))].sort((a, b) => a - b).join(',');
  for (const [quality, ivs] of Object.entries(QUALITY_INTERVALS)) {
    if ([...new Set(ivs.map((i) => i % 12))].sort((a, b) => a - b).join(',') === set) return quality;
  }
  return 'other';
};

/** Parses a Harte chord label as used in MIREX .lab files and the model vocabulary. */
export const parseChord = (label: string): Chord => {
  const text = label.trim();
  if (text === 'N' || text === '') return { kind: 'none' };
  if (text === 'X') return { kind: 'unknown' };
  const note = parseNote(text);
  if (!note) return { kind: 'unknown' };
  let rest = text.slice(note.length);
  let bass: number | undefined;
  const slash = rest.lastIndexOf('/');
  if (slash >= 0) {
    const b = parseDegree(rest.slice(slash + 1));
    if (b !== undefined) bass = (note.pc + b) % 12;
    rest = rest.slice(0, slash);
  }
  let quality = 'maj';
  if (rest.startsWith(':')) rest = rest.slice(1);
  const paren = rest.indexOf('(');
  const shorthand = paren >= 0 ? rest.slice(0, paren) : rest;
  if (shorthand) quality = shorthand;
  if (paren >= 0) {
    // Explicit interval lists: start from the shorthand (if any) and apply additions/omissions.
    const base = shorthand ? [...(QUALITY_INTERVALS[shorthand] ?? [0])] : [0];
    const items = rest.slice(paren + 1, rest.indexOf(')')).split(',');
    let intervals = base;
    for (const item of items) {
      if (item.startsWith('*')) {
        const s = parseDegree(item.slice(1));
        intervals = intervals.filter((i) => i % 12 !== (s ?? -1) % 12);
      } else {
        const s = parseDegree(item);
        if (s !== undefined) intervals.push(s);
      }
    }
    quality = intervalsToQuality(intervals);
  }
  if (!(quality in QUALITY_INTERVALS)) quality = 'other';
  return { kind: 'chord', root: note.pc, quality, bass };
};

export const chordFamily = (chord: Chord): Family | undefined => {
  if (chord.kind !== 'chord') return undefined;
  const ivs = QUALITY_INTERVALS[chord.quality];
  if (!ivs) return 'other';
  const pcs = new Set(ivs.map((i) => i % 12));
  if (pcs.has(4) && pcs.has(8) && !pcs.has(7)) return 'aug';
  if (pcs.has(3) && pcs.has(6) && !pcs.has(7)) return 'dim';
  if (pcs.has(4) && pcs.has(7)) return 'maj';
  if (pcs.has(3) && pcs.has(7)) return 'min';
  if ((pcs.has(2) || pcs.has(5)) && pcs.has(7) && !pcs.has(3) && !pcs.has(4)) return 'sus';
  return 'other';
};

export const noteName = (pc: number, preferFlats = false): string =>
  (preferFlats ? FLAT_NAMES : PITCH_NAMES)[((pc % 12) + 12) % 12];

// Roots whose key signature uses flats: major-type chords follow the major
// key (F Bb Eb Ab Db), minor-type chords the relative-minor key (D G C F Bb Eb).
const FLAT_MAJOR_ROOTS = new Set([5, 10, 3, 8, 1]);
const FLAT_MINOR_ROOTS = new Set([2, 7, 0, 5, 10, 3]);

/** Whether a chord is conventionally spelled with flats (Gm7 = G Bb D F, not G A# D F). */
export const prefersFlats = (chord: Chord): boolean => {
  if (chord.kind !== 'chord') return false;
  const family = chordFamily(chord);
  return family === 'min' || family === 'dim' ? FLAT_MINOR_ROOTS.has(chord.root) : FLAT_MAJOR_ROOTS.has(chord.root);
};

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];

/** Scale degree (1-based, mod 7) of an interval within a given chord quality. */
const intervalDegree = (semitones: number, quality: string): number => {
  const s = semitones % 12;
  if (s === 9) return quality === 'dim7' ? 7 : 6; // diminished 7th vs. major 6th
  return ({ 0: 1, 1: 2, 2: 2, 3: 3, 4: 3, 5: 4, 6: 5, 7: 5, 8: 5, 10: 7, 11: 7 } as Record<number, number>)[s];
};

/**
 * Chord tones spelled for display, root first, using interval degrees so each
 * tone gets the right letter: C7 = C E G Bb, Gm7 = G Bb D F, D7 = D F# A C.
 * Double accidentals are simplified to their enharmonic (Cdim7 = C Eb Gb A).
 */
export const spellChord = (chord: Chord): string[] => {
  if (chord.kind !== 'chord') return [];
  const rootName = noteName(chord.root, prefersFlats(chord));
  const rootLetter = LETTERS.indexOf(rootName[0] as (typeof LETTERS)[number]);
  return (QUALITY_INTERVALS[chord.quality] ?? [0]).map((iv) => {
    const pc = (chord.root + iv) % 12;
    const letter = (rootLetter + intervalDegree(iv, chord.quality) - 1) % 7;
    const diff = (((pc - LETTER_PCS[letter]) % 12) + 18) % 12 - 6; // -6..5
    if (diff === 0) return LETTERS[letter];
    if (diff === 1) return `${LETTERS[letter]}#`;
    if (diff === -1) return `${LETTERS[letter]}b`;
    return noteName(pc, prefersFlats(chord));
  });
};

export const displayName = (chord: Chord): string => {
  if (chord.kind === 'none') return 'N.C.';
  if (chord.kind === 'unknown') return '?';
  const flats = prefersFlats(chord);
  const name = noteName(chord.root, flats) + (DISPLAY_SUFFIX[chord.quality] ?? chord.quality);
  return chord.bass !== undefined && chord.bass !== chord.root ? `${name}/${noteName(chord.bass, flats)}` : name;
};

/** Chord tones as pitch classes (root first). */
export const chordTones = (chord: Chord): number[] => {
  if (chord.kind !== 'chord') return [];
  const ivs = QUALITY_INTERVALS[chord.quality] ?? [0];
  return ivs.map((i) => (chord.root + i) % 12);
};

/** Reduces a chord to its triad family, e.g. C:min7 -> C:min, G:7 -> G:maj. */
export const simplify = (chord: Chord): Chord => {
  const family = chordFamily(chord);
  if (chord.kind !== 'chord' || !family || family === 'other') return chord;
  const quality = family === 'sus' ? (QUALITY_INTERVALS[chord.quality].includes(5) ? 'sus4' : 'sus2') : family;
  return { kind: 'chord', root: chord.root, quality };
};

/** Canonical label in the model's vocabulary style (sharps, bare major), or undefined. */
export const toVocabLabel = (chord: Chord): string | undefined => {
  if (chord.kind === 'none') return 'N';
  if (chord.kind === 'unknown') return 'X';
  const root = PITCH_NAMES[chord.root];
  return chord.quality === 'maj' ? root : `${root}:${chord.quality}`;
};
