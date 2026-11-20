# Game kit: hardware buttons (volume) as a trigger — phase 2

**Kind:** platform task (`native/ios`, `native/protocol/v1.json`, `packages/native`), after Sky Shot
v1. Needs `@dashnash` review. Issue #133. Status: **draft, not refined**: settle the open
questions before building.

## Why

Sky Shot's light gun fires with a tap or a flick. A volume button is the most gun-like trigger: it
sits under the index finger in portrait and doesn't disturb the aim.

## Constraints found so far

- iOS has **no public "volume button pressed" API**, and a web page in Safari can't see the buttons
  at all. So this is native-only, with tap as the fallback everywhere else.
- Two known ways to do it:
  1. **Watch the volume**: KVO on `AVAudioSession.sharedInstance().outputVolume` with an active audio
     session, an off-screen `MPVolumeView` to hide the system HUD, and resetting the volume to a
     middle value after each press (otherwise presses at max/min volume are lost). Down and up are
     both visible. No hold or auto-repeat signal; rapid presses can merge.
  2. **`AVCaptureEventInteraction`** (iOS 17.2+): official primary/secondary button events, but
     only while an `AVCaptureSession` is running (a camera app). It would mean running the camera
     (light, privacy indicator) for a game. Probably not acceptable.
- **App Review guideline 2.5.9** forbids apps that "alter or disable the functions of standard
  switches, such as the Volume Up/Down". The KVO trick risks rejection for external TestFlight and
  the App Store. Internal TestFlight builds are not reviewed.

## Shape (to confirm)

- Manifest `native: ["buttons"]` (a new capability; sensitive? probably not, but it changes system
  volume behaviour while active).
- `native.buttons.capture({ volume: true }, (e) => e.button /* 'volumeUp' | 'volumeDown' */, e.t)`
  returns `stop()`; `stop.source`: `'native' | 'none'`. Active only while the page is visible and the
  capture is held; the app restores the volume and the HUD on stop or when the page goes away.
- Fakes: `fakeButtons()` with `press('volumeUp')` for demos and tests.
- Sky Shot: a third trigger option, `volume`, in the tuning panel.

## Open questions

1. Ship it in internal TestFlight builds only (a build flag), or accept the review risk for all?
2. Is the audio session it needs a problem with Sky Shot's WebAudio sound?
3. Event timing: how far is the KVO notification behind the press? Measure on a device before
   building the Sky Shot side.
