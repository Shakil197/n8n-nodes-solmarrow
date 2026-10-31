// Live check against a SolMarrow server, driving the built nodes with real HTTP the way n8n does. SM_SKIP_MEDIA=1 leaves
// file uploads out.
// Not part of `npm test`. Needs an OAuth code from the consent screen of an app made in Settings → Your own apps:
//   SM_SERVER=https://app.solmarrow.com SM_CLIENT_ID=smo_… SM_CLIENT_SECRET=smcs_… SM_CODE=smac_… \
//   SM_REDIRECT=http://localhost:5678/rest/oauth2-credential/callback node test/e2e-live.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SolMarrow } = require('../dist/nodes/SolMarrow/SolMarrow.node.js');
const { SolMarrowTrigger } = require('../dist/nodes/SolMarrowTrigger/SolMarrowTrigger.node.js');

const { SM_SERVER, SM_CLIENT_ID, SM_CLIENT_SECRET, SM_CODE, SM_REDIRECT } = process.env;
const basic = 'Basic ' + Buffer.from(`${SM_CLIENT_ID}:${SM_CLIENT_SECRET}`).toString('base64');
let failures = 0;
const check = (label, ok, extra = '') => {
	if (!ok) failures++;
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  (${extra})` : ''}`);
};

async function token(form) {
	// Like n8n's OAuth2 client with "Send credentials in header".
	const r = await fetch(`${SM_SERVER}/oauth/token`, {
		method: 'POST',
		headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
		body: new URLSearchParams(form),
	});
	return { status: r.status, body: await r.json().catch(() => ({})) };
}

const first = await token({ grant_type: 'authorization_code', code: SM_CODE, redirect_uri: SM_REDIRECT });
check('code exchanged with client secret (Basic)', first.status === 200 && !!first.body.access_token, `HTTP ${first.status}, expires_in ${first.body.expires_in}, scope ${first.body.scope}`);
if (!first.body.access_token) process.exit(1);
const refreshed = await token({ grant_type: 'refresh_token', refresh_token: first.body.refresh_token });
check('refresh token works', refreshed.status === 200 && !!refreshed.body.access_token, `HTTP ${refreshed.status}`);
let accessToken = refreshed.body.access_token ?? first.body.access_token;

// n8n's httpRequest: json in/out, qs, throws an axios-style error on non-2xx.
async function httpRequest(options, bearer) {
	const url = new URL(options.url);
	for (const [k, v] of Object.entries(options.qs ?? {})) url.searchParams.set(k, String(v));
	const headers = { ...(options.headers ?? {}) };
	if (bearer) headers.Authorization = `Bearer ${accessToken}`;
	let body = options.body;
	if (options.json && body && !Buffer.isBuffer(body)) {
		body = JSON.stringify(body);
		headers['Content-Type'] = 'application/json';
	}
	if (Buffer.isBuffer(body)) delete headers['Content-Length'];
	const r = await fetch(url, { method: options.method, headers, body });
	const text = await r.text();
	let data = text;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {}
	if (r.status >= 400) throw Object.assign(new Error(`Request failed with status code ${r.status}`), { response: { status: r.status, data } });
	return data;
}

function ctx(params, extra = {}) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getCurrentNodeParameter: (name) => params[name],
		getNode: () => ({ name: 'SolMarrow', type: 'n8n-nodes-solmarrow.solMarrow', typeVersion: 1, parameters: params }),
		getTimezone: () => 'Asia/Dhaka',
		getCredentials: async () => ({ server: SM_SERVER }),
		continueOnFail: () => false,
		logger: { debug: () => {} },
		helpers: {
			httpRequestWithAuthentication: (_cred, o) => httpRequest(o, true),
			httpRequest: (o) => httpRequest(o, false),
			returnJsonArray: (d) => (Array.isArray(d) ? d : [d]).map((json) => ({ json })),
			constructExecutionMetaData: (items) => items,
			assertBinaryData: () => extra.binary.meta,
			getBinaryDataBuffer: async () => extra.binary.bytes,
		},
		...extra.overrides,
	};
}
const node = new SolMarrow();
const run = async (params, extra) => (await node.execute.call(ctx(params, extra)))[0].map((i) => i.json);
const expectError = async (label, params, pattern) => {
	try {
		await run(params);
		check(label, false, 'no error');
	} catch (e) {
		check(label, pattern.test(e.message), e.message.slice(0, 120));
	}
};

const me = await httpRequest({ method: 'GET', url: `${SM_SERVER}/api/v1/me`, json: true }, true);
check('credential test GET /me', !!me.user?.id, `app ${me.app?.name}`);

const workspaces = await run({ resource: 'workspace', operation: 'getAll' });
check('Workspace → Get Many', workspaces.length >= 1, `${workspaces.length}, tz ${workspaces[0]?.timezone}`);
const WS = workspaces[0].id;
const wsOptions = await node.methods.loadOptions.getWorkspaces.call(ctx({}));
check('Workspace dropdown', wsOptions[0]?.value === WS, wsOptions[0]?.name);
const accounts = await run({ resource: 'account', operation: 'getAll', workspaceId: WS });
check('Account → Get Many', Array.isArray(accounts), `${accounts.length} accounts`);

const draft = (await run({ resource: 'post', operation: 'create', workspaceId: WS, text: 'n8n check draft', when: 'draft', accountIds: [], additionalFields: {} }))[0];
check('Post → Create (draft)', draft.status === 'draft' && !!draft.post_id, draft.post_id);
const got = (await run({ resource: 'post', operation: 'get', postId: draft.post_id }))[0];
check('Post → Get', got.id === draft.post_id && got.created_by_app === true, `created_by_app ${got.created_by_app}`);
const drafts = await run({ resource: 'post', operation: 'getAll', workspaceId: WS, limit: 50, filters: { status: 'draft' } });
check('Post → Get Many (status draft)', drafts.some((p) => p.id === draft.post_id), `${drafts.length}`);

