import { useState } from 'react';
import { AccountMenu, BuildVersion, useHashRoute } from '@stacks/web';
import type { Attitude } from '@stacks/native';
import { manifest } from '../../api/manifest';
import { Kit } from './Kit';
import { Lab } from './Lab';
import { Maze } from './Maze';
import { ZERO } from './motion/tilt';
import { ZeroContext } from './motion/useMotion';

const TABS = [
  { path: '/', label: 'Lab' },
  { path: '/kit', label: 'Kit' },
  { path: '/maze', label: 'Maze' },
] as const;

/** Everything works signed in or out: nothing is stored on the server. */
export function App() {
  const { path } = useHashRoute();
  const [zero, setZero] = useState<Attitude>(ZERO);
  const tab = TABS.find((t) => t.path === path) ?? TABS[0];
  return (
    <ZeroContext.Provider value={{ zero, setZero }}>
      <div className="page">
        {/* Platform rule: the account menu sits at the top right of the header (tools/app-conformance). */}
        <header className="top">
          <h1>
            Gyro <span className="accent">Gym</span>
          </h1>
          <AccountMenu className="account" />
        </header>
        <nav className="tabs" aria-label="Sections">
          {TABS.map((t) => (
            <a key={t.path} href={`#${t.path}`} aria-current={t === tab ? 'page' : undefined}>
              {t.label}
            </a>
          ))}
        </nav>
        <main>{tab.path === '/kit' ? <Kit /> : tab.path === '/maze' ? <Maze /> : <Lab />}</main>
        {/* Platform rule: the build is shown on every screen (tools/app-conformance). */}
        <footer className="foot muted small">
          {manifest.tagline} · <BuildVersion className="build" />
        </footer>
      </div>
    </ZeroContext.Provider>
  );
}
