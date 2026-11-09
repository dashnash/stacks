import type { AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';
import { scoreOf } from './tools';

/** One persona per role (top role first, so "Sign in" in the demo shows every control). */
export const personas: Persona[] = [
  { email: 'olive@demo.stacks', name: 'Olive', role: 'OWNER', blurb: 'Owner (manages access, cleans the board)' },
  { email: 'max@demo.stacks', name: 'Max', role: 'FLIPPER', blurb: 'Flipper (has unlocked the crowbar)' },
];

// [email, name, playerId, flips as [damage, hangMs, tool]]
const players: [string, string, string, [number, number, string][]][] = [
  ['olive@demo.stacks', 'Olive', 'olive', [[2100, 2400, 'hand'], [3900, 3100, 'boot'], [5200, 3800, 'crowbar']]],
  ['max@demo.stacks', 'Max', 'max', [[900, 1700, 'hand'], [1400, 2200, 'hand'], [2600, 2900, 'boot']]],
  ['tony@demo.stacks', 'Big Tony', 'tony', [[8800, 4100, 'hammer'], [9900, 4600, 'hammer']]],
  ['svetlana@demo.stacks', 'Svetlana K', 'svetlana', [[6100, 3500, 'crowbar']]],
  ['flipper@demo.stacks', 'xX_Flipper_Xx', 'xx', [[49_000, 14_900, 'hand']]],
  ['gary@demo.stacks', 'Gary', 'gary', [[300, 900, 'hand']]],
];

/** Sample data for the demo: written on first load and after a reset. Dates relative to now. */
export async function seed(deps: AppDeps): Promise<void> {
  const now = deps.now().getTime();
  let n = 0;
  for (const [email, name, playerId, flips] of players) {
    let best = 0;
    let total = 0; // Max ends up past 5000: boot and crowbar unlocked in the demo
    let createdAt = '';
    for (const [damage, hangMs, tool] of flips) {
      createdAt = new Date(now - (60 - n++) * 3_600_000).toISOString();
      const score = scoreOf(damage, hangMs);
      best = Math.max(best, score);
      total += score;
      const id = `${playerId}-${n}`;
      await deps.store.put({ PK: `FLIPS#${email}`, SK: `${createdAt}#${id}`, id, score, damage, hangMs, tool, createdAt });
    }
    await deps.store.put({ PK: 'PLAYER', SK: email, playerId, email, name, best, total, flips: flips.length, updatedAt: createdAt });
  }
}
