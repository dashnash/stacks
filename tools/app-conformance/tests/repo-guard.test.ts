import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #93: the repo is public, so `main` is gated by the ruleset in .github/rulesets/main.json
// (applied by the owner with `gh api -X POST repos/dashnash/stacks/rulesets --input …`), and
// pull requests from forks must never reach the self-hosted runners.
const root = join(__dirname, '../../..');
const workflowsDir = join(root, '.github/workflows');
const ruleset = JSON.parse(readFileSync(join(root, '.github/rulesets/main.json'), 'utf8'));
const workflows = readdirSync(workflowsDir)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({ file: f, text: readFileSync(join(workflowsDir, f), 'utf8') }));

const FORK_GUARD = 'github.event.pull_request.head.repo.full_name == github.repository';

/** Top-level jobs of a workflow as `{ id, body }`, split on two-space-indented keys under `jobs:`. */
function jobs(text: string): { id: string; body: string }[] {
  const after = text.slice(text.indexOf('\njobs:\n') + 7);
  const parts = after.split(/^ {2}([\w-]+):\s*$/m);
  const out: { id: string; body: string }[] = [];
  for (let i = 1; i < parts.length; i += 2) out.push({ id: parts[i] ?? '', body: parts[i + 1] ?? '' });
  return out;
}

const triggersOnPr = (text: string) => /^ {2}pull_request:/m.test(text.slice(0, text.indexOf('\njobs:\n')));

describe('main ruleset', () => {
  const rule = (type: string) => ruleset.rules.find((r: { type: string }) => r.type === type);

  it('is active on the default branch', () => {
    expect(ruleset).toMatchObject({ target: 'branch', enforcement: 'active', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } } });
  });

  it('blocks deletion and force pushes and requires a PR with code-owner review', () => {
    expect(rule('deletion')).toBeDefined();
    expect(rule('non_fast_forward')).toBeDefined();
    expect(rule('pull_request').parameters).toMatchObject({
      required_approving_review_count: 0,
      require_code_owner_review: true,
      dismiss_stale_reviews_on_push: true,
      require_last_push_approval: true,
    });
  });

  it('requires the CI check, which must be a real job in ci.yml', () => {
    const checks = rule('required_status_checks').parameters.required_status_checks;
    expect(checks).toEqual([{ context: 'check', integration_id: 15368 }]);
    const ci = workflows.find((w) => w.file === 'ci.yml')!;
    expect(jobs(ci.text).map((j) => j.id)).toContain('check');
  });

  it('lets only repo admins bypass, and only through a pull request (no direct pushes)', () => {
    expect(ruleset.bypass_actors).toEqual([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }]);
  });
});

describe('workflows on a public repo', () => {
  it('never use pull_request_target', () => {
    for (const w of workflows) expect(w.text, w.file).not.toMatch(/pull_request_target/);
  });

  it('keep fork PRs off self-hosted runners', () => {
    const prWorkflows = workflows.filter((w) => triggersOnPr(w.text));
    expect(prWorkflows.map((w) => w.file)).toEqual(expect.arrayContaining(['ci.yml', 'ios.yml']));
    for (const w of prWorkflows) {
      for (const job of jobs(w.text)) {
        const runsOn = job.body.match(/^ {4}runs-on:.*$/m)?.[0] ?? '';
        if (/vars\.\w+_RUNNER/.test(runsOn)) expect(runsOn, `${w.file} ${job.id}`).toContain(FORK_GUARD);
      }
    }
  });

  it('finds every job (the parser sanity check)', () => {
    expect(jobs(workflows.find((w) => w.file === 'deploy.yml')!.text).map((j) => j.id)).toEqual(['zones', 'build', 'staging', 'production']);
  });
});
