// Runs against the built files: npm run build && node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hmacSha256Hex, verifySignature } = require('../dist/nodes/SolMarrowTrigger/signature.js');
const { toUtcIso, apiError, splitIds } = require('../dist/nodes/SolMarrow/GenericFunctions.js');
const { SolMarrow } = require('../dist/nodes/SolMarrow/SolMarrow.node.js');
const { SolMarrowTrigger } = require('../dist/nodes/SolMarrowTrigger/SolMarrowTrigger.node.js');
const { SolMarrowOAuth2Api } = require('../dist/credentials/SolMarrowOAuth2Api.credentials.js');
const { NodeApiError } = require('n8n-workflow');

const WS = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const POST = '33333333-3333-4333-8333-333333333333';

// --- signature -------------------------------------------------------------------------------------------------------
test('HMAC-SHA256 matches Node crypto for many lengths and characters', () => {
	for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 5000]) {
		const key = randomBytes(1 + (len % 90)).toString('base64url');
		const msg = 'é🙂中'.repeat(len % 7) + randomBytes(len).toString('hex').slice(0, len);
		assert.equal(hmacSha256Hex(key, msg), createHmac('sha256', key).update(msg).digest('hex'), `len ${len}`);
	}
	const long = 'k'.repeat(200);
	assert.equal(hmacSha256Hex(long, 'x'), createHmac('sha256', long).update('x').digest('hex'));
});

test('verifySignature accepts the worker format and rejects tampering, old times and wrong secrets', () => {
	const secret = 'whsec_' + randomBytes(24).toString('base64url');
	const body = JSON.stringify({ id: '9', event: 'post.published', post: { text: 'Héllo 🙂' } });
	const t = Math.floor(Date.now() / 1000);
	const header = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
	assert.equal(verifySignature(secret, body, header, Date.now()), true);
	assert.equal(verifySignature(secret, body + ' ', header, Date.now()), false);
	assert.equal(verifySignature('whsec_other', body, header, Date.now()), false);
	assert.equal(verifySignature(secret, body, header, Date.now() + 301_000), false);
	assert.equal(verifySignature(secret, body, `v1=${header.split('v1=')[1]}`, Date.now()), false);
	assert.equal(verifySignature(secret, body, '', Date.now()), false);
	// A second v1 (secret rotation) still matches.
	assert.equal(verifySignature(secret, body, `t=${t},v1=deadbeef,${header.split(',')[1]}`, Date.now()), true);
});

// --- helpers ---------------------------------------------------------------------------------------------------------
test('toUtcIso reads n8n date picker values in the workflow time zone', () => {
	assert.equal(toUtcIso('2026-11-02T09:30:00', 'America/New_York'), '2026-11-02T14:30:00.000Z'); // EST
	assert.equal(toUtcIso('2026-07-02T09:30:00', 'America/New_York'), '2026-07-02T13:30:00.000Z'); // EDT
	assert.equal(toUtcIso('2026-11-02T09:30:00', 'Asia/Dhaka'), '2026-11-02T03:30:00.000Z');
	assert.equal(toUtcIso('2026-11-02 09:30', 'UTC'), '2026-11-02T09:30:00.000Z');
	assert.equal(toUtcIso('2026-11-02T09:30:00+02:00', 'Asia/Dhaka'), '2026-11-02T07:30:00.000Z');
	assert.equal(toUtcIso('2026-11-02T09:30:00Z', 'Asia/Dhaka'), '2026-11-02T09:30:00.000Z');
	assert.equal(toUtcIso({ toISO: () => '2026-11-02T09:30:00.000-05:00' }, 'UTC'), '2026-11-02T14:30:00.000Z');
	// Just after the US clocks go back (1 Nov 2026, 2:00 → 1:00): 03:00 local is EST.
	assert.equal(toUtcIso('2026-11-01T03:00:00', 'America/New_York'), '2026-11-01T08:00:00.000Z');
	assert.equal(toUtcIso('next tuesday', 'UTC'), null);
	assert.equal(toUtcIso('', 'UTC'), null);
});

test('apiError finds the API message wherever n8n puts the response', () => {
	const body = { error: { status: 422, message: 'schedule_at must be at least 5 minutes from now' } };
	assert.deepEqual(apiError({ response: { data: body } }), body.error);
	assert.deepEqual(apiError({ cause: { response: { body: JSON.stringify(body) } } }), body.error);
	assert.deepEqual(apiError({ message: 'socket hang up' }), {});
	assert.deepEqual(splitIds(' a, b\nc ,,'), ['a', 'b', 'c']);
});

