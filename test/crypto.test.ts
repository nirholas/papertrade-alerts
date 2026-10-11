import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256Hex, signWebhook, timingSafeEqual, verifyWebhookSignature } from '../src/lib/crypto.js';

describe('webhook signing', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'alt_1', type: 'position_closed', title: 'Closed' });

  it('matches an independent Node HMAC-SHA256 over "<t>.<body>"', async () => {
    const header = await signWebhook(secret, body, 1791665000);
    const expected = createHmac('sha256', secret).update(`1791665000.${body}`).digest('hex');
    expect(header).toBe(`t=1791665000,v1=${expected}`);
  });

  it('verifies a good signature and rejects a tampered body, wrong secret and bad header', async () => {
    const header = await signWebhook(secret, body, 1791665000);
    expect(await verifyWebhookSignature(secret, body, header, 1791665010)).toBe(true);
    expect(await verifyWebhookSignature(secret, body + ' ', header, 1791665010)).toBe(false);
    expect(await verifyWebhookSignature('whsec_other', body, header, 1791665010)).toBe(false);
    expect(await verifyWebhookSignature(secret, body, null, 1791665010)).toBe(false);
    expect(await verifyWebhookSignature(secret, body, 'garbage', 1791665010)).toBe(false);
  });

  it('rejects a replay outside the tolerance window', async () => {
    const header = await signWebhook(secret, body, 1791665000);
    expect(await verifyWebhookSignature(secret, body, header, 1791665000 + 301)).toBe(false);
    expect(await verifyWebhookSignature(secret, body, header, 1791665000 - 301)).toBe(false);
  });

  it('hashes and compares in constant-time-safe ways', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hmacSha256Hex('k', 'm')).toBe(createHmac('sha256', 'k').update('m').digest('hex'));
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
