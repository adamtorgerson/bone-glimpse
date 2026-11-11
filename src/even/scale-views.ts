// G2 keyboard views for scale mode. Each view turns the same screen state
// into a Frame (page layout + content); GlassesDisplay sends text updates
// while the layout stays the same and rebuilds the page when it changes. No
// images: text containers (max 8) and empty bordered list containers ("boxes").
// Left hand above, right hand below; the L and R labels have lines of their
// own above and below the keyboard, so the keys get the full screen width.
//
// keyboard  the whole run's keyboard in text, fingers above (L) and below (R)
// groups    more keys (at least 15 white): one box per group of white keys
//           between the gaps in the black keys (C–E, F–B), short │ lines for
//           the boundaries under the black keys; fingers above/below
// hands     the groups keyboard drawn once per hand (L above, R below), each
//           with that hand's fingers on the keys; one ● row between them
// near      thin black keys in stacked rows (keyboard-rows.ts), fingers only
//           for the next few notes: room for 4 octaves
// dim       the same with every finger, key lines dimmer than keys and fingers
import { type Hands, isBlackKey, type KeyboardKey, type KeyboardView, keyboardView, type RunNote } from '../engine/scales';
import { type Frame, type Page } from './glasses-display';
import { ROW, rowsKeyboard, type RowsSpec, text } from './keyboard-rows';
import { keyboardText, placeGlyphs } from './keyboard-text';

export type ScaleViewId = 'keyboard' | 'groups' | 'hands' | 'near' | 'dim';
export const SCALE_VIEWS: Record<ScaleViewId, string> = {
  keyboard: 'Keyboard (text)',
  groups: 'Keyboard (key-group outlines, 2+ octaves)',
  hands: 'Two keyboards (key-group outlines, one per hand)',
  near: 'Thin keys, fingers for the next notes',
  dim: 'Thin keys, dimmed lines',
};
export const SCALE_VIEW_IDS = Object.keys(SCALE_VIEWS) as ScaleViewId[];
/** Longest run (octaves) each view fits across the screen. */
export const SCALE_VIEW_MAX_OCTAVES: Record<ScaleViewId, number> = { keyboard: 2, groups: 2, hands: 2, near: 4, dim: 4 };
export const isScaleViewId = (value: unknown): value is ScaleViewId => typeof value === 'string' && value in SCALE_VIEWS;

/** Everything a view may show. */
export type ScaleScreen = {
  /** "D major · both hands · 1 oct · 72 bpm". */
  title: string;
  /** "now F#  R3 L3 · up 3/15", "get ready · 3", "paused · tap: play …". */
  now: string;
  /** "next G major", or the gesture hints when idle. */
  next: string;
  /** Playing a note (status shown bright). */
  active: boolean;
  hands: Hands;
  view: KeyboardView;
  run: RunNote[];
  /** The note to play now, if any (not during count-in, rests or when idle). */
  note?: RunNote;
  /** Run step to look ahead from: the current note's step, or the next one to play. */
  position: number;
  /** Count-in beats left (4 … 1) during the count-in. */
  countdown?: number;
};

type Hand = 'right' | 'left';

const FULL = { x: 0, width: 576 };
/** Text width inside a full-width container (4 px padding each side). */
export const SCALE_TEXT_WIDTH = 568;
/** Full-width text starts 4 px in (padding); box positions are absolute. */
const TEXT_X = 4;
const CIRCLED = ['', '①', '②', '③', '④', '⑤'];
/** Box keyboards span the screen: key edges from x 4 to 572 (absolute px). */
const BOX_X0 = 4;
const BOX_X1 = 572;

const viewMidi = (n: RunNote): number => n.right?.midi ?? n.left!.midi;
const playing = (hands: Hands, hand: Hand): boolean => hands === 'both' || hands === hand;
/** A hand's label line ("L" / "R" at the left edge), blank when that hand is not playing. */
const label = (hands: Hands, hand: Hand): string => (playing(hands, hand) ? (hand === 'right' ? 'R' : 'L') : ' ');
/** Title, then what to play (or the idle state). */
const status = (s: ScaleScreen): string => `${s.title}\n${s.active ? `${s.now} · ${s.next}` : s.now}`;

