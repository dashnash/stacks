import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortalApi } from './api';
import { App } from './App';
import { PortalProvider } from './portal';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PortalProvider api={createPortalApi()} signInMethod={{ kind: 'google' }}>
      <App />
    </PortalProvider>
  </StrictMode>,
);
