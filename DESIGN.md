
BoneGlimpse is an app for Even G2 to help learn chords on the musical
keyboard.

It's main purpose is to display chord/scale names, keys played, and finger
positions.

It can display any chord, and recognizes the 170 class set, fallig
back when confidence is low.

It has two main modes: scale mode and chord mode.

In scale mode, the user selects a scale and bpm, and the app runs
through various scale progressons.

In chord mode, input data can come from several sources:

- It has a learn mode where users can enter a chord progression and
  bpm, and the app runs through them

- It has a mode that can detect chords. This has submodes:
  - It can extract the chords and bpm from a user's file
  - It can detect the chords and bpm from live music

- It has a mode that takes a standard input file format and bpm, to
  display a keyboard, chord, keys to play, and finger position.

The code is structured so that the "chord engine" is separate from any
specifics relating to Even G2.

For the initial prototype, we are going to see how well realtime
detection works. Ignore any learning functionality, and just build a
glasses app that detects chords in the live audio stream, using either
the glasses or phone mic. The initial prototype does not need bpm
detection.
