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

  it('makes turning on needsEmail platform work, and refuses it on an app branch', () => {
    const on = { mofobookklub: { before: { slug: 'mofobookklub' }, after: { slug: 'mofobookklub', needsEmail: true } } };
    const files = ['apps/mofobookklub/app.manifest.json'];
    const r = classifyPr('claude/emails', files, on);
    expect(r).toMatchObject({ ok: true, kind: 'platform', apps: ['mofobookklub'] });
    expect(r.message).toMatch(/needsEmail[\s\S]*CODEOWNERS|CODEOWNERS[\s\S]*needsEmail/);
    expect(classifyPr('app/mofobookklub/x', files, on)).toMatchObject({ ok: false, kind: 'app' });
    // A new app that asks for it, too; already on, or turned off, is not news.
    expect(classifyPr('claude/new', ['apps/mailer/app.manifest.json'], { mailer: { before: null, after: { needsEmail: true } } }).kind).toBe('platform');
    expect(classifyPr('claude/edit', files, { mofobookklub: { before: { needsEmail: true }, after: { needsEmail: true } } }).kind).toBe('app');
    expect(classifyPr('claude/off', files, { mofobookklub: { before: { needsEmail: true }, after: {} } }).kind).toBe('app');
  });
});
