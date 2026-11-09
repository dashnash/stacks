import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain .mjs script, no types
import { classifyPr } from '../../../scripts/pr-paths.mjs';

describe('PR path guard', () => {
  it('keeps app branches inside their app (the lockfile is fine)', () => {
    expect(classifyPr('app/potluck/initial', ['apps/potluck/api/routes.ts', 'package-lock.json'])).toMatchObject({ ok: true, kind: 'app' });
    expect(classifyPr('app/potluck/initial', ['apps/potluck/a.ts', 'packages/api/src/app.ts']).ok).toBe(false);
    expect(classifyPr('app/potluck/initial', ['apps/hello/a.ts']).ok).toBe(false);
  });

  it('treats any other PR that only touches apps/ as an app PR: one app only', () => {
    expect(classifyPr('claude/upbeat-bell', ['apps/flippy-work-table/web/src/App.tsx', 'package-lock.json'])).toMatchObject({ ok: true, kind: 'app', apps: ['flippy-work-table'] });
    const two = classifyPr('claude/x', ['apps/potluck/a.ts', 'apps/hello/b.ts']);
    expect(two).toMatchObject({ ok: false, apps: ['hello', 'potluck'] });
    expect(two.message).toMatch(/one PR per app/);
  });

  it('labels anything outside apps/ as platform work for code-owner review, apps allowed', () => {
    const r = classifyPr('claude/blocked-access', ['packages/web/src/AccountMenu.tsx', 'apps/mofobookklub/web/src/components/AdminPanel.tsx']);
    expect(r).toMatchObject({ ok: true, kind: 'platform', apps: ['mofobookklub'] });
    expect(r.message).toMatch(/CODEOWNERS/);
    expect(classifyPr('main', ['package-lock.json'])).toMatchObject({ ok: true, kind: 'none' });
  });
});
