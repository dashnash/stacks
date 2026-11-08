import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DemoControlsContext, StacksProvider, useStacks, type DemoControls } from '@stacks/web';
import type { Demo } from './backend';

/** Keeps the app's session in step with the demo's persona, and offers the switcher to the account menu. */
function DemoBridge({ demo, children }: { demo: Demo; children: ReactNode }) {
  const { refresh } = useStacks();
  const [current, setCurrent] = useState(demo.current()?.email ?? null);
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
 */
export function DemoApp({ demo, children }: { demo: Demo; children: ReactNode }) {
  return (
    <StacksProvider client={demo.client} navigator={demo.navigator}>
      <DemoBridge demo={demo}>{children}</DemoBridge>
    </StacksProvider>
  );
}
