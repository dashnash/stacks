# #97 Version content buckets and rehearse a table restore (DR-01, DR-02)

Content buckets (members' photos) can be lost with one bad delete, and the only table backup is
35 days of point-in-time recovery with no runbook. After this change content buckets keep old
versions for 90 days, production tables get monthly AWS Backup snapshots kept for a year, staging has
PITR so restores can be rehearsed, and `docs/RESTORE.md` plus a copy-back script make restores routine.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Versioning | `versioned: true` on every `ContentBucket` (both environments), lifecycle rule `noncurrentVersionExpiration: 90 days` and `abortIncompleteMultipartUploadAfter: 7 days`. Web buckets unchanged (rebuilt on every deploy) (default). |
| Backups | AWS Backup in the **production platform stack** only: one vault `stacks-prod-backups` (retain on delete), one plan with a monthly rule (1st of the month, 05:00 UTC), deleteAfter 365 days, selection = every `AWS::DynamoDB::Table` tagged `stacks:env=production`. CDK `BackupPlan`/`BackupSelection` create the service role. |
| PITR | On for every table in both environments (staging too, so the runbook is rehearsed on the real path). |
| Restore model | Restore to a new table, then **copy items back into the stack's live table** with `tools/table-copy` (owner runs it with admin credentials). Stacks, the registry and names are never repointed. |
| Copy tool | `npm run table-copy -- --from <restored> --to <live> [--dry-run] [--region us-east-1]`: Scan (paginated, parallel segments optional) + BatchWriteItem with retry of unprocessed items; refuses if `--to` is missing or equals `--from`; prints counts. Pure logic unit-tested with a fake client; no AWS in tests. |

## Manual steps for the owner

1. After deploy: rehearse once on staging following `docs/RESTORE.md` (restore the staging platform
   table to a point a few minutes ago, dry-run then copy back, delete the restored table). Note how long it took in the runbook.
2. Check AWS Backup → Backup plans shows `stacks-prod-monthly` with the selection, and after the 1st of next month that a recovery point exists.

## Changes

- `packages/infra/src/app-stack.ts`: versioning + lifecycle on `ContentBucket`; PITR on in both envs.
- `packages/infra/src/platform-stack.ts`: PITR in both envs; production-only backup vault/plan/selection.
- Staging exec policy: no change needed (staging creates no Backup resources).
- `tools/table-copy/` (package, script, tests) and root `package.json` script `table-copy`.
- `docs/RESTORE.md`: DynamoDB PITR restore, AWS Backup restore, S3 object-version restore, copy-back, cleanup.
- `docs/PLATFORM_SPEC.md`: Data/backup bullets.

## Tests

- Infra: content bucket has `VersioningConfiguration.Status: Enabled` and the lifecycle rule; tables have PITR in staging and production; production platform stack has `AWS::Backup::BackupPlan` with a monthly rule and a selection on the tag; staging has none.
- table-copy: copies every page, retries unprocessed items, refuses same/missing target, dry-run writes nothing.

## Acceptance (agent)

`npm test`, typecheck, lint, both synths.

## Acceptance (owner, after deploy)

Manual steps 1 and 2.

## Out of scope

Cross-region or cross-account backup copies.
