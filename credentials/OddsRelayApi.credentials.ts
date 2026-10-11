import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class OddsRelayApi implements ICredentialType {
	name = 'oddsRelayApi';

	displayName = 'OddsRelay API';

	icon: Icon = {
		light: 'file:../nodes/OddsRelay/oddsrelay.svg',
		dark: 'file:../nodes/OddsRelay/oddsrelay.dark.svg',
	};

	documentationUrl = 'https://github.com/oddsrelay/n8n-nodes-oddsrelay#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Your OddsRelay API key. Sign up at https://app.oddsrelay.io/signup, then copy the key from your dashboard.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Reading the key's own usage costs no tokens.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.oddsrelay.io',
			url: '/v2/usage',
			method: 'GET',
		},
	};
}
