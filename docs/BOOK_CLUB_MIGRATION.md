# Book Club cut-over

Moves the MOFO Book Club Portal (`BookClubStack`, repo `dashnash/MofoBookKlubPortal`) onto Stacks
as `apps/book-club`. Run every command on your own machine with admin AWS credentials
(`export AWS_PROFILE=admin AWS_REGION=us-east-1`), never in CI or a Claude session.

What moves: books, meetings, The Lineup and votes, comments, critic quotes, the activity log,
members and roles (to the platform), and the critic photos and shared faces (bucket to bucket;
they are never put in git). What doesn't: sign-in sessions, so every member signs in once more.

## 1. Find the resource names

```bash
aws cloudformation describe-stacks --stack-name BookClubStack --query "Stacks[0].Outputs"
```

```bash
aws cloudformation describe-stacks --stack-name stacks-test-app-book-club --query "Stacks[0].Outputs"
```

```bash
aws cloudformation describe-stacks --stack-name stacks-test-platform --query "Stacks[0].Outputs"
```

You need: the old `TableName` and `EasterEggBucketName`; the new app's `TableName` and
`ContentBucketName`; the platform's `TableName`. Repeat with `stacks-prod-…` for production.

## 2. Rehearse on staging

Deploy the app to staging (it has no data yet):

```bash
gh workflow run deploy-test.yml -f app=book-club -f ref=main
```

Copy production's data into staging. The old table is only read:

```bash
npm run migrate -w tools/migrate-book-club -- --source-table <old TableName> --app-table <staging app TableName> --platform-table <staging platform TableName> --source-bucket <old EasterEggBucketName> --content-bucket <staging ContentBucketName> --dry-run
```

Check the counts it prints, then run it again without `--dry-run`. Open
`https://book-club.test.iamdashnash.com`: sign in, check the shelf, The Lineup, discussions, the
critics' photos, and that **Access** in `https://auth.test.iamdashnash.com` shows every member with
their role.

## 3. Production

Merging the app deploys `stacks-prod-app-book-club` at `https://book-club.iamdashnash.com` (empty
and private: only the manifest's owners get in). When you're ready to switch:

1. Run the migration against the production tables and bucket, `--dry-run` first.
2. Check `https://book-club.iamdashnash.com`.
3. Tell members the new address. They sign in once with Google; their role is already there.

The migration is safe to re-run: anything added on the old site since the last run is copied, and
nothing on the platform is overwritten. (Deletions on the old site are not carried over.)

## 4. Retire the old site

- Point the old address at the new one (a redirect on the old CloudFront, or change its DNS
  record): tell Claude the old domain and it can prepare the change in the old repo.
- After 30 days, delete `BookClubStack`. Its table is kept on delete (`RETAIN`); remove it by hand
  once you're sure.
- The face photos remain in the old repo's git history. Rewrite that history or delete the repo
  if they should be gone everywhere.
