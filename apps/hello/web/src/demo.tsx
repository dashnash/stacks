import { StrictMode, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createDemo, DemoApp } from '@stacks/demo';
import { App, demoOptions } from './demo/setup';
import './styles.css';

/**
 * `demo.html#/duo`: two personas side by side in one Live dots room, so one screen (and one
 * screenshot) shows a multiplayer game. Each side is a full demo of its own, as two tabs would be;
 * Olive's side creates the room and so runs its server.
 */
function Duo() {
  const [olive, max] = useMemo(() => [createDemo(demoOptions()), createDemo(demoOptions())], []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await olive.signInAs('olive@demo.stacks');
      const { room } = await olive.client.post<{ room: { id: string } }>('/rooms', { name: 'Olive and Max' });
      if (!cancelled) window.location.hash = `#/play/${room.id}`;
    })();
    return () => {
      cancelled = true;
    };
  }, [olive]);
  return (
    <div className="duo">
      {[
        { demo: olive, as: 'olive@demo.stacks' },
        { demo: max, as: 'max@demo.stacks' },
      ].map(({ demo, as }) => (
        <div className="duo-pane" key={as}>
          <DemoApp demo={demo} startAs={as}>
            <App />
          </DemoApp>
        </div>
      ))}
    </div>
  );
}

const duo = window.location.hash.startsWith('#/duo');

createRoot(document.getElementById('root')!).render(
  duo ? (
    <Duo />
  ) : (
    <StrictMode>
      <DemoApp demo={createDemo(demoOptions())}>
        <App />
      </DemoApp>
    </StrictMode>
  ),
);
