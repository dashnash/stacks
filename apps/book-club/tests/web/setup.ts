import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  // Hash routes leak between tests in one file (jsdom shares window.location): start each test at home.
  window.history.replaceState(null, '', window.location.pathname);
});
