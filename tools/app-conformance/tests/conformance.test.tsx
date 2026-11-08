import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { createDemo, DemoApp, type DemoOptions } from '@stacks/demo';

/**
 * Platform rules every app must follow, checked on the real UI running on its demo backend.
 * An app takes part by exporting `App` and `demoOptions()` from `web/src/demo/setup.ts`.
 */
interface AppSetup {
  App: ComponentType;
  demoOptions(): DemoOptions<any>;
}

const setups = import.meta.glob<AppSetup>('../../../apps/*/web/src/demo/setup.ts');
const appsDir = path.resolve(__dirname, '../../../apps');
const appDirs = readdirSync(appsDir).filter((d) => statSync(path.join(appsDir, d)).isDirectory());

it('every app exports web/src/demo/setup.ts', () => {
  const found = Object.keys(setups).map((p) => p.split('/apps/')[1]!.split('/')[0]);
  expect(appDirs.filter((d) => !found.includes(d))).toEqual([]);
});

function accountMenus() {
  return [...document.querySelectorAll<HTMLElement>('[data-stacks-account-menu]')];
}

describe.each(appDirs)('%s', (slug) => {
  const load = async () => {
    const setup = setups[`../../../apps/${slug}/web/src/demo/setup.ts`];
    if (!setup) throw new Error(`apps/${slug} has no web/src/demo/setup.ts`);
    const { App, demoOptions } = await setup();
    const demo = createDemo({ ...demoOptions(), storageKey: false });
    render(
      <DemoApp demo={demo}>
        <App />
      </DemoApp>,
    );
    return demo;
  };

  it('puts the account menu in its header: Sign in when signed out, the menu when signed in', async () => {
    await load();

    // Signed out: exactly one account control, in a <header>, offering Sign in.
    await waitFor(() => expect(document.querySelector('[data-stacks-account-menu="signedOut"]')).not.toBeNull(), { timeout: 10_000 });
    expect(accountMenus()).toHaveLength(1);
    const signedOut = accountMenus()[0]!;
    expect(signedOut.closest('header')).not.toBeNull();
    await userEvent.click(within(signedOut).getByRole('button', { name: 'Sign in' }));

    // Signed in: still one control, in a <header>, opening the standard menu.
    await waitFor(() => expect(document.querySelector('[data-stacks-account-menu="signedIn"]')).not.toBeNull(), { timeout: 10_000 });
    expect(accountMenus()).toHaveLength(1);
    const signedIn = accountMenus()[0]!;
    expect(signedIn.closest('header')).not.toBeNull();
    await userEvent.click(within(signedIn).getByRole('button', { name: /^Account menu for / }));
    const menu = screen.getByRole('menu', { name: 'Account' });
    for (const name of [/^All apps/, /^Inbox/, /^Settings/, /^Sign out/]) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }

    // Sign out (of everything) brings back the Sign in control.
    await userEvent.click(within(menu).getByRole('menuitem', { name: /^Sign out/ }));
    await waitFor(() => expect(document.querySelector('[data-stacks-account-menu="signedOut"]')).not.toBeNull(), { timeout: 10_000 });
  });
});
