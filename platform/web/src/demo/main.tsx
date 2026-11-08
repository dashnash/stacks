import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { PortalProvider } from '../portal';
import '../styles.css';
import { createDemoPortal, DEMO_PEOPLE } from './backend';

const { api } = createDemoPortal();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PortalProvider api={api} signInMethod={{ kind: 'personas', personas: DEMO_PEOPLE }}>
      <App />
    </PortalProvider>
  </StrictMode>,
);
