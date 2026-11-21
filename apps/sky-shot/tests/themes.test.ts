import { afterEach, describe, expect, it } from 'vitest';
import type { Snapshot, TargetView } from '../game/protocol';
import { DEFAULT_THEME, isThemeChoice, THEME_IDS, THEME_PALETTES, THEME_TAGS, themeTag, type ThemeChoice } from '../game/themes';
import { drawFrame, drawThumb, Layers, type MakeLayer } from '../web/src/draw';
import { nextTheme, THEMES, themeOf, type Palette, type Theme } from '../web/src/themes';

/** A 2D context that accepts every call and records the method names (jsdom has no canvas). */
function fakeCtx() {
  const calls: { name: string; args: unknown[] }[] = [];
  const target: Record<string | symbol, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => ({}),
    measureText: (t: string) => ({ width: t.length * 8 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  const ctx = new Proxy(target, {
    get(t, k) {
      if (k in t) {
        const v = t[k];
        return typeof v === 'function' ? (...args: unknown[]) => (calls.push({ name: String(k), args }), (v as (...a: unknown[]) => unknown)(...args)) : v;
      }
      return (...args: unknown[]) => void calls.push({ name: String(k), args });
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const target = (over: Partial<TargetView> = {}): TargetView => ({ id: 1, k: 0, x: 0.5, y: 0.5, r: 0.05, s: 0, h: 0.3, ...over });
const snap = (tg: TargetView[]): Snapshot => ({
  ph: 'playing',
  m: 'rounds',
  pz: false,
  tg,
  g: [{ id: 'a', c: 0, x: 0.4, y: 0.4, rx: 0.41, ry: 0.41, on: true, m: false }],
  sc: 100,
  rd: 1,
  sl: 3,
  h: 0,
  q: 6,
  left: 8,
  cfg: 'abc',
});

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, bl] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const added: string[] = [];
/** Register a theme for one test (the registry is the only way drawFrame finds one). */
function register(theme: Theme): ThemeChoice {
  (THEMES as Record<string, Theme>)[theme.id] = theme;
  added.push(theme.id);
  return { id: theme.id, palette: Object.keys(theme.palettes)[0]! } as ThemeChoice;
}
afterEach(() => {
  for (const id of added.splice(0)) delete (THEMES as Record<string, Theme>)[id];
});

describe('the theme registry', () => {
  it('has a drawing for every theme the server and API accept, with the same palettes', () => {
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_IDS].sort());
    for (const id of THEME_IDS) {
      expect(THEMES[id].id).toBe(id);
      expect(Object.keys(THEMES[id].palettes).sort()).toEqual([...THEME_PALETTES[id]].sort());
    }
    expect(DEFAULT_THEME).toEqual({ id: 'dusk', palette: 'dusk' });
    expect(THEME_TAGS).toContain(themeTag(DEFAULT_THEME));
  });

  it('every palette has three seat colours with at least 3:1 contrast against its ground', () => {
    for (const id of THEME_IDS)
      for (const [key, p] of Object.entries(THEMES[id].palettes as Record<string, Palette>)) {
        expect(p.seats, `${id}/${key}`).toHaveLength(3);
        for (const seat of p.seats) expect(contrast(seat, p.ground), `${id}/${key} ${seat} on ${p.ground}`).toBeGreaterThanOrEqual(3);
      }
  });

  it('checks choices strictly and falls back to the default', () => {
    expect(isThemeChoice({ id: 'dusk', palette: 'dusk' })).toBe(true);
    for (const v of [null, 'dusk', { id: 'dusk' }, { id: 'nope', palette: 'dusk' }, { id: 'dusk', palette: 'nope' }, { id: 'constructor', palette: 'dusk' }]) expect(isThemeChoice(v)).toBe(false);
    expect(themeOf({ id: 'gone', palette: 'x' } as unknown as ThemeChoice).theme.id).toBe('dusk');
    expect(nextTheme(DEFAULT_THEME).id).toBe(THEME_IDS[1 % THEME_IDS.length]);
  });

  it('every theme draws every target, hit and miss effects, crosshairs, calibration and a whole frame', () => {
    for (const id of THEME_IDS)
      for (const palette of THEME_PALETTES[id]) {
        const choice = { id, palette };
        const { ctx, calls } = fakeCtx();
        const tg = [0, 1, 2].flatMap((k) => [target({ id: k + 1, k }), target({ id: k + 10, k, s: 1 }), target({ id: k + 20, k, s: 2 })]);
        const now = 10_000;
        const effects = [
          { kind: 'hit' as const, id: 1, x: 0.5, y: 0.5, c: 0, at: now - 100, pts: 100, r: 0.05 },
          { kind: 'miss' as const, id: 2, x: 0.3, y: 0.3, c: 1, at: now - 100 },
        ];
        const trails = new Map([['a', [[0.3, 0.3], [0.35, 0.35]] as [number, number][]]]);
        drawFrame(ctx, 960, 540, snap(tg), effects, { now, theme: choice, overlay: true, calibrate: true, cal: { i: 1, pts: [[0.5, 0.5], [0.2, 0.2]] }, hits: [{ id: 10, k: 0, x: 0.5, y: 0.4, r: 0.05, h: 0, at: now - 200 }], hitboxes: 1.1, trails });
        drawThumb(ctx, 160, 90, choice);
        expect(calls.length, `${id}/${palette}`).toBeGreaterThan(50);
        // Every save is restored, so one theme's state never leaks into the next draw.
        expect(calls.filter((c) => c.name === 'save').length).toBe(calls.filter((c) => c.name === 'restore').length);
      }
  });
});

describe('drawing a frame', () => {
  const calls = (theme: Theme) => {
    const seen: { id: number; hitAge: number; x: number }[] = [];
    return {
      seen,
      theme: {
        ...theme,
        target: (_c: CanvasRenderingContext2D, t: TargetView, _r: number, _n: number, _p: Palette, hitAge: number) => void seen.push({ id: t.id, hitAge, x: t.x }),
      } as Theme,
    };
  };

  it('a theme whose hit targets stay put draws the copy where it was hit, not the falling target', () => {
    const t = calls({ ...THEMES.dusk, id: 'held' as Theme['id'], hitMotion: 'hold', hitMs: 900 });
    const choice = register(t.theme);
    const now = 5_000;
    const hits = [{ id: 7, k: 0, x: 0.2, y: 0.3, r: 0.05, h: 0, at: now - 300 }];
    drawFrame(fakeCtx().ctx, 800, 450, snap([target({ id: 7, s: 1, x: 0.25, y: 0.9 }), target({ id: 8 })]), [], { now, theme: choice, overlay: false, calibrate: false, hits });
    expect(t.seen).toEqual([
      { id: 8, hitAge: -1, x: 0.5 },
      { id: 7, hitAge: 300, x: 0.2 },
    ]);
    // Once its animation is over, nothing is drawn for it.
    t.seen.length = 0;
    drawFrame(fakeCtx().ctx, 800, 450, snap([target({ id: 7, s: 1, y: 1.1 })]), [], { now: now + 1000, theme: choice, overlay: false, calibrate: false, hits });
    expect(t.seen).toEqual([]);
  });

  it('a theme whose hit targets fall draws the server\'s falling target, with its age', () => {
    const t = calls({ ...THEMES.dusk, id: 'falls' as Theme['id'], hitMotion: 'fall' });
    const choice = register(t.theme);
    drawFrame(fakeCtx().ctx, 800, 450, snap([target({ id: 7, s: 1, x: 0.25 })]), [], { now: 5_000, theme: choice, overlay: false, calibrate: false, hits: [{ id: 7, k: 0, x: 0.2, y: 0.3, r: 0.05, h: 0, at: 4_800 }] });
    expect(t.seen).toEqual([{ id: 7, hitAge: 200, x: 0.25 }]);
  });

  it('caches the background and overlay per size and palette, and draws them directly without a canvas', () => {
    let made = 0;
    const make: MakeLayer = () => (made++, { image: {} as CanvasImageSource, ctx: fakeCtx().ctx });
    const layers = new Layers(make);
    const frame = (w: number) => drawFrame(fakeCtx().ctx, w, 450, snap([]), [], { now: 0, theme: DEFAULT_THEME, overlay: false, calibrate: false }, layers);
    frame(800);
    frame(800);
    frame(800);
    expect(layers.builds).toBe(1);
    frame(900);
    expect(layers.builds).toBe(2);
    layers.clear();
    frame(900);
    expect(layers.builds).toBe(3);
    expect(made).toBe(3); // Dusk has no overlay: one layer per build.

    const direct = fakeCtx();
    drawFrame(direct.ctx, 800, 450, snap([]), [], { now: 0, theme: DEFAULT_THEME, overlay: false, calibrate: false }, new Layers(() => null));
    expect(direct.calls.some((c) => c.name === 'createLinearGradient')).toBe(true);
  });

  it('skips ambient motion when asked to, and draws hitboxes scaled by the tuning', () => {
    let ambient = 0;
    const choice = register({ ...THEMES.dusk, id: 'moving' as Theme['id'], ambient: () => void ambient++ });
    const base = { now: 0, theme: choice, overlay: false, calibrate: false };
    drawFrame(fakeCtx().ctx, 800, 450, snap([]), [], base);
    drawFrame(fakeCtx().ctx, 800, 450, snap([]), [], { ...base, reducedMotion: true });
    expect(ambient).toBe(1);
    const { ctx, calls: seen } = fakeCtx();
    drawFrame(ctx, 800, 450, snap([target({ r: 0.1 }), target({ id: 2, s: 1 })]), [], { ...base, hitboxes: 1.5 });
    // One dashed circle (the live target only), radius r × scale in px.
    const dashed = seen.filter((c) => c.name === 'arc' && c.args[2] === 0.1 * 450 * 1.5);
    expect(dashed).toHaveLength(1);
  });
});

describe('Stargazer', () => {
  const stars = THEMES.stars;
  const p = stars.palettes.dusk!;

  it('hangs a sleeping star on a thread that reaches the top of the play area', () => {
    const { ctx, calls } = fakeCtx();
    const h = 540;
    const t = target({ k: 2, y: 0.4, r: 0.06 });
    stars.target(ctx, t, t.r * h, 0, p, -1);
    const thread = calls.find((c) => c.name === 'lineTo');
    expect(thread?.args[0]).toBe(0);
    expect(thread?.args[1]).toBeCloseTo(-0.4 * h);
  });

  it('a hit star pops, then has faded out by the end of hitMs', () => {
    expect(stars.hitMotion).toBe('hold');
    const at = (hitAge: number) => {
      const { ctx, calls } = fakeCtx();
      ctx.globalAlpha = 1;
      stars.target(ctx, target({ k: 0 }), 27, 0, p, hitAge);
      return { scale: calls.find((c) => c.name === 'scale')?.args[0] as number, alpha: ctx.globalAlpha };
    };
    expect(at(150).scale).toBeCloseTo(1.35);
    expect(at(500)).toEqual({ scale: 1, alpha: 1 });
    expect(at(stars.hitMs).alpha).toBe(0);
  });
});
