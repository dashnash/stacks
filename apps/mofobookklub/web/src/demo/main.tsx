import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDemo, DemoApp } from '@stacks/demo';
import '../index.css';
import { App, demoOptions } from './setup';

const demo = createDemo(demoOptions());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoApp demo={demo}>
      <App />
    </DemoApp>
  </StrictMode>,
);
