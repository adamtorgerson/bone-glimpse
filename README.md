# BoneGlimpse: live chord detection prototype

First prototype from DESIGN.md: **how well does real-time chord detection
work?** It runs in a laptop browser (no glasses yet), listens to a microphone
or plays an audio file in real time, and shows the detected chord in a
G2-sized preview.

## Quick start

```sh
npm install
npm run setup      # downloads + SHA-256-verifies the ChordMini model (17 MB) into public/models
npm run dev        # http://localhost:5180 (also on your LAN, for the phone)
```

Open the page in Chrome. Pick **Microphone** or **Audio file**, then press
**Start**. For files you can load a reference `.lab` to get live accuracy.
**Download session** saves exactly what the detector heard (16 kHz WAV) plus a
JSON log of every detection, so you can replay it through the harness.

## On the G2 glasses

With `npm run dev` running:

```sh
npm run qr         # QR code for http://<LAN-IP>:5180/
npm run dev:https  # or: HTTPS via a Cloudflare quick tunnel, QR code for https://…trycloudflare.com/
```

Prefer `dev:https`: browsers only enable WebGPU, multi-threaded WASM
(SharedArrayBuffer), AudioWorklet and the microphone on secure (HTTPS) pages,
so over plain `http://<LAN-IP>` the phone runs single-threaded WASM only. The
tunnel URL is random and changes per run, but anyone who has it can reach the
dev server while it runs. It reuses a running `npm run dev`, or starts one.

In the Even Realities app, sign in to the Even Hub developer account, open the
**Even Hub** tab and tap **Scan QR** (developer section, top right). The phone
and laptop must be on the same network. The app starts listening on the
**glasses mic** as soon as the model has loaded (allow a few seconds for the
17 MB model).

| on the glasses | does |
|---|---|
| tap | pause / resume listening |
| double-tap | switch between the glasses mic and the phone mic |
| swipe down / up | more / less lookahead: more accurate vs. less lag (±186 ms) |

The display labels every value:

```
chord Am · 70% · maybe Am7              brightness = confidence; "?" = unsure, "maybe" = fell back to the triad
tones A C E · next F in 2s              chord tones, predicted next chord
key C · note E5 80%                     estimated key, the one note that stands out ("?" = weak, "–" = none)
last G* 12s · Cx 8s · Am* 5s · F* 2s    last chords + age (* / x = predicted or missed)
mic glasses · lag 1.1s · look 372 ms · hits 75%
```

The phone-side page shows the same information plus the tuning controls and stats.

* **Simulator:** `npm run sim` opens the official evenhub-simulator against
  the dev server. It records the glasses mic from your default input device.
  `npx evenhub-simulator --list-audio-input-devices` lists inputs and
  `--aid <id>` picks one.
* **Package:** `npm run pack` builds `boneglimpse.ehpk` (about 19 MB with the
  model) for `evenhub create` / `evenhub upload`. `app.json` declares the
  `g2-microphone` and `phone-microphone` permissions.
* Outside the Even app the page simply runs in laptop mode: the bridge is
  detected with a 2.5 s timeout, in parallel with model loading.

URL flags: `?debug` logs detections to the console, `?autostart` starts as soon
as the model loads, and `?backend=webgpu` uses WebGPU for inference.

## Measuring accuracy (no browser needed)

```sh
npm run synth                          # makes test-audio/synth/*.wav + .lab (exact ground truth)
npm run eval -- test-audio/synth       # or any folder of .wav files with sibling .lab files
npm run eval -- song.wav --lookaheads 0,2,4,8 --step 2 --json report.json
```

Audio goes through the glasses path (mono, then 16 kHz, then 16-bit, then 22.05 kHz).
For each lookahead the harness reports:

| metric | meaning |
|---|---|
| offline | whole song visible; the upper bound for an "analyse first, then play along" mode |
| label acc | is the chord reported for moment *t* right (ignoring lag)? |
| screen acc | is the chord **on screen** at time *t* right for what's playing at *t*? This is what the user experiences. |
| change lag | median time from a chord change until the screen shows it |

`root` / `majmin` / `exact` follow MIREX conventions. `exact` is the full
170-class vocabulary. Reference `.lab` files use Harte syntax, as in the
Isophonics or Billboard annotations.

## How it works

