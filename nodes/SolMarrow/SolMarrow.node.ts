import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { apiRequest, getAccounts, getWorkspaces, segment, splitIds, toUtcIso } from './GenericFunctions';

/** API errors already carry the API's message; anything else is reported against the item. */
function asNodeError(ctx: IExecuteFunctions, error: unknown, itemIndex: number): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	return new NodeOperationError(ctx.getNode(), error as Error, { itemIndex });
}

const STATUSES = [
	{ name: 'Draft', value: 'draft' },
	{ name: 'Failed', value: 'failed' },
	{ name: 'Partially Published', value: 'partially_published' },
	{ name: 'Published', value: 'published' },
	{ name: 'Publishing', value: 'publishing' },
	{ name: 'Scheduled', value: 'scheduled' },
];

const MIME_ALIASES: Record<string, string> = {
	'image/jpg': 'image/jpeg',
	'image/pjpeg': 'image/jpeg',
};

export class SolMarrow implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SolMarrow',
		name: 'solMarrow',
		icon: { light: 'file:../../icons/solmarrow.svg', dark: 'file:../../icons/solmarrow.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Schedule and publish social media posts with SolMarrow',
		defaults: { name: 'SolMarrow' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'solMarrowOAuth2Api', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Analytic', value: 'analytics' },
					{ name: 'Media', value: 'media' },
					{ name: 'Post', value: 'post' },
					{ name: 'Workspace', value: 'workspace' },
				],
				default: 'post',
			},

			// Operations
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['post'] } },
				options: [
					{ name: 'Create', value: 'create', action: 'Create a post', description: 'Save a draft, schedule a post, or publish it now' },
					{ name: 'Delete', value: 'delete', action: 'Delete a post', description: 'Delete a draft, scheduled or failed post' },
					{ name: 'Get', value: 'get', action: 'Get a post', description: 'Get a post with its status and links' },
					{ name: 'Get Many', value: 'getAll', action: 'Get many posts', description: 'Get posts, newest first' },
				],
				default: 'create',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['media'] } },
				options: [
					{ name: 'Get Many', value: 'getAll', action: 'Get many media files', description: 'Get recent files in the media library' },
					{ name: 'Upload', value: 'upload', action: 'Upload a media file', description: 'Add an image or video to the media library' },
				],
				default: 'upload',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{ name: 'Get Many', value: 'getAll', action: 'Get many accounts', description: 'Get the connected social accounts and their posting rules' },
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['workspace'] } },
				options: [{ name: 'Get Many', value: 'getAll', action: 'Get many workspaces', description: 'Get your workspaces and their time zones' }],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['analytics'] } },
				options: [{ name: 'Get', value: 'get', action: 'Get analytics', description: 'Get likes, comments, shares and views of published posts' }],
				default: 'get',
			},

			// Workspace (everything except workspaces, and one post by ID)
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'getWorkspaces' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['post', 'media', 'account'], operation: ['create', 'getAll', 'upload'] } },
			},
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'getWorkspaces' },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['analytics'] } },
			},

			// Post: create
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'The post text. Use Text per Account below to change it for one account.',
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
			},
			{
				displayName: 'When',
				name: 'when',
				type: 'options',
				options: [
					{ name: 'Publish Now', value: 'now', description: 'Publish right away' },
					{ name: 'Save as Draft', value: 'draft', description: 'Keep it in SolMarrow without scheduling it' },
					{ name: 'Schedule', value: 'schedule', description: 'Publish at a set time, at least 5 minutes from now' },
				],
				default: 'draft',
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
			},
			{
				displayName: 'Publish At',
				name: 'scheduleAt',
				type: 'dateTime',
				required: true,
				default: '',
				description: "When to publish, at least 5 minutes from now. Times without an offset use the workflow's time zone.",
				displayOptions: { show: { resource: ['post'], operation: ['create'], when: ['schedule'] } },
			},
			{
				displayName: 'Account Names or IDs',
				name: 'accountIds',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getAccounts', loadOptionsDependsOn: ['workspaceId'] },
				required: true,
				default: [],
				description: 'The social accounts to post to. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: { show: { resource: ['post'], operation: ['create'], when: ['now', 'schedule'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['post'], operation: ['create'] } },
				options: [
					{
						displayName: 'Account Names or IDs',
						name: 'accountIds',
						type: 'multiOptions',
						typeOptions: { loadOptionsMethod: 'getAccounts', loadOptionsDependsOn: ['workspaceId'] },
						default: [],
						description: 'For a draft: the accounts it is meant for (optional). Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
						displayOptions: { show: { '/when': ['draft'] } },
					},
					{
						displayName: 'Media IDs',
						name: 'mediaIds',
						type: 'string',
						default: '',
						description: 'Media library IDs in order, separated by commas. Upload files first with Media → Upload.',
					},
					{
						displayName: 'Network Settings (JSON)',
						name: 'perAccountOptions',
						type: 'json',
						default: '{}',
						description:
							'Settings some networks use, by account ID. YouTube {"title", "privacy": "public|unlisted|private", "madeForKids"}; Pinterest {"boardId", "title", "link"}; Dribbble {"title", "tags"}; Tumblr {"tags"}; WordPress, DEV and Ghost {"title", "tags", "status"}.',
					},
					{
						displayName: 'Text per Account',
						name: 'perAccountText',
						type: 'fixedCollection',
						typeOptions: { multipleValues: true },
						placeholder: 'Add Text',
						default: {},
						options: [
							{
								displayName: 'Text',
								name: 'values',
								values: [
									{
										displayName: 'Account Name or ID',
										name: 'accountId',
										type: 'options',
										description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
										typeOptions: { loadOptionsMethod: 'getAccounts', loadOptionsDependsOn: ['workspaceId'] },
										default: '',
									},
									{
										displayName: 'Text',
										name: 'text',
										type: 'string',
										typeOptions: { rows: 3 },
										default: '',
									},
								],
							},
						],
					},
				],
			},

			// Post: get, delete
			{
				displayName: 'Post ID',
				name: 'postId',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['post'], operation: ['get', 'delete'] } },
			},

			// Post: getAll
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 50 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['post'], operation: ['getAll'] } },
			},
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['post'], operation: ['getAll'] } },
				options: [
					{ displayName: 'From', name: 'from', type: 'dateTime', default: '', description: 'Only posts scheduled or created from this time' },
					{ displayName: 'Status', name: 'status', type: 'options', options: STATUSES, default: 'scheduled' },
					{ displayName: 'To', name: 'to', type: 'dateTime', default: '', description: 'Only posts scheduled or created before this time' },
				],
			},

			// Media: upload
			{
				displayName: 'Source',
				name: 'source',
				type: 'options',
				options: [
					{ name: 'Binary File', value: 'binary', description: 'A file from an earlier node (up to 90 MB)' },
					{ name: 'URL', value: 'url', description: 'A public https link to the file (any size that fits your storage)' },
				],
				default: 'binary',
				displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
			},
			{
				displayName: 'Input Binary Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				hint: 'The name of the input binary field containing the file',
				displayOptions: { show: { resource: ['media'], operation: ['upload'], source: ['binary'] } },
			},
			{
				displayName: 'File URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com/photo.jpg',
				description: 'Public https link to a JPG, PNG, WebP, GIF, MP4, MOV or WebM file',
				displayOptions: { show: { resource: ['media'], operation: ['upload'], source: ['url'] } },
			},
			{
				displayName: 'Options',
				name: 'uploadOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['media'], operation: ['upload'] } },
				options: [{ displayName: 'File Name', name: 'fileName', type: 'string', default: '', description: 'Name shown in the media library' }],
			},

			// Media: getAll
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 100 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['media'], operation: ['getAll'] } },
			},

			// Analytics: get
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				displayOptions: { show: { resource: ['analytics'], operation: ['get'] } },
				options: [
					{ displayName: 'From', name: 'from', type: 'dateTime', default: '', description: 'Published from this time (default: 30 days ago)' },
					{ displayName: 'Post ID', name: 'postId', type: 'string', default: '', description: 'Only this post' },
					{ displayName: 'To', name: 'to', type: 'dateTime', default: '', description: 'Published before this time' },
				],
			},
		],
	};

	methods = { loadOptions: { getWorkspaces, getAccounts } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const timeZone = this.getTimezone();

		const push = (data: IDataObject | IDataObject[], i: number) =>
			out.push(...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(data), { itemData: { item: i } }));

		const time = (value: unknown, label: string, i: number) => {
			if (value === undefined || value === null || value === '') return undefined;
			const iso = toUtcIso(value, timeZone);
			if (!iso) throw new NodeOperationError(this.getNode(), `${label} isn't a date and time`, { itemIndex: i });
			return iso;
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				if (resource === 'workspace') {
					const res = await apiRequest.call(this, 'GET', '/workspaces');
					push((res.workspaces as IDataObject[]) ?? [], i);
					continue;
				}

				if (resource === 'post' && (operation === 'get' || operation === 'delete')) {
					const postId = segment(this.getNodeParameter('postId', i) as string);
					push(await apiRequest.call(this, operation === 'get' ? 'GET' : 'DELETE', `/posts/${postId}`), i);
					continue;
				}

				const ws = segment(this.getNodeParameter('workspaceId', i) as string);

				if (resource === 'account') {
					const res = await apiRequest.call(this, 'GET', `/workspaces/${ws}/accounts`);
					push((res.accounts as IDataObject[]) ?? [], i);
				} else if (resource === 'analytics') {
					const f = this.getNodeParameter('filters', i, {}) as IDataObject;
					push(
						await apiRequest.call(this, 'GET', `/workspaces/${ws}/analytics`, undefined, {
							from: time(f.from, 'From', i),
							to: time(f.to, 'To', i),
							post_id: f.postId ? String(f.postId).trim() : undefined,
						}),
						i,
					);
				} else if (resource === 'post' && operation === 'getAll') {
					const f = this.getNodeParameter('filters', i, {}) as IDataObject;
					const res = await apiRequest.call(this, 'GET', `/workspaces/${ws}/posts`, undefined, {
						limit: this.getNodeParameter('limit', i, 20) as number,
						status: f.status as string | undefined,
						from: time(f.from, 'From', i),
						to: time(f.to, 'To', i),
					});
					push((res.posts as IDataObject[]) ?? [], i);
				} else if (resource === 'post' && operation === 'create') {
					const when = this.getNodeParameter('when', i) as string;
					const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
					const body: IDataObject = {
						text: this.getNodeParameter('text', i, '') as string,
						// Publishing needs accounts (a required field); a draft takes them from Additional Fields, if any.
						account_ids: splitIds(when === 'draft' ? extra.accountIds : this.getNodeParameter('accountIds', i, [])),
						media_ids: splitIds(extra.mediaIds),
					};
					if (when === 'draft') body.draft = true;
					if (when === 'now') body.publish_now = true;
					if (when === 'schedule') body.schedule_at = time(this.getNodeParameter('scheduleAt', i), 'Publish At', i);

					const perText = ((extra.perAccountText as IDataObject | undefined)?.values as IDataObject[] | undefined) ?? [];
					const texts = Object.fromEntries(perText.filter((v) => v.accountId).map((v) => [String(v.accountId), String(v.text ?? '')]));
					if (Object.keys(texts).length) body.per_account_text = texts;

					if (extra.perAccountOptions !== undefined && extra.perAccountOptions !== '') {
						let settings: unknown = extra.perAccountOptions;
						if (typeof settings === 'string') {
							try {
								settings = JSON.parse(settings);
							} catch {
								throw new NodeOperationError(this.getNode(), 'Network Settings must be valid JSON', { itemIndex: i });
							}
						}
						if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
							throw new NodeOperationError(this.getNode(), 'Network Settings must be a JSON object keyed by account ID', { itemIndex: i });
						}
						if (Object.keys(settings).length) body.per_account_options = settings as IDataObject;
					}
					push(await apiRequest.call(this, 'POST', `/workspaces/${ws}/posts`, body), i);
				} else if (resource === 'media' && operation === 'getAll') {
					const res = await apiRequest.call(this, 'GET', `/workspaces/${ws}/media`, undefined, {
						limit: this.getNodeParameter('limit', i, 30) as number,
					});
					push((res.media as IDataObject[]) ?? [], i);
				} else if (resource === 'media' && operation === 'upload') {
					const source = this.getNodeParameter('source', i) as string;
					const fileName = String((this.getNodeParameter('uploadOptions', i, {}) as IDataObject).fileName ?? '').trim();
					if (source === 'url') {
						const body: IDataObject = { url: (this.getNodeParameter('url', i) as string).trim() };
						if (fileName) body.file_name = fileName;
						push(await apiRequest.call(this, 'POST', `/workspaces/${ws}/media/from-url`, body), i);
					} else {
						const field = this.getNodeParameter('binaryPropertyName', i) as string;
						const binary = this.helpers.assertBinaryData(i, field);
						const bytes = await this.helpers.getBinaryDataBuffer(i, field);
						const mimeType = MIME_ALIASES[binary.mimeType] ?? binary.mimeType;
						const name = fileName || binary.fileName || `upload.${binary.fileExtension ?? 'bin'}`;
						const start = await apiRequest.call(this, 'POST', `/workspaces/${ws}/media/uploads`, {
							file_name: name,
							mime_type: mimeType,
							size: bytes.length,
						});
						// The file goes straight to SolMarrow's storage with the signed link (no sign-in needed there).
						await this.helpers.httpRequest({
							method: 'PUT',
							url: String(start.upload_url),
							headers: (start.headers as IDataObject) ?? { 'Content-Type': mimeType },
							body: bytes,
							json: false,
						});
						push(
							await apiRequest.call(this, 'POST', `/workspaces/${ws}/media/uploads/complete`, {
								upload_id: start.upload_id,
								file_name: name,
								mime_type: mimeType,
							}),
							i,
						);
					}
				} else {
					throw new NodeOperationError(this.getNode(), `The operation "${operation}" isn't supported for ${resource}`, { itemIndex: i });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					push({ error: (error as Error).message }, i);
					continue;
				}
				throw asNodeError(this, error, i);
			}
		}
		return [out];
	}
}
