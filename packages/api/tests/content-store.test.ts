import { describe, expect, it, vi } from 'vitest';
import { contentStore } from '../src/lambda';

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };

function fakeS3(keys: string[]) {
  const objects = new Set(keys);
  const send = vi.fn(async (cmd: Cmd) => {
    const { input } = cmd;
    switch (cmd.constructor.name) {
      case 'ListObjectsV2Command':
        return { Contents: [...objects].filter((k) => k.startsWith(String(input.Prefix))).map((Key) => ({ Key })) };
      case 'PutObjectCommand':
        objects.add(String(input.Key));
        return {};
      case 'DeleteObjectCommand':
        objects.delete(String(input.Key));
        return {};
      default:
        throw new Error(`unexpected ${cmd.constructor.name}`);
    }
  });
  return { send, objects };
}

describe('contentStore', () => {
  it('lists keys under a prefix, skipping folder markers, and caches the listing', async () => {
    const s3 = fakeS3(['eggs/faces/', 'eggs/faces/a.jpg', 'eggs/b.jpg']);
    const content = contentStore({ bucket: 'b', client: s3 as never, now: () => 0 });
    expect(await content.list('eggs/faces/')).toEqual(['eggs/faces/a.jpg']);
    await content.list('eggs/faces/');
    expect(s3.send).toHaveBeenCalledTimes(1);
  });

  it('puts and deletes objects in the bucket, and clears the cached listings', async () => {
    const s3 = fakeS3(['eggs/faces/a.jpg']);
    const content = contentStore({ bucket: 'b', client: s3 as never, now: () => 0 });
    expect(await content.list('eggs/faces/')).toEqual(['eggs/faces/a.jpg']);

    const body = new Uint8Array([0xff, 0xd8, 0xff]);
    await content.put('eggs/faces/new.jpg', body, 'image/jpeg');
    const put = s3.send.mock.calls[1]![0];
    expect(put.input).toEqual({ Bucket: 'b', Key: 'eggs/faces/new.jpg', Body: body, ContentType: 'image/jpeg' });
    expect(await content.list('eggs/faces/')).toEqual(['eggs/faces/a.jpg', 'eggs/faces/new.jpg']);

    await content.delete('eggs/faces/a.jpg');
    expect(s3.send.mock.calls[3]![0].input).toEqual({ Bucket: 'b', Key: 'eggs/faces/a.jpg' });
    expect(await content.list('eggs/faces/')).toEqual(['eggs/faces/new.jpg']);
  });
});
