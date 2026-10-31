import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

type Context = IExecuteFunctions | IHookFunctions | ILoadOptionsFunctions;

export const CREDENTIAL = 'solMarrowOAuth2Api';
const DEFAULT_SERVER = 'https://app.solmarrow.com';

export const segment = (id: string) => encodeURIComponent(String(id).trim());

async function apiBase(this: Context): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL);
	return `${String(credentials.server || DEFAULT_SERVER).replace(/\/+$/, '')}/api/v1`;
}

/** The SolMarrow API answers errors as {"error": {"status", "message"}}; this finds them in a failed request. */
export function apiError(error: unknown): { message?: string; status?: number } {
	const seen = new Set<unknown>();
	const walk = (value: unknown, depth: number): { message: string; status: number } | undefined => {
		let v = value;
		if (typeof v === 'string' && v.startsWith('{')) {
			try {
				v = JSON.parse(v);
			} catch {
				return undefined;
			}
		}
		if (!v || typeof v !== 'object' || depth > 6 || seen.has(v)) return undefined;
		seen.add(v);
		const o = v as Record<string, unknown>;
		const e = o.error as Record<string, unknown> | undefined;
		if (e && typeof e === 'object' && typeof e.message === 'string' && typeof e.status === 'number') {
			return { message: e.message, status: e.status };
		}
		for (const key of ['cause', 'response', 'body', 'data', 'error', 'context']) {
			const found = walk(o[key], depth + 1);
			if (found) return found;
		}
		return undefined;
	};
	return walk(error, 0) ?? {};
}

export async function apiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method,
		url: `${await apiBase.call(this)}${path}`,
		headers: { Accept: 'application/json' },
		json: true,
	};
	if (body) options.body = body;
	if (qs) {
		const query = Object.fromEntries(Object.entries(qs).filter(([, v]) => v !== undefined && v !== ''));
		if (Object.keys(query).length) options.qs = query;
	}
	try {
		return ((await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, options)) ?? {}) as IDataObject;
	} catch (error) {
		const { message, status } = apiError(error);
		throw new NodeApiError(
			this.getNode(),
			error as JsonObject,
			message ? { message, httpCode: status ? String(status) : undefined } : {},
		);
	}
}

export async function getWorkspaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const res = await apiRequest.call(this, 'GET', '/workspaces');
	return ((res.workspaces as IDataObject[] | undefined) ?? []).map((w) => ({
		name: String(w.name),
		value: String(w.id),
		description: w.timezone ? `Time zone: ${String(w.timezone)}` : undefined,
	}));
}

export async function getAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const workspaceId = this.getCurrentNodeParameter('workspaceId') as string | undefined;
	if (!workspaceId) return [];
	const res = await apiRequest.call(this, 'GET', `/workspaces/${segment(workspaceId)}/accounts`);
	return ((res.accounts as IDataObject[] | undefined) ?? []).map((a) => ({
		name: `${String(a.network_name)}: ${String(a.name)}${a.handle ? ` (${String(a.handle)})` : ''}`,
		value: String(a.id),
		description: a.status === 'active' ? undefined : String(a.status),
	}));
}

/** The time zone's offset from UTC, in minutes, at a moment. */
function offsetMinutes(utcMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(utcMs));
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	return Math.round((asUtc - utcMs) / 60000);
}

/**
 * n8n's date picker gives a local time without an offset ("2026-11-02T09:30:00"), meant in the workflow's time zone.
 * The API needs an exact moment, so this returns it in UTC. Values that already carry an offset are kept as they are.
 */
export function toUtcIso(value: unknown, timeZone: string): string | null {
	const raw =
		value && typeof value === 'object' && typeof (value as { toISO?: unknown }).toISO === 'function'
			? String((value as { toISO: () => string }).toISO())
			: String(value ?? '').trim();
	if (!raw) return null;
	if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(raw)) {
		const t = Date.parse(raw);
		return Number.isNaN(t) ? null : new Date(t).toISOString();
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(raw);
	if (!m) return null;
	const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
	// Twice, so times next to a daylight-saving change land on the right side of it.
	let utc = wall - offsetMinutes(wall, timeZone) * 60000;
	utc = wall - offsetMinutes(utc, timeZone) * 60000;
	return new Date(utc).toISOString();
}

export function splitIds(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	return String(value ?? '')
		.split(/[\s,]+/)
		.map((v) => v.trim())
		.filter(Boolean);
}
