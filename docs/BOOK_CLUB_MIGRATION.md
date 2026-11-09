# Book Club cut-over

> **Done on 2026-11-08.** Steps 1-5 are complete. Remaining: step 6 (retire the old site) after
> 2026-12-08. Kept as the pattern for migrating other existing apps.

Moves the MOFO Book Club Portal (`BookClubStack`, repo `dashnash/MofoBookKlubPortal`) onto Stacks
as `apps/mofobookklub`, **keeping its address `https://mofobookklub.iamdashnash.com`**. Run every
AWS command on your own machine with admin credentials (`export AWS_PROFILE=admin AWS_REGION=us-east-1`),
never in CI or a Claude session.

What moves: books, meetings, The Lineup and votes, comments, critic quotes, the activity log,
members and roles (to the platform), and the critic photos and shared faces (bucket to bucket;
they are never put in git). What doesn't: sign-in sessions, so every member signs in once more.

**Why there's a hold:** the old stack owns `mofobookklub.iamdashnash.com` (its DNS record and
CloudFront alias). Until it lets go, production must not try to create them, so
`stacks.config.json` lists `mofobookklub` under `production.holdApps`. Staging is not held.

## 1. Find the resource names

```bash
aws cloudformation describe-stacks --stack-name BookClubStack --query "Stacks[0].Outputs"
```

```bash
aws cloudformation describe-stacks --stack-name stacks-test-platform --query "Stacks[0].Outputs"
```

You need the old `TableName` and `EasterEggBucketName`, and the platform's `TableName`. The new
app's `TableName` and `ContentBucketName` come from `stacks-test-app-mofobookklub` (after step 2)
and `stacks-prod-app-mofobookklub` (after step 4).

## 2. Rehearse on staging (no downtime)

Every merge to `main` deploys it to staging. If it isn't there yet (no merge since this runbook
landed), deploy it once by hand:

```bash
gh workflow run deploy-test.yml -f app=mofobookklub -f ref=main
```

```bash
aws cloudformation describe-stacks --stack-name stacks-test-app-mofobookklub --query "Stacks[0].Outputs"
```

Copy production's data into staging (the old table is only read), dry run first:

```bash
# Historical: tools/migrate-book-club was removed with the user-id cut-over (it wrote email-keyed users); see git history.
npm run migrate -w tools/migrate-book-club -- --source-table <old TableName> --app-table <staging app TableName> --platform-table <staging platform TableName> --source-bucket <old EasterEggBucketName> --content-bucket <staging ContentBucketName> --dry-run
```

Then without `--dry-run`. Open `https://mofobookklub.test.iamdashnash.com`: sign in, check the shelf,
The Lineup, discussions, critics' photos, and **Access** on `https://auth.test.iamdashnash.com`.

## 3. Release the old address (downtime starts)

Tell members the site will be down for about half an hour. In the old repo's GitHub settings
(*Settings → Secrets and variables → Actions*), delete the variables `DOMAIN_NAME`,
`HOSTED_ZONE_ID` and `HOSTED_ZONE_NAME`, then re-run its last **CI/CD Pipeline** run on `main`.
The old stack then removes its `mofobookklub` DNS records, CloudFront alias and certificate (the
old site stays reachable on its `*.cloudfront.net` address). Wait for the run to finish, then check:

```bash
aws route53 list-resource-record-sets --hosted-zone-id Z34UPUIR94DZXQ --query "ResourceRecordSets[?starts_with(Name, 'mofobookklub.iamdashnash.com')]"
```

It should print `[]`.

## 4. Lift the hold

Remove `holdApps` (and `$holdApps`) from `production` in `stacks.config.json`, open a PR and merge
it (or ask Claude to). The **Deploy** run creates `stacks-prod-app-mofobookklub` at
`https://mofobookklub.iamdashnash.com` (first deploy about 5-10 minutes).

## 5. Migrate production

```bash
aws cloudformation describe-stacks --stack-name stacks-prod-app-mofobookklub --query "Stacks[0].Outputs"
```

```bash
aws cloudformation describe-stacks --stack-name stacks-prod-platform --query "Stacks[0].Outputs"
```

Run the migration with the production names, `--dry-run` first, then for real. Check the site,
then tell members to sign in at the same address as before. Their role is already there.

The migration is safe to re-run: anything added since the last run is copied, and nothing on the
platform is overwritten. (Deletions on the old site are not carried over.)

## 6. Retire the old site

- After 30 days, delete `BookClubStack`. Its table is kept on delete (`RETAIN`); remove it by hand
  once you're sure. Its assets bucket is also retained.
- The face photos remain in the old repo's git history. Rewrite that history or delete the repo
  if they should be gone everywhere.