/** L label and fingers, 3-line keyboard, R fingers and label, status. */
const keyboardFrame = (s: ScaleScreen): Frame => {
  const text = keyboardText(s.view, s.note && viewMidi(s.note), SCALE_TEXT_WIDTH);
  // A text line is ~27 px plus 8 px padding; a shorter container shows a scroll bar.
  const page: Page = {
    scaleLeft: { ...FULL, y: 0, height: 62, content: `${label(s.hands, 'left')}\n${text.left}`, color: 4 },
    scaleKeys: { ...FULL, y: 56, height: 92, content: text.keys, color: 2 },
    scaleRight: { ...FULL, y: 139, height: 62, content: `${text.right}\n${label(s.hands, 'right')}`, color: 4 },
    scaleStatus: { ...FULL, y: 214, height: 62, content: status(s), color: s.active ? 4 : 3, capture: true },
  };
  return { layout: 'keyboard', page };
};

/** White keys with nothing between them and the next one up: E–F and B–C, where key groups end. */
const endsGroup = (midi: number): boolean => midi % 12 === 4 || midi % 12 === 11;

/**
 * The run's keys widened to whole groups (from a C or F, to an E or B), then by
 * whole groups, alternately above and below, to at least `minWhites` white keys.
 * Keys outside the run carry no fingers.
 */
export const widenedView = (view: KeyboardView, minWhites: number): KeyboardView => {
  let low = view.whites[0].midi;
  let high = view.whites[view.whites.length - 1].midi;
  const groupStart = (m: number): number => {
    while (m % 12 !== 0 && m % 12 !== 5) m--; // down to a C or F
    return m;
  };
  const groupEnd = (m: number): number => {
    while (!endsGroup(m)) m++; // up to an E or B
    return m;
  };
  low = groupStart(low);
  high = groupEnd(high);
  const whiteCount = (): number => Array.from({ length: high - low + 1 }, (_, i) => low + i).filter((m) => !isBlackKey(m)).length;
  for (let up = true; whiteCount() < minWhites; up = !up) {
    if (up) high = groupEnd(high + 1);
    else low = groupStart(low - 1);
  }
  const whites: KeyboardKey[] = [];
  const blacks: KeyboardKey[] = [];
  const byMidi = new Map<number, KeyboardKey>();
  for (let midi = low; midi <= high; midi++) {
    const own = view.byMidi.get(midi);
    const key: KeyboardKey = { ...(own ?? { midi, black: isBlackKey(midi) }) };
    if (key.black) key.afterWhite = whites.length - 1;
    (key.black ? blacks : whites).push(key);
    byMidi.set(midi, key);
  }
  return { whites, blacks, byMidi };
};

/** One box per C–E / F–B run of white keys, sharing border lines where groups meet. */
const groupBoxes = (page: Page, prefix: string, view: KeyboardView, edge: (i: number) => number, y: number, height: number): void => {
  const groups: [number, number][] = [];
  view.whites.forEach((_, i) => {
    if (i === 0 || endsGroup(view.whites[i - 1].midi)) groups.push([i, i]);
    else groups[groups.length - 1][1] = i;
  });
  groups.forEach(([first, last], g) => {
    page[`${prefix}${g}`] = {
      kind: 'box',
      x: Math.round(edge(first)),
      width: Math.round(edge(last + 1)) - Math.round(edge(first)) + 1,
      y,
      height,
      content: '',
      color: 0,
      border: { width: 2, color: 7, radius: 3 },
    };
  });
};

/** Key positions for a box keyboard of `view` spanning the screen. */
const boxGeometry = (view: KeyboardView) => {
  const keyWidth = (BOX_X1 - BOX_X0) / view.whites.length;
  const edge = (i: number): number => BOX_X0 + keyWidth * i; // left edge of white key i (absolute px)
  return {
    edge,
    whiteX: (i: number): number => edge(i + 0.5) - TEXT_X,
    blackX: (b: KeyboardKey): number => edge(b.afterWhite! + 1) - TEXT_X,
  };
};

