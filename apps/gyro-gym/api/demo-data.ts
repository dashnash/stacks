import type { AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';

/** One persona per role (top role first, so "Sign in" in the demo shows every control). */
export const personas: Persona[] = [
  { email: 'olive@demo.stacks', name: 'Olive', role: 'OWNER', blurb: 'Owner (manages access)' },
  { email: 'max@demo.stacks', name: 'Max', role: 'PLAYER', blurb: 'Player' },
];

/** Nothing to seed: the app stores nothing. */
export async function seed(_deps: AppDeps): Promise<void> {}
