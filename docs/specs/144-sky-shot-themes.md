# Sky Shot themes: Ink Koi, Neon Courier, Stargazer

**Kind:** app task (`apps/sky-shot/` only). Issue #144. Builds on [`132-sky-shot.md`](132-sky-shot.md).

Concept art (live, same simulation in every theme): https://claude.ai/artifact/132FrUxBvykG4T6zamirnc.
Its drawing code is a working prototype of the theme interface below; port from it rather than
starting over.

Sky Shot gets three switchable art styles beside today's look. The **game does not change**: the
same targets, paths, radii, hitboxes, scoring, rounds, tuning and telemetry in every theme. A theme
only changes how things are drawn and worded. Because of that, shots stay comparable across themes,
and the theme is logged with each shot so we can see whether a look changes accuracy (contrast,
busy backgrounds).

## Decisions the owner settled (don't reopen)

| Topic | Decision |
| --- | --- |
| Themes | **Ink Koi** (sumi-e brush painting), **Neon Courier** (synthwave wireframe), **Stargazer** (cut-paper night sky). |
| Switching | In the app, by each player, at any time (title screen, tuning panel, mid-round). |
| Gameplay | Identical in every theme. Theme-specific rules are out of scope (see "Later"). |
| Palettes | Ink Koi **Rice paper**, Neon Courier **Midnight run**, Stargazer **Dusk paper** (picked on the concept page). |

## Choices this spec makes (the owner may change them before the build starts)

| Topic | Choice | Why |
| --- | --- | --- |
| Today's look | Kept as a fourth theme, **Dusk**, and stays the default for new players. | Nothing changes for anyone who doesn't pick a theme; a baseline for telemetry. |
| Second palettes | Each theme also ships its other concept palette (Ink Koi *Moon pond*, Neon Courier *Amber terminal*, Stargazer *Indigo paper*) as a player option; the owner's picks above are the defaults. | Both were drawn already; a light and a dark option helps on bright rooms and projectors. |
| Who chooses in a room | The **screen**. The phone follows it. | The screen is what everyone looks at; the phone just matches it. |
| Saved choice | Per person (by user id), like the default tuning. Signed out and demo: `localStorage`. | Same pattern as `/tuning`. |

## The look of each theme

How each existing target kind is drawn. Radii (`RADIUS` in `game/targets.ts`) and motion are
unchanged.

| Kind | Dusk (today) | Ink Koi | Neon Courier | Stargazer |
| --- | --- | --- | --- | --- |
| `bird` (r 0.05) | teal bird | koi (top-down, sways, ink with red or gold patch) | courier drone (4 rotors, parcel, tilts with heading) | shooting star (paper star, three ribbon tails) |
| `clay` (r 0.035) | orange disc | dragonfly (wing blur) | data packet (spinning nested diamonds) | firefly (paper bug, pulsing glow) |
| `balloon` (r 0.06) | pink balloon | lotus on a lily pad (opens and closes) | beacon (pulsing hexagon, light beam down) | sleeping star (hangs on a thread from the top; dashed cut line) |

