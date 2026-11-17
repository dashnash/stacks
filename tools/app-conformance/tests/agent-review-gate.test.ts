import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { decide, findReview, gatedFiles, hasMarker, marker } from '../../../scripts/agent-review-gate.mjs';

const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const agent = { login: 'dashnash-agent' };

describe('agent review gate (#111)', () => {
  it('gates infra, workflow and platform API paths, renames by either name', () => {
    const files = [
      { filename: 'packages/infra/src/ci-stack.ts' },
      { filename: '.github/workflows/ci.yml' },
      { filename: 'platform/api/src/app.ts' },
      { filename: 'docs/x.md', previous_filename: 'platform/api/notes.md' },
      { filename: 'platform/web/src/App.tsx' },
      { filename: 'packages/api/src/app.ts' },
      { filename: 'apps/hello/api/routes.ts' },
      { filename: 'packages/infrastructure/x.ts' },
    ];
    expect(gatedFiles(files)).toEqual(['packages/infra/src/ci-stack.ts', '.github/workflows/ci.yml', 'platform/api/src/app.ts', 'docs/x.md']);
  });

  it('matches the marker only for the exact sha, on its own line, not quoted', () => {
    expect(hasMarker(`Review: no findings\n\n${marker(head)}\n`, head)).toBe(true);
    expect(hasMarker(`  ${marker(head)}  `, head)).toBe(true);
    expect(hasMarker(marker(old), head)).toBe(false);
    expect(hasMarker(`> ${marker(head)}`, head)).toBe(false);
    expect(hasMarker(`see ${marker(head)} above`, head)).toBe(false);
    expect(hasMarker(null, head)).toBe(false);
  });

  it('counts only allowed reviewers (case-insensitive)', () => {
    const entries = [
      { user: { login: 'someone' }, body: marker(head) },
      { user: { login: 'Dashnash-Agent' }, body: marker(head) },
    ];
    expect(findReview(entries, head)?.user.login).toBe('Dashnash-Agent');
    expect(findReview(entries.slice(0, 1), head)).toBeUndefined();
    expect(findReview(entries.slice(0, 1), head, ['someone'])?.user.login).toBe('someone');
  });

  it('is not required without gated files', () => {
    expect(decide({ files: [{ filename: 'apps/hello/web/src/App.tsx' }], entries: [], headSha: head })).toMatchObject({ state: 'success', description: expect.stringContaining('Not required') });
  });

  it('waits for a review of the head commit; an older review does not count', () => {
    const files = [{ filename: '.github/rulesets/main.json' }];
    const stale = decide({ files, entries: [{ user: agent, body: marker(old) }], headSha: head });
    expect(stale).toEqual({ state: 'pending', description: 'Needs an agent code review of aaaaaaa (1 gated file)' });
    const done = decide({ files, entries: [{ user: agent, body: `/code-review: no findings\n${marker(head)}` }], headSha: head });
    expect(done).toEqual({ state: 'success', description: 'Agent code review of aaaaaaa by dashnash-agent' });
  });
});
