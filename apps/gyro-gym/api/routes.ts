import type { AppDeps, AppRoutes } from '@stacks/api';

/**
 * Gyro Gym keeps nothing on the server: every screen runs in the page (BRIEF.md). The platform's
 * own routes (sign-in, health, client errors) still come with the app.
 */
export function routes(_api: AppRoutes<AppDeps>) {}
