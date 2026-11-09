/// <reference path="./env.d.ts" />
import type { CSSProperties } from 'react';

function fromEnv(name: 'VITE_STACKS_BUILD_SHA' | 'VITE_STACKS_REPO_URL'): string {
  try {
    // Vite replaces these at build time; CI sets them (the commit and the repository).
    return (name === 'VITE_STACKS_BUILD_SHA' ? import.meta.env.VITE_STACKS_BUILD_SHA : import.meta.env.VITE_STACKS_REPO_URL) ?? '';
  } catch {
    return '';
  }
}

/**
 * Which build is live: "Build 1a2b3c4", linking to the commit on GitHub. Required somewhere on every
 * app's screens, signed in and out (usually its footer); `tools/app-conformance` checks for it.
 * Local builds show "Build dev".
 */
export function BuildVersion({
  sha = fromEnv('VITE_STACKS_BUILD_SHA'),
  repoUrl = fromEnv('VITE_STACKS_REPO_URL'),
  className,
  style,
}: {
  sha?: string;
  repoUrl?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const label = sha ? `Build ${sha.slice(0, 7)}` : 'Build dev';
  const common = { className, style, 'data-stacks-build': sha || 'dev', title: sha ? `Built from commit ${sha}` : 'A local build' };
  return sha && repoUrl ? (
    <a {...common} href={`${repoUrl.replace(/\/$/, '')}/commit/${sha}`} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  ) : (
    <span {...common}>{label}</span>
  );
}
