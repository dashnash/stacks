import { execSync } from 'node:child_process';

/**
 * Which commit this build is, for the footer's build link. In GitHub Actions the commit and
 * repository come from GITHUB_SHA / GITHUB_REPOSITORY / GITHUB_SERVER_URL; locally from git.
 * Either part may be missing (e.g. no git): the footer then shows less.
 */
export function buildInfo(): { sha: string; commitUrl: string } {
  const git = (args: string) => {
    try {
      return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return '';
    }
  };
  const sha = process.env.GITHUB_SHA || git('rev-parse HEAD');
  let repoUrl = '';
  if (process.env.GITHUB_REPOSITORY) {
    repoUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}`;
  } else {
    // e.g. https://github.com/owner/repo(.git) or git@github.com:owner/repo.git
    const remote = git('remote get-url origin');
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
    if (m) repoUrl = `https://github.com/${m[1]}/${m[2]}`;
  }
  return { sha, commitUrl: sha && repoUrl ? `${repoUrl}/commit/${sha}` : '' };
}

/** Vite `define` entries that put the build info in the bundle. */
export function buildDefines() {
  const { sha, commitUrl } = buildInfo();
  return { __BUILD_SHA__: JSON.stringify(sha), __BUILD_COMMIT_URL__: JSON.stringify(commitUrl) };
}