| | Ink Koi | Neon Courier | Stargazer |
| --- | --- | --- | --- |
| Background | Rice paper with ink washes, lily pads, reeds at the edges; slow ambient ripples | Gradient sky, striped sun, skyline, perspective grid scrolling towards you | Layered paper sky and hills with drop shadows, moon, paper trees, a faint constellation, twinkles |
| Overlay (over everything) | Paper grain | Scanlines + vignette | Paper grain |
| Hit effect | Ink bloom, `+pts` in the brush face, red | Vector shards + `SIGNED +pts` in the seat colour | Paper confetti with gravity + `+pts` |
| Hit target | **sink**: shrinks and fades where it was hit (~1 s) | **fall** (today's behaviour), flickering | **hold**: lights up, pops (scale 1.35) and fades after ~0.7 s |
| Miss effect | Two ripple rings | RGB-split glitch square | Puff of paper dust |
| Crosshair | Ensō brush circle in the seat colour | Corner-bracket reticle with a short light trail | Punched-paper ring with moving stitches |
| Type | Yuji Syuku (score), Shippori Mincho (labels); round in a red seal | Chakra Petch (HUD), Tilt Neon (titles) | Sniglet, on paper tags |
| Phone verb | Tap to catch | Tap to sign | Tap to light |
| Shots-left glyphs | ink dots | bars | stars |

Palettes, seat colours and every drawing routine: the concept page's `koi`, `neon` and `stars`
objects. Copy the hex values from there.

## What changes

### 1. Theme registry (`game/themes.ts`, `web/src/themes/`)

```
game/themes.ts      // THEME_PALETTES (ids and palette keys), ThemeChoice, DEFAULT_THEME,
                    // isThemeChoice, themeTag ("koi/rice"): shared by the server, the API and the web
web/src/themes/
  types.ts          // the Theme and Palette interfaces (the source of truth for the shapes)
  index.ts          // THEMES, themeOf(choice), nextTheme (the L key), lookStyle (CSS variables)
  dusk.ts           // the original look, moved from draw.ts with no visual change
  koi.ts  neon.ts  stars.ts
  paint.ts          // shared helpers (rng, rgba, starPath, brush strokes, grain, paper shadow);
                    // added with the first theme that needs them
```

Adding a theme: its palette keys in `THEME_PALETTES` (the first is its default), its drawing in
`THEMES`. `themes.test.ts` fails until the two agree.

A `Palette` has a `name`, three `seats` (replacing `GUN_COLORS`), a `ground` (for the contrast
rule) and `css` (custom properties for the HUD and phone), plus the theme's own colours. A `Theme`
has its `palettes`, `hitMotion` and `hitMs`, the phone's `verb` (`tap`, `flick`) and `shells`
glyphs, `fonts` to preload, and the drawing methods: `background` and `overlay` (cached layers),
`ambient` (every frame, skipped under reduced motion), `target` (with `hitAge` in ms, or -1),
`effect`, `crosshair` (with the raw position for the tuning overlay and a trail) and an optional
`calibration` (falls back to Dusk's).

`draw.ts` keeps `drawFrame`, now taking `opts.theme: ThemeChoice`. A `Layers` object caches the
background and overlay per theme, palette, size and pixel ratio, then each frame: background,
`ambient`, calibration, targets, hit copies, hitboxes, effects, crosshairs, overlay. Each theme
stops drawing its own effects when they finish; the screen drops them after `EFFECT_MS` (1.5 s).

### 2. Hit motion is drawn by the screen only

The server keeps making hit targets fall (no server change). For `sink` and `hold`, the screen:

- on a `hit` event, records `{ target id, kind, r, x, y, at }` from the latest snapshot;
- stops drawing snapshot targets with `s === 1` whose id it recorded;
- draws the recorded copy at the hit position through `theme.target(..., hitAge)` until the theme's
  hit animation ends.

Hit targets can't be hit again, so this is purely visual and lag compensation is untouched.

### 3. HUD, overlays and the phone

- `.screen` and the phone root get `data-theme` and `data-palette`, and the palette's `css` is set
  as custom properties. `styles.css` reads `--hud-fg`, `--hud-font`, `--hud-accent`, `--panel-bg`,
  etc. instead of literals. The HUD stays DOM; restyle the score, shells (glyph per theme), gun chips
  and banners per theme. The tuning panel, telemetry page and account menu keep the neutral app
  style in every theme so tuning stays readable.
- Fonts: one Google Fonts `@import` for the four families (precedent:
  `apps/mofobookklub/web/src/index.css`), with system fallbacks. Before drawing canvas text in a
  theme, `await Promise.all(theme.fonts.map((f) => document.fonts.load(f)))` and drop the layer cache
  once loaded.
- `Gun.tsx`: the trigger button shows `theme.verb` in tap mode ("Flick to fire" etc. stays in flick
  mode, worded per theme: "Flick to catch", "Flick to sign", "Flick to light"); the background,
  border and font come from the palette. The `aria-label` stays "Fire" so tests and screen readers
  don't depend on the theme.

### 4. Choosing a theme

- **Title screen:** a "Look" row of four cards (a small static thumbnail drawn with the theme's
  `background` plus one target) and a palette toggle under the selected card. Changing it applies at
  once and saves.
- **Tuning panel:** the same choice as a compact select, plus a **Show hitboxes** checkbox that draws
  each live target's hitbox (`r × hitboxScale`, dashed) under the existing overlay toggle.
- **Keyboard:** `L` cycles the theme on the screen (beside `T` for the panel).
- **Saved:** `GET /api/prefs` → `{ theme: ThemeChoice | null }`, `PUT /api/prefs { theme }`,
  member routes keyed by `v.user.id` (`keys.prefs(userId)` → `PK: PREFS#<userId>, SK: CURRENT`).
  Validate with `isThemeChoice`; an unknown id or palette is a 400. A saved theme that has since
  been removed reads as null. Signed out and in the demo:
  `localStorage['sky-shot:theme']`, read in try/catch.

### 5. The room knows the theme (for the phone and telemetry)

- Screen → server event: `{ theme: ThemeChoice }`. Sent when the screen joins and on every change.
  The server validates it (unknown values ignored), keeps it in room state and broadcasts
  `{ theme: ThemeChoice }` to all seats. A gun that joins later gets it with the next broadcast; send
  it on join as well.
- `ShotRecord` gets `theme?: string` (`themeTag`, e.g. `"koi/rice"`), `GameSummary` gets `theme?: string`. Optional,
  so the previous app version's results still parse. The 500-shot results stay under
  `MAX_RESULTS_BYTES` (about +10 KB); extend the size test to include it.
- Telemetry page and CSV/JSON download: a **Look** column and filter (`GET /telemetry?theme=`). The per-config stats in the
  tuning panel stay per config id (not split by theme).

### 6. Rules every theme must meet

- **Hitbox fit:** the target's solid body sits inside `r × 1.1` and its longest dimension is at
  least `0.8 r`. Tails, trails, wings, beams, threads and glows may spill outside; they are
  decoration and never count for hits. Check with Show hitboxes.
- **Contrast:** every seat colour has at least 3:1 contrast against the palette's dominant
  background colour (`palette.ground`). Each palette declares `ground`.
- **Readability while moving:** at 1920×1080, a target is identifiable at full speed in round 6; the
  crosshair is never hidden behind the overlay (the overlay may tint it, not cover it).
- **Reduced motion:** `prefers-reduced-motion` stops `ambient` (ripples, grid scroll, twinkles) and
  the crosshair trail. Game motion is unchanged.
- **Performance:** a frame at 1920×1080, DPR 2, stays under 6 ms of drawing on a mid-range laptop.
  Backgrounds and overlays are cached layers; `shadowBlur` only on targets, effects and crosshairs,
  never per background element per frame.
- **No real-world IP:** original drawings only, no sprites or fonts lifted from another game.

## Tests

- `themes.test.ts`: the registry matches `THEME_PALETTES`; every palette has three seats with 3:1
  contrast against its `ground`; every theme and palette draws every target kind (flying, hit,
  fleeing), hit and miss effects, crosshairs, calibration, a whole frame and a thumbnail against a
  recording fake `CanvasRenderingContext2D` without throwing, with every `save` restored (jsdom has
  no canvas; `app.test.tsx` already stubs `getContext`). Drawing: with `hitMotion: 'hold'` the hit
  copy is drawn instead of the falling target; `fall` draws the server's target with its age; layers
  rebuild only on a size or palette change; reduced motion skips `ambient`; hitboxes are scaled by
  `hitboxScale`.
- `game.test.ts`: every seat gets the look on joining and when the screen changes it; a gun's
  `theme` event and bad values are ignored; shots and the game summary carry the `themeTag`; the
  results-size test passes with it.
- `api.test.ts`: `/prefs` GET/PUT by user id; 400 on unknown id or palette (including inherited
  property names); 401 signed out; a removed theme reads as null; telemetry filters by `theme`.
- `app.test.tsx`: the title screen offers the looks; the screen and phone carry `data-theme` and the
  palette's CSS variables; the tuning panel has the Look select and Show hitboxes; an unknown look in
  `localStorage` falls back to Dusk. From PR 2 (two themes): picking a look saves it, the screen
  switches, and the phone shows the new verb.
- Demo screenshots (`web/src/demo/pages.ts`), from PR 2: `mid-round-koi`, `mid-round-neon`,
  `mid-round-stars`, so `npm run verify-app -- sky-shot` captures each theme.

## Build order (PRs)

| Order | PR | Visible change |
| --- | --- | --- |
| 1 | Theme plumbing: registry, `dusk.ts` (moved from `draw.ts`), cached layers, hit-motion recording, CSS variables, picker, `/prefs`, room `theme` event, telemetry column, tests | Only the picker (one choice) and the telemetry column |
| 2 | Ink Koi | New theme |
| 3 | Neon Courier | New theme |
| 4 | Stargazer | New theme |

PRs 2-4 are independent of each other once 1 has merged.

## Docs to update in the same PRs

- `apps/sky-shot/BRIEF.md`: "Look and feel" lists the four themes; "What it tracks" adds the saved
  look.
- `docs/specs/132-sky-shot.md`: the "Look" row points here.
- `docs/specs/README.md`: add this spec to the Sky Shot table.

## Owner steps

None: no infra, manifest or platform change.

## Later (not in this spec)

Theme-specific rules, each a separate spec because they change gameplay and telemetry:
a golden koi that dodges when your aim gets close; Neon drone chains hit in order for a combo;
Stargazer constellations (static stars lit in any order, scored as a set) with a moth that puts lit
stars out. Also: per-theme sound.

## How to check the work

1. `npm test`, `npm run typecheck`, `npm run lint` and `npm run verify-app -- sky-shot` pass.
2. `npm run demo -w apps/sky-shot`: pick each theme and palette on the title screen; play a round
   with the pretend phone; turn on Show hitboxes and compare with the concept page.
3. Switch theme mid-round with `L`: the round carries on and the phone's trigger changes.
4. Download telemetry after shots in two themes: each row has the right theme.
