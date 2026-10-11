import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { TokenGuard } from './transport';
import { apiGet, isoTime, OverBudgetError, spend, splitList } from './transport';

// Programmatic style, not declarative: a capped call is two dependent requests (the free price, then the data),
// and the raw board, events and sports page through a cursor while keeping a running token budget.

/** The raw board's largest page. */
const RAW_PAGE_MAX = 250;

const show = (resource: string, operation: string[]) => ({
	show: { resource: [resource], operation },
});

const returnAllAndLimit = (resource: string, operation: string): INodeProperties[] => [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		displayOptions: show(resource, [operation]),
		default: false,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		displayOptions: { show: { resource: [resource], operation: [operation], returnAll: [false] } },
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
	},
];

const tokenSpend = (operation: string[]): INodeProperties[] => [
	{
		displayName: 'Token Spend',
		name: 'tokenSpend',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['board', 'event'], operation } },
		options: [
			{
				name: 'Check Price First',
				value: 'cap',
				description:
					"Ask the API what the call costs (free) and stop, spending nothing, if it is above 'Max Tokens'",
			},
			{
				name: 'No Check',
				value: 'spend',
				description: 'Make the call without asking its price first',
			},
			{
				name: 'Price Only',
				value: 'quote',
				description: 'Return what the call would cost and spend nothing',
			},
		],
		default: 'cap',
		description: 'How to guard the tokens this call spends from your account',
	},
	{
		displayName: 'Max Tokens',
		name: 'maxTokens',
		type: 'number',
		displayOptions: { show: { resource: ['board', 'event'], operation, tokenSpend: ['cap'] } },
		typeOptions: { minValue: 0 },
		default: 500,
		description:
			'The most tokens this node may spend per input item. A call priced above what is left is not made.',
	},
];

const startTimes: INodeProperties[] = [
	{
		displayName: 'Start Time From',
		name: 'commenceTimeFrom',
		type: 'dateTime',
		default: '',
		description: 'Only events that start at or after this time',
	},
	{
		displayName: 'Start Time To',
		name: 'commenceTimeTo',
		type: 'dateTime',
		default: '',
		description: 'Only events that start at or before this time',
	},
];

const sportsList: INodeProperties = {
	displayName: 'Sports',
	name: 'sports',
	type: 'string',
	default: '',
	placeholder: 'e.g. soccer, tennis',
	description:
		'Comma-separated sport or competition keys. Get them with the Sport resource, Get Many operation.',
};

const marketsList: INodeProperties = {
	displayName: 'Markets',
	name: 'markets',
	type: 'string',
	default: '',
	placeholder: 'e.g. h2h',
	description:
		'Comma-separated market keys. The Coverage resource lists the keys each board carries.',
};

const eventIdsList: INodeProperties = {
	displayName: 'Event IDs',
	name: 'eventIds',
	type: 'string',
	default: '',
	placeholder: 'e.g. or_evt_da71d5873e85',
	description: 'Comma-separated event IDs',
};

const region: INodeProperties = {
	displayName: 'Region',
	name: 'region',
	type: 'string',
	default: '',
	placeholder: 'e.g. uk',
	description: 'Region code. Left empty, the API uses uk.',
};

const oddsFormat: INodeProperties = {
	displayName: 'Odds Format',
	name: 'oddsFormat',
	type: 'options',
	options: [
		{ name: 'Decimal', value: 'decimal' },
		{ name: 'Moneyline', value: 'american' },
	],
	default: 'decimal',
};

const dateFormat: INodeProperties = {
	displayName: 'Date Format',
	name: 'dateFormat',
	type: 'options',
	options: [
		{ name: 'ISO 8601', value: 'iso' },
		{ name: 'Unix Seconds', value: 'unix' },
	],
	default: 'iso',
};

const includeLinks: INodeProperties = {
	displayName: 'Include Links',
	name: 'includeLinks',
	type: 'boolean',
	default: false,
	description: "Whether to include a link to each bookmaker's page for the event",
};

const includeLiquidity: INodeProperties = {
	displayName: 'Include Liquidity',
	name: 'includeLiquidity',
	type: 'boolean',
	default: true,
	description: 'Whether to include the amount available at each exchange price',
};

const options = (
	resource: string,
	operation: string,
	values: INodeProperties[],
): INodeProperties => ({
	displayName: 'Options',
	name: 'options',
	type: 'collection',
	placeholder: 'Add Option',
	displayOptions: show(resource, [operation]),
	default: {},
	options: values,
});

const filters = (
	resource: string,
	operation: string,
	values: INodeProperties[],
): INodeProperties => ({
	displayName: 'Filters',
	name: 'filters',
	type: 'collection',
	placeholder: 'Add Filter',
	displayOptions: show(resource, [operation]),
	default: {},
	options: values,
});

