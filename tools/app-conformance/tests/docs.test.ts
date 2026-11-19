import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #106: agents treat docs/PLATFORM_SPEC.md as the source of truth, so its "Repo layout" tree must
// name only paths that exist. Lines marked "(planned)" are skipped.
const root = join(__dirname, '../../..');
const spec = readFileSync(join(root, 'docs/PLATFORM_SPEC.md'), 'utf8');

/** The code block right after "## Repo layout". */
export function layoutBlock(markdown: string): string {
  const section = markdown.slice(markdown.indexOf('## Repo layout'));
  const open = section.indexOf('```\n');
  return section.slice(open + 4, section.indexOf('\n```', open + 4));
}

/**
 * Paths named in a tree like `stacks/` → `  docs/` → `    SETUP.md  RESTORE.md  # comment`,
 * relative to the top folder. Two spaces per level; several names on one line are siblings; only
 * a line with a single name ending in `/` can be a parent.
 */
export function treePaths(block: string): string[] {
  const parents: { indent: number; path: string }[] = [];
  const out: string[] = [];
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const [names = '', comment = ''] = line.split(/\s#\s?/);
    const indent = line.length - line.trimStart().length;
    while (parents.length && parents[parents.length - 1]!.indent >= indent) parents.pop();
    if (indent === 0) {
      parents.push({ indent, path: '' }); // the repo itself (`stacks/`)
      continue;
    }
    const base = parents[parents.length - 1]?.path ?? '';
    const tokens = names.trim().split(/\s+/).filter(Boolean);
    if (!/\(planned\)/.test(comment)) out.push(...tokens.map((t) => base + t));
    if (tokens.length === 1 && tokens[0]!.endsWith('/')) parents.push({ indent, path: base + tokens[0] });
  }
  return out;
}

describe('PLATFORM_SPEC.md repo layout', () => {
  it('parses a tree (siblings, parents, planned lines, comments)', () => {
    const block = ['stacks/', '  platform/   # p', '    api/  web/', '    portal-bar/   # (planned)', '  docs/', '    SETUP.md  # one', '  a/b.ts # x'].join('\n');
    expect(treePaths(block)).toEqual(['platform/', 'platform/api/', 'platform/web/', 'docs/', 'docs/SETUP.md', 'a/b.ts']);
  });

  it('would catch a stale path', () => {
    const missing = treePaths(['stacks/', '  platform/', '    portal-bar/'].join('\n')).filter((p) => !existsSync(join(root, p)));
    expect(missing).toEqual(['platform/portal-bar/']);
  });

  it('names only paths that exist', () => {
    const paths = treePaths(layoutBlock(spec));
    expect(paths.length).toBeGreaterThan(30);
    expect(paths.filter((p) => !existsSync(join(root, p)))).toEqual([]);
  });
});
