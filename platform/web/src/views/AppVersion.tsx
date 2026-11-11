import { getNative } from '@stacks/native';
import { useAsync } from '@stacks/web';

/**
 * In the iOS app: which app build this is, next to the web's own build in the footer, e.g.
 * "App 1.0.0 (4201) · 0123abc". The commit is the one CI built the app from ("local" from Xcode).
 */
export function AppVersion({ className }: { className?: string }) {
  const info = useAsync(async () => {
    const app = getNative();
    return app.has('app.info') ? app.call('app.info') : null;
  }, []);
  const i = info.data;
  if (!i) return null;
  const commit = i.commit === undefined ? null : i.commit ? i.commit.slice(0, 7) : 'local';
  return (
    <span className={className} data-stacks-app-build={i.commit || 'local'} title={i.commit ? `App built from commit ${i.commit}` : undefined}>
      App {i.version} ({i.build}){commit ? ` · ${commit}` : ''}
    </span>
  );
}
