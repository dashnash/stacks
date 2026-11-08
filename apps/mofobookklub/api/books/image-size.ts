/**
 * Read an image's pixel size from its header bytes (JPEG, PNG, GIF, WebP)
 * without decoding it. Returns null for anything unrecognised.
 */
export function imageDimensions(buf: Uint8Array): { width: number; height: number } | null {
  const u16be = (i: number) => (buf[i]! << 8) | buf[i + 1]!;
  const u16le = (i: number) => buf[i]! | (buf[i + 1]! << 8);
  const u24le = (i: number) => buf[i]! | (buf[i + 1]! << 8) | (buf[i + 2]! << 16);
  const u32be = (i: number) => ((buf[i]! << 24) >>> 0) + (buf[i + 1]! << 16) + (buf[i + 2]! << 8) + buf[i + 3]!;
  const ascii = (i: number, n: number) => String.fromCharCode(...buf.subarray(i, i + n));

  // PNG: width/height are the first fields of the IHDR chunk.
  if (buf.length >= 24 && buf[0] === 0x89 && ascii(1, 3) === 'PNG') {
    return { width: u32be(16), height: u32be(20) };
  }
  // GIF: logical screen size.
  if (buf.length >= 10 && ascii(0, 3) === 'GIF') {
    return { width: u16le(6), height: u16le(8) };
  }
  // WebP: VP8 (lossy), VP8L (lossless) or VP8X (extended).
  if (buf.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.subarray(21, 25);
      return { width: 1 + (((b[1]! & 0x3f) << 8) | b[0]!), height: 1 + (((b[3]! & 0xf) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6)) };
    }
    if (chunk === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) };
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      // Markers with no length field.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: u16be(i + 5), width: u16be(i + 7) };
      }
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}
