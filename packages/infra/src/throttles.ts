import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';

/**
 * Per-route caps (#102) on the routes anyone can call without a session or that fan out: sign-in,
 * access requests and browser error reports. API Gateway applies them per route, for every caller
 * together (not per IP): a flood on one of them uses up that route's cap, not the whole API.
 * Each stage keeps its default limit for everything else (`API_RATE_LIMIT` / `API_BURST_LIMIT`).
 */
export interface RouteThrottle {
  /** The HTTP API route key, e.g. `POST /api/auth/google`. A route with exactly this key is created. */
  routeKey: string;
  /** Steady requests per second. */
  rate: number;
  /** Burst. */
  burst: number;
}

/** The platform API (`auth.<domain>`). */
export const PLATFORM_ROUTE_THROTTLES: readonly RouteThrottle[] = [
  { routeKey: 'POST /api/auth/google', rate: 5, burst: 10 },
  { routeKey: 'POST /api/auth/apple', rate: 5, burst: 10 },
  { routeKey: 'GET /authorize', rate: 10, burst: 20 },
  { routeKey: 'POST /api/apps/{slug}/request', rate: 2, burst: 5 },
  { routeKey: 'POST /api/stacks/client-error', rate: 2, burst: 10 },
];

/** Every app's API (`<slug>.<domain>`). */
export const APP_ROUTE_THROTTLES: readonly RouteThrottle[] = [
  { routeKey: 'GET /api/auth/login', rate: 5, burst: 10 },
  { routeKey: 'GET /api/auth/callback', rate: 5, burst: 10 },
  { routeKey: 'POST /api/auth/silent-finish', rate: 5, burst: 10 },
  { routeKey: 'POST /api/stacks/client-error', rate: 1, burst: 5 },
];

/**
 * Creates a route for each key (route settings only apply to a route of exactly that key; the
 * rest still goes to `{proxy+}`), all to the same integration, and sets their caps on the stage.
 * The stage waits for the routes: CloudFormation rejects route settings for a key that doesn't
 * exist yet.
 */
export function addRouteThrottles(
  httpApi: apigw.HttpApi,
  stage: apigw.CfnStage,
  integration: apigw.HttpRouteIntegration,
  throttles: readonly RouteThrottle[],
): void {
  // A JSON property in CloudFormation: CDK passes it through as is, so the keys are CloudFormation's.
  const settings: Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }> = {};
  for (const t of throttles) {
    const [method, path] = t.routeKey.split(' ') as [keyof typeof apigw.HttpMethod, string];
    for (const route of httpApi.addRoutes({ path, methods: [apigw.HttpMethod[method]], integration })) stage.node.addDependency(route);
    settings[t.routeKey] = { ThrottlingRateLimit: t.rate, ThrottlingBurstLimit: t.burst };
  }
  stage.routeSettings = settings;
}
