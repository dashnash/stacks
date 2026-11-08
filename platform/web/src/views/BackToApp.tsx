import { useAsync } from '@stacks/web';
import { usePortal } from '../portal';

/** "← Back to <app>" when someone came here from an app's account menu (?from=<slug>). */
export function BackToApp({ from }: { from?: string }) {
  const { api } = usePortal();
  const { data } = useAsync(() => (from ? api.catalog() : Promise.resolve(null)), [from]);
  const app = from ? data?.apps.find((a) => a.slug === from) : undefined;
  if (!app) return null;
  return (
    <p className="back">
      <a href={app.url}>← Back to {app.name}</a>
    </p>
  );
}
