import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

export const BASE_URL = 'https://api.oddsrelay.io';

/** The `info.version` of the OpenAPI file this node was written against. */
export const CONTRACT_VERSION = '2026-07-08';

const MAX_TRIES = 3;
/** A longer Retry-After is passed to the user rather than waited out: the API's rate windows are a minute at most. */
const MAX_WAIT_S = 60;

type Context = IExecuteFunctions | ILoadOptionsFunctions;

/** What a `quote=true` call returns instead of data. */
export interface Quote extends IDataObject {
	cost: number;
	remaining: number | string | null;
	rate_card: string;
}

/** How a call that spends tokens is guarded. */
export interface TokenGuard {
	mode: 'cap' | 'quote' | 'spend';
	/** The most tokens this item may spend, in 'cap' mode. */
	budget: number;
}

/** Drops empty values and joins lists into the comma lists the API takes. */
export function cleanQuery(qs: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [name, value] of Object.entries(qs)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value)) {
			if (value.length) out[name] = value.join(',');
			continue;
		}
		out[name] = value;
	}
	return out;
}

/** Splits a comma list typed by a user ("soccer, tennis") into keys. */
export function splitList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value !== 'string') return [];
	return value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** A Date & Time field's value (a string, a Date or a Luxon DateTime) as the ISO 8601 UTC time the API takes. */
export function isoTime(value: unknown): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const text = value instanceof Date ? value.toISOString() : String(value).trim();
	const t = new Date(text);
	return Number.isNaN(t.getTime()) ? text : t.toISOString().replace('.000Z', 'Z');
}

function header(res: IN8nHttpFullResponse, name: string): string | undefined {
	const v = res.headers[name] ?? res.headers[name.toLowerCase()];
	return v === undefined || v === null ? undefined : String(v);
}

/** One GET to the API with the credential's key, gzip, and up to three tries on 429. */
export async function apiGet(
	this: Context,
	path: string,
	qs: IDataObject = {},
	itemIndex = 0,
): Promise<IDataObject> {
	const options: IHttpRequestOptions = {
		method: 'GET',
		url: `${BASE_URL}${path}`,
		qs: cleanQuery(qs),
		headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	for (let attempt = 1; ; attempt++) {
		const res = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'oddsRelayApi',
			options,
		)) as IN8nHttpFullResponse;
		if (res.statusCode === 429 && attempt < MAX_TRIES) {
			const wait = Number(header(res, 'retry-after') ?? 1);
			if (Number.isFinite(wait) && wait >= 0 && wait <= MAX_WAIT_S) {
				await sleep(Math.max(wait, 1) * 1000);
				continue;
			}
		}
		if (res.statusCode >= 400) throw toNodeError.call(this, res, itemIndex);
		const body = res.body;
		return body && typeof body === 'object' && !Array.isArray(body) ? (body as IDataObject) : {};
	}
}

/** Turns an API reply of 400 or more into an error that says what happened and what to change. */
function toNodeError(this: Context, res: IN8nHttpFullResponse, itemIndex: number): NodeApiError {
	const body = (res.body && typeof res.body === 'object' ? res.body : {}) as IDataObject;
	const error = (body.error && typeof body.error === 'object' ? body.error : {}) as IDataObject;
	const code = typeof error.code === 'string' ? error.code : `http_${res.statusCode}`;
	const apiMessage = typeof error.message === 'string' ? error.message : undefined;
	const requestId =
		typeof error.request_id === 'string' ? error.request_id : header(res, 'x-oddsrelay-request-id');
	const ref = requestId ? ` Request ID: ${requestId}.` : '';
	let message = apiMessage ?? `The OddsRelay API answered with HTTP ${res.statusCode}`;
	let description: string;

	switch (res.statusCode) {
		case 401:
			message = 'The OddsRelay API did not accept the API key';
			description =
				'Check the API key in the OddsRelay credential. You can copy your key from your dashboard at https://app.oddsrelay.io.' +
				ref;
			break;
		case 402: {
			const cost =
				typeof error.cost === 'number' ? `${error.cost} tokens` : 'more tokens than are left';
			const plans =
				typeof error.upgrade_url === 'string' ? error.upgrade_url : 'https://oddsrelay.io/pricing';
			message = 'Not enough tokens left for this call';
			description = `${apiMessage ?? `This call costs ${cost}.`} Nothing was spent. Plans: ${plans}.${ref}`;
			break;
		}
		case 429: {
			const wait = header(res, 'retry-after');
			message = 'Too many requests to the OddsRelay API';
			description =
				`The node waited and tried again ${MAX_TRIES - 1} times. ${wait ? `Wait ${wait} seconds, then` : 'Wait a minute, then'} run the node again, or space out the calls in your workflow.` +
				ref;
			break;
		}
		case 403:
			description =
				'This key cannot read this data. Check the products and regions your plan includes with the Account resource, Get Usage operation.' +
				ref;
			break;
		default: {
			const valid = Array.isArray(error.valid)
				? ` Accepted values: ${error.valid.join(', ')}.`
				: '';
			description = `${apiMessage ?? 'Try again shortly.'}${valid} Code: ${code}.${ref}`;
		}
	}
	return new NodeApiError(this.getNode(), { ...error, code } as JsonObject, {
		message,
		description,
		httpCode: String(res.statusCode),
		itemIndex,
	});
}

/**
 * A GET that spends tokens. In 'quote' mode it returns the price and spends nothing; in 'cap' mode it asks the
 * price first (free) and refuses when the price is above what is left of the budget, which it then lowers.
 */
export async function spend(
	this: IExecuteFunctions,
	path: string,
	qs: IDataObject,
	guard: TokenGuard,
	itemIndex: number,
): Promise<IDataObject> {
	if (guard.mode === 'quote')
		return await apiGet.call(this, path, { ...qs, quote: 'true' }, itemIndex);
	if (guard.mode === 'cap') {
		const quote = (await apiGet.call(this, path, { ...qs, quote: 'true' }, itemIndex)) as Quote;
		if (typeof quote.cost !== 'number') {
			throw new NodeOperationError(
				this.getNode(),
				'The OddsRelay API returned no price for this call',
				{
					itemIndex,
					description: "Nothing was spent. Try again, or set 'Token Spend' to 'No Check'.",
				},
			);
		}
		if (quote.cost > guard.budget) throw new OverBudgetError(this, quote, guard.budget, itemIndex);
		guard.budget -= quote.cost;
	}
	return await apiGet.call(this, path, qs, itemIndex);
}

/** The call is priced above what is left of 'Max Tokens'. Nothing was spent on it. */
export class OverBudgetError extends NodeOperationError {
	readonly quote: Quote;

	constructor(ctx: IExecuteFunctions, quote: Quote, budget: number, itemIndex: number) {
		super(
			ctx.getNode(),
			`This call is priced at ${quote.cost} tokens, above 'Max Tokens' (${budget} left)`,
			{
				itemIndex,
				description:
					"Nothing was spent on it. Narrow the filters (fewer bookmakers, one sport, a shorter time window), or raise 'Max Tokens'.",
			},
		);
		this.quote = quote;
	}
}
