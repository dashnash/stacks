import { useStacks } from '@stacks/web';
import { Spinner } from './components/ui';
import type { Role, User } from './lib/types';
import { DashboardView } from './views/DashboardView';
import { Centered, SignedOutSite } from './views/SignInView';

/**
 * Which screen to show. Signing in, waiting for approval and roles are the platform's job now:
 * signed out (or still waiting) you get the public site; signed in you have a role.
 */
export default function App() {
  const { status, session } = useStacks();
  if (status === 'loading') {
    return (
      <Centered>
        <Spinner label="Checking your library card" />
      </Centered>
    );
  }
  if (status === 'signedOut' || !session) return <SignedOutSite />;
  const user: User = { id: session.user.id, name: session.user.name, pictureUrl: session.user.pictureUrl, role: session.role as Role };
  return <DashboardView key={`${user.id}:${user.role}`} user={user} />;
}
