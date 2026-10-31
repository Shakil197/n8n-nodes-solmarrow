import type { ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

/**
 * Sign in with SolMarrow (OAuth 2.0, authorization code). The client ID and secret come from
 * SolMarrow → Settings → Apps and AI agents → Your own apps.
 */
export class SolMarrowOAuth2Api implements ICredentialType {
	name = 'solMarrowOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'SolMarrow OAuth2 API';

	icon: Icon = { light: 'file:../icons/solmarrow.svg', dark: 'file:../icons/solmarrow.dark.svg' };

	documentationUrl = 'https://solmarrow.com/developers';

	properties: INodeProperties[] = [
		{
			displayName:
				'In SolMarrow, open Settings → Apps and AI agents → Your own apps, create an app, and add the OAuth Redirect URL shown above as its redirect address. Then paste the client ID and secret here.',
			name: 'notice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'SolMarrow URL',
			name: 'server',
			type: 'string',
			default: 'https://app.solmarrow.com',
			description: 'Leave as is unless SolMarrow support gives you another address',
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'authorizationCode',
		},
		{
			displayName: 'Authorization URL',
			name: 'authUrl',
			type: 'hidden',
			default: '={{$self["server"].replace(/\\/+$/, "")}}/oauth/authorize',
		},
		{
			displayName: 'Access Token URL',
			name: 'accessTokenUrl',
			type: 'hidden',
			default: '={{$self["server"].replace(/\\/+$/, "")}}/oauth/token',
		},
		{
			displayName: 'Scope',
			name: 'scope',
			type: 'hidden',
			default: 'solmarrow',
		},
		{
			displayName: 'Auth URI Query Parameters',
			name: 'authQueryParameters',
			type: 'hidden',
			default: '',
		},
		{
			displayName: 'Authentication',
			name: 'authentication',
			type: 'hidden',
			default: 'header',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.server.replace(/\\/+$/, "")}}/api/v1',
			url: '/me',
		},
	};
}
