/**
 * Every CDK synth in these tests writes a full cloud assembly (tens of MB with the bundled Lambdas)
 * to a fresh folder under the system temp directory, and nothing deletes them: a few test runs
 * filled a session's disk. Each test file gets its own temp directory instead, removed when the
 * file is done. (`os.tmpdir()`, which CDK and the tests use, reads TMPDIR on every call.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';

const previous = process.env.TMPDIR;
const dir = mkdtempSync(path.join(tmpdir(), 'stacks-infra-tests-'));
process.env.TMPDIR = dir;

afterAll(() => {
  if (previous === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
