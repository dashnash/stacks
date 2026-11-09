/** Set by CI when it builds an app or the portal (see .github/workflows); missing in local builds. */
interface ImportMetaEnv {
  /** The commit being built. */
  readonly VITE_STACKS_BUILD_SHA?: string;
  /** e.g. https://github.com/owner/repo, for the commit link. */
  readonly VITE_STACKS_REPO_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
