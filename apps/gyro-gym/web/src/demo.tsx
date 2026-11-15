import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDemo, DemoApp } from '@stacks/demo';
import { fakeGameKit, fakeMotion, installFakeNative } from '@stacks/native';
import { App, demoOptions } from './demo/setup';
import './styles.css';

const demo = createDemo(demoOptions());

// The demo pretends to be the iOS app: a CoreMotion that sways on its own (so the Lab moves) and a
// Game kit that says yes. `?native=off` shows the plain-browser page instead.
if (new URLSearchParams(location.search).get('native') !== 'off') {
  const motion = fakeMotion({ wobble: true });
  installFakeNative({ ...motion.handlers, ...fakeGameKit() });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoApp demo={demo}>
      <App />
    </DemoApp>
  </StrictMode>,
);
