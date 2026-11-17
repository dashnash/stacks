import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { unpinnedActions } from '../../../scripts/action-pins.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const sha = 'a'.repeat(40);

describe('unpinnedActions (#99)', () => {
  it('accepts SHA-pinned actions, digest-pinned images and local actions', () => {
    const text = [
      `      - uses: actions/checkout@${sha} # v4.4.0`,
      `        uses: aws-actions/configure-aws-credentials@${sha}`,
      `      - uses: docker://rhysd/actionlint:1.7.12@sha256:${'b'.repeat(64)}`,
      `      - uses: ./.github/actions/local`,
      `      - uses: 'actions/cache@${sha}'`,
    ].join('\n');
    expect(unpinnedActions({ 'w.yml': text })).toEqual([]);
  });

  it('flags tags, branches, short SHAs and undigested images, with file and line', () => {
    const text = [
      'jobs:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@main',
      '      - uses: actions/cache@0057852',
      '      - uses: docker://rhysd/actionlint:1.7.12',
      `      - uses: owner/repo/sub/path@${sha}`,
    ].join('\n');
    const found = unpinnedActions({ 'w.yml': text });
    expect(found).toHaveLength(4);
    expect(found[0]).toMatch(/^w\.yml:2: actions\/checkout@v4/);
    expect(found[3]).toMatch(/^w\.yml:5: docker:\/\/rhysd\/actionlint:1\.7\.12 \(pin the image by digest/);
  });

  it('ignores uses: text inside run blocks and comments', () => {
    const text = ['    steps:', '      - run: |', '          echo "uses: actions/checkout@v4"', '      # uses: actions/cache@v4', `      - uses: actions/checkout@${sha}`].join('\n');
    expect(unpinnedActions({ 'w.yml': text })).toEqual([]);
  });

  it("passes on this repo's workflows", () => {
    const dir = path.resolve(__dirname, '../../../.github/workflows');
    const files = Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]));
    expect(unpinnedActions(files)).toEqual([]);
  });
});
