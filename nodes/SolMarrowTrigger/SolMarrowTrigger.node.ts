import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { apiError, apiRequest, getWorkspaces, segment } from '../SolMarrow/GenericFunctions';
import { verifySignature } from './signature';

const sameSet = (a: unknown, b: string[]) =>
	Array.isArray(a) && a.length === b.length && b.every((x) => (a as unknown[]).includes(x));

export class SolMarrowTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'SolMarrow Trigger',
		name: 'solMarrowTrigger',
		icon: { light: 'file:../../icons/solmarrow.svg', dark: 'file:../../icons/solmarrow.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when a SolMarrow post is scheduled, published or fails',
		defaults: { name: 'SolMarrow Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'solMarrowOAuth2Api', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName: 'n8n must be reachable at a public https address for SolMarrow to send events to it.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Workspace Name or ID',
				name: 'workspaceId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getWorkspaces' },
				required: true,
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				options: [
					{ name: 'Post Failed', value: 'post.failed', description: 'A post could not be published' },
					{ name: 'Post Published', value: 'post.published', description: 'A post went out (to all or some of its accounts)' },
					{ name: 'Post Scheduled', value: 'post.scheduled', description: 'A post was scheduled' },
				],
				default: ['post.published'],
			},
		],
	};

	methods = { loadOptions: { getWorkspaces } };

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (!data.webhookId) return false;
				const workspaceId = segment(this.getNodeParameter('workspaceId') as string);
				const events = this.getNodeParameter('events') as string[];
				const url = this.getNodeWebhookUrl('default');
				const res = await apiRequest.call(this, 'GET', `/workspaces/${workspaceId}/webhooks`);
				const hook = ((res.webhooks as IDataObject[] | undefined) ?? []).find((h) => h.id === data.webhookId);
				if (hook && hook.url === url && sameSet(hook.events, events) && data.secret) return true;
				// The workspace, events or address changed (or the webhook is gone): start over.
				try {
					await apiRequest.call(this, 'DELETE', `/webhooks/${segment(String(data.webhookId))}`);
				} catch (error) {
					// Usually already removed; a new webhook replaces it either way.
					this.logger.debug('SolMarrow: old webhook not removed', { error: apiError(error).message ?? String(error) });
				}
				delete data.webhookId;
				delete data.secret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				const workspaceId = segment(this.getNodeParameter('workspaceId') as string);
				const events = this.getNodeParameter('events') as string[];
				const url = this.getNodeWebhookUrl('default') as string;
				// A webhook for this address whose secret was lost can't be checked any more: replace it.
				const res = await apiRequest.call(this, 'GET', `/workspaces/${workspaceId}/webhooks`);
				for (const old of ((res.webhooks as IDataObject[] | undefined) ?? []).filter((h) => h.url === url)) {
					await apiRequest.call(this, 'DELETE', `/webhooks/${segment(String(old.id))}`);
				}
				const hook = await apiRequest.call(this, 'POST', `/workspaces/${workspaceId}/webhooks`, { url, events });
				if (!hook.id || !hook.secret) return false;
				data.webhookId = hook.id;
				data.secret = hook.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData('node');
				if (data.webhookId) {
					try {
						await apiRequest.call(this, 'DELETE', `/webhooks/${segment(String(data.webhookId))}`);
					} catch (error) {
						if (apiError(error).status !== 404) return false;
					}
				}
				delete data.webhookId;
				delete data.secret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const secret = this.getWorkflowStaticData('node').secret as string | undefined;
		const req = this.getRequestObject() as unknown as { rawBody?: { toString(encoding: string): string } };
		const body = this.getBodyData();
		const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(body);
		const header = this.getHeaderData()['solmarrow-signature'];
		if (!secret || typeof header !== 'string' || !verifySignature(secret, raw, header, Date.now())) {
			const res = this.getResponseObject();
			res.status(401).json({ error: 'Invalid signature' });
			return { noWebhookResponse: true };
		}
		return { workflowData: [this.helpers.returnJsonArray(body)] };
	}
}
