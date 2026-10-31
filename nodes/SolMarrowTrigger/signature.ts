/**
 * Checks the SolMarrow-Signature header of a webhook delivery: "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>".
 * SHA-256 is written out here because n8n community nodes may not import modules (not even Node's crypto).
 */

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
	0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
	0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
	0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function utf8(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		let c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const d = text.charCodeAt(i + 1);
			if (d >= 0xdc00 && d <= 0xdfff) {
				c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
				i++;
			}
		}
		if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
		if (c < 0x80) out.push(c);
		else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
		else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
		else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
	}
	return Uint8Array.from(out);
}

export function sha256(data: Uint8Array): Uint8Array {
	const bitLength = data.length * 8;
	const padded = new Uint8Array((((data.length + 9 + 63) >> 6) << 6));
	padded.set(data);
	padded[data.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
	view.setUint32(padded.length - 4, bitLength >>> 0);

	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const w = new Uint32Array(64);
	const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
		for (let t = 16; t < 64; t++) {
			const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
			const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
			w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, hh] = h;
		for (let t = 0; t < 64; t++) {
			const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
			const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		h[0] += a;
		h[1] += b;
		h[2] += c;
		h[3] += d;
		h[4] += e;
		h[5] += f;
		h[6] += g;
		h[7] += hh;
	}
	const out = new Uint8Array(32);
	const outView = new DataView(out.buffer);
	for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
	return out;
}

export function hmacSha256Hex(key: string, message: string): string {
	let k = utf8(key);
	if (k.length > 64) k = sha256(k);
	const block = new Uint8Array(64);
	block.set(k);
	const inner = new Uint8Array(64);
	const outer = new Uint8Array(64);
	for (let i = 0; i < 64; i++) {
		inner[i] = block[i] ^ 0x36;
		outer[i] = block[i] ^ 0x5c;
	}
	const msg = utf8(message);
	const innerInput = new Uint8Array(64 + msg.length);
	innerInput.set(inner);
	innerInput.set(msg, 64);
	const innerHash = sha256(innerInput);
	const outerInput = new Uint8Array(96);
	outerInput.set(outer);
	outerInput.set(innerHash, 64);
	return Array.from(sha256(outerInput), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameText(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
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
	return (parts.get('v1') ?? []).some((v) => sameText(v.toLowerCase(), expected));
}
