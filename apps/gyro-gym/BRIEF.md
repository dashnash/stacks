# Gyro Gym

## What it is for
A test bench for the DashyHQ iOS app's Game kit (#45): it shows that CoreMotion reaches a web page
at up to 100 Hz, that every haptic and screen control works, and what a tilt game feels like. It is
the N5 gate pilot. In a plain browser it uses the browser's own motion events, so the two can be
compared side by side.

## Who uses it
The owner and testers with an iPhone, checking a new DashyHQ build. Anyone curious.

## Roles
- **Owner** (`OWNER`): manages access. Nothing else differs.
- **Player** (`PLAYER`, default): anyone who signs in with Google.

## What it tracks
Nothing on the server. The best maze time is kept in the browser (`localStorage`) only.

## What signed-out visitors see
Everything: the Lab, the Kit panel and the Maze all work signed out.

## Look and feel
A gym scoreboard: dark, high-contrast, chunky numbers, one bright accent (lime) and status chips
(Native / Web / Fake / None). Phone first; works on a laptop with arrow keys or dragging.

## Screens
- **Lab**: source chip and a Native ↔ Web toggle; rate selector (10/30/60/100 Hz); readouts and
  5 s graphs for userAcceleration, rotationRate, gravity and attitude; a meter with requested Hz,
  measured Hz, samples per batch, late batches and dropped samples; a bubble level; a CSS 3D phone
  that follows the attitude, with "Zero".
- **Kit**: a button for every haptic (five impacts, three notifications, one pattern), orientation
  lock (portrait / landscape / any), immersive on/off, keep awake on/off; each shows its last result
  (`ok`, `unsupported`, `forbidden`, …).
- **Maze**: one fixed maze. Tilt to roll the marble to the goal; a timer starts on the first move,
  a heavy buzz on wall hits (at most 10 a second), a success buzz at the goal, best time kept.
  Immersive and portrait lock while playing.

## User stories
- As a tester in DashyHQ, I open the Lab, allow motion and see "Native" at about 100 Hz.
- As a tester, I switch to Web and see the browser's lower rate; switching back works.
- As a tester, I tap each Kit button and feel or see it, with `ok` next to it.
- As a player, I roll the marble to the goal and beat my best time.
- As a laptop visitor, I tilt with the arrow keys or by dragging.
