import { unzipSync } from 'fflate';
import { detectImage, MAX_PHOTOS_PER_UPLOAD, MAX_UPLOAD_BYTES } from '../../../api/easter-egg/face-files';

/** A photo found in a zip, ready to upload. */
export interface FacePhoto {
  fileName: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface ZipContents {
  photos: FacePhoto[];
  /** Files in the zip that aren't photos we can use, with why. */
  skipped: { fileName: string; reason: string }[];
}

/** More than this in one zip is almost certainly the wrong zip. */
export const MAX_PHOTOS_PER_ZIP = 300;

const HEIC = (b: Uint8Array) => b.length >= 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1|avif)$/.test(String.fromCharCode(...b.subarray(8, 12)));

/**
 * The photos in a zip of faces. Folders, macOS metadata (`__MACOSX/`, `._*`) and hidden files are
 * ignored; anything else that isn't a JPEG, PNG, GIF or WebP image (checked from its bytes, not
 * its name) is listed as skipped. Throws when the file isn't a zip or holds no photos.
 */
export function readFacesZip(zip: Uint8Array): ZipContents {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error("That file isn't a zip we can open.");
  }
  const photos: FacePhoto[] = [];
  const skipped: ZipContents['skipped'] = [];
  for (const [path, bytes] of Object.entries(files)) {
    const fileName = path.split('/').pop() ?? path;
    if (path.endsWith('/') || path.startsWith('__MACOSX/') || fileName.startsWith('.') || !fileName) continue;
    const type = detectImage(bytes);
    if (type) photos.push({ fileName, bytes, contentType: type.contentType });
    else skipped.push({ fileName, reason: HEIC(bytes) ? 'HEIC/AVIF photo: export it as JPEG first' : 'not a photo' });
  }
  if (photos.length === 0) {
    throw new Error(skipped.length ? `No photos in that zip (found ${describeSkipped(skipped)}).` : 'That zip is empty.');
  }
  if (photos.length > MAX_PHOTOS_PER_ZIP) throw new Error(`That zip has ${photos.length} photos; add at most ${MAX_PHOTOS_PER_ZIP} at a time.`);
  photos.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
  return { photos, skipped };
}

export function describeSkipped(skipped: ZipContents['skipped']): string {
  const names = skipped.slice(0, 3).map((s) => s.fileName);
  return skipped.length > 3 ? `${names.join(', ')} and ${skipped.length - 3} more` : names.join(', ');
}

/** The longest side of a stored face: the quote band shows them at most 224 px wide. */
export const FACE_SIZE = 640;

/**
 * A smaller JPEG copy of a photo (longest side {@link FACE_SIZE}), which also drops its metadata
 * (camera, location). Falls back to the original where the browser can't redraw it, as long as it
 * still fits in an upload.
 */
export async function shrinkPhoto(photo: FacePhoto): Promise<FacePhoto> {
  try {
    const bitmap = await createImageBitmap(new Blob([photo.bytes as BlobPart], { type: photo.contentType }));
    const scale = Math.min(1, FACE_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff'; // transparent PNGs on white, not black
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    for (const quality of [0.85, 0.7, 0.5]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob) break;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (bytes.length <= MAX_UPLOAD_BYTES) return { fileName: photo.fileName, bytes, contentType: 'image/jpeg' };
    }
  } catch {
    // Not decodable here (or no canvas, as in tests): send it as it is if it fits.
  }
  if (photo.bytes.length <= MAX_UPLOAD_BYTES) return photo;
  throw new Error(`${photo.fileName} is too big to upload and couldn't be shrunk here.`);
}

/** Photos grouped into upload requests that fit the API's limits, in order. */
export function batches(photos: FacePhoto[]): FacePhoto[][] {
  const out: FacePhoto[][] = [];
  let current: FacePhoto[] = [];
  let size = 0;
  for (const p of photos) {
    if (current.length && (size + p.bytes.length > MAX_UPLOAD_BYTES || current.length >= MAX_PHOTOS_PER_UPLOAD)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += p.bytes.length;
  }
  if (current.length) out.push(current);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
