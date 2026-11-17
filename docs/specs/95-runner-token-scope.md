# #95 Runner registration token can administer this repo (SEC-02)

**Status: specced, not implemented (the owner chose to skip it for now).** The work lives in the
homelab repo, which isn't attached to Stacks sessions.

The self-hosted runners register with a fine-grained PAT holding **Administration: read and write**
on `dashnash/stacks` (vault key `github_runner_stacks_pat_prod`, `/etc/github-runner/pat` on
`kairos-prod`). Anyone who reads it can add a collaborator and, through that, reach production.

## Finding from refinement (read before choosing a fix)

For a **user-owned** repo, GitHub's runner registration API (`POST /repos/{owner}/{repo}/actions/runners/registration-token`)
needs repository **Administration: write**, for fine-grained PATs and GitHub Apps alike. The
narrower "Self-hosted runners" permission exists only for organizations. So a GitHub App does not
shrink the scope here; what it changes is **lifetime and location**: installation tokens live one
hour, and the App's private key can stay on the runner host instead of the shared vault.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Approach | GitHub App installed on `dashnash/stacks` only, repository permission Administration: read & write, no webhook. The runner role mints a one-hour installation token, then a registration token, at runner start. |
| Secret location | The App's private key lives only on the runner host (root, mode 0400), never in the shared vault. |
| Prerequisite | The homelab vault exposure is fixed first (tracked in the homelab repo). |
| Later | If the repo moves to a GitHub organization, switch to the org-level `Self-hosted runners: write` permission and drop repo Administration. |

## Manual steps for the owner

1. Fix the homelab vault exposure.
2. Create the GitHub App (Settings → Developer settings → GitHub Apps → New): no webhook,
   repository permission Administration: read & write, "Only on this account", install it on
   `dashnash/stacks` only. Download the private key straight to the runner host.
3. In the homelab repo, change `roles/github_runner`: JWT from the App key → `POST /app/installations/<id>/access_tokens`
   → `POST /repos/dashnash/stacks/actions/runners/registration-token`.
4. Revoke the PAT; delete vault key `github_runner_stacks_pat_prod` and `/etc/github-runner/pat`.
5. Record the App id, installation id and key location in the manual-state inventory (#105).

## Acceptance (owner)

Both runners still pick up jobs; the old PAT is revoked; no repo-admin credential is left in the vault.

## Out of scope

Any code change in this repo.
