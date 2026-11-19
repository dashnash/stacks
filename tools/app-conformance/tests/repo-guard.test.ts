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

  it('requires the CI check and the agent review status (#111), each a real job', () => {
    const checks = rule('required_status_checks').parameters.required_status_checks;
    expect(checks).toEqual([
      { context: 'check', integration_id: 15368 },
      { context: 'agent-review', integration_id: 15368 },
    ]);
    const ci = workflows.find((w) => w.file === 'ci.yml')!;
    expect(jobs(ci.text).map((j) => j.id)).toContain('check');
    const review = workflows.find((w) => w.file === 'agent-review.yml')!;
    expect(jobs(review.text).map((j) => j.id)).toEqual(['agent-review']);
  });

  it('lets only repo admins bypass, and only through a pull request (no direct pushes)', () => {
    expect(ruleset.bypass_actors).toEqual([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }]);
  });
});

describe('workflows on a public repo', () => {
  it('never use pull_request_target, except the agent review gate, which never touches PR code', () => {
    for (const w of workflows.filter((x) => x.file !== 'agent-review.yml')) expect(w.text, w.file).not.toMatch(/pull_request_target/);
    // #111: it must run main's workflow and script (pull_request would let a PR post its own
    // success), so it holds a write token next to PR events. It may only read the base branch.
    const gate = workflows.find((w) => w.file === 'agent-review.yml')!.text;
    const steps = gate.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    expect(steps).toMatch(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
    expect(steps).not.toMatch(/github\.event\.pull_request\.head|github\.head_ref|refs\/pull\//);
    expect(steps).not.toMatch(/\bnpm\b|\bnpx\b|actions\/setup-node/);
    expect(steps).toMatch(/^ {4}runs-on: ubuntu-latest$/m);
    expect(steps).not.toMatch(/contents: write|pull-requests: write/);
    expect(steps).toMatch(/run: node scripts\/agent-review-gate\.mjs$/m);
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

  it('keep PR code off the Mac that signs releases (#103)', () => {
    const ios = jobs(workflows.find((w) => w.file === 'ios.yml')!.text);
    const runsOn = (id: string) => ios.find((j) => j.id === id)!.body.match(/^ {4}runs-on:.*$/m)?.[0] ?? '';
    // The PR build: the PR runner first, fork-guarded. Until that runner is set up it may fall back
    // to the release runner (owner's call), but only after MACOS_PR_RUNNER, so setting it wins.
    const app = runsOn('app');
    expect(app).toContain(FORK_GUARD);
    expect(app).toContain('fromJSON(vars.MACOS_PR_RUNNER || vars.MACOS_RUNNER)');
    expect(app.replace(/vars\.MACOS_PR_RUNNER \|\| vars\.MACOS_RUNNER/g, '')).not.toMatch(/vars\.MACOS_(PR_)?RUNNER/);
    // Jobs that hold the App Store Connect key never use the PR runner.
    for (const job of ios.filter((j) => j.id === 'release' || /^ {4}environment: ios-release$/m.test(j.body))) {
      expect(job.body, job.id).not.toContain('MACOS_PR_RUNNER');
    }
    // Every other job that can run on a pull request stays off the release runner.
    for (const w of workflows.filter((x) => triggersOnPr(x.text))) {
      for (const job of jobs(w.text).filter((j) => !(w.file === 'ios.yml' && j.id === 'app'))) {
        const cond = job.body.match(/^ {4}if:.*$/m)?.[0] ?? '';
        const prOnly = /github\.event_name == 'pull_request'/.test(cond);
        const neverPr = /github\.event_name != 'pull_request'/.test(cond);
        if (prOnly || !neverPr) expect(job.body.match(/^ {4}runs-on:.*$/m)?.[0] ?? '', `${w.file} ${job.id}`).not.toContain('vars.MACOS_RUNNER');
      }
    }
  });

  it('run the policy drift check only from main, with no environment (#101)', () => {
    const drift = workflows
      .find((w) => w.file === 'ci-drift.yml')!
      .text.split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(triggersOnPr(drift)).toBe(false);
    expect(drift).not.toMatch(/pull_request/);
    expect(drift).not.toMatch(/^\s+environment:/m);
    expect(drift).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    // Deploy calls it as a warning that nothing waits on.
    const deploy = jobs(workflows.find((w) => w.file === 'deploy.yml')!.text);
    const call = deploy.find((j) => j.id === 'ci-drift')!.body;
    expect(call).toMatch(/uses: \.\/\.github\/workflows\/ci-drift\.yml/);
    expect(call).toMatch(/warn: true/);
    for (const j of deploy) expect(j.body.match(/^ {4}needs:.*$/m)?.[0] ?? '', j.id).not.toContain('ci-drift');
  });

  it('install without dependency install scripts (#104)', () => {
    for (const w of workflows) {
      for (const line of w.text.split('\n').filter((l) => /\bnpm (ci|install|i)\b/.test(l) && !l.trim().startsWith('#'))) {
        expect(line, w.file).toMatch(/--ignore-scripts/);
      }
    }
  });

  it('finds every job (the parser sanity check)', () => {
    expect(jobs(workflows.find((w) => w.file === 'deploy.yml')!.text).map((j) => j.id)).toEqual(['ci-drift', 'zones', 'build', 'staging', 'production']);
  });
});

// #107: Claude Code refuses AWS, deploys and pushes to main in every session on this repo.
describe('.claude/settings.json', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
  const required = [
    'Bash(aws:*)',
    'Bash(npx cdk deploy:*)',
    'Bash(cdk deploy:*)',
    'Bash(npx aws-cdk deploy:*)',
    'Bash(cdk destroy:*)',
    'Bash(npx cdk destroy:*)',
    'Bash(cdk bootstrap:*)',
    'Bash(npx cdk bootstrap:*)',
    'Bash(git push origin main*)',
    'Bash(git push * main)',
    'Bash(git push origin HEAD:main*)',
    'Bash(git push * HEAD:main)',
  ];

  it('denies AWS, cdk deploy/destroy/bootstrap and pushes to main', () => {
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(required));
  });

  it('allows none of them back', () => {
    const allow: string[] = settings.permissions.allow ?? [];
    expect(allow.filter((r) => /^Bash\((aws|cdk|npx cdk|npx aws-cdk|git push)/.test(r))).toEqual([]);
  });
});
