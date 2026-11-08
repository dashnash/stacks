import { describe, expect, it } from 'vitest';
import { scoreOf } from '../api/tools';
import { ITEMS, simulateFlip, swipeStrength, WORLD } from '../web/src/game/sim';

describe('the flip simulation', () => {
  it('is the same for the same seed', () => {
    expect(simulateFlip(1, 42).score).toBe(simulateFlip(1, 42).score);
  });

  it('flips the table with a good pull and not with a weak one', () => {
    expect(simulateFlip(1, 3).flipped).toBe(true);
    expect(simulateFlip(0.3, 3).flipped).toBe(false);
  });

  it('scores damage plus hang time, within what the API accepts, and keeps things on the stage', () => {
    for (const s of [0.5, 1, 2, 4]) {
      const r = simulateFlip(s, 9);
      expect(r.score).toBe(scoreOf(r.damage, r.hangMs));
      expect(r.damage).toBeGreaterThan(0);
      expect(r.damage).toBeLessThanOrEqual(50_000);
      expect(r.hangMs).toBeLessThanOrEqual(15_000);
      expect(r.items).toHaveLength(ITEMS.length);
      for (const f of r.frames) for (const it of f.items) expect(it.x >= 0 && it.x <= WORLD.w && it.y >= 0 && it.y <= WORLD.floor).toBe(true);
    }
  });

  it('turns a swipe into a strength, ignoring tiny or downward swipes', () => {
    expect(swipeStrength(5, 100)).toBe(0);
    expect(swipeStrength(-200, 100)).toBe(0);
    expect(swipeStrength(300, 300)).toBeGreaterThan(0.5);
    expect(swipeStrength(3000, 1)).toBe(1.8);
  });
});
