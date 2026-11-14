/**
 * The `gameServer` module on AWS: one Fargate task per room on the platform's shared cluster
 * (public subnets, a public IP, no load balancer), the game key from Secrets Manager and
 * short-lived TURN credentials from Cloudflare. Node only; loaded lazily by `lambda.ts`.
 */
import { DescribeTasksCommand, ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { STUN_ONLY, TURN_KEY_NAMES, roomKeys, type Games, type IceServer } from './games';
import type { Item, Store } from './store';

export interface AwsGamesOptions {
  /** The app's slug (tags its tasks, so one app can never stop another's). */
  app: string;
  store: Store;
  clusterArn: string;
  /** Family (latest revision) or full ARN. */
  taskDefinition: string;
  containerName: string;
  subnetIds: string[];
  securityGroupId: string;
  /** Reads the game key (a Secrets Manager secret; `realtimeKeyReader` does it). */
  key: () => Promise<string>;
  /** SSM prefix of the platform's TURN key, e.g. `/stacks/test/secrets/platform/`. Unset: STUN only. */
  turnPrefix?: string;
  ecs?: Pick<ECSClient, 'send'>;
  ssm?: Pick<SSMClient, 'send'>;
  fetch?: typeof fetch;
  now?: () => number;
}

const TURN_KEY_TTL_MS = 5 * 60_000;
const TURN_TIMEOUT_MS = 3000;
/** Task states that mean "gone or going". */
const STOPPING = new Set(['DEACTIVATING', 'STOPPING', 'DEPROVISIONING', 'STOPPED', 'DELETED']);

/**
 * Cloudflare's TURN URLs as browsers can use them: the alternate port 53 ones are dropped
 * (browsers block that port, so they only time out).
 */
export function usableIceServers(servers: unknown): IceServer[] {
  if (!Array.isArray(servers)) return [];
  const out: IceServer[] = [];
  for (const s of servers as { urls?: unknown; username?: unknown; credential?: unknown }[]) {
    const urls = (Array.isArray(s?.urls) ? s.urls : [s?.urls]).filter((u): u is string => typeof u === 'string' && /^(stun|turn|turns):/.test(u) && !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    out.push({
      urls,
      ...(typeof s.username === 'string' ? { username: s.username } : {}),
      ...(typeof s.credential === 'string' ? { credential: s.credential } : {}),
    });
  }
  return out;
}

/** `deps.games` on AWS. `opts.ecs`, `ssm`, `fetch` and `now` are for tests. */
export function awsGames(opts: AwsGamesOptions): Games {
  const ecs = opts.ecs ?? new ECSClient({});
  const ssm = opts.ssm ?? new SSMClient({});
  const doFetch = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? Date.now;
  let turnKey: { at: number; value: Promise<{ id?: string; token?: string }> } | undefined;

  const readParam = (name: string) =>
    ssm
      .send(new GetParameterCommand({ Name: `${opts.turnPrefix}${name}`, WithDecryption: true }))
      .then((r) => r.Parameter?.Value || undefined)
      .catch((err: { name?: string }) => {
        if (err?.name === 'ParameterNotFound') return undefined;
        throw err;
      });

  /** The platform's TURN key (either half may be missing), cached for five minutes. */
  const turn = (): Promise<{ id?: string; token?: string }> => {
    if (!opts.turnPrefix) return Promise.resolve({});
    if (turnKey && now() - turnKey.at < TURN_KEY_TTL_MS) return turnKey.value;
    const value = Promise.all([readParam(TURN_KEY_NAMES[0]), readParam(TURN_KEY_NAMES[1])]).then(([id, token]) => ({ id, token }));
    value.catch(() => (turnKey = undefined));
    turnKey = { at: now(), value };
    return value;
  };

  const taskOf = async (roomId: string) => (await opts.store.get<Item & { taskArn: string }>(roomKeys.task(roomId).PK, roomKeys.task(roomId).SK))?.taskArn;

  return {
    key: opts.key,

    async start(roomId) {
      const res = await ecs.send(
        new RunTaskCommand({
          cluster: opts.clusterArn,
          taskDefinition: opts.taskDefinition,
          launchType: 'FARGATE',
          count: 1,
          // Room ids are at most 36 characters here (`startedBy` allows 36).
          ...(roomId.length <= 36 ? { startedBy: roomId } : {}),
          networkConfiguration: { awsvpcConfiguration: { subnets: opts.subnetIds, securityGroups: [opts.securityGroupId], assignPublicIp: 'ENABLED' } },
          overrides: { containerOverrides: [{ name: opts.containerName, environment: [{ name: 'STACKS_ROOM_ID', value: roomId }] }] },
          // The stack's tags (stacks:env) come from the task definition; these two are the task's own.
          propagateTags: 'TASK_DEFINITION',
          tags: [
            { key: 'stacks:app', value: opts.app },
            { key: 'stacks:room', value: roomId },
          ],
        }),
      );
      const taskArn = res.tasks?.[0]?.taskArn;
      if (!taskArn) throw new Error(`ECS did not start a task: ${JSON.stringify(res.failures ?? []).slice(0, 500)}`);
      await opts.store.put({ ...roomKeys.task(roomId), taskArn });
    },

    async stop(roomId) {
      const taskArn = await taskOf(roomId);
      if (!taskArn) return;
      try {
        await ecs.send(new StopTaskCommand({ cluster: opts.clusterArn, task: taskArn, reason: 'Room ended' }));
      } catch (err) {
        // Already gone (ECS forgets stopped tasks after about an hour).
        if (!/not ?found|MISSING|InvalidParameter/i.test(`${(err as Error).name} ${(err as Error).message}`)) throw err;
      }
    },

    async running(roomIds) {
      const alive = new Set<string>();
      const arns = new Map<string, string>();
      for (const id of roomIds) {
        const arn = await taskOf(id);
        if (arn) arns.set(arn, id);
      }
      const all = [...arns.keys()];
      for (let i = 0; i < all.length; i += 100) {
        const res = await ecs.send(new DescribeTasksCommand({ cluster: opts.clusterArn, tasks: all.slice(i, i + 100) }));
        for (const t of res.tasks ?? []) {
          const id = t.taskArn ? arns.get(t.taskArn) : undefined;
          if (id && !STOPPING.has(t.lastStatus ?? '') && t.desiredStatus !== 'STOPPED') alive.add(id);
        }
      }
      return alive;
    },

    async iceServers(ttlSeconds) {
      const { id, token } = await turn();
      if (!id || !token) return STUN_ONLY;
      const res = await doFetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: Math.min(Math.max(Math.ceil(ttlSeconds), 60), 172_800) }),
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
      const servers = usableIceServers(((await res.json()) as { iceServers?: unknown }).iceServers);
      // STUN first either way, so a direct path is always tried.
      return servers.some((s) => s.urls.some((u) => u.startsWith('stun:'))) ? servers : [...STUN_ONLY, ...servers];
    },

    async missingKeys() {
      if (!opts.turnPrefix) return [...TURN_KEY_NAMES];
      const { id, token } = await turn();
      return [...(id ? [] : [TURN_KEY_NAMES[0]]), ...(token ? [] : [TURN_KEY_NAMES[1]])];
    },
  };
}
