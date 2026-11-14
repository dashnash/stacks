import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DemoControlsContext, StacksProvider, useStacks, type DemoControls } from '@stacks/web';
import type { Demo } from './backend';

/** Keeps the app's session in step with the demo's persona, and offers the switcher to the account menu. */
function DemoBridge({ demo, startAs, children }: { demo: Demo; startAs: string | null; children: ReactNode }) {
  const { refresh } = useStacks();
  const [current, setCurrent] = useState(demo.current()?.email ?? null);
  useEffect(() => {
    if (startAs) void demo.signInAs(startAs);
  }, [demo, startAs]);
  // For scripted checks (npm run verify-app): who can the demo sign in as?
  useEffect(() => {
    (globalThis as { __stacksDemo?: unknown }).__stacksDemo = { personas: demo.personas.filter((p) => p.role).map(({ email, name, role }) => ({ email, name, role })) };
  }, [demo]);
  useEffect(
    () =>
      demo.subscribe(() => {
        setCurrent(demo.current()?.email ?? null);
        void refresh();
      }),
    [demo, refresh],
  );
  const controls = useMemo<DemoControls>(
    () => ({
      personas: demo.personas.filter((p) => p.role).map((p) => ({ email: p.email, name: p.name, role: p.role })),
      current,
      switchTo: (email) => void demo.signInAs(email),
      reset: () => void demo.reset(),
    }),
    [demo, current],
  );
  return <DemoControlsContext.Provider value={controls}>{children}</DemoControlsContext.Provider>;
}

/**
 * Wrap the app's root in this instead of `<StacksProvider>` for the demo build. "Sign in" signs in
 * the first persona; the account menu then offers "Demo: try the app as" and a reset.
 *
 * `startAs` signs a persona in on load; by default it comes from `?as=<email>` in the page URL, so
 * scripted checks (screenshots per persona) can open the demo as anyone.
 */
export function DemoApp({ demo, startAs, children }: { demo: Demo; startAs?: string | null; children: ReactNode }) {
  const initial = useMemo(() => (startAs !== undefined ? startAs : asFromUrl()), [startAs]);
  return (
    <StacksProvider client={demo.client} navigator={demo.navigator} silentSignIn={false} errorReporting="console">
      <DemoBridge demo={demo} startAs={initial}>
        {children}
      </DemoBridge>
    </StacksProvider>
  );
}

function asFromUrl(): string | null {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('as');
  } catch {
    return null;
  }
}
