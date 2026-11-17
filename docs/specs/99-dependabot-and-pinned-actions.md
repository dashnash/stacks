# #99 Enable Dependabot and secret scanning; pin Actions to SHAs (SUP-01, SUP-02)

Dependabot and secret scanning are off, `npm audit` reports criticals, and every action is referenced
by a moving tag in jobs that hold the production role. After this change Dependabot opens weekly
grouped updates, the audit is clean, and every action is pinned to a commit SHA.

## Decisions (settled, don't reopen)

| Topic | Decision |
| --- | --- |
| Dependabot | `.github/dependabot.yml`: `npm` at `/` and `github-actions` at `/`, weekly (Monday). Per ecosystem one group for minor+patch updates; majors come one per PR; security updates are separate PRs (Dependabot default). Open PR limit 5 (default). |
| Audit | Bump `vitest` (and `@vitest/*`) to the fixed major, `aws-cdk-lib` and `fflate` (and transitive `minimatch`) to fixed versions, so `npm audit` shows no critical/high. Fix any test breakage from the vitest major in the same PR. **Known residual (found while implementing):** a moderate `minimatch` advisory bundled inside every current `aws-cdk-lib` (≥2.240); not fixable without downgrading CDK, synth-time only, accepted until CDK ships a fix (Dependabot will pick it up). |
| Pinning | Every `uses:` in `.github/workflows/*.yml` pinned to the full commit SHA of the current latest release in the same major, with a `# vX.Y.Z` comment. The actionlint Docker image pinned by digest (`docker://rhysd/actionlint:1.7.12@sha256:…`). |
| Guard | `scripts/check-action-pins.mjs` (run in CI `check`) fails on any `uses:` that isn't a 40-hex SHA or a digest-pinned Docker image; unit-tested. Dependabot keeps SHAs current. |

## Manual steps for the owner (after merge)

1. Settings → Code security: enable Dependabot alerts, Dependabot security updates, secret scanning and push protection.
2. Settings → Actions → General: tick **Require actions to be pinned to a full-length commit SHA**; optionally set *Allow* to GitHub-owned + `aws-actions/*` only.
3. Dependabot PRs touch `package-lock.json` / `.github/`, so each needs your code-owner review (and, for `.github/`, an agent review per #111).

## Acceptance (agent)

`npm audit` has no critical/high findings (only the bundled `minimatch` moderate); `npm test`, typecheck, lint, build, synths;
`node scripts/check-action-pins.mjs` passes; actionlint passes.
