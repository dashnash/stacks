import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// The real config, not a fixture: these are rules about the deployed environments.
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../stacks.config.json'), 'utf8'));
const { production, staging } = config.environments;

describe('stacks.config.json: one Google OAuth client per environment (#96)', () => {
  it('gives staging and production different web client ids', () => {
    // The platform accepts any Google credential addressed to its client id, so a shared id makes
    // a credential captured on staging good for a production session.
    expect(staging.googleClientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(production.googleClientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(staging.googleClientId).not.toBe(production.googleClientId);
  });

  it("never lists one environment's client among the other's iOS clients", () => {
    const ios = (env: { native?: { googleIosClientIds?: string[] } }) => env.native?.googleIosClientIds ?? [];
    for (const [a, b] of [
      [production, staging],
      [staging, production],
    ]) {
      expect(ios(b)).not.toContain(a.googleClientId);
      for (const id of ios(a)) expect(ios(b)).not.toContain(id);
    }
  });
});