/** Group-outline view: few boxes, so the keyboard can be wide. */
const groupsFrame = (s: ScaleScreen): Frame => {
  const view = widenedView(s.view, 15);
  const { edge, whiteX, blackX } = boxGeometry(view);
  const current = s.note && viewMidi(s.note);
  const fingerRow = (hand: Hand): string =>
    playing(s.hands, hand)
      ? placeGlyphs([
          ...view.whites.flatMap((w, i) => (w[hand] ? [{ x: whiteX(i), text: String(w[hand]) }] : [])),
          ...view.blacks.flatMap((b) => (b[hand] ? [{ x: blackX(b), text: CIRCLED[b[hand]!] }] : [])),
        ])
      : ' ';
  const blackRow = placeGlyphs(view.blacks.map((b) => ({ x: blackX(b), text: b.midi === current ? '○' : '█' })));
  // Boundaries under the black keys: short lines below them. Next to the ● they are left out (no room for both).
  const currentWhite = view.whites.findIndex((w) => w.midi === current);
  const lowerRow = (withMarker: boolean): string =>
    placeGlyphs([
      ...view.blacks
        .filter((b) => !withMarker || (b.afterWhite !== currentWhite && b.afterWhite! + 1 !== currentWhite))
        .map((b) => ({ x: blackX(b), text: '│' })),
      ...(withMarker && currentWhite >= 0 ? [{ x: whiteX(currentWhite), text: '●' }] : []),
    ]);
  const rows = [
    label(s.hands, 'left'),
    fingerRow('left'),
    blackRow,
    blackRow,
    lowerRow(true),
    lowerRow(false),
    fingerRow('right'),
    label(s.hands, 'right'),
  ];

  // Text lines are 27 px from y 4; the boxes frame the key rows 2–5.
  const page: Page = {};
  groupBoxes(page, 'group', view, edge, 57, 106);
  page.scaleStatus = { ...FULL, y: 226, height: 62, content: status(s), color: s.active ? 4 : 3, capture: true };
  page.scaleKeys = { ...FULL, y: 0, height: 224, content: rows.join('\n'), color: 4 };
  return { layout: `groups:${view.whites[0].midi}:${view.whites.length}`, page };
};

/** The run as one hand plays it, so its keyboard carries only that hand's fingers. */
const handRun = (run: RunNote[], hand: Hand): RunNote[] =>
  run.flatMap((n) => (n[hand] ? [{ ...n, right: hand === 'right' ? n.right : undefined, left: hand === 'left' ? n.left : undefined }] : []));

/**
 * Two group keyboards, L above and R below, each with its hand's fingers on
 * the keys: circled on the black keys, plain on the white keys between the
 * short boundary lines. Both keyboards have the same keys an octave apart, so
 * a single ● row between them marks the key to play on both.
 */
