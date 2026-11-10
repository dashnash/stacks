import { fixtureUserId, type AppDeps } from '@stacks/api';
import type { Persona } from '@stacks/demo';

/** One persona per role (top role first, so "Sign in" in the demo shows every control). */
export const personas: Persona[] = /*__PERSONAS__*/ [];

/** Sample data for the demo: written on first load and after a reset. */
export async function seed(deps: AppDeps): Promise<void> {
  let t = Date.parse('2026-11-01T12:00:00Z');
  for (const [i, p] of personas.entries()) {
    const createdAt = new Date((t += 60_000)).toISOString();
    const id = deps.newId();
    const text = i === 0 ? 'Welcome! This is a starter note: replace it with the real features.' : `Hi, I'm ${p.name}.`;
    await deps.store.put({ PK: 'NOTES', SK: `${createdAt}#${id}`, id, text, authorId: fixtureUserId(p.email), authorName: p.name, createdAt });
  }
}
