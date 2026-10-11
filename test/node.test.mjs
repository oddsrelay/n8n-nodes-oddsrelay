// Runs the built node against the contract's example responses through a stubbed n8n context. No network calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { OddsRelay } = require('../dist/nodes/OddsRelay/OddsRelay.node.js');
const { OddsRelayApi } = require('../dist/credentials/OddsRelayApi.credentials.js');
const { cleanQuery, isoTime, CONTRACT_VERSION } = require('../dist/nodes/OddsRelay/transport.js');

const fixture = (name) =>
	JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ok = (body, headers = {}) => ({ status: 200, body, headers });
const quote = (cost) => ok({ cost, remaining: 'unlimited', rate_card: '2026-09' });
const page = (rows, next) => ok({ meta: { count: rows.length, next_cursor: next }, data: rows });

/** A stand-in for n8n's execute and load-options contexts. Replies are served in order. */
function context(params, replies, { items = [{ json: {} }], continueOnFail = false } = {}) {
	const calls = [];
	const hints = [];
	const ctx = {
		getInputData: () => items,
		getNodeParameter(name, _i, fallback, opts) {
			const v = params[name];
			if (v === undefined) return fallback;
			if (opts?.extractValue && v && typeof v === 'object' && 'value' in v) return v.value;
			return v;
		},
		getNode: () => ({
			id: '1',
			name: 'OddsRelay',
			type: 'n8n-nodes-oddsrelay.oddsRelay',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => continueOnFail,
		addExecutionHints: (...h) => hints.push(...h),
		helpers: {
			async httpRequestWithAuthentication(credential, options) {
				calls.push({ credential, ...options });
				const reply = replies.shift();
				if (!reply) throw new Error(`no reply queued for ${options.url}`);
				return { statusCode: reply.status, headers: reply.headers ?? {}, body: reply.body };
			},
		},
	};
	return { ctx, calls, hints };
}

const node = new OddsRelay();
const execute = (ctx) => node.execute.call(ctx);

test('the description is a tool-ready node with one credential', () => {
	const d = node.description;
	assert.equal(d.name, 'oddsRelay');
	assert.equal(d.usableAsTool, true);
	assert.deepEqual(d.credentials, [{ name: 'oddsRelayApi', required: true }]);
	const resources = d.properties.find((p) => p.name === 'resource').options.map((o) => o.value);
	assert.deepEqual(resources, ['account', 'board', 'bookmaker', 'coverage', 'event', 'sport']);
	assert.match(CONTRACT_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test('the credential sends the key as a Bearer header and tests against usage', () => {
	const cred = new OddsRelayApi();
	assert.equal(cred.name, 'oddsRelayApi');
	assert.equal(cred.properties[0].typeOptions.password, true);
	assert.equal(
		cred.authenticate.properties.headers.Authorization,
		'=Bearer {{$credentials.apiKey}}',
	);
	assert.equal(
		cred.test.request.baseURL + cred.test.request.url,
		'https://api.oddsrelay.io/v2/usage',
	);
});

test('matched board: priced first, then read, one item per event', async () => {
	const board = fixture('v2-odds-type.standard_filtered.json');
	const { ctx, calls } = context(
		{
			resource: 'board',
			operation: 'getMatched',
			board: 'standard',
			tokenSpend: 'cap',
			maxTokens: 500,
			returnAll: true,
			filters: { sports: 'soccer, tennis', bookmakers: ['ladbrokes', 'william_hill'], markets: '' },
			options: { region: 'uk' },
		},
		[quote(211), ok(board)],
	);
	const [out] = await execute(ctx);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].url, 'https://api.oddsrelay.io/v2/odds/standard');
	assert.equal(calls[0].credential, 'oddsRelayApi');
	assert.equal(calls[0].headers['Accept-Encoding'], 'gzip');
	assert.deepEqual(calls[0].qs, {
		region: 'uk',
		sports: 'soccer,tennis',
		bookmakers: 'ladbrokes,william_hill',
		quote: 'true',
	});
	assert.equal(calls[1].qs.quote, undefined);
	assert.equal(out.length, board.data.length);
	assert.deepEqual(out[0], { json: board.data[0], pairedItem: { item: 0 } });
});

test('matched board: a price above Max Tokens is refused and nothing else is called', async () => {
	const { ctx, calls } = context(
		{
			resource: 'board',
			operation: 'getMatched',
			board: 'standard',
			tokenSpend: 'cap',
			maxTokens: 500,
		},
		[quote(10000)],
	);
	await assert.rejects(execute(ctx), (err) => {
		assert.match(err.message, /priced at 10000 tokens, above 'Max Tokens' \(500 left\)/);
		assert.match(err.description, /Nothing was spent/);
		return true;
	});
	assert.equal(calls.length, 1);
});

test('price only returns the quote and spends nothing', async () => {
	const priced = fixture('v2-odds-type.quote.json');
	const { ctx, calls } = context(
		{ resource: 'board', operation: 'getMatched', board: 'bog', tokenSpend: 'quote' },
		[ok(priced)],
	);
	const [out] = await execute(ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].qs.quote, 'true');
	assert.deepEqual(out, [{ json: priced, pairedItem: { item: 0 } }]);
});

test('no check makes one call and the limit trims the rows', async () => {
	const board = fixture('v2-odds-type.standard_filtered.json');
	const { ctx, calls } = context(
		{
			resource: 'board',
			operation: 'getMatched',
			board: 'standard',
			tokenSpend: 'spend',
			returnAll: false,
			limit: 1,
		},
		[ok(board)],
	);
	const [out] = await execute(ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].qs.quote, undefined);
	assert.equal(out.length, 1);
});

test('raw board pages with a running budget and stops, with a hint, before a page it cannot afford', async () => {
	const raw = fixture('v2-odds-raw.page.json');
	const { ctx, calls, hints } = context(
		{
			resource: 'board',
			operation: 'getRaw',
			tokenSpend: 'cap',
			maxTokens: 100,
			returnAll: true,
			filters: { exchangesOnly: true, updatedSince: '2026-10-11T20:00:00.000Z' },
		},
		[quote(60), ok(raw), quote(60)],
	);
	const [out] = await execute(ctx);
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[0].qs, {
		exchangesOnly: 'true',
		updatedSince: '2026-10-11T20:00:00Z',
		limit: 250,
		quote: 'true',
	});
	assert.equal(calls[2].qs.cursor, raw.meta.next_cursor);
	assert.equal(out.length, raw.data.length);
	assert.equal(hints[0].message.startsWith(`Stopped after ${raw.data.length} row`), true);
	assert.match(hints[0].message, /the next page is priced at 60 tokens/);
});

