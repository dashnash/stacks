import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { StacksProvider, useStacks } from '@stacks/web';
import type { Demo } from './backend';

const bar: CSSProperties = {
  position: 'fixed',
  left: 12,
  bottom: 12,
  zIndex: 2147483000,
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  padding: '6px 10px',
  font: '13px/1.3 system-ui, sans-serif',
  background: '#111',
  color: '#fff',
  borderRadius: 8,
  boxShadow: '0 2px 8px rgba(0,0,0,.3)',
  // Leave room for the portal bar's pill at the bottom right.
  maxWidth: 'calc(100vw - 120px)',
  boxSizing: 'border-box',
};

/** Keeps the app's session in step with the demo's persona. */
function DemoBar({ demo }: { demo: Demo }) {
  const { refresh } = useStacks();
  const [current, setCurrent] = useState(demo.current()?.email ?? '');
  useEffect(
    () =>
      demo.subscribe(() => {
        setCurrent(demo.current()?.email ?? '');
        void refresh();
      }),
    [demo, refresh],
  );
  return (
    <div style={bar} role="region" aria-label="Demo controls">
      <strong>Demo</strong>
      <label style={{ minWidth: 0, flex: '1 1 auto', display: 'flex' }}>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Try the app as</span>
        <select value={current} style={{ maxWidth: '100%', minWidth: 0 }} onChange={(e) => void demo.signInAs(e.target.value || null)}>
          <option value="">Signed out</option>
          {demo.personas.map((p) => (
            <option key={p.email} value={p.email}>
              {p.name} ({p.role}){p.blurb ? ` - ${p.blurb}` : ''}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => void demo.reset()}>
        Reset
      </button>
    </div>
  );
}

/** Wrap the app's root in this instead of `<StacksProvider>` for the demo build. */
export function DemoApp({ demo, children }: { demo: Demo; children: ReactNode }) {
  return (
    <StacksProvider client={demo.client} navigator={demo.navigator}>
      {children}
      <DemoBar demo={demo} />
    </StacksProvider>
  );
}