test('credential points at SolMarrow and can be overridden for another server', () => {
	const c = new SolMarrowOAuth2Api();
	const p = Object.fromEntries(c.properties.map((x) => [x.name, x.default]));
	assert.equal(p.server, 'https://app.solmarrow.com');
	assert.equal(p.scope, 'solmarrow');
	assert.equal(p.grantType, 'authorizationCode');
	assert.match(p.authUrl, /\/oauth\/authorize$/);
	assert.match(p.accessTokenUrl, /\/oauth\/token$/);
	assert.equal(c.extends[0], 'oAuth2Api');
});

// --- a fake n8n -----------------------------------------------------------------------------------------------------
function fakeApi(routes) {
	const calls = [];
	const httpRequestWithAuthentication = async (credential, options) => {
		assert.equal(credential, 'solMarrowOAuth2Api');
		calls.push({ ...options, auth: true });
		const key = `${options.method} ${options.url.replace('https://app.solmarrow.com/api/v1', '')}`;
		const handler = routes[key];
		if (!handler) throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { error: { status: 404, message: `No route ${key}` } } } });
		const out = handler(options);
		if (out && out.__status) throw Object.assign(new Error(`Request failed with status code ${out.__status}`), { response: { status: out.__status, data: out.body } });
		return out;
	};
	return { calls, httpRequestWithAuthentication };
}

function execContext({ params, api, items = [{ json: {} }], binary, continueOnFail = false, timeZone = 'Asia/Dhaka' }) {
	const node = { name: 'SolMarrow', type: 'n8n-nodes-solmarrow.solMarrow', typeVersion: 1, parameters: params };
	return {
		getInputData: () => items,
		getNodeParameter: (name, i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => node,
		getTimezone: () => timeZone,
		getCredentials: async () => ({ server: 'https://app.solmarrow.com/' }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: api.httpRequestWithAuthentication,
			httpRequest: async (options) => {
				api.calls.push({ ...options, auth: false });
				return '';
			},
			returnJsonArray: (d) => (Array.isArray(d) ? d : [d]).map((json) => ({ json })),
			constructExecutionMetaData: (items, meta) => items.map((it) => ({ ...it, pairedItem: meta.itemData })),
			assertBinaryData: () => binary.meta,
			getBinaryDataBuffer: async () => binary.bytes,
		},
	};
}

const run = (ctx) => new SolMarrow().execute.call(ctx);

test('Post → Create schedules with the workflow time zone and per-account text and settings', async () => {
	const api = fakeApi({ [`POST /workspaces/${WS}/posts`]: (o) => ({ post_id: POST, status: 'scheduled', echo: o.body }) });
	const [out] = await run(
		execContext({
			api,
			params: {
				resource: 'post',
				operation: 'create',
				workspaceId: WS,
				text: 'Hello',
				when: 'schedule',
				scheduleAt: '2026-11-03T10:00:00',
				accountIds: [ACC],
				additionalFields: {
					mediaIds: 'm1, m2',
					perAccountText: { values: [{ accountId: ACC, text: 'Hi LinkedIn' }] },
					perAccountOptions: `{"${ACC}": {"title": "T"}}`,
				},
			},
		}),
	);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].json.echo, {
		text: 'Hello',
		account_ids: [ACC],
		media_ids: ['m1', 'm2'],
		schedule_at: '2026-11-03T04:00:00.000Z',
		per_account_text: { [ACC]: 'Hi LinkedIn' },
		per_account_options: { [ACC]: { title: 'T' } },
	});
	assert.equal(api.calls[0].url, `https://app.solmarrow.com/api/v1/workspaces/${WS}/posts`);
	assert.equal(out[0].pairedItem.item, 0);
});

test('Post → Create sends draft or publish_now, never both', async () => {
	for (const [when, flag] of [['draft', 'draft'], ['now', 'publish_now']]) {
		const api = fakeApi({ [`POST /workspaces/${WS}/posts`]: (o) => o.body });
		const [out] = await run(execContext({ api, params: { resource: 'post', operation: 'create', workspaceId: WS, text: 'x', when, accountIds: [ACC], additionalFields: {} } }));
		assert.equal(out[0].json[flag], true);
		assert.equal('schedule_at' in out[0].json, false);
		assert.equal(Object.keys(out[0].json).filter((k) => ['draft', 'publish_now'].includes(k)).length, 1);
	}
});

