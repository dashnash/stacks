#!/usr/bin/env node
/**
 * Merge gate for agent code reviews (#111, spec: Security → Merge gate).
 *
 * A PR that changes a gated path needs an agent code review of its head commit: a PR comment (or
 * review) by an allowed reviewer with the line `<!-- agent-code-review sha=<head sha> -->`. This
 * posts the commit status `agent-review` on the head commit, which the ruleset on main requires.
 *
 *   node scripts/agent-review-gate.mjs            in the agent-review workflow (reads the event)
 *   node scripts/agent-review-gate.mjs marker <sha>   prints the marker line for a review comment
 */
export const STATUS_CONTEXT = 'agent-review';
export const GATED_PATHS = ['packages/infra/', '.github/', 'platform/api/'];
export const DEFAULT_REVIEWERS = ['dashnash-agent'];

export const marker = (sha) => `<!-- agent-code-review sha=${sha} -->`;

/** Changed files (GitHub's `pulls/:n/files` entries) under a gated path; a rename counts by either name. */
export function gatedFiles(files) {
  const gated = (name) => !!name && GATED_PATHS.some((p) => name.startsWith(p));
  return files.filter((f) => gated(f.filename) || gated(f.previous_filename)).map((f) => f.filename);
}

/** Whether a body carries the marker for `sha` on a line of its own (not quoted with `>`). */
export function hasMarker(body, sha) {
  return (body ?? '').split(/\r?\n/).some((line) => line.trim() === marker(sha));
}

/** The first comment or review by an allowed reviewer that records a review of `sha`. */
export function findReview(entries, sha, reviewers = DEFAULT_REVIEWERS) {
  const allowed = new Set(reviewers.map((r) => r.toLowerCase()));
  return entries.find((e) => allowed.has(String(e.user?.login ?? '').toLowerCase()) && hasMarker(e.body, sha));
}

/** The commit status to post: `{ state, description }`. */
export function decide({ files, entries, headSha, reviewers = DEFAULT_REVIEWERS }) {
  const gated = gatedFiles(files);
  if (!gated.length) return { state: 'success', description: 'Not required: no infra, workflow or platform API changes' };
  const review = findReview(entries, headSha, reviewers);
  if (review) return { state: 'success', description: `Agent code review of ${headSha.slice(0, 7)} by ${review.user.login}` };
  return { state: 'pending', description: `Needs an agent code review of ${headSha.slice(0, 7)} (${gated.length} gated file${gated.length > 1 ? 's' : ''})` };
}

async function main() {
  const { readFileSync } = await import('node:fs');
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const reviewers = (process.env.AGENT_REVIEWERS || DEFAULT_REVIEWERS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const call = async (path, init = {}) => {
    const res = await fetch(`${api}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const all = async (path) => {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await call(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  };

  const number = event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : undefined);
  if (!number) return console.log('Not a pull request: nothing to do.');
  const pr = await call(`/repos/${repo}/pulls/${number}`);
  const headSha = pr.head.sha;
  const [files, comments, reviews] = await Promise.all([
    all(`/repos/${repo}/pulls/${number}/files`),
    all(`/repos/${repo}/issues/${number}/comments`),
    all(`/repos/${repo}/pulls/${number}/reviews`),
  ]);
  const result = decide({ files, entries: [...comments, ...reviews], headSha, reviewers });
  await call(`/repos/${repo}/statuses/${headSha}`, {
    method: 'POST',
    body: JSON.stringify({ ...result, context: STATUS_CONTEXT, description: result.description.slice(0, 140) }),
  });
  console.log(`#${number} ${headSha.slice(0, 7)}: ${result.state} (${result.description})`);
}

const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, sha] = process.argv.slice(2);
  if (cmd === 'marker') {
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) {
      console.error('Usage: agent-review-gate.mjs marker <40-hex head sha>');
      process.exit(1);
    }
    console.log(marker(sha));
  } else {
    main().catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  }
}
