import { canManageAccess, type AppManifest } from '@stacks/manifest';
import { badRequest, notFound, randomToken, sha256Hex, type Item } from '@stacks/api';
import { getUser, grantsForApp, grantsForUser, listApps, listNotifications, managesApp, userIdForEmail } from './core';
import { holdsRole, keys, PENDING, type Device, type DeviceItem, type PlatformDeps, type PlatformUser, type PushMessage } from './model';

/*
 * Push to the iOS app (docs/NATIVE_APP_SPEC.md, "Notifications and push"). The inbox stays the
 * source of truth; a push is only a way of delivering it, so sending is best-effort and never fails
 * the call that caused it.
 */

/** APNs device tokens are 32 bytes today; Apple says to allow for longer ones. */
const TOKEN = /^[0-9a-f]{64,200}$/;
const MAX_DEVICES = 20;

type TokenItem = Item & { deviceId: string; userId: string };

const strip = ({ PK: _a, SK: _b, GSI1PK: _c, GSI1SK: _d, ...d }: DeviceItem): Device => d as Device;

export async function listDevices(deps: PlatformDeps, userId: string): Promise<Device[]> {
  return (await deps.store.queryGsi1<DeviceItem>(keys.device('', userId).GSI1PK)).map(strip);
}

async function deleteDevice(deps: PlatformDeps, d: Pick<Device, 'id' | 'userId' | 'token'>): Promise<void> {
  const k = keys.device(d.id, d.userId);
  await deps.store.delete(k.PK, k.SK);
  const t = keys.pushToken(await sha256Hex(d.token));
  const owner = await deps.store.get<TokenItem>(t.PK, t.SK);
  if (owner?.deviceId === d.id) await deps.store.delete(t.PK, t.SK);
}

/**
 * The app on this phone gets this person's notifications. A token another account registered (the
 * phone signed in as someone else) moves here; registering again refreshes the device and its
 * secret. Returns the secret once: only its hash is kept.
 */
export async function registerDevice(
  deps: PlatformDeps,
  user: PlatformUser,
  input: { token?: unknown; env?: unknown; bundleId?: unknown; deviceName?: unknown },
): Promise<{ device: Device; secret: string }> {
  const token = String(input.token ?? '').toLowerCase();
  if (!TOKEN.test(token)) throw badRequest('"token" must be an APNs device token (hex)');
  if (input.env !== 'sandbox' && input.env !== 'production') throw badRequest('"env" must be "sandbox" or "production"');
  const bundleId = String(input.bundleId ?? '');
  if (!deps.config.iosBundleId || bundleId !== deps.config.iosBundleId) throw badRequest('This app is not the iOS app of this environment');
  const deviceName = String(input.deviceName ?? '').trim().slice(0, 60) || 'iPhone';

  const now = deps.now().toISOString();
  const tokenKey = keys.pushToken(await sha256Hex(token));
  const owner = await deps.store.get<TokenItem>(tokenKey.PK, tokenKey.SK);
  let previous: DeviceItem | undefined;
  if (owner) {
    previous = await deps.store.get<DeviceItem>(keys.device(owner.deviceId, owner.userId).PK, 'DEVICE');
    if (previous && previous.userId !== user.id) {
      await deleteDevice(deps, previous);
      previous = undefined;
    }
  }
  if (!previous && (await listDevices(deps, user.id)).length >= MAX_DEVICES) throw badRequest(`At most ${MAX_DEVICES} devices: remove one in Settings first`);

  const secret = randomToken('sdv_');
  const device: Device = {
    id: previous?.id ?? deps.newId(),
    userId: user.id,
    token,
    env: input.env,
    bundleId,
    deviceName,
    createdAt: previous?.createdAt ?? now,
    lastSeenAt: now,
    secretHash: await sha256Hex(secret),
  };
  await deps.store.put({ ...keys.device(device.id, user.id), ...device });
  await deps.store.put({ ...tokenKey, deviceId: device.id, userId: user.id });
  return { device, secret };
}

export async function removeDevice(deps: PlatformDeps, userId: string, id: string): Promise<void> {
  const d = await deps.store.get<DeviceItem>(keys.device(id, userId).PK, 'DEVICE');
  if (!d || d.userId !== userId) throw notFound('No such device');
  await deleteDevice(deps, d);
}

/** Signing out everywhere (or a merge) ends push to every device too. */
export async function removeAllDevices(deps: PlatformDeps, userId: string): Promise<void> {
  await Promise.all((await listDevices(deps, userId)).map((d) => deleteDevice(deps, d)));
}