test("API errors show SolMarrow's own message, and Continue On Fail keeps going", async () => {
	const api = fakeApi({ [`POST /workspaces/${WS}/posts`]: () => ({ __status: 422, body: { error: { status: 422, message: 'Choose at least one account (account_ids), or save a draft.' } } }) });
	const params = { resource: 'post', operation: 'create', workspaceId: WS, text: 'x', when: 'now', accountIds: [], additionalFields: {} };
	await assert.rejects(run(execContext({ api, params })), (e) => e instanceof NodeApiError && /Choose at least one account/.test(e.message) && e.httpCode === '422');
	const [out] = await run(execContext({ api, params, continueOnFail: true, items: [{ json: {} }, { json: {} }] }));
	assert.equal(out.length, 2);
	assert.match(out[1].json.error, /Choose at least one account/);
});

test('bad Network Settings JSON stops before calling the API', async () => {
	const api = fakeApi({});
	await assert.rejects(
		run(execContext({ api, params: { resource: 'post', operation: 'create', workspaceId: WS, text: 'x', when: 'draft', accountIds: [], additionalFields: { perAccountOptions: '{nope' } } })),
		/valid JSON/,
	);
	assert.equal(api.calls.length, 0);
});

test('Get Many operations return one item per record, with filters as query values', async () => {
	const api = fakeApi({
		[`GET /workspaces/${WS}/posts`]: (o) => ({ posts: [{ id: 'a', q: o.qs }, { id: 'b' }] }),
		[`GET /workspaces/${WS}/accounts`]: () => ({ accounts: [{ id: ACC }] }),
		[`GET /workspaces/${WS}/media`]: (o) => ({ media: [{ id: 'm', limit: o.qs.limit }] }),
		['GET /workspaces']: () => ({ workspaces: [{ id: WS }] }),
	});
	let [out] = await run(execContext({ api, params: { resource: 'post', operation: 'getAll', workspaceId: WS, limit: 5, filters: { status: 'failed', from: '2026-11-01T00:00:00' } } }));
	assert.deepEqual(out.map((o) => o.json.id), ['a', 'b']);
	assert.deepEqual(out[0].json.q, { limit: 5, status: 'failed', from: '2026-10-31T18:00:00.000Z' });
	[out] = await run(execContext({ api, params: { resource: 'account', operation: 'getAll', workspaceId: WS } }));
	assert.equal(out[0].json.id, ACC);
	[out] = await run(execContext({ api, params: { resource: 'media', operation: 'getAll', workspaceId: WS, limit: 7 } }));
	assert.equal(out[0].json.limit, 7);
	[out] = await run(execContext({ api, params: { resource: 'workspace', operation: 'getAll' } }));
	assert.equal(out[0].json.id, WS);
});

test('Post → Get and Delete use the post id; Analytics passes its filters', async () => {
	const api = fakeApi({
		[`GET /posts/${POST}`]: () => ({ id: POST }),
		[`DELETE /posts/${POST}`]: () => ({ deleted: true }),
		[`GET /workspaces/${WS}/analytics`]: (o) => ({ totals: {}, q: o.qs }),
	});
	let [out] = await run(execContext({ api, params: { resource: 'post', operation: 'get', postId: ` ${POST} ` } }));
	assert.equal(out[0].json.id, POST);
	[out] = await run(execContext({ api, params: { resource: 'post', operation: 'delete', postId: POST } }));
	assert.equal(out[0].json.deleted, true);
	[out] = await run(execContext({ api, params: { resource: 'analytics', operation: 'get', workspaceId: WS, filters: { postId: POST } } }));
	assert.deepEqual(out[0].json.q, { post_id: POST });
});

