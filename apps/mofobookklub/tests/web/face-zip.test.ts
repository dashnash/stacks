import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../../api/easter-egg/face-files';
import { batches, readFacesZip, shrinkPhoto, toBase64, type FacePhoto } from '../../web/src/lib/face-zip';

const pad = (head: number[], size = 20) => new Uint8Array([...head, ...new Array(size - head.length).fill(7)]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIC = new Uint8Array([0, 0, 0, 24, ...[...'ftypheic'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);
// Not TextEncoder: under jsdom its bytes fail fflate's instanceof check and zip as folders.
const text = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe('readFacesZip', () => {
  it('finds the photos by their bytes, in name order, ignoring folders and macOS clutter', () => {
    const zip = zipSync({
      'faces/10.jpg': JPEG,
      'faces/2.png': PNG,
      'faces/renamed.txt': JPEG,
      'faces/notes.txt': text('hello'),
      'faces/IMG_1.HEIC': HEIC,
      '__MACOSX/faces/._2.png': text('junk'),
      'faces/.DS_Store': text('junk'),
    });
    const { photos, skipped } = readFacesZip(zip);
    expect(photos.map((p) => [p.fileName, p.contentType])).toEqual([
      ['2.png', 'image/png'],
      ['10.jpg', 'image/jpeg'],
      ['renamed.txt', 'image/jpeg'],
    ]);
    expect(skipped).toEqual([
      { fileName: 'notes.txt', reason: 'not a photo' },
      { fileName: 'IMG_1.HEIC', reason: 'HEIC/AVIF photo: export it as JPEG first' },
    ]);
  });

  it('says so when the file is not a zip, is empty, or has no photos', () => {
    expect(() => readFacesZip(text('not a zip at all'))).toThrow("That file isn't a zip we can open.");
    expect(() => readFacesZip(zipSync({}))).toThrow('That zip is empty.');
    expect(() => readFacesZip(zipSync({ 'a.txt': text('a'), 'b.pdf': text('b') }))).toThrow('No photos in that zip (found a.txt, b.pdf).');
  });
});

describe('uploading', () => {
  const photo = (name: string, size: number): FacePhoto => ({ fileName: name, bytes: pad([0xff, 0xd8, 0xff], size), contentType: 'image/jpeg' });

  it('groups photos into requests under the size limit', () => {
    const half = Math.floor(MAX_UPLOAD_BYTES / 2);
    const groups = batches([photo('a', half), photo('b', half), photo('c', half), photo('d', 100)]);
    expect(groups.map((g) => g.map((p) => p.fileName))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps a photo as it is where the browser cannot redraw it, if it fits', async () => {
    const small = photo('small.jpg', 1000);
    expect(await shrinkPhoto(small)).toBe(small);
    await expect(shrinkPhoto(photo('huge.jpg', MAX_UPLOAD_BYTES + 1))).rejects.toThrow("huge.jpg is too big to upload and couldn't be shrunk here.");
  });

  it('base64-encodes large files', () => {
    const bytes = pad([1, 2, 3], 100_000);
    expect(atob(toBase64(bytes)).length).toBe(100_000);
  });
});
