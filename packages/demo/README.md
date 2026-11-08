# @stacks/demo

The credential-free demo: your real UI and real API running in the browser on sample data, with a
persona switcher. Every app ships one (`npm run demo -w apps/<slug>`); it is also the pre-merge preview.

```tsx
// apps/<slug>/web/src/demo.tsx
const demo = createDemo({ manifest, routes, personas, seed });
createRoot(el).render(<DemoApp demo={demo}><App /></DemoApp>);
```

- `personas`: `{ email, name, role, blurb? }`, usually one per role. "Sign in" uses the first.
- `seed(deps)`: write sample data with `deps.store`. Runs on first load and on Reset.
- Changes persist in localStorage (`storageKey: false` to disable).
- `demo.signInAs(email | null)`, `demo.reset()` for scripted checks; `demo.html?as=<email>` opens the
  demo signed in as that persona (`<DemoApp startAs>` overrides).
- The persona switcher and Reset live in the account menu ("Demo: try the app as").
- Every app exports `App` and `demoOptions()` from `web/src/demo/setup.ts`; the demo entry and
  `tools/app-conformance` both use it.