test('raw board asks for no more rows than it returns', async () => {
	const { ctx, calls } = context(
		{ resource: 'board', operation: 'getRaw', tokenSpend: 'spend', returnAll: false, limit: 20 },
		[page([{ id: 'a' }], 'next'), page([{ id: 'b' }], null)],
	);
	const [out] = await execute(ctx);
	assert.equal(calls[0].qs.limit, 20);
	assert.equal(out.length, 2);
});

test('events: the sport comes from the resource locator; one page is enough for the limit', async () => {
	const events = fixture('v2-events.page.json');
	const { ctx, calls } = context(
		{
			resource: 'event',
			operation: 'getAll',
			sport: { __rl: true, mode: 'list', value: 'soccer_england_premier_league' },
			returnAll: false,
			limit: 1,
			filters: { commenceTimeFrom: '2026-10-12T00:00:00Z' },
		},
		[ok(events)],
	);
	const [out] = await execute(ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://api.oddsrelay.io/v2/events');
	assert.deepEqual(calls[0].qs, {
		commenceTimeFrom: '2026-10-12T00:00:00Z',
		sport: 'soccer_england_premier_league',
	});
	assert.equal(out.length, 1);
});

test('sports: return all follows the cursor to the last page, free of quotes', async () => {
	const sports = fixture('v2-sports.page.json');
	const { ctx, calls } = context({ resource: 'sport', operation: 'getAll', returnAll: true }, [
		ok(sports),
		page([{ key: 'tennis' }], null),
	]);
	const [out] = await execute(ctx);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].qs.cursor, sports.meta.next_cursor);
	assert.ok(calls.every((c) => c.qs.quote === undefined));
	assert.equal(out.length, sports.data.length + 1);
});

