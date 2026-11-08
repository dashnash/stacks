import { describe, expect, it } from 'vitest';
import { imageDimensions } from '../../../api/books/image-size.js';

/** A minimal JPEG: SOI, a JFIF APP0 segment, then an SOF0 frame header with the size. */
function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sofSeg = [0xff, sof, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sofSeg, 0xff, 0xd9]);
}

describe('imageDimensions', () => {
  it('reads JPEG frame headers (baseline and progressive)', () => {
    expect(imageDimensions(jpeg(110, 110))).toEqual({ width: 110, height: 110 });
    expect(imageDimensions(jpeg(464, 300, 0xc2))).toEqual({ width: 464, height: 300 });
  });

  it('reads PNG and GIF headers', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x03, 0x20, 0, 0, 0x04, 0xb0]);
    expect(imageDimensions(png)).toEqual({ width: 800, height: 1200 });

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0xb0, 0x04]);
    expect(imageDimensions(gif)).toEqual({ width: 800, height: 1200 });
  });

  it('returns null for anything else', () => {
    expect(imageDimensions(new TextEncoder().encode('<html>not an image</html>'))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});
