# #100 Smoke-check staging before production deploys (ARCH-01)

"Staging passed" in `deploy.yml` means only that CloudFormation finished. Add a smoke check after the
staging deploy that production waits on, and the same check after production, so a deploy that
breaks sign-in or an API stops before production (or fails loudly after it).

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Script | `tools/smoke/smoke.mjs` (plain Node 22, `fetch`, no deps) with tests: `node tools/smoke/smoke.mjs <outputs.json> --env staging|production`. |
| URLs | From the deploy's `--outputs-file` (`PortalURL` of the platform stack, `SiteURL` of every app stack), so held apps are skipped automatically. |
| Checks | 1) `GET <portal>/api/health` and `GET <app>/api/health` for every app: 200 with `ok: true`. 2) `GET <portal>/api/public/catalog`: 200 with an `apps` array. 3) For the first app: `GET <app>/api/auth/login` (no redirect follow) is a 302 to `<portal>/authorize?…`; following it is a 302 to `<portal>/signin?next=…`. |
| Failure rule | Fail on network error, 5xx, wrong status, wrong redirect target. `missingSecrets` / `missingPlatformKeys` in a health body are printed as warnings, never failures. |
| Retries | Each check up to 4 attempts, 10 s apart (≈30 s), 10 s timeout per request, for CloudFront/Lambda warm-up. |
| Maintenance | When the environment's `maintenance` is true in `stacks.config.json`, only the health checks run. |
| Production | The same script runs as the last step of `production`; a failure fails the run (red X, step summary). No automatic rollback. |
| Output | One line per check to the log and a Markdown table to `$GITHUB_STEP_SUMMARY`. |

## Changes

- `tools/smoke/` (`smoke.mjs`, `smoke.test.mjs` or `.test.ts` run by the root Vitest, `README.md`).
- `.github/workflows/deploy.yml`: `Smoke check` step at the end of `staging` and `production` (production `needs: staging`, so a failed staging smoke blocks it).
- `docs/PLATFORM_SPEC.md` (Environments and CI/CD): describe the smoke gate.

## Tests (fetch stubbed)

All-green passes; a 500 on one app fails; a wrong redirect target fails; missingSecrets warns but
passes; maintenance skips catalog/sign-in; retries recover from one failure; outputs parsing finds
portal and apps.

## Acceptance (agent)

`npm test`, typecheck, lint, actionlint.

## Acceptance (owner, after merge)

The next Deploy run shows a green "Smoke check" in both jobs with the summary table.
