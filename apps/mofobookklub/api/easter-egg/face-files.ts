// Rules for face photo files, shared by the API and the browser (so: no imports).

/**
 * One upload request: at most this many photos and bytes. Stacks caps request bodies at 256 KB and
 * base64 adds a third, so the browser shrinks photos first and sends them in batches under this.
 */
export const MAX_PHOTOS_PER_UPLOAD = 20;
export const MAX_UPLOAD_BYTES = 180_000;

/** Image types accepted, told apart by their first bytes. */
const TYPES = [
  { ext: 'jpg', contentType: 'image/jpeg', test: (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', contentType: 'image/png', test: (b: Uint8Array) => ascii(b, 1, 3) === 'PNG' && b[0] === 0x89 },
  { ext: 'gif', contentType: 'image/gif', test: (b: Uint8Array) => ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a' },
  { ext: 'webp', contentType: 'image/webp', test: (b: Uint8Array) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' },
];

function ascii(b: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...b.subarray(start, start + length));
}

/** The image type of a file from its first bytes (JPEG, PNG, GIF or WebP), or null if it isn't one. */
export function detectImage(bytes: Uint8Array): { ext: string; contentType: string } | null {
  const type = TYPES.find((t) => bytes.length >= 12 && t.test(bytes));
  return type ? { ext: type.ext, contentType: type.contentType } : null;
}