const handsFrame = (s: ScaleScreen): Frame => {
  const hands: Hand[] = s.hands === 'both' ? ['left', 'right'] : [s.hands];
  const views = hands.map((h) => widenedView(keyboardView(handRun(s.run, h)), 15));
  const shape = views[0];
  const { edge, whiteX, blackX } = boxGeometry(shape);

  /** Rows of one hand's keyboard: black keys, black keys with circled fingers, boundary lines with white fingers. */
  const keyboardRows = (hand: Hand, view: KeyboardView): string[] => {
    const current = s.note?.[hand]?.midi;
    const body = (b: KeyboardKey): string => (b.midi === current ? '○' : '█');
    return [
      placeGlyphs(view.blacks.map((b) => ({ x: blackX(b), text: body(b) }))),
      placeGlyphs(view.blacks.map((b) => ({ x: blackX(b), text: b[hand] ? CIRCLED[b[hand]!] : body(b) }))),
      placeGlyphs([
        ...view.blacks.map((b) => ({ x: blackX(b), text: '│' })),
        ...view.whites.flatMap((w, i) => (w[hand] ? [{ x: whiteX(i), text: String(w[hand]) }] : [])),
      ]),
    ];
  };
  // The key to play sits in the same column on both keyboards.
  const at = s.note && views[0].byMidi.get(s.note[hands[0]]!.midi);
  const marker = !at ? ' ' : placeGlyphs([{ x: at.black ? blackX(at) : whiteX(shape.whites.indexOf(at)), text: '●' }]);
  // L: label, keyboard, ● (then R: keyboard, label). R alone: ●, keyboard, label.
  const handLabel = (hand: Hand): string => (hand === 'right' ? 'R' : 'L');
  const rows =
    hands.length === 2
      ? [handLabel('left'), ...keyboardRows('left', views[0]), marker, ...keyboardRows('right', views[1]), handLabel('right')]
      : hands[0] === 'left'
        ? [handLabel('left'), ...keyboardRows('left', views[0]), marker]
        : [marker, ...keyboardRows('right', views[0]), handLabel('right')];

  // Text lines are 27 px from y 4: the first keyboard is rows 1–3, the second rows 5–7.
  // Nine lines leave room for a one-line status: the key, then what to play.
  const page: Page = {};
  groupBoxes(page, 'a', shape, edge, 29, 86);
  if (views[1]) groupBoxes(page, 'b', shape, edge, 137, 86);
  const key = s.title.split(' · ')[0];
  page.scaleStatus = {
    ...FULL,
    y: 252,
    height: 36,
    content: `${key} · ${s.active ? `${s.now} · ${s.next}` : s.now}`,
    color: s.active ? 4 : 3,
    capture: true,
  };
  page.scaleKeys = { ...FULL, y: 0, height: 251, content: rows.join('\n'), color: 4 };
  return { layout: `hands:${hands.join('+')}:${shape.whites[0].midi % 12}:${shape.whites.length}`, page };
};

/** `view` with fingers only on the keys of the run's next few notes (two back, five on from `step`). */
export const nearFingers = (view: KeyboardView, run: RunNote[], step: number): KeyboardView => {
  const near = new Set(run.slice(Math.max(0, step - 2), step + 6).map(viewMidi));
  const copy = (k: KeyboardKey): KeyboardKey => (near.has(k.midi) ? { ...k } : { ...k, right: undefined, left: undefined });
  const whites = view.whites.map(copy);
  const blacks = view.blacks.map(copy);
  return { whites, blacks, byMidi: new Map([...whites, ...blacks].map((k) => [k.midi, k])) };
};

/** Thin black keys (▌), black-key fingers on a row of their own outside the white-key ones. */
const THIN: RowsSpec = { black: '▌', tiers: 2, blackRows: 2, blackZoneLines: false };

/**
 * Stacked-row keyboard of the run (near: fingers for the next notes only; dim:
 * dimmed key lines). The status gets two lines when they fit (one hand), else one.
 */
const thinFrame = (id: 'near' | 'dim', s: ScaleScreen): Frame => {
  const view = id === 'near' ? nearFingers(s.view, s.run, s.position) : s.view;
  const dim = id === 'dim';
  const { page, free } = rowsKeyboard(dim ? { ...THIN, style: { dim } } : THIN, view, s.note && viewMidi(s.note), {
    left: playing(s.hands, 'left'),
    right: playing(s.hands, 'right'),
  });
  const now = s.active ? `${s.now} · ${s.next}` : s.now;
  const lines = free <= 288 - 2 * ROW - 6 ? [s.title, now] : [`${s.title.split(' · ')[0]} · ${now}`];
  page.scaleStatus = text(Math.max(free, 288 - lines.length * ROW - 6), lines, s.active ? 4 : dim ? 2 : 3, { capture: true });
  return { layout: `${id}:${s.hands}:${view.whites[0].midi % 12}:${view.whites.length}`, page };
};

export const scaleFrame = (id: ScaleViewId, screen: ScaleScreen): Frame => {
  if (id === 'near' || id === 'dim') return thinFrame(id, screen);
  if (id === 'hands') return handsFrame(screen);
  if (id === 'groups') return groupsFrame(screen);
  return keyboardFrame(screen);
};
