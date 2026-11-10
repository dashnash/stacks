# User-id cut-over (N1a)

Moves every person from email keys (`USER#<email>`, `GRANT#<email>`, `authorEmail`, …) to a stable
user id (`u_…`), in the platform table and in every app's table, in one maintenance window.
Background: `docs/NATIVE_APP_SPEC.md`, "Identity v2". Run every AWS command on your own machine with
admin credentials (`export AWS_PROFILE=admin AWS_REGION=us-east-1`), never in CI or a Claude session.

**What people notice:** Stacks shows "Back in a few minutes" for the length of the window, then
everyone signs in once more (sessions are dropped). Accounts, display names, roles, inboxes, posts,
votes and history all stay. Someone who left before the cut-over shows as "Former member" on their
old posts, as before.

**Why a window:** the new code can't read email-keyed data, and the merge deploys staging and then
production at once. The PR that ships the code also sets `"maintenance": true` for both
environments in `stacks.config.json`, so both come up in maintenance; a one-line PR lifts it.

## 0. Before merging: dry runs on today's data (read-only)

The tool only reads with `--dry-run`, so run it against both environments while they still run the
old code. It prints what it would change per table and any items it can't handle.

```bash
aws cloudformation describe-stacks --stack-name stacks-test-platform --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text
```

```bash
npm run migrate -w tools/migrate-user-ids -- --env staging --platform-table <staging platform TableName> --dry-run
```

```bash
aws cloudformation describe-stacks --stack-name stacks-prod-platform --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text
```

```bash
npm run migrate -w tools/migrate-user-ids -- --env production --platform-table <production platform TableName> --dry-run
```

Expect, for production: `user` = the number of people, `grant` = cells in the access grid,
`session.dropped` > 0, and for `mofobookklub` some `rewritten`/`rekeyed` items. Any `ERROR` line or
exit code 1: stop and fix before merging.

## 1. Back up (production has point-in-time recovery too)

```bash
aws dynamodb create-backup --table-name <production platform TableName> --backup-name pre-user-ids
```

Repeat for each production app table (`aws ssm get-parameters-by-path --path /stacks/prod/apps/ --recursive --query "Parameters[?ends_with(Name, '/table')].Value"`).

## 2. Merge the PR

`deploy.yml` deploys staging, then production, both in maintenance. Check both answer 503:

```bash
curl -s https://auth.test.iamdashnash.com/api/catalog -o /dev/null -w '%{http_code}\n'
```

```bash
curl -s https://auth.iamdashnash.com/api/catalog -o /dev/null -w '%{http_code}\n'
```

## 3. Migrate staging, then check it

```bash
npm run migrate -w tools/migrate-user-ids -- --env staging --platform-table <staging platform TableName>
```

To check staging before production, lift maintenance there only (a PR setting
`environments.staging.maintenance` to `false`), then on `https://auth.test.iamdashnash.com`: sign in,
see your apps and roles in the grid, open Book Club and see meetings, the Lineup with its votes and
comments with names. Run the command again: it should report `nothing to do` everywhere.

## 4. Migrate production

```bash
npm run migrate -w tools/migrate-user-ids -- --env production --platform-table <production platform TableName>
```

## 5. Lift maintenance

A PR setting `"maintenance": false` (or removing it) for production. After it deploys: sign in, check
the grid (every member still has their role), Book Club's history, Lineup votes and comments, and
`flippy-work-table`'s leaderboard.

## If something goes wrong

- Before step 4, production is untouched: revert the PR (maintenance off with the old code) and fix.
- After step 4, the data is in the new shape and the old code can't read it: fix forward, or restore
  the step 1 backups (`aws dynamodb restore-table-from-backup` into new tables, then point the stacks
  at them) and revert.
- The tool is idempotent: a run that stopped halfway can simply be run again.