test('event odds, bookmakers, coverage and usage', async () => {
	const cases = [
		[
			{
				resource: 'event',
				operation: 'getOdds',
				eventId: ' or_evt_da71d5873e85 ',
				tokenSpend: 'spend',
			},
			'v2-odds-event-id.event.json',
			'/v2/odds/event/or_evt_da71d5873e85',
			1,
		],
		[
			{ resource: 'bookmaker', operation: 'getAll', returnAll: true },
			'v2-bookmakers.catalogue.json',
			'/v2/bookmakers',
			null,
		],
		[{ resource: 'coverage', operation: 'get' }, 'v2-coverage.keyed.json', '/v2/coverage', 1],
		[{ resource: 'account', operation: 'getUsage' }, 'v2-usage.usage.json', '/v2/usage', 1],
	];
	for (const [params, file, path, count] of cases) {
		const body = fixture(file);
		const { ctx, calls } = context(params, [ok(body)]);
		const [out] = await execute(ctx);
		assert.equal(calls[0].url, `https://api.oddsrelay.io${path}`);
		assert.equal(out.length, count ?? body.data.length, file);
		if (count === 1) assert.deepEqual(out[0].json, body);
	}
});

test('401, 402, 400 and 403 become errors that say what to change', async () => {
	const usage = { resource: 'account', operation: 'getUsage' };
	const run = async (status, file, headers) => {
		const { ctx } = context(usage, [{ status, body: fixture(file), headers }]);
		return await execute(ctx).then(
			() => assert.fail('expected a rejection'),
			(err) => err,
		);
	};
	let err = await run(401, 'error-401.invalid_api_key.json');
	assert.equal(err.constructor.name, 'NodeApiError');
	assert.equal(err.httpCode, '401');
	assert.match(err.message, /did not accept the API key/);
	assert.match(err.description, /OddsRelay credential/);
	assert.match(err.description, /Request ID: or_req_/);

	err = await run(402, 'error-402.insufficient_tokens.json');
	assert.match(err.message, /Not enough tokens/);
	assert.match(err.description, /Nothing was spent\. Plans: https:\/\/app\.oddsrelay\.io\/billing/);

	err = await run(400, 'error-400.unknown_bookmaker.json');
	assert.match(err.message, /Unknown bookmaker 'nope'/);
	assert.match(err.description, /^Accepted values: 7bet, 888sport/);
	assert.equal(err.description.includes(err.message), false, 'the description repeats the message');

	err = await run(403, 'error-403.bookmaker_not_in_plan.json');
	assert.match(err.description, /Get Usage/);
});

test('429: waits for Retry-After and tries again, then gives up after three tries', async () => {
	const usage = { resource: 'account', operation: 'getUsage' };
	const busy = { status: 429, body: '', headers: { 'retry-after': '0' } };
	const recovered = context(usage, [busy, ok({ plan: 'pro' })]);
	const [out] = await execute(recovered.ctx);
	assert.equal(recovered.calls.length, 2);
	assert.deepEqual(out[0].json, { plan: 'pro' });

	const stuck = context(usage, [busy, busy, busy]);
	await assert.rejects(execute(stuck.ctx), /Too many requests/);
	assert.equal(stuck.calls.length, 3);

	const tooLong = context(usage, [{ ...busy, headers: { 'retry-after': '3600' } }]);
	await assert.rejects(execute(tooLong.ctx), (err) => /Wait 3600 seconds/.test(err.description));
	assert.equal(tooLong.calls.length, 1);
});

