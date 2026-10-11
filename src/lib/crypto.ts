const encoder = new TextEncoder();

const toHex = (buf: ArrayBuffer | Uint8Array): string =>
  [...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

export function randomBase64Url(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison (length is not secret here, contents are). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export const newId = (prefix: string) => `${prefix}_${randomHex(8)}`;

/** Management token: shown once, only its SHA-256 is stored. */
export const newManagementToken = () => `ptal_${randomBase64Url(32)}`;

export const WEBHOOK_SIGNATURE_HEADER = 'x-papertrade-alerts-signature';
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Webhook signature: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * The timestamp is inside the signed payload so a captured request cannot be replayed outside the tolerance window.
 */
export async function signWebhook(secret: string, body: string, nowSeconds: number): Promise<string> {
  return `t=${nowSeconds},v1=${await hmacSha256Hex(secret, `${nowSeconds}.${body}`)}`;
}

export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null,
  nowSeconds: number,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  return timingSafeEqual(parts.v1, await hmacSha256Hex(secret, `${t}.${body}`));
}
