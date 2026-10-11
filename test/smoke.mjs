// A few live calls through the built node, with your key from ODDSRELAY_KEY. Spends a handful of tokens at most:
// every call that spends is capped at 300 tokens, and the rest are free.
//   npm run build && ODDSRELAY_KEY=... node test/smoke.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OddsRelay } = require('../dist/nodes/OddsRelay/OddsRelay.node.js');

const key = process.env.ODDSRELAY_KEY?.trim();
if (!key) {
	console.error('Set ODDSRELAY_KEY first.');
	process.exit(2);
}

/** n8n's request helper, in miniature: the credential's Bearer header, the query string, the full response. */
function helper(apiKey) {
	return async (_credential, options) => {
		const url = new URL(options.url);
		for (const [k, v] of Object.entries(options.qs ?? {})) url.searchParams.set(k, String(v));
		const res = await fetch(url, {
			headers: { ...options.headers, Authorization: `Bearer ${apiKey}` },
		});
		const text = await res.text();
		let body = text;
		try {
			body = JSON.parse(text);
		} catch {}
		return { statusCode: res.status, headers: Object.fromEntries(res.headers), body };
	};
}

function context(params, apiKey = key) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback, opts) => {
			const v = params[name];
			if (v === undefined) return fallback;
			return opts?.extractValue && typeof v === 'object' ? v.value : v;
		},
		getNode: () => ({
			id: '1',
			name: 'OddsRelay',
			type: 'n8n-nodes-oddsrelay.oddsRelay',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => false,
		addExecutionHints: (h) => console.log('  hint:', h.message),
		helpers: { httpRequestWithAuthentication: helper(apiKey) },
	};
}

const node = new OddsRelay();
const hide = (s) => s.replaceAll(key, '[hidden]');
let failed = 0;

/** Runs one node call. With `refused`, the step passes only when the call is refused with a matching message. */
async function step(label, params, check, { apiKey = key, refused } = {}) {
	try {
		const [out] = await node.execute.call(context(params, apiKey));
		if (refused) throw new Error('expected a refusal, got data');
		const note = check(out);
		console.log(`ok   ${label}: ${out.length} item(s)${note ? `, ${note}` : ''}`);
	} catch (err) {
		if (refused?.test(err.message)) {
			console.log(`ok   ${label}: ${err.message}`);
			return;
		}
		failed++;
		console.log(`FAIL ${label}: ${hide(`${err.message} | ${err.description ?? ''}`)}`);
	}
}

const need = (cond, what) => {
	if (!cond) throw new Error(what);
};

await step('usage', { resource: 'account', operation: 'getUsage' }, (o) => {
	need(o[0].json.tokens, 'no tokens block');
});
await step(
	'sports',
	{ resource: 'sport', operation: 'getAll', returnAll: false, limit: 3 },
	(o) => {
		need(o.length === 3 && o[0].json.key, 'expected 3 sports');
	},
);
await step('bookmakers', { resource: 'bookmaker', operation: 'getAll', returnAll: true }, (o) => {
	need(
		o.some((v) => v.json.is_exchange),
		'no exchange in the catalogue',
	);
	need(
		o.some((v) => v.json.key === 'ladbrokes'),
		'ladbrokes missing',
	);
});
let eventId;
await step(
	'events',
	{
		resource: 'event',
		operation: 'getAll',
		sport: { mode: 'id', value: 'soccer' },
		returnAll: false,
		limit: 2,
	},
	(o) => {
		need(o.length === 2 && o[0].json.id, 'expected 2 events');
		eventId = o[0].json.id;
	},
);
await step('coverage', { resource: 'coverage', operation: 'get' }, (o) => {
	need(o[0].json.products?.standard, 'no standard product');
});
await step(
	'matched board, price only',
	{ resource: 'board', operation: 'getMatched', board: 'standard', tokenSpend: 'quote' },
	(o) => `priced at ${o[0].json.cost} tokens`,
);
await step(
	'matched board, capped and narrow',
	{
		resource: 'board',
		operation: 'getMatched',
		board: 'standard',
		tokenSpend: 'cap',
		maxTokens: 300,
		returnAll: false,
		limit: 2,
		filters: {
			sports: 'soccer',
			bookmakers: ['ladbrokes'],
			markets: 'h2h',
			commenceTimeFrom: new Date().toISOString(),
		},
	},
	(o) =>
		need(
			o.every((e) => e.json.markets),
			'events without markets',
		),
);
await step(
	'matched board, refused above the cap',
	{
		resource: 'board',
		operation: 'getMatched',
		board: 'standard',
		tokenSpend: 'cap',
		maxTokens: 1,
	},
	null,
	{ refused: /above 'Max Tokens'/ },
);
await step(
	'event odds, price only',
	{
		resource: 'event',
		operation: 'getOdds',
		eventId: eventId ?? 'or_evt_missing',
		tokenSpend: 'quote',
	},
	(o) => `priced at ${o[0].json.cost} tokens`,
);
await step(
	'raw board, price only',
	{
		resource: 'board',
		operation: 'getRaw',
		tokenSpend: 'quote',
		returnAll: false,
		limit: 5,
		filters: { exchangesOnly: true },
	},
	(o) => `priced at ${o[0].json.cost} tokens`,
);
try {
	// Soccer starts several pages into the sport list, so this checks the search reads on.
	const r = await node.methods.listSearch.searchSports.call(context({}), 'england premier');
	need(
		r.results.some((s) => s.value === 'soccer_england_premier_league'),
		'England Premier League not found',
	);
	console.log(`ok   sport search: ${r.results.length} match(es)`);
} catch (err) {
	failed++;
	console.log(`FAIL sport search: ${hide(err.message)}`);
}
await step('a wrong key is refused clearly', { resource: 'account', operation: 'getUsage' }, null, {
	apiKey: 'not-a-real-key',
	refused: /did not accept the API key/,
});

console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed ? 1 : 0);
