import { describe, expect, it } from 'vitest';
import { playGame } from '@stacks/testing';
import game, { BUMP, INPUT_HZ, MAX_PLAYERS, SMOOTHING, TICK_HZ, type DotsState } from '../game/server';

const dot = (state: DotsState | undefined, name: string) => state!.dots.find((d) => d.name === name)!;

describe('Live dots (the game rules)', () => {
  it('gives each player a dot, apart from the others, and tells everyone', () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    g.advance(50);
    expect(ann.state!.dots.map((d) => d.name)).toEqual(['ann', 'bob']);
    expect(bob.state).toEqual(ann.state);
    const [a, b] = ann.state!.dots;
    expect([a!.x, a!.y]).not.toEqual([b!.x, b!.y]);
    expect(a!.color).not.toBe(b!.color);
  });

  it('moves a dot toward where its player points, smoothly: most of the way in a few ticks, never past it', () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    g.advance(50);
    const start = dot(ann.state, 'ann').x; // 0.3
    ann.input({ x: 0.9, y: 0.3 });
    g.advance(1000 / TICK_HZ);
    const pull = 1 - Math.exp(-SMOOTHING / TICK_HZ);
    expect(dot(ann.state, 'ann').x).toBeCloseTo(start + (0.9 - start) * pull, 3);
    // Each tick closes the same share of what is left.
    const xs = [dot(ann.state, 'ann').x];
    for (let i = 0; i < 5; i++) {
      g.advance(1000 / TICK_HZ);
      xs.push(dot(ann.state, 'ann').x);
    }
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
      expect(xs[i]!).toBeLessThanOrEqual(0.9);
    }
    g.advance(1000);
    expect(dot(ann.state, 'ann').x).toBeCloseTo(0.9, 3);
    expect(dot(ann.state, 'ann').y).toBeCloseTo(0.3, 3);
  });

  it('clamps to the board whatever a browser sends', () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    ann.input({ x: 5, y: -3 });
    g.advance(2000);
    expect(dot(ann.state, 'ann')).toMatchObject({ x: 1, y: 0 });
  });

  it('ignores input that is not a position', () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    g.advance(50);
    const before = dot(ann.state, 'ann');
    for (const junk of [null, 'left', { x: 'a', y: 1 }, { x: NaN, y: 0.5 }, { x: Infinity, y: 0.5 }, { x: 0.5 }, [0.1, 0.2]]) ann.input(junk);
    g.advance(500);
    expect(dot(ann.state, 'ann')).toEqual(before);
  });

  it('only moves your own dot', () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    g.advance(50);
    const bobBefore = dot(ann.state, 'bob');
    ann.input({ x: 0.9, y: 0.9, id: bob.id });
    g.advance(1000);
    expect(dot(bob.state, 'bob')).toEqual(bobBefore);
    expect(dot(bob.state, 'ann').x).toBeCloseTo(0.9, 3);
  });

  it('takes pointer positions at 30 a second and drops the rest', () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    // 30 positions get through; the 31st (the far corner) does not.
    for (let i = 0; i < INPUT_HZ; i++) ann.input({ x: 0.4, y: 0.4 });
    ann.input({ x: 1, y: 1 });
    g.advance(2000);
    expect(dot(ann.state, 'ann')).toMatchObject({ x: 0.4, y: 0.4 });
  });

  it('fans a bump out to everyone as a shake, on the reliable channel', () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    const cy = g.join('cy@test.dev');
    bob.event(BUMP);
    for (const p of [ann, bob, cy]) expect(p.events).toEqual([{ shake: { by: 'bob' } }]);
    // Anything else is not a bump.
    bob.event('explode');
    bob.event({ type: BUMP });
    expect(ann.events).toHaveLength(1);
  });

  it("takes a leaver's dot off the board, and keeps a dropped player's for 20 s", () => {
    const g = playGame(game);
    const ann = g.join('ann@test.dev');
    const bob = g.join('bob@test.dev');
    bob.drop();
    g.advance(5000);
    expect(ann.state!.dots.map((d) => d.name)).toEqual(['ann', 'bob']);
    bob.rejoin();
    bob.leave();
    g.advance(50);
    expect(ann.state!.dots.map((d) => d.name)).toEqual(['ann']);
  });

  it('seats 8 and no more, and keeps the state small enough for one packet', () => {
    const g = playGame(game);
    const players = Array.from({ length: MAX_PLAYERS }, (_, i) => g.join({ id: `u_${'0123456789abcdef'.repeat(2).slice(i, i + 24)}`, name: `A fairly long name ${i}` }));
    expect(() => g.join('ninth@test.dev')).toThrow(/full/);
    g.advance(50);
    expect(players[0]!.state!.dots).toHaveLength(8);
    expect(JSON.stringify({ n: 99999, t: 7_200_000, s: players[0]!.state }).length).toBeLessThan(1200);
    expect(g.logs).toEqual([]);
  });

  it('records how many played when the room ends', () => {
    const g = playGame(game, { idleMinutes: 1 });
    g.join('ann@test.dev');
    g.join('bob@test.dev');
    g.advance(61_000);
    expect(g.ended).toEqual({ reason: 'idle', results: { players: 2 } });
  });
});
