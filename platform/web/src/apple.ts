import { getNative } from '@stacks/native';

/*
 * Sign in with Apple: the iOS app's native sheet (bridge `auth.apple`), or Apple's JS on the
 * portal (popup) with the environment's Services ID. Either way the portal gets Apple's identity
 * token, plus the person's name, which Apple shares only the first time they sign in here.
 */

interface AppleSignInResponse {
  authorization: { id_token: string };
  user?: { name?: { firstName?: string; lastName?: string } };
}
declare global {
  interface Window {
    AppleID?: {
      auth: {
        init(config: { clientId: string; scope: string; redirectURI: string; usePopup: boolean }): void;
        signIn(): Promise<AppleSignInResponse>;
      };
    };
  }
}

const APPLE_JS = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
let loading: Promise<void> | null = null;

function loadAppleJs(): Promise<void> {
  if (window.AppleID) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = APPLE_JS;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not load Sign in with Apple'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Is Apple sign-in offered here: in an app version that has it, or on the web when a Services ID is set? */
export const appleAvailable = (servicesId: string | null | undefined) => getNative().has('auth.apple') || !!servicesId;

/** Ask Apple. Resolves null when the person backs out. */
export async function signInWithApple(servicesId: string | null | undefined): Promise<{ credential: string; name: string } | null> {
  const app = getNative();
  if (app.has('auth.apple')) {
    try {
      return await app.call('auth.apple');
    } catch (err) {
      if ((err as { code?: string }).code === 'cancelled') return null;
      throw err;
    }
  }
  if (!servicesId) throw new Error('Sign in with Apple is not set up here');
  await loadAppleJs();
  window.AppleID!.auth.init({ clientId: servicesId, scope: 'name email', redirectURI: `${window.location.origin}/`, usePopup: true });
  try {
    const res = await window.AppleID!.auth.signIn();
    const name = [res.user?.name?.firstName, res.user?.name?.lastName].filter(Boolean).join(' ');
    return { credential: res.authorization.id_token, name };
  } catch (err) {
    // Apple's popup reports a closed window as { error: 'popup_closed_by_user' }.
    if ((err as { error?: string })?.error === 'popup_closed_by_user' || (err as { error?: string })?.error === 'user_cancelled_authorize') return null;
    throw new Error((err as { error?: string })?.error ?? (err as Error)?.message ?? 'Sign in with Apple failed');
  }
}
