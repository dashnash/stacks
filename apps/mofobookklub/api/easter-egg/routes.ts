import type { Deps } from '../utils/deps.js';
import { notFound } from '../utils/http.js';
import { keys, strip, type EasterEgg, type EasterEggItem, type User } from '../utils/model.js';
import type { RequestContext } from '../utils/router.js';

/** Every quote: the ones bundled with the deploy, overridden by any in the table with the same id. */
export async function allEasterEggs(deps: Deps): Promise<EasterEgg[]> {
  const stored = (await deps.store.query<EasterEggItem>(keys.easterEggPartition, 'EGG#')).map(
    (i) => strip(i) as EasterEgg,
  );
  const byId = new Map<string, EasterEgg>();
  for (const egg of deps.bundledEasterEggs ?? []) byId.set(egg.id, egg);
  for (const egg of stored) byId.set(egg.id, egg);
  return [...byId.values()];
}

/**
 * A random parody quote. The photo lives in the private assets bucket, so the
 * client gets a short-lived presigned `imageUrl` rather than the S3 key.
 */
export async function randomEasterEgg(req: RequestContext, _user: User, deps: Deps) {
  const eggs = await allEasterEggs(deps);
  if (eggs.length === 0) throw notFound('No easter eggs have been seeded yet');

  // Avoid showing the same quote twice in a row when shuffling.
  const pool = eggs.length > 1 && req.query.exclude ? eggs.filter((e) => e.id !== req.query.exclude) : eggs;
  const egg = pool[Math.floor(deps.random() * pool.length)]!;

  // A quote's own photo wins; otherwise any of the shared faces.
  let imageKey = egg.imageKey;
  if (!imageKey && deps.listFacePhotos) {
    const faces = await deps.listFacePhotos();
    if (faces.length > 0) imageKey = faces[Math.floor(deps.random() * faces.length)];
  }

  return {
    body: {
      id: egg.id,
      quote: egg.quote,
      characterName: egg.characterName,
      imageUrl: imageKey ? await deps.signImageUrl(imageKey) : null,
    },
  };
}
