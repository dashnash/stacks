import { describe, expect, it } from 'vitest';
import { detectImage, MAX_PHOTOS_PER_UPLOAD, MAX_UPLOAD_BYTES } from '../../../api/easter-egg/faces.js';
import { makeTestApp } from '../helpers';

const ADMIN = 'admin@club.test';
const OWNER = 'owner@club.test';
const ALICE = 'alice@club.test';

// The first bytes of each format, padded: enough for the type check.
const pad = (head: number[]) => new Uint8Array([...head, ...new Array(16).fill(0)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP = new Uint8Array([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8 '].map((c) => c.charCodeAt(0))));
const TEXT = new TextEncoder().encode('just some notes, not a photo');
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

async function setup(faces: string[] = []) {
  let n = 0;
  const t = makeTestApp({ faces });
  t.deps.newId = () => `id-${++n}`;
  await t.seedUser(OWNER, 'OWNER', 'Owner');
  await t.seedUser(ADMIN, 'ADMIN', 'Admin');
  await t.seedUser(ALICE, 'MEMBER', 'Alice');
  return t;
}

describe('detectImage', () => {
  it('recognizes JPEG, PNG and WebP from their bytes, and nothing else', () => {
    expect(detectImage(JPEG)).toEqual({ ext: 'jpg', contentType: 'image/jpeg' });
    expect(detectImage(PNG)).toEqual({ ext: 'png', contentType: 'image/png' });
    expect(detectImage(WEBP)).toEqual({ ext: 'webp', contentType: 'image/webp' });
    expect(detectImage(TEXT)).toBeNull();
    expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('face photos on the admin page', () => {
  it('lists the photos with short-lived links, for admins and owners only', async () => {
    const t = await setup(['eggs/faces/b.jpg', 'eggs/faces/a.png']);
    const res = await t.call('GET', '/admin/faces', { as: ADMIN });
    expect(res.body.faces).toEqual([
      { name: 'a.png', url: 'https://signed.example/eggs/faces/a.png' },
      { name: 'b.jpg', url: 'https://signed.example/eggs/faces/b.jpg' },
    ]);
    expect((await t.call('GET', '/admin/faces', { as: OWNER })).status).toBe(200);
    expect((await t.call('GET', '/admin/faces', { as: ALICE })).status).toBe(403);
    expect((await t.call('POST', '/admin/faces', { as: ALICE, body: { photos: [{ fileName: 'x.jpg', data: b64(JPEG) }] } })).status).toBe(403);
    expect((await t.call('DELETE', '/admin/faces/a.png', { as: ALICE })).status).toBe(403);
  });

  it('stores uploaded photos under eggs/faces/ with their real type, and logs the batch once', async () => {
    const t = await setup();
    const res = await t.call('POST', '/admin/faces', {
      as: ADMIN,
      body: { photos: [{ fileName: 'Jo.JPG', data: b64(JPEG) }, { fileName: 'Sam.png', data: b64(PNG) }] },
    });
    expect(res.status).toBe(201);
    expect(res.body.faces).toEqual([
      { name: 'id-1.jpg', url: 'https://signed.example/eggs/faces/id-1.jpg' },
      { name: 'id-2.png', url: 'https://signed.example/eggs/faces/id-2.png' },
    ]);
    expect(t.faces!.files.get('eggs/faces/id-2.png')).toEqual({ body: PNG, contentType: 'image/png' });

    const log = await t.call('GET', '/admin/audit', { as: ADMIN, query: { action: 'critic' } });
    expect(log.body.events).toHaveLength(1);
    expect(log.body.events[0]).toMatchObject({ action: 'critic.photos_add', label: '2 face photos', details: { files: ['Jo.JPG', 'Sam.png'] } });
  });

  it('uses uploaded photos on the quotes', async () => {
    const t = makeTestApp({ faces: [], bundledEasterEggs: [{ id: 'q', quote: 'A quote.' }] });
    await t.seedUser(ADMIN, 'ADMIN');
    expect((await t.call('GET', '/easter-egg/random', { as: ADMIN })).body.imageUrl).toBeNull();
    await t.call('POST', '/admin/faces', { as: ADMIN, body: { photos: [{ fileName: 'a.jpg', data: b64(JPEG) }] } });
    expect((await t.call('GET', '/easter-egg/random', { as: ADMIN })).body.imageUrl).toMatch(/^https:\/\/signed\.example\/eggs\/faces\/.+\.jpg$/);
  });

  it('stores nothing when any file is not a photo, and says which', async () => {
    const t = await setup();
    const res = await t.call('POST', '/admin/faces', {
      as: ADMIN,
      body: { photos: [{ fileName: 'ok.jpg', data: b64(JPEG) }, { fileName: 'notes.jpg', data: b64(TEXT) }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("notes.jpg isn't a photo (JPEG, PNG, GIF or WebP)");
    expect(t.faces!.files.size).toBe(0);
  });

  it('rejects empty, unreadable and oversized uploads', async () => {
    const t = await setup();
    const post = (body: unknown) => t.call('POST', '/admin/faces', { as: ADMIN, body });
    expect((await post({})).status).toBe(400);
    expect((await post({ photos: [] })).status).toBe(400);
    expect((await post({ photos: [{ fileName: 'x.jpg', data: '%%%' }] })).body.error).toBe('x.jpg is empty or unreadable');
    const many = Array.from({ length: MAX_PHOTOS_PER_UPLOAD + 1 }, (_, i) => ({ fileName: `${i}.jpg`, data: b64(JPEG) }));
    expect((await post({ photos: many })).status).toBe(400);
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(JPEG);
    let s = '';
    for (let i = 0; i < big.length; i += 0x8000) s += String.fromCharCode(...big.subarray(i, i + 0x8000));
    expect((await post({ photos: [{ fileName: 'huge.jpg', data: btoa(s) }] })).body.error).toMatch(/Too much at once/);
    expect(t.faces!.files.size).toBe(0);
  });

  it('deletes a photo, logs it, and only touches eggs/faces/', async () => {
    const t = await setup(['eggs/faces/a.jpg']);
    expect((await t.call('DELETE', '/admin/faces/a.jpg', { as: ADMIN })).status).toBe(200);
    expect(t.faces!.files.size).toBe(0);
    expect((await t.call('DELETE', '/admin/faces/a.jpg', { as: ADMIN })).status).toBe(404);
    expect((await t.call('DELETE', `/admin/faces/${encodeURIComponent('../quotes.json')}`, { as: ADMIN })).status).toBe(400);
    const log = await t.call('GET', '/admin/audit', { as: ADMIN, query: { action: 'critic' } });
    expect(log.body.events[0]).toMatchObject({ action: 'critic.photo_delete', label: 'a.jpg' });
  });
});