test('Media → Upload a binary file: start, PUT to the signed link without sign-in, finish', async () => {
	const bytes = Buffer.from('fake-jpeg-bytes');
	const api = fakeApi({
		[`POST /workspaces/${WS}/media/uploads`]: (o) => ({ upload_id: `${WS}/abc.jpg`, upload_url: 'https://storage.solmarrow.com/put?sig=1', headers: { 'Content-Type': o.body.mime_type, 'Content-Length': String(o.body.size) }, start: o.body }),
		[`POST /workspaces/${WS}/media/uploads/complete`]: (o) => ({ media_id: 'm1', finish: o.body }),
	});
	const [out] = await run(
		execContext({
			api,
			binary: { meta: { mimeType: 'image/jpg', fileName: 'photo.jpg', fileExtension: 'jpg' }, bytes },
			params: { resource: 'media', operation: 'upload', workspaceId: WS, source: 'binary', binaryPropertyName: 'data', uploadOptions: {} },
		}),
	);
	assert.deepEqual(api.calls.map((c) => `${c.method} ${c.auth}`), ['POST true', 'PUT false', 'POST true']);
	assert.deepEqual(api.calls[0].body, { file_name: 'photo.jpg', mime_type: 'image/jpeg', size: bytes.length });
	assert.equal(api.calls[1].url, 'https://storage.solmarrow.com/put?sig=1');
	assert.equal(api.calls[1].body, bytes);
	assert.equal(api.calls[1].headers['Content-Type'], 'image/jpeg');
	assert.deepEqual(out[0].json.finish, { upload_id: `${WS}/abc.jpg`, file_name: 'photo.jpg', mime_type: 'image/jpeg' });
});

test('Media → Upload from a URL', async () => {
	const api = fakeApi({ [`POST /workspaces/${WS}/media/from-url`]: (o) => ({ media_id: 'm2', body: o.body }) });
	const [out] = await run(execContext({ api, params: { resource: 'media', operation: 'upload', workspaceId: WS, source: 'url', url: ' https://example.com/a.png ', uploadOptions: { fileName: 'a.png' } } }));
	assert.deepEqual(out[0].json.body, { url: 'https://example.com/a.png', file_name: 'a.png' });
});

test('load options list workspaces and accounts', async () => {
	const api = fakeApi({
		['GET /workspaces']: () => ({ workspaces: [{ id: WS, name: 'Main', timezone: 'Asia/Dhaka' }] }),
		[`GET /workspaces/${WS}/accounts`]: () => ({ accounts: [{ id: ACC, network_name: 'LinkedIn', name: 'Ahmad', handle: null, status: 'active' }, { id: 'x', network_name: 'X', name: 'Sol', handle: '@sol', status: 'needs reconnecting in SolMarrow' }] }),
	});
	const ctx = { ...execContext({ api, params: {} }), getCurrentNodeParameter: () => WS };
	const node = new SolMarrow();
	assert.deepEqual(await node.methods.loadOptions.getWorkspaces.call(ctx), [{ name: 'Main', value: WS, description: 'Time zone: Asia/Dhaka' }]);
	const accounts = await node.methods.loadOptions.getAccounts.call(ctx);
	assert.deepEqual(accounts.map((a) => a.name), ['LinkedIn: Ahmad', 'X: Sol (@sol)']);
	assert.equal(accounts[1].description, 'needs reconnecting in SolMarrow');
});

// --- trigger ---------------------------------------------------------------------------------------------------------
function hookContext({ api, staticData, params, url = 'https://n8n.example.com/webhook/abc/webhook' }) {
	const logs = [];
	return {
		logs,
		getWorkflowStaticData: () => staticData,
		getNodeParameter: (name) => params[name],
		getNodeWebhookUrl: () => url,
		getNode: () => ({ name: 'SolMarrow Trigger', parameters: params }),
		getCredentials: async () => ({ server: 'https://app.solmarrow.com' }),
		logger: { debug: (...a) => logs.push(a) },
		helpers: { httpRequestWithAuthentication: api.httpRequestWithAuthentication },
	};
}

test('trigger: create replaces stale webhooks for the same address and keeps the secret', async () => {
	const url = 'https://n8n.example.com/webhook/abc/webhook';
	const api = fakeApi({
		[`GET /workspaces/${WS}/webhooks`]: () => ({ webhooks: [{ id: 'old', url, events: ['post.failed'] }, { id: 'other', url: 'https://elsewhere.example.com/x', events: [] }] }),
		['DELETE /webhooks/old']: () => ({ deleted: true }),
		[`POST /workspaces/${WS}/webhooks`]: (o) => ({ id: 'new', secret: 'whsec_abc', url: o.body.url, events: o.body.events }),
	});
	const staticData = {};
	const ok = await new SolMarrowTrigger().webhookMethods.default.create.call(hookContext({ api, staticData, params: { workspaceId: WS, events: ['post.published', 'post.failed'] }, url }));
	assert.equal(ok, true);
	assert.deepEqual(staticData, { webhookId: 'new', secret: 'whsec_abc' });
	assert.deepEqual(api.calls.map((c) => `${c.method} ${c.url.split('/v1')[1]}`), [`GET /workspaces/${WS}/webhooks`, 'DELETE /webhooks/old', `POST /workspaces/${WS}/webhooks`]);
	assert.deepEqual(api.calls[2].body, { url, events: ['post.published', 'post.failed'] });
});

