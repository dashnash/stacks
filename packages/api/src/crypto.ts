/** Web Crypto helpers that run the same in Lambda (Node 22) and in the browser demo. */

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 256 random bits as base64url, with an optional prefix. */
export function randomToken(prefix = ''): string {
  return prefix + base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PKCE S256 code challenge for a verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}
