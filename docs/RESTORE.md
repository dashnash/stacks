# Restoring data

What to do when data is lost or overwritten: a DynamoDB table (the platform's or an app's) or a file in
an app's content bucket (e.g. Book Club's photos). Everything here runs from your machine with the
admin profile; CI never restores. Decisions behind it: `docs/specs/97-content-versioning-and-restore.md`.

| What | Protection | Window |
| --- | --- | --- |
| Every table, both environments | Point-in-time recovery (PITR) | Any second in the last 35 days |
| Production tables | AWS Backup plan `stacks-prod-monthly`, vault `stacks-prod-backups` | 1st of each month, 05:00 UTC, kept 365 days |
| Content buckets (`contentPacks`) | S3 versioning | Overwritten or deleted versions kept 90 days |

**The model:** a restore always creates a **new** table. Nothing gets repointed at it. Instead,
`npm run table-copy` copies its items back into the stack's **live** table, so stacks, the registry
and names stay as they are. Then you delete the restored table.

Set the profile once per shell:

```bash
export AWS_PROFILE=admin AWS_REGION=us-east-1
```

## 1. Find the live table

The platform's table is in its stack outputs (`stacks-prod-platform`, or `stacks-test-platform` on staging):

```bash
aws cloudformation describe-stacks --stack-name stacks-prod-platform --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text
```

An app's table is in the registry:

```bash
aws ssm get-parameter --name /stacks/prod/apps/<slug>/table --query Parameter.Value --output text
```

Use `/stacks/test/...` for staging. Below, `LIVE` is that name.

## 2. Restore to a new table

**From PITR** (last 35 days). Pick a time just before the damage, in UTC:

```bash
aws dynamodb restore-table-to-point-in-time --source-table-name "$LIVE" --target-table-name "$LIVE-restore-$(date -u +%Y%m%d%H%M)" --restore-date-time 2026-11-17T09:30:00Z
```

**From a monthly backup** (older than 35 days, production only): AWS Backup console → Backup vaults →
`stacks-prod-backups` → pick the table's recovery point → **Restore**. Give it a new table name
(`<LIVE>-restore-<date>`) and use the `BackupRole` from `stacks-prod-platform` as the IAM role.

Either way, wait until the new table is `ACTIVE`. That takes minutes for small tables.

```bash
aws dynamodb wait table-exists --table-name "$RESTORED"
```

The restored table has no tags and no PITR, so it's never backed up itself. That's fine, because it's temporary.

## 3. Copy items back

Do a dry run first. It counts the items and writes nothing:

```bash
npm run table-copy -- --from "$RESTORED" --to "$LIVE" --dry-run
```

```bash
npm run table-copy -- --from "$RESTORED" --to "$LIVE"
```

What the copy does: every item in the restored table is written whole into the live table. An item
with the same key is **replaced** by its restored version. Items that exist only in the live table
(created after the restore point) **stay**. Items deleted since the restore point **come back**.

To roll back only part of a table, such as one person's records, don't run the full copy. Open both
tables in the DynamoDB console (Explore items) and copy the few items by hand.

Sessions in the copied data have expired `expiresAt` values, so DynamoDB's TTL removes them again
on its own.

## 4. Clean up

```bash
aws dynamodb delete-table --table-name "$RESTORED"
```

## Content bucket files (S3 versions)

Find the bucket from the app stack's `ContentBucketName` output (stack `stacks-prod-app-<slug>`). Then list a file's versions:

```bash
aws s3api list-object-versions --bucket "$BUCKET" --prefix "<key>" --query "{versions:Versions[].[VersionId,LastModified,IsLatest],deletes:DeleteMarkers[].[VersionId,LastModified,IsLatest]}"
```

- **Deleted file:** delete its latest *delete marker*, and the previous version becomes current again:

  ```bash
  aws s3api delete-object --bucket "$BUCKET" --key "<key>" --version-id "<delete marker VersionId>"
  ```
- **Overwritten file:** copy the good version over the current one:

  ```bash
  aws s3api copy-object --bucket "$BUCKET" --key "<key>" --copy-source "$BUCKET/<key>?versionId=<VersionId>"
  ```

Older versions are gone 90 days after they stop being current.

## Rehearsal log

Rehearse on staging once a year, or after changing anything above: restore `stacks-test-platform`'s
table to a few minutes ago, dry-run the copy, copy, then delete the restored table. Record it here.

| Date | Who | Table | Restore took | Copy (items / time) | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
