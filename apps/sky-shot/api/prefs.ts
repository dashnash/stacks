/**
 * Your own look, kept between rooms and devices.
 *
 * - `GET /prefs`: `{ theme }`, null if you never picked one (the app then uses the default).
 * - `PUT /prefs { theme }`: save one; an unknown theme or palette is a 400.
 */
import { badRequest, type AppDeps, type AppRoutes } from '@stacks/api';
import { isThemeChoice } from '../game/themes';
import { keys, type PrefsItem } from './keys';

export function prefsRoutes(api: AppRoutes<AppDeps>) {
  api
    .member('GET', '/prefs', async (_req, v) => {
      const key = keys.prefs(v.user.id);
      const item = await v.deps.store.get<PrefsItem>(key.PK, key.SK);
      // A theme that has since been removed reads as no choice.
      return { body: { theme: item && isThemeChoice(item.theme) ? item.theme : null } };
    })
    .member('PUT', '/prefs', async (req, v) => {
      const theme = (req.body as { theme?: unknown } | undefined)?.theme;
      if (!isThemeChoice(theme)) throw badRequest('"theme" must be a known theme and palette');
      const at = v.deps.now().toISOString();
      await v.deps.store.put({ ...keys.prefs(v.user.id), userId: v.user.id, theme: { id: theme.id, palette: theme.palette }, at } satisfies PrefsItem);
      return { body: { theme: { id: theme.id, palette: theme.palette } } };
    });
}
