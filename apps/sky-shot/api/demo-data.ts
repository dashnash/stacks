import { fixtureUserId, type AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';
import type { ShotRecord } from '../game/protocol';
import { configId, DEFAULT_TUNING, type Tuning } from '../game/tuning';
import { keys, TELEMETRY_DAYS, type LeaderItem } from './keys';

/** One persona per role (top role first, so "Sign in" in the demo shows every control). */
export const personas: Persona[] = [
  { email: 'olive@demo.stacks', name: 'Olive', role: 'OWNER', blurb: 'Owner (sees all telemetry)' },
  { email: 'max@demo.stacks', name: 'Max', role: 'SHOOTER', blurb: 'Shooter' },
];

/** Two tuning configs Max has been comparing on the Range. */
const SNAPPY: Tuning = { ...DEFAULT_TUNING, fovGain: 1.9, minCutoff: 2.5, prediction: 40 };
const FLICKY: Tuning = { ...DEFAULT_TUNING, mode: 'hybrid', trigger: 'flick', flickThreshold: 1.4 };

/** Sample data for the demo: written on first load and after a reset. */
export async function seed(deps: AppDeps): Promise<void> {
  const now = deps.now();
  const day = 86_400_000;
  const board: [string, string, number, number, number][] = [
    ['Max', 'max@demo.stacks', 8450, 6, 0.81],
    ['Robin', 'robin@demo.stacks', 7200, 5, 0.77],
    ['Olive', 'olive@demo.stacks', 5100, 4, 0.7],
    ['Sam', 'sam@demo.stacks', 2650, 2, 0.58],
  ];
  for (const [i, [name, email, score, rounds, accuracy]] of board.entries()) {
    const at = new Date(now.getTime() - (i + 1) * day);
    at.setHours(20, 15, 0, 0);
    const userId = fixtureUserId(email);
    await deps.store.put({ ...keys.leader(userId), userId, name, score, rounds, accuracy, at: at.toISOString(), roomId: `demo-room-${i}` } satisfies LeaderItem);
  }

  const expiresAt = Math.floor(now.getTime() / 1000) + TELEMETRY_DAYS * 86_400;
  for (const t of [SNAPPY, FLICKY]) await deps.store.put({ ...keys.config(configId(t)), id: configId(t), tuning: t, expiresAt });
  // Last night's Range session: Max and Olive, 18 shots each, two configs.
  const session = new Date(now.getTime() - day);
  session.setHours(21, 0, 0, 0);
  for (const [who, email] of [
    ['max', 'max@demo.stacks'],
    ['olive', 'olive@demo.stacks'],
  ] as const) {
    const userId = fixtureUserId(email);
    for (let n = 0; n < 18; n++) {
      const tuning = n < 9 ? SNAPPY : FLICKY;
      const hit = (n * 7 + who.length) % 10 < (n < 9 ? 7 : 8);
      const at = new Date(session.getTime() + (who === 'max' ? 0 : 3_600_000) + n * 4100).toISOString();
      const shot: ShotRecord = {
        t: n * 4100,
        shooterId: userId,
        mode: 'range',
        configId: configId(tuning),
        trigger: tuning.trigger,
        hit,
        missDist: hit ? 0 : 0.01 + ((n * 13) % 7) / 100,
        rewindMs: 140 + ((n * 17) % 60),
        latency: { gunRtt: 38 + (n % 5) * 4, screenRtt: 24 + (n % 3) * 3, shotToPixel: 165 + (n % 4) * 9 },
        window: Array.from({ length: 11 }, (_, k) => [-300 + k * 40, 0, 0, Math.sin(k / 3) * 0.05, 1, 0.1, 0.02, Math.cos(k) * 0.4, 0, tuning.trigger === 'flick' && k === 7 ? 2.1 : 0.05, 0]),
      };
      await deps.store.put({ ...keys.shot(userId, at, `demo-range-${who}`, n), ...shot, roomId: `demo-range-${who}`, at, expiresAt });
    }
  }
}
