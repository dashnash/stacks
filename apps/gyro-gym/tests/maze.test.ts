import { describe, expect, it } from 'vitest';
import { BALL_R, find, HIT_SPEED, isWall, MAZE, solvable, startBall, step } from '../web/src/game/maze';

const run = (ball = startBall(), tilt = { x: 0, y: 0 }, seconds = 1) => {
  let hit = 0;
  let goal = false;
  for (let t = 0; t < seconds; t += 1 / 60) {
    const r = step(ball, tilt, 1 / 60);
    hit = Math.max(hit, r.hit);
    goal ||= r.goal;
  }
  return { ball, hit, goal };
};

const inWall = (x: number, y: number) =>
  [[x - BALL_R, y], [x + BALL_R, y], [x, y - BALL_R], [x, y + BALL_R]].some(([px, py]) => isWall(Math.floor(px! + 1e-6 * Math.sign(x - px!)), Math.floor(py! + 1e-6 * Math.sign(y - py!))));

describe('the maze', () => {
  it('can be solved, and the marble starts at S', () => {
    expect(solvable()).toBe(true);
    expect(solvable(['####', '#S##', '##G#', '####'])).toBe(false);
    expect(startBall()).toEqual({ ...find('S'), vx: 0, vy: 0 });
  });

  it('stops the marble at walls, whatever the tilt', () => {
    for (const tilt of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 1 }, { x: -1, y: -1 }]) {
      const { ball } = run(startBall(), tilt, 4);
      expect(inWall(ball.x, ball.y), `${JSON.stringify(tilt)} → ${ball.x},${ball.y}`).toBe(false);
      expect(ball.x).toBeGreaterThan(1);
      expect(ball.y).toBeGreaterThan(1);
    }
  });

  it('reports a hard wall hit, not a gentle one', () => {
    // Start is 0.2 cells from the left wall: a gentle tilt arrives slowly (a bump), a full one hits.
    expect(run(startBall(), { x: -0.1, y: 0 }, 0.5).hit).toBe(0);
    expect(run(startBall(), { x: -1, y: 0 }, 0.5).hit).toBeGreaterThanOrEqual(HIT_SPEED);
    const ball = { ...startBall(), vx: 8, vy: 0 };
    const r = run(ball, { x: 0, y: 0 }, 0.5);
    expect(r.hit).toBeGreaterThanOrEqual(HIT_SPEED);
  });

  it('slows down with no tilt (friction)', () => {
    const ball = { x: 5.5, y: 3, vx: 0, vy: 3 };
    run(ball, { x: 0, y: 0 }, 0.5);
    expect(Math.abs(ball.vy)).toBeLessThan(3);
  });

  it('wins at the hole', () => {
    const g = find('G');
    const ball = { x: g.x, y: g.y - 0.6, vx: 0, vy: 0 };
    expect(run(ball, { x: 0, y: 0.6 }, 0.5).goal).toBe(true);
    expect(MAZE.every((row) => row.length === MAZE[0]!.length)).toBe(true);
  });
});
