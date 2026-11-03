import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks the SolMarrow-Signature header of a webhook delivery: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>".
 */

export function hmacSha256Hex(key: string, message: string): string {
	return createHmac('sha256', key).update(message).digest('hex');
}

function sameHex(a: string, b: string): boolean {
	const x = Buffer.from(a, 'utf8');
	const y = Buffer.from(b, 'utf8');
	return x.length === y.length && timingSafeEqual(x, y);
}

/** True when the header is signed with the secret and is at most `toleranceS` old (default 5 minutes). */
export function verifySignature(secret: string, body: string, header: string, nowMs: number, toleranceS = 300): boolean {
	const parts = new Map<string, string[]>();
	for (const piece of header.split(',')) {
		const at = piece.indexOf('=');
		if (at < 1) continue;
		const key = piece.slice(0, at).trim();
		parts.set(key, [...(parts.get(key) ?? []), piece.slice(at + 1).trim()]);
	}
	const t = parts.get('t')?.[0];
	if (!t || !/^\d{1,12}$/.test(t)) return false;
	if (Math.abs(nowMs / 1000 - Number(t)) > toleranceS) return false;
	const expected = hmacSha256Hex(secret, `${t}.${body}`);
	return (parts.get('v1') ?? []).some((v) => sameHex(v.toLowerCase(), expected));
}