test('trigger: checkExists keeps a matching webhook and resets one whose events changed', async () => {
	const url = 'https://n8n.example.com/webhook/abc/webhook';
	const api = fakeApi({
		[`GET /workspaces/${WS}/webhooks`]: () => ({ webhooks: [{ id: 'h1', url, events: ['post.failed', 'post.published'] }] }),
		['DELETE /webhooks/h1']: () => ({ deleted: true }),
	});
	const trigger = new SolMarrowTrigger();
	let staticData = { webhookId: 'h1', secret: 's' };
	assert.equal(await trigger.webhookMethods.default.checkExists.call(hookContext({ api, staticData, params: { workspaceId: WS, events: ['post.published', 'post.failed'] }, url })), true);
	assert.equal(api.calls.length, 1);
	assert.equal(await trigger.webhookMethods.default.checkExists.call(hookContext({ api, staticData, params: { workspaceId: WS, events: ['post.published'] }, url })), false);
	assert.deepEqual(staticData, {});
	assert.equal(api.calls.at(-1).method, 'DELETE');
	staticData = {};
	assert.equal(await trigger.webhookMethods.default.checkExists.call(hookContext({ api, staticData, params: { workspaceId: WS, events: [] }, url })), false);
});

test('trigger: delete treats an already-removed webhook as done, but not other failures', async () => {
	const trigger = new SolMarrowTrigger();
	let api = fakeApi({}); // 404
	let staticData = { webhookId: 'gone', secret: 's' };
	assert.equal(await trigger.webhookMethods.default.delete.call(hookContext({ api, staticData, params: {} })), true);
	assert.deepEqual(staticData, {});
	api = fakeApi({ ['DELETE /webhooks/h2']: () => ({ __status: 500, body: { error: { status: 500, message: 'oops' } } }) });
	staticData = { webhookId: 'h2', secret: 's' };
	assert.equal(await trigger.webhookMethods.default.delete.call(hookContext({ api, staticData, params: {} })), false);
	assert.equal(staticData.webhookId, 'h2');
});

function webhookContext({ secret, raw, headers }) {
	const response = { code: 0, sent: null };
	return {
		response,
		getWorkflowStaticData: () => (secret ? { secret } : {}),
		getRequestObject: () => ({ rawBody: raw === undefined ? undefined : Buffer.from(raw) }),
		getBodyData: () => JSON.parse(raw ?? '{}'),
		getHeaderData: () => headers,
		getResponseObject: () => ({
			status(code) {
				response.code = code;
				return this;
			},
			json(body) {
				response.sent = body;
				return this;
			},
		}),
		helpers: { returnJsonArray: (d) => (Array.isArray(d) ? d : [d]).map((json) => ({ json })) },
	};
}

test('trigger: a signed delivery starts the workflow; unsigned or forged ones get 401', async () => {
	const secret = 'whsec_test';
	const raw = JSON.stringify({ id: '7', event: 'post.published', created_at: '2026-11-01T00:00:00Z', workspace_id: WS, post: { id: POST, text: 'Hi 🙂' } });
	const t = Math.floor(Date.now() / 1000);
	const good = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
	const trigger = new SolMarrowTrigger();

	let ctx = webhookContext({ secret, raw, headers: { 'solmarrow-signature': good } });
	let res = await trigger.webhook.call(ctx);
	assert.equal(res.workflowData[0][0].json.post.id, POST);

	for (const [s, h] of [[secret, {}], [secret, { 'solmarrow-signature': good.replace(/.$/, '0') }], [undefined, { 'solmarrow-signature': good }]]) {
		ctx = webhookContext({ secret: s, raw, headers: h });
		res = await trigger.webhook.call(ctx);
		assert.equal(res.noWebhookResponse, true);
		assert.equal(ctx.response.code, 401);
	}
});
