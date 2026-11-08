import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createDemo, DemoApp } from '@stacks/demo';
import { personas, seed } from '../../api/demo-data';
import { manifest } from '../../api/manifest';
import { routes } from '../../api/routes';
import { App } from './App';
import './styles.css';

const demo = createDemo({ manifest, routes, personas, seed });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoApp demo={demo}>
      <App />
    </DemoApp>
  </StrictMode>,
);
