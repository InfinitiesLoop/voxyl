// Agent tokens. A token is the whole credential for one person's relay: `vx1.<id>.<signature>`.
//
// The Worker mints them statelessly (no database): the id is random, and the signature is an
// HMAC of the id under a secret only the Worker knows. Verifying needs no lookup, so a made-up
// token is refused before any Durable Object is woken. The id names the relay, so it is also
// the userId the plan asks for from day one: signing in later only attaches an identity to it.
// Rotating the secret revokes every token.

declare function btoa(data: string): string;
declare function atob(data: string): string;
declare class TextEncoder {
  encode(input: string): Uint8Array;
}

// Web Crypto exists in browsers, Workers and Node, but this package carries no DOM or Node types.
interface Subtle {
  importKey(
    format: "raw",
    key: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    usages: string[],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: "HMAC",
    key: unknown,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}
interface CryptoLike {
  subtle: Subtle;
  getRandomValues(bytes: Uint8Array): Uint8Array;
}
const webCrypto = (): CryptoLike => (globalThis as unknown as { crypto: CryptoLike }).crypto;

const PREFIX = "vx1";
const ID_BYTES = 16;
const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function key(secret: string): Promise<unknown> {
  return webCrypto().subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** A new token under `secret`. */
export async function mintToken(secret: string): Promise<string> {
  const crypto = webCrypto();
  const id = toBase64Url(crypto.getRandomValues(new Uint8Array(ID_BYTES)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(secret),
    encoder.encode(`${PREFIX}.${id}`),
  );
  return `${PREFIX}.${id}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The id inside a token this secret signed, or null for anything else. */
export async function verifyToken(secret: string, token: string): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, id, signature] = parts as [string, string, string];
  const idBytes = fromBase64Url(id);
  const sigBytes = fromBase64Url(signature);
  if (!idBytes || idBytes.length !== ID_BYTES || !sigBytes) return null;
  const ok = await webCrypto().subtle.verify(
    "HMAC",
    await key(secret),
    sigBytes,
    encoder.encode(`${PREFIX}.${id}`),
  );
  return ok ? id : null;
}

/** Whether a string has the shape of a token (not whether it is genuine). */
export function looksLikeToken(text: string): boolean {
  return /^vx1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(text);
}
