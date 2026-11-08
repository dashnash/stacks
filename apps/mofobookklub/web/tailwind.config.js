import { fileURLToPath } from 'node:url';

// Absolute, so the build works from any working directory.
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [here('./index.html'), here('./demo.html'), here('./src/**/*.{ts,tsx}')],
  theme: {
    extend: {
      // Poster palette. Each color is a CSS variable ("R G B", defined in src/index.css)
      // so Tailwind's opacity modifiers like text-ink/60 keep working.
      colors: Object.fromEntries(
        ['ink', 'paper', 'coral', 'lav', 'sun'].map((name) => [name, `rgb(var(--c-${name}) / <alpha-value>)`]),
      ),
      fontFamily: {
        cond: ['var(--font-cond)'],
        serif: ['var(--font-serif)'],
        sans: ['var(--font-sans)'],
      },
    },
  },
  plugins: [],
};
