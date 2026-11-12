import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StacksProvider } from '@stacks/web';
import { App } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StacksProvider>
      <App />
    </StacksProvider>
  </StrictMode>,
);