```
mic / file / (later) Even G2 audioEvent
  → 16 kHz s16 mono chunks            src/audio/*        (device-specific)
  → resample to 22.05 kHz             src/engine/resample.ts
  → CQT (librosa-equivalent)          src/engine/cqt.ts
  → 108-frame window → ChordMini      src/engine/detector.ts, model.ts
  → smoothing + confidence fallback   src/engine/decision.ts
  → display                           src/web/*          (device-specific)
```

* `src/engine/` is pure TypeScript with no DOM, no runtime and no device code:
  the "chord engine" from DESIGN.md. It runs unchanged in the browser worker
  and in the Node harness (`tests/engine.test.ts` checks that live chunked
  detection matches the offline simulation).
* The CQT is a CPU port of the plan shipped with the model. It matches
  librosa's reference magnitudes (`tests/cqt.test.ts`).
* **Lookahead** is the main knob. The chord reported is for *lookahead*
  frames (93 ms each) before the newest audio. More lookahead gives the model
  more context, so it's more accurate but later.
* **Fallback:** if the full chord is below the threshold but its triad family
  (e.g. Am7, Am6 and Am together) is above it, the display shows the triad.
  Otherwise the result is shown as unsure.
* **Single notes** (`src/engine/note.ts`) don't use the chord model, which only
  knows chord labels. They come from a separate harmonic-salience detector on
  the raw 16 kHz audio: a 256 ms FFT every 64 ms, covering E1–C8. That's wider
  than the model CQT's C1–B6. It runs on the UI thread (about 0.2 ms per frame),
  so it never waits on inference. Confidence is the geometric mean of two
  measures: *share*, the fraction of the energy in that note's partials, and
  *dominance*, how far it is ahead of the strongest other note. A solo note
  scores about 100%, a melody note over a chord about 50% at 1.5× and 75% at
  3× louder, and an even triad 15–20%. ≥ 70% shows the note, ≥ 45% shows it
  with a `?`, and anything lower shows "no single note". A note has to win 2
  of the last 3 frames before it is shown. Known limits: a tone with no
  fundamental at all reads an octave high. In a band mix it usually reports
  the bass line, because the chord's partials sit on the bass root's harmonic
  series.

## Status and known limits

* **Inference cost:** the ONNX export has a fixed batch of 16 windows, so live
  use pays for 16 windows to get 1. That's about 0.7 s per update in desktop
  Chrome (WASM, 4 threads) and about 1.7–2 s in the simulator's WebView. Display
  delay is about 1.1 s and about 2.2 s respectively. A phone WebView without
  cross-origin isolation gets 1 thread and will be slower still. Fix: re-export
  the upstream ChordMini PyTorch weights with batch 1 (~16× less work). This is
  the top priority before real-world testing on the glasses.
* **Even host quirks** (seen in the simulator):
  * `audioControl(false)` returns `false` even when capture stopped.
  * A start sent right after a stop can cancel the stop and duplicate the
    stream, so `EvenSource` waits 400 ms after stopping.
  * Taps arrive as a `sysEvent` with no `eventType`.
* The G2's glasses-mic audio is "processed PCM" from the Even app, possibly
  tuned for speech. How that affects music is unknown until it's tried on
  hardware. Compare the glasses mic and the phone mic with double-tap.
* CQT per update takes about 85 ms on a laptop. It could be made incremental.
* **Backends:** WASM loads first. If the browser has WebGPU, a second worker
  then preloads a WebGPU session (including a warm-up run that compiles
  shaders), and switching between them is instant while listening continues.
  Each backend has its own worker because onnxruntime-web runs one runtime per
  worker: a WebGPU load in the same worker blocked WASM inference for its whole
  duration. The standby worker keeps ingesting audio so it takes over without a
  gap. It costs a second copy of the model in memory (about 17 MB plus the
  runtime) when WebGPU exists. WebGPU speed is still untested on a real GPU:
  in headless Chrome (software rendering) it took about 60 s to load and was too
  slow to produce results.
* For mic testing from a **phone** browser, getUserMedia needs HTTPS on
  anything other than localhost: use `npm run dev:https`.
* Synthetic test songs are easy. Real recordings with `.lab` annotations are
  needed to judge the model.

## Credits

Model: ChordMini (ptnghia-j, MIT), ONNX export and CQT plan
musetric/chordmini-onnx (MIT). CQT plan format ported from musetric
`packages/cqt` (MIT).