export class OddsRelay implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'OddsRelay',
		name: 'oddsRelay',
		icon: { light: 'file:oddsrelay.svg', dark: 'file:oddsrelay.dark.svg' },
		group: ['input'],
		version: [1],
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Read pre-match odds from UK and Irish bookmakers and exchanges: matched boards, raw prices, events and sports',
		defaults: {
			name: 'OddsRelay',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'oddsRelayApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Board', value: 'board' },
					{ name: 'Bookmaker', value: 'bookmaker' },
					{ name: 'Coverage', value: 'coverage' },
					{ name: 'Event', value: 'event' },
					{ name: 'Sport', value: 'sport' },
				],
				default: 'board',
			},

			// ----- Operations -----
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['board'] } },
				options: [
					{
						name: 'Get Matched',
						value: 'getMatched',
						description:
							'Get a matched board: bookmaker back prices paired with exchange lay prices, by event',
						action: 'Get matched board',
					},
					{
						name: 'Get Raw',
						value: 'getRaw',
						description: 'Get the raw board: every bookmaker and exchange price, by event',
						action: 'Get raw board',
					},
				],
				default: 'getMatched',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['event'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get the upcoming events of one sport, with their IDs',
						action: 'Get many events',
					},
					{
						name: 'Get Odds',
						value: 'getOdds',
						description: "Get one event's prices at every bookmaker and exchange that carries it",
						action: 'Get event odds',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['sport'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get the sport and competition keys you can filter on',
						action: 'Get many sports',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['bookmaker'] } },
				options: [
					{
						name: 'Get Many',
						value: 'getAll',
						description: 'Get the bookmaker and exchange keys you can filter on',
						action: 'Get many bookmakers',
					},
				],
				default: 'getAll',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['coverage'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Get which bookmakers and exchanges carry which sports on each board',
						action: 'Get coverage',
					},
				],
				default: 'get',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get Usage',
						value: 'getUsage',
						description: "Get your plan, token balance, reset time and the key's scope",
						action: 'Get account usage',
					},
				],
				default: 'getUsage',
			},

			// ----- Odds: Get Matched Board -----
			{
				displayName: 'Board',
				name: 'board',
				type: 'options',
				required: true,
				displayOptions: show('board', ['getMatched']),
				options: [
					{ name: '2Up', value: '2up' },
					{ name: 'BOG', value: 'bog' },
					{ name: 'Dutching', value: 'dutching' },
					{ name: 'Each Way', value: 'each-way' },
					{ name: 'Extra Place', value: 'extra-place' },
					{ name: 'Standard', value: 'standard' },
				],
				default: 'standard',
				description: 'Which matched board to read',
			},
			...tokenSpend(['getMatched', 'getRaw', 'getOdds']),
			...returnAllAndLimit('board', 'getMatched'),
			filters('board', 'getMatched', [
				{
					displayName: 'Bookmaker Names or IDs',
					name: 'bookmakers',
					type: 'multiOptions',
					description:
						'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					typeOptions: { loadOptionsMethod: 'getBookmakers' },
					default: [],
					hint: 'Only prices from these bookmakers',
				},
				{
					displayName: 'Exchange Names or IDs',
					name: 'exchanges',
					type: 'multiOptions',
					description:
						'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					typeOptions: { loadOptionsMethod: 'getExchanges' },
					default: [],
					hint: 'Only lay prices from these exchanges',
				},
				marketsList,
				sportsList,
				...startTimes,
			]),
			options('board', 'getMatched', [dateFormat, oddsFormat, region]),

			// ----- Odds: Get Raw Board -----
			...returnAllAndLimit('board', 'getRaw'),
			filters('board', 'getRaw', [
				{
					displayName: 'Bookmaker or Exchange Names or IDs',
					name: 'bookmakers',
					type: 'multiOptions',
					description:
						'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					typeOptions: { loadOptionsMethod: 'getVenues' },
					default: [],
					hint: 'Only prices from these bookmakers and exchanges',
				},
				eventIdsList,
				{
					displayName: 'Exchanges Only',
					name: 'exchangesOnly',
					type: 'boolean',
					default: false,
					description: 'Whether to return exchange prices only',
				},
				{
					displayName: 'Leagues',
					name: 'leagues',
					type: 'string',
					default: '',
					placeholder: 'e.g. soccer_epl',
					description: 'Comma-separated competition keys',
				},
				marketsList,
				{
					displayName: 'Required Bookmaker or Exchange Names or IDs',
					name: 'requireBookmakers',
					type: 'multiOptions',
					description:
						'Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					typeOptions: { loadOptionsMethod: 'getVenues' },
					default: [],
					hint: 'Only events that every one of these carries',
				},
				sportsList,
				...startTimes,
				{
					displayName: 'Updated Since',
					name: 'updatedSince',
					type: 'dateTime',
					default: '',
					description: 'Only prices that changed at or after this time',
				},
			]),
			options('board', 'getRaw', [dateFormat, includeLinks, includeLiquidity, oddsFormat, region]),

			// ----- Odds: Get Event Odds -----
			{
				displayName: 'Event ID',
				name: 'eventId',
				type: 'string',
				required: true,
				displayOptions: show('event', ['getOdds']),
				default: '',
				placeholder: 'e.g. or_evt_da71d5873e85',
				description: 'The event ID, from the Event resource or a board',
			},
			options('event', 'getOdds', [dateFormat, includeLinks, includeLiquidity, oddsFormat, region]),

			// ----- Event: Get Many -----
			{
				displayName: 'Sport',
				name: 'sport',
				type: 'resourceLocator',
				required: true,
				displayOptions: show('event', ['getAll']),
				default: { mode: 'list', value: '' },
				description: 'The sport or competition whose events to get',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Select a sport...',
						typeOptions: { searchListMethod: 'searchSports', searchable: true },
					},
					{
						displayName: 'By Key',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. soccer_epl',
						validation: [
							{
								type: 'regex',
								properties: {
									regex: '^[a-z0-9_.-]+$',
									errorMessage: 'Use a lowercase key such as soccer or soccer_epl',
								},
							},
						],
					},
				],
			},
			...returnAllAndLimit('event', 'getAll'),
			filters('event', 'getAll', [eventIdsList, ...startTimes]),
			options('event', 'getAll', [dateFormat, region]),

			// ----- Sport: Get Many -----
			...returnAllAndLimit('sport', 'getAll'),
			options('sport', 'getAll', [region]),

			// ----- Bookmaker: Get Many -----
			...returnAllAndLimit('bookmaker', 'getAll'),

			// ----- Coverage: Get -----
			options('coverage', 'get', [region]),
		],
	};

	methods = {
		loadOptions: {
			async getBookmakers(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await venueOptions.call(this, false);
			},
			async getExchanges(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await venueOptions.call(this, true);
			},
			async getVenues(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				return await venueOptions.call(this);
			},
		},
		listSearch: {
			async searchSports(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				const page = await apiGet.call(this, '/v2/sports', { cursor: paginationToken });
				const term = filter?.trim().toLowerCase();
				const results = rowsOf(page)
					.map((s) => ({
						name: s.group && s.group !== s.title ? `${s.group}: ${s.title}` : String(s.title),
						value: String(s.key),
					}))
					.filter((s) => !term || s.name.toLowerCase().includes(term) || s.value.includes(term));
				return { results, paginationToken: nextCursor(page) };
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const rows = await run.call(this, `${resource}:${operation}`, i);
				for (const json of rows) returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Both constructors hand back an error of their own kind unchanged, so nothing is wrapped twice.
				if (error instanceof NodeOperationError)
					throw new NodeOperationError(this.getNode(), error);
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}

/** One input item's resource and operation, as output rows. */
async function run(this: IExecuteFunctions, op: string, i: number): Promise<IDataObject[]> {
	const filters = (key: string) => this.getNodeParameter(key, i, {}) as IDataObject;
	const many = () => ({
		returnAll: this.getNodeParameter('returnAll', i, false) as boolean,
		limit: this.getNodeParameter('limit', i, 50) as number,
	});

	switch (op) {
		case 'board:getMatched': {
			const board = this.getNodeParameter('board', i) as string;
			const f = filters('filters');
			const qs = {
				...timeFilters(f),
				...filters('options'),
				sports: splitList(f.sports),
				markets: splitList(f.markets),
				bookmakers: f.bookmakers,
				exchanges: f.exchanges,
			};
			const guard = tokenGuard.call(this, i);
			const res = await spend.call(this, `/v2/odds/${encodeURIComponent(board)}`, qs, guard, i);
			if (guard.mode === 'quote') return [res];
			return cut(rowsOf(res), many());
		}

		case 'board:getRaw': {
			const f = filters('filters');
			const { returnAll, limit } = many();
			const qs: IDataObject = {
				...timeFilters(f),
				...filters('options'),
				sports: splitList(f.sports),
				leagues: splitList(f.leagues),
				markets: splitList(f.markets),
				eventIds: splitList(f.eventIds),
				bookmakers: f.bookmakers,
				requireBookmakers: f.requireBookmakers,
				updatedSince: isoTime(f.updatedSince),
				exchangesOnly: f.exchangesOnly ? 'true' : undefined,
				// The page size sets the price, so ask for no more rows than will be returned.
				limit: returnAll ? RAW_PAGE_MAX : Math.min(limit, RAW_PAGE_MAX),
			};
			const guard = tokenGuard.call(this, i);
			if (guard.mode === 'quote') return [await spend.call(this, '/v2/odds/raw', qs, guard, i)];
			return await paged.call(this, '/v2/odds/raw', qs, { returnAll, limit }, i, guard);
		}

		case 'event:getOdds': {
			const id = (this.getNodeParameter('eventId', i) as string).trim();
			if (!id) {
				throw new NodeOperationError(this.getNode(), "'Event ID' is empty", {
					itemIndex: i,
					description:
						'Enter an event ID, such as one from the Event resource, Get Many operation.',
				});
			}
			const path = `/v2/odds/event/${encodeURIComponent(id)}`;
			return [await spend.call(this, path, filters('options'), tokenGuard.call(this, i), i)];
		}

		case 'event:getAll': {
			const sport = String(this.getNodeParameter('sport', i, '', { extractValue: true })).trim();
			if (!sport) {
				throw new NodeOperationError(this.getNode(), "'Sport' is empty", {
					itemIndex: i,
					description: 'Choose a sport from the list, or enter a key such as soccer_epl.',
				});
			}
			const f = filters('filters');
			const qs = {
				...timeFilters(f),
				...filters('options'),
				sport,
				eventIds: splitList(f.eventIds),
			};
			return await paged.call(this, '/v2/events', qs, many(), i);
		}

		case 'sport:getAll':
			return await paged.call(this, '/v2/sports', filters('options'), many(), i);

		case 'bookmaker:getAll':
			return cut(rowsOf(await apiGet.call(this, '/v2/bookmakers', {}, i)), many());

		case 'coverage:get':
			return [await apiGet.call(this, '/v2/coverage', filters('options'), i)];

		case 'account:getUsage':
			return [await apiGet.call(this, '/v2/usage', {}, i)];
	}
	throw new NodeOperationError(this.getNode(), `The operation "${op}" is not known`, {
		itemIndex: i,
	});
}

function tokenGuard(this: IExecuteFunctions, i: number): TokenGuard {
	const mode = this.getNodeParameter('tokenSpend', i, 'cap') as TokenGuard['mode'];
	const budget = mode === 'cap' ? (this.getNodeParameter('maxTokens', i, 500) as number) : Infinity;
	return { mode, budget };
}

function timeFilters(f: IDataObject): IDataObject {
	return {
		commenceTimeFrom: isoTime(f.commenceTimeFrom),
		commenceTimeTo: isoTime(f.commenceTimeTo),
	};
}

function rowsOf(page: IDataObject): IDataObject[] {
	return Array.isArray(page.data) ? (page.data as IDataObject[]) : [];
}

function nextCursor(page: IDataObject): string | undefined {
	const meta = page.meta as IDataObject | undefined;
	return typeof meta?.next_cursor === 'string' && meta.next_cursor ? meta.next_cursor : undefined;
}

function cut(
	rows: IDataObject[],
	{ returnAll, limit }: { returnAll: boolean; limit: number },
): IDataObject[] {
	return returnAll ? rows : rows.slice(0, limit);
}

/**
 * Rows from a cursor-paged route, until the last page or the limit. With a token guard each page is priced first;
 * a later page over the budget ends the paging with the rows already read, and a hint says so.
 */
async function paged(
	this: IExecuteFunctions,
	path: string,
	qs: IDataObject,
	want: { returnAll: boolean; limit: number },
	i: number,
	guard?: TokenGuard,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	let cursor: string | undefined;
	do {
		const query = { ...qs, cursor };
		let page: IDataObject;
		try {
			page = guard
				? await spend.call(this, path, query, guard, i)
				: await apiGet.call(this, path, query, i);
		} catch (error) {
			if (error instanceof OverBudgetError && rows.length > 0) {
				this.addExecutionHints({
					message: `Stopped after ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}: the next page is priced at ${error.quote.cost} tokens, above what is left of 'Max Tokens'. Raise it, or narrow the filters.`,
					location: 'outputPane',
				});
				break;
			}
			if (error instanceof NodeOperationError) throw new NodeOperationError(this.getNode(), error);
			throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
		}
		rows.push(...rowsOf(page));
		cursor = nextCursor(page);
	} while (cursor && (want.returnAll || rows.length < want.limit));
	return cut(rows, want);
}

async function venueOptions(
	this: ILoadOptionsFunctions,
	exchanges?: boolean,
): Promise<INodePropertyOptions[]> {
	const venues = rowsOf(await apiGet.call(this, '/v2/bookmakers'));
	return venues
		.filter((v) => exchanges === undefined || Boolean(v.is_exchange) === exchanges)
		.map((v) => ({
			name:
				exchanges === undefined && v.is_exchange ? `${String(v.name)} (exchange)` : String(v.name),
			value: String(v.key),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