await expectError('Post → Create (schedule, no accounts) shows the API message', { resource: 'post', operation: 'create', workspaceId: WS, text: 'x', when: 'schedule', scheduleAt: new Date(Date.now() + 30 * 86400_000).toISOString(), accountIds: [], additionalFields: {} }, /at least one account/);
await expectError('Post → Create (schedule too soon) shows the API message', { resource: 'post', operation: 'create', workspaceId: WS, text: 'x', when: 'schedule', scheduleAt: new Date(Date.now() + 60_000).toISOString(), accountIds: [], additionalFields: {} }, /5 minutes/);

// SM_SKIP_MEDIA=1 leaves files out (production check: removing a test account doesn't remove its stored files).
const posts = [draft.post_id];
if (!process.env.SM_SKIP_MEDIA) {
	const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
	const up = (await run({ resource: 'media', operation: 'upload', workspaceId: WS, source: 'binary', binaryPropertyName: 'data', uploadOptions: {} }, { binary: { meta: { mimeType: 'image/png', fileName: 'n8n-check.png', fileExtension: 'png' }, bytes: png } }))[0];
	check('Media → Upload (binary, signed PUT)', !!up.media_id, `${up.media_id} ${up.size_bytes} bytes`);
	const fromUrl = await run({ resource: 'media', operation: 'upload', workspaceId: WS, source: 'url', url: `${SM_SERVER}/icon.svg`, uploadOptions: {} }).catch((e) => [{ error: e.message }]);
	check('Media → Upload (URL, unsupported type refused clearly)', !!fromUrl[0].error && /JPG|PNG|type/i.test(fromUrl[0].error), (fromUrl[0].error ?? '').slice(0, 100));
	const media = await run({ resource: 'media', operation: 'getAll', workspaceId: WS, limit: 5 });
	check('Media → Get Many', media.some((m) => m.id === up.media_id), `${media.length}`);

	const withMedia = (await run({ resource: 'post', operation: 'create', workspaceId: WS, text: 'n8n check with media', when: 'draft', accountIds: [], additionalFields: { mediaIds: up.media_id } }))[0];
	const withMediaGot = (await run({ resource: 'post', operation: 'get', postId: withMedia.post_id }))[0];
	check('Post → Create with Media IDs', withMediaGot.media?.[0]?.id === up.media_id);
	posts.push(withMedia.post_id);
} else {
	const media = await run({ resource: 'media', operation: 'getAll', workspaceId: WS, limit: 5 });
	check('Media → Get Many', Array.isArray(media), `${media.length}`);
}

const analytics = (await run({ resource: 'analytics', operation: 'get', workspaceId: WS, filters: {} }))[0];
check('Analytic → Get', typeof analytics.totals?.posts === 'number', JSON.stringify(analytics.totals));

for (const id of posts) {
	const del = (await run({ resource: 'post', operation: 'delete', postId: id }))[0];
	check('Post → Delete', del.deleted === true);
}
await expectError('Post → Get after delete gives 404 message', { resource: 'post', operation: 'get', postId: draft.post_id }, /not found/i);

// Trigger lifecycle against the real API.
const trigger = new SolMarrowTrigger();
const staticData = {};
const hookCtx = (url, events) => ({ ...ctx({ workspaceId: WS, events }), getWorkflowStaticData: () => staticData, getNodeWebhookUrl: () => url });
const hookUrl = 'https://example.com/n8n-check/webhook';
check('Trigger: checkExists before activation', (await trigger.webhookMethods.default.checkExists.call(hookCtx(hookUrl, ['post.published']))) === false);
check('Trigger: create (activate)', (await trigger.webhookMethods.default.create.call(hookCtx(hookUrl, ['post.published', 'post.failed']))) === true && /^whsec_/.test(staticData.secret ?? ''));
check('Trigger: checkExists after activation', (await trigger.webhookMethods.default.checkExists.call(hookCtx(hookUrl, ['post.failed', 'post.published']))) === true);
const listed = await httpRequest({ method: 'GET', url: `${SM_SERVER}/api/v1/workspaces/${WS}/webhooks`, json: true }, true);
check('Trigger: webhook listed in SolMarrow', listed.webhooks.length === 1 && listed.webhooks[0].url === hookUrl);
check('Trigger: delete (deactivate)', (await trigger.webhookMethods.default.delete.call(hookCtx(hookUrl, []))) === true);
const after = await httpRequest({ method: 'GET', url: `${SM_SERVER}/api/v1/workspaces/${WS}/webhooks`, json: true }, true);
check('Trigger: webhook gone', after.webhooks.length === 0);
try {
	await trigger.webhookMethods.default.create.call(hookCtx('http://localhost:5678/webhook/abc/webhook', ['post.published']));
	check('Trigger: localhost n8n refused with a clear message', false);
} catch (e) {
	check('Trigger: localhost n8n refused with a clear message', /https/i.test(e.message), e.message.slice(0, 120));
}

// Last, because a replayed code revokes everything issued from it (RFC 6749 4.1.2).
const again = await token({ grant_type: 'authorization_code', code: SM_CODE, redirect_uri: SM_REDIRECT });
check('same code refused the second time', again.status === 400, `HTTP ${again.status}`);
const revoked = await httpRequest({ method: 'GET', url: `${SM_SERVER}/api/v1/me`, json: true }, true).then(() => 200, (e) => e.response?.status);
check('...and the tokens from it stop working', revoked === 401, `HTTP ${revoked}`);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
