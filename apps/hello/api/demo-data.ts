import type { AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';

/** One persona per role, so the demo shows every view. */
export const personas: Persona[] = [
  { email: 'olive@demo.stacks', name: 'Olive', role: 'OWNER', blurb: 'runs the board' },
  { email: 'max@demo.stacks', name: 'Max', role: 'MEMBER', blurb: 'says hi a lot' },
];

export async function seed(deps: AppDeps): Promise<void> {
  const samples = [
    ['Max', 'max@demo.stacks', 'First! Hello everyone 👋'],
    ['Olive', 'olive@demo.stacks', 'Welcome to the Hello Board.'],
  ] as const;
  let t = Date.parse('2026-11-01T12:00:00Z');
  for (const [name, email, text] of samples) {
    const createdAt = new Date((t += 60_000)).toISOString();
    const id = deps.newId();
    await deps.store.put({ PK: 'GREETINGS', SK: `${createdAt}#${id}`, id, text, authorEmail: email, authorName: name, createdAt });
  }
}
