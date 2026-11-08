import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StacksProvider } from '@stacks/web';
import manifest from '../../app.manifest.json';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StacksProvider portalBar={manifest.portalBar as 'shown' | 'minimized' | 'off'}>
      <App />
    </StacksProvider>
  </StrictMode>,
);
