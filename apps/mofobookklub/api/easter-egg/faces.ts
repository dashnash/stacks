import { recordAudit } from '@stacks/api';
import type { Deps } from '../utils/deps.js';
import { badRequest, notFound } from '../utils/http.js';
import type { User } from '../utils/model.js';
import type { RequestContext } from '../utils/router.js';
import { detectImage, MAX_PHOTOS_PER_UPLOAD, MAX_UPLOAD_BYTES } from './face-files.js';
import { FACES_PREFIX } from './quotes-file.js';

export { detectImage, MAX_PHOTOS_PER_UPLOAD, MAX_UPLOAD_BYTES };

/** Decodes base64 with what both Node and the browser demo have. */
function fromBase64(data: string): Uint8Array {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** A face's name is its file name under eggs/faces/; names we hand out are `<id>.<ext>`. */
const NAME_RE = /^[\w-]{1,100}\.(jpe?g|png|gif|webp)$/i;
const nameOf = (key: string) => key.slice(FACES_PREFIX.length);

function photosStore(deps: Deps) {
  if (!deps.faces) throw notFound('Face photos are not available here');
  return deps.faces;
}

async function view(deps: Deps, key: string) {
  return { name: nameOf(key), url: await deps.signImageUrl(key) };
}

/** Every shared face photo (admins), with a short-lived link to each. */
export async function listFaces(_req: RequestContext, _user: User, deps: Deps) {
  const keys = (await photosStore(deps).list()).filter((k) => k.startsWith(FACES_PREFIX)).sort();
  return { body: { faces: await Promise.all(keys.map((k) => view(deps, k))) } };
}

/**
 * Add face photos (admins). Body: `{ photos: [{ fileName, data }] }`, `data` base64. Every file must
 * be a JPEG, PNG, GIF or WebP image, checked from its bytes; if any isn't, nothing is stored.
 */
export async function uploadFaces(req: RequestContext, user: User, deps: Deps) {
  const store = photosStore(deps);
  const photos = (req.body as { photos?: unknown }).photos;
  if (!Array.isArray(photos) || photos.length === 0) throw badRequest('Add at least one photo');
  if (photos.length > MAX_PHOTOS_PER_UPLOAD) throw badRequest(`At most ${MAX_PHOTOS_PER_UPLOAD} photos at a time`);

  let total = 0;
  const files = photos.map((p: unknown, i) => {
    const { fileName, data } = (p ?? {}) as { fileName?: unknown; data?: unknown };
    const label = typeof fileName === 'string' && fileName.trim() ? fileName.trim().slice(0, 200) : `Photo ${i + 1}`;
    if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw badRequest(`${label} is empty or unreadable`);
    const bytes = fromBase64(data);
    total += bytes.length;
    if (total > MAX_UPLOAD_BYTES) throw badRequest('Too much at once: upload fewer or smaller photos');
    const type = detectImage(bytes);
    if (!type) throw badRequest(`${label} isn't a photo (JPEG, PNG, GIF or WebP)`);
    return { label, bytes, ...type };
  });

  const added = [];
  for (const f of files) {
    const key = `${FACES_PREFIX}${deps.newId()}.${f.ext}`;
    await store.put(key, f.bytes, f.contentType);
    added.push(await view(deps, key));
  }
  await recordAudit(deps, user, {
    action: 'critic.photos_add',
    label: added.length === 1 ? '1 face photo' : `${added.length} face photos`,
    details: { files: files.map((f) => f.label), names: added.map((a) => a.name) },
  });
  return { status: 201, body: { faces: added } };
}

/** Remove one face photo (admins). */
export async function deleteFace(req: RequestContext, _user: User, deps: Deps) {
  const store = photosStore(deps);
  const name = req.params.name ?? '';
  if (!NAME_RE.test(name)) throw badRequest('Not a face photo');
  const key = FACES_PREFIX + name;
  if (!(await store.list()).includes(key)) throw notFound('That photo is already gone');
  await store.delete(key);
  return { body: { ok: true }, audit: { label: name } };
}
