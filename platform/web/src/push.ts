import { getNative, NativeError, type PushPermission } from '@stacks/native';
import type { Me, PortalApi } from './api';

/*
 * Push in the iOS app (docs/NATIVE_APP_SPEC.md): the app hands the portal its APNs token, the
 * portal registers it with its own session, and gives the app back the device id and secret.
 */

/** Can this page turn on notifications (inside an app version that does push)? */
export const canPush = () => getNative().has('push.register');

/** This device's permission and registration, or null outside the app. */
export async function pushStatus(): Promise<{ permission: PushPermission; deviceId: string | null } | null> {
  const app = getNative();
  if (!app.has('push.status')) return null;
  return app.call('push.status').catch(() => null);
}

/**
 * Ask (the system prompt, the first time) and register this device. Returns false when the person
 * said no. Registering again is harmless: it refreshes the token and the device's secret.
 */
export async function enablePush(api: PortalApi): Promise<boolean> {
  const app = getNative();
  let reg;
  try {
    reg = await app.call('push.register');
  } catch (err) {
    if (err instanceof NativeError && err.code === 'cancelled') return false;
    throw err;
  }
  const { device, secret } = await api.registerDevice(reg);
  await app.call('push.saveDevice', { id: device.id, secret });
  return true;
}

/**
 * On every portal load in the app: keep the icon's number right, and refresh this device's
 * registration when notifications are already allowed (tokens can change). Never prompts.
 */
export async function syncWithApp(api: PortalApi, me: Me): Promise<void> {
  const app = getNative();
  if (app.has('badge.set')) await app.call('badge.set', { count: me.unread + me.pendingRequests }).catch(() => undefined);
  const status = await pushStatus();
  if (status?.permission === 'granted') await enablePush(api).catch((err) => console.error('Could not refresh push registration', err));
}

const DISMISSED = 'stacks.pushPrompt.dismissed';
export const promptDismissed = () => {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
};
export const dismissPrompt = () => {
  try {
    localStorage.setItem(DISMISSED, '1');
  } catch {
    /* private mode: it asks again next time */
  }
};