test('continue on fail turns an error into an output item', async () => {
	const { ctx } = context(
		{ resource: 'account', operation: 'getUsage' },
		[{ status: 401, body: fixture('error-401.invalid_api_key.json') }],
		{ continueOnFail: true },
	);
	const [out] = await execute(ctx);
	assert.deepEqual(out, [
		{ json: { error: 'The OddsRelay API did not accept the API key' }, pairedItem: { item: 0 } },
	]);
});

test('list helpers: exchanges, venues and the sport search', async () => {
	const catalogue = fixture('v2-bookmakers.catalogue.json');
	let { ctx } = context({}, [ok(catalogue)]);
	const exchanges = await node.methods.loadOptions.getExchanges.call(ctx);
	const wanted = catalogue.data
		.filter((v) => v.is_exchange)
		.map((v) => v.key)
		.sort();
	assert.deepEqual(exchanges.map((o) => o.value).sort(), wanted);

	({ ctx } = context({}, [ok(catalogue)]));
	const venues = await node.methods.loadOptions.getVenues.call(ctx);
	assert.equal(venues.length, catalogue.data.length);

	const sports = fixture('v2-sports.page.json');
	const browse = context({}, [ok(sports)]);
	let result = await node.methods.listSearch.searchSports.call(browse.ctx);
	assert.equal(browse.calls.length, 1, 'browsing reads one page at a time');
	assert.equal(result.results.length, sports.data.length);
	assert.equal(result.paginationToken, sports.meta.next_cursor);

	// A competition on a later page is still found: a search reads on until it has matches or the list ends.
	const epl = {
		key: 'soccer_england_premier_league',
		group: 'Soccer',
		title: 'England Premier League',
	};
	const search = context({}, [ok(sports), page([epl], null)]);
	result = await node.methods.listSearch.searchSports.call(search.ctx, 'England Premier');
	assert.equal(search.calls.length, 2);
	assert.equal(search.calls[1].qs.cursor, sports.meta.next_cursor);
	assert.deepEqual(result.results, [{ name: 'Soccer: England Premier League', value: epl.key }]);
	assert.equal(result.paginationToken, undefined);
});

test('query and time helpers', () => {
	assert.deepEqual(
		cleanQuery({ a: '', b: undefined, c: null, d: [], e: ['x', 'y'], f: false, g: 0 }),
		{ e: 'x,y', f: false, g: 0 },
	);
	assert.equal(isoTime(''), undefined);
	assert.equal(isoTime('2026-10-12T18:00:00.000Z'), '2026-10-12T18:00:00Z');
	assert.equal(isoTime(new Date('2026-10-12T18:00:30.500Z')), '2026-10-12T18:00:30.500Z');
	assert.equal(isoTime('2026-10-12T19:00:00+01:00'), '2026-10-12T18:00:00Z');
});

test('the example workflow makes the narrow, capped call the README describes', async () => {
	const workflow = JSON.parse(
		readFileSync(new URL('../examples/matched-board.json', import.meta.url), 'utf8'),
	);
	const step = workflow.nodes.find((n) => n.type === 'n8n-nodes-oddsrelay.oddsRelay');
	assert.equal(step.name, workflow.connections[workflow.nodes[0].name].main[0][0].node);
	const board = fixture('v2-odds-type.standard_filtered.json');
	const { ctx, calls } = context(step.parameters, [quote(211), ok(board)]);
	const [out] = await execute(ctx);
	assert.deepEqual(calls[0].qs, {
		sports: 'soccer',
		markets: 'h2h',
		bookmakers: 'ladbrokes,william_hill',
		quote: 'true',
	});
	assert.equal(out.length, Math.min(20, board.data.length));
});

test('package.json registers exactly the built node and credential', () => {
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	assert.deepEqual(pkg.n8n.nodes, ['dist/nodes/OddsRelay/OddsRelay.node.js']);
	assert.deepEqual(pkg.n8n.credentials, ['dist/credentials/OddsRelayApi.credentials.js']);
	assert.equal(pkg.dependencies, undefined);
	assert.deepEqual(pkg.peerDependencies, { 'n8n-workflow': '*' });
	assert.ok(
		readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').includes(
			`## ${pkg.version} `,
		),
	);
});