/** What the portal and settings show; never the token or the secret's hash. */
export const deviceView = (d: Device) => ({ id: d.id, deviceName: d.deviceName, env: d.env, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt });

/* ---------- Badges and links ---------- */

/** Unread notifications, and requests waiting on this person (the account menu's counts). */
export async function badges(deps: PlatformDeps, user: PlatformUser): Promise<{ unread: number; pendingRequests: number; managesApps: number }> {
  const unread = (await listNotifications(deps, user.id)).filter((n) => !n.read).length;
  let pendingRequests = 0;
  let managesApps = 0;
  for (const a of await listApps(deps)) {
    if (!(await managesApp(deps, user, a.manifest)).manages) continue;
    managesApps++;
    pendingRequests += (await grantsForApp(deps, a.manifest.slug)).filter((g) => g.role === PENDING).length;
  }
  return { unread, pendingRequests, managesApps };
}

/** The app icon's number: unread notifications plus requests waiting on them. */
export async function badgeCount(deps: PlatformDeps, user: PlatformUser): Promise<number> {
  const b = await badges(deps, user);
  return b.unread + b.pendingRequests;
}

/** Notification links are absolute, so a tapped push can open them: portal routes go to the portal. */
export function absoluteLink(deps: PlatformDeps, link: string | undefined): string | undefined {
  if (!link) return undefined;
  if (link.startsWith('#')) return `${deps.config.authOrigin}/${link}`;
  return /^https:\/\//.test(link) ? link : undefined;
}

/** Everyone who handles access requests for an app: its approvers and the platform admins. */
export async function accessManagers(deps: PlatformDeps, manifest: AppManifest): Promise<string[]> {
  const approvers = (await grantsForApp(deps, manifest.slug)).filter((g) => holdsRole(g.role) && canManageAccess(manifest, g.role)).map((g) => g.userId);
  const admins = (await Promise.all(deps.config.platformAdmins.map((e) => userIdForEmail(deps, e)))).filter((id): id is string => !!id);
  return [...new Set([...approvers, ...admins])];
}

/* ---------- Sending ---------- */

async function deliver(deps: PlatformDeps, user: PlatformUser, build: (badge: number) => PushMessage): Promise<void> {
  const push = deps.push;
  if (!push) return;
  const devices = await listDevices(deps, user.id);
  if (!devices.length) return;
  const message = build(await badgeCount(deps, user));
  await Promise.all(
    devices.map(async (d) => {
      const result = await push.send(d, message).catch((err) => {
        console.error('Push failed', err);
        return 'failed' as const;
      });
      if (result === 'gone') await deleteDevice(deps, d);
    }),
  );
}

/** A new inbox item, pushed to the person's devices (unless they muted its app: then the badge only). */
export async function pushNotification(deps: PlatformDeps, userId: string, n: { text: string; link?: string; app?: string }): Promise<void> {
  try {
    const user = await getUser(deps, userId);
    if (!user) return;
    const muted = !!n.app && (user.mutedApps ?? []).includes(n.app);
    const title = n.app ? ((await listApps(deps)).find((a) => a.manifest.slug === n.app)?.manifest.name ?? 'Stacks') : 'Stacks';
    await deliver(deps, user, (badge) =>
      muted ? { badge } : { alert: { title, body: n.text }, badge, url: absoluteLink(deps, n.link) ?? `${deps.config.authOrigin}/#/notifications`, ...(n.app ? { threadId: n.app } : {}) },
    );
  } catch (err) {
    console.error('Could not push a notification', err);
  }
}

/** Badge-only pushes after counts change elsewhere (read on another device, a request handled). */
export async function syncBadges(deps: PlatformDeps, userIds: string[]): Promise<void> {
  if (!deps.push) return;
  await Promise.all(
    [...new Set(userIds)].map(async (id) => {
      try {
        const user = await getUser(deps, id);
        if (user) await deliver(deps, user, (badge) => ({ badge }));
      } catch (err) {
        console.error('Could not sync a badge', err);
      }
    }),
  );
}

/** Settings › Notifications: the apps this person uses, and whether each one's pushes are muted. */
export async function notificationSettings(deps: PlatformDeps, user: PlatformUser) {
  const apps = await listApps(deps); // first: it registers apps seen for the first time
  const held = new Set((await grantsForUser(deps, user.id)).filter((g) => holdsRole(g.role)).map((g) => g.app));
  const muted = new Set(user.mutedApps ?? []);
  return apps
    .filter((a) => held.has(a.manifest.slug))
    .map((a) => ({ slug: a.manifest.slug, name: a.manifest.name, muted: muted.has(a.manifest.slug) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
