# Smoke check

Runs after each environment's deploy in `deploy.yml` (#100). Staging's result gates production.

```bash
node tools/smoke/smoke.mjs <cdk outputs.json> --env staging|production [--sha <commit>]
```

Checks `/api/health` on the portal and every app in the outputs file, the public catalog, and that
the first app's `/api/auth/login` redirects to the platform's `/authorize`, which (signed out)
redirects to the portal's `/#/signin`. Each check is tried up to 4 times, 10 s apart. Missing
secrets in a health body are warnings. In maintenance (`stacks.config.json`) only health runs.
Each health answer names its commit (`build`), shown in the table; with `--sha` (Deploy passes the
commit it deployed) a stack on another commit, or one that doesn't say, is a warning: that's how
mixed versions after a partly failed deploy show (`docs/ROLLBACK.md`). Results go to the log and the job summary. Tests: `npm test -w tools/smoke`.
