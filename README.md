# n8n-nodes-oddsrelay

An [n8n](https://n8n.io/) community node for [OddsRelay](https://oddsrelay.io), the pre-match odds API for UK and
Irish bookmakers, with Betfair, Smarkets, Matchbook and BETDAQ lay prices. Read matched boards (bookmaker back
prices paired with exchange lay prices), the raw board of every price, one event's prices, and the sport, event
and bookmaker lists behind them, in any workflow or as a tool for an n8n AI Agent.

Every call that spends tokens can ask the API for its price first, which is free, and stop above a cap you set,
so a workflow or an agent cannot run down your token balance by accident.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) ·
[Token Spend](#token-spend) · [Use with AI agents](#use-with-ai-agents) · [Example workflows](#example-workflows) ·
[Errors](#errors) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

Follow n8n's [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).
In short: Settings, Community Nodes, Install, then enter `n8n-nodes-oddsrelay`.

## Credentials

You need an OddsRelay API key.

1. Sign up at [app.oddsrelay.io/signup](https://app.oddsrelay.io/signup) and copy your key from the dashboard.
   Free gives you 50,000 tokens for 14 days from sign-up, with no card, then no tokens until you choose a plan,
   on the same key. [Plans and token prices](https://oddsrelay.io/pricing).
2. In n8n, create an **OddsRelay API** credential and paste the key into **API Key**.
3. Save. n8n tests the key by reading your account's usage, which costs no tokens.

The node sends the key only to `https://api.oddsrelay.io`, in the `Authorization: Bearer` header. n8n stores it
encrypted, and the node never writes it to its output or its error messages.

## Operations

| Resource | Operation | What it returns | Tokens |
|---|---|---|---|
| Board | Get Matched | One item per event on a matched board: Standard, 2Up, Dutching, Each Way, Extra Place or BOG. Filter by sports, bookmakers, exchanges, markets and start time | Spends; Token Spend applies |
| Board | Get Raw | One item per event with every bookmaker and exchange price. Filter by sports, leagues, bookmakers, markets, event IDs, start time and last change; paged | Spends; Token Spend applies |
| Event | Get Many | The upcoming events of one sport, with their IDs; paged | None |
| Event | Get Odds | One event's prices at every bookmaker and exchange that carries it | Spends; Token Spend applies |
| Sport | Get Many | Sport and competition keys, for the sport filters; paged | None |
| Bookmaker | Get Many | Bookmaker and exchange keys, for the bookmaker filters | None |
| Coverage | Get | Which bookmakers and exchanges carry which sports on each board | None |
| Account | Get Usage | Your plan, token balance, reset time and the key's scope | None |

Lists take **Return All** or a **Limit**. The bookmaker and exchange filters load their choices from the API, and
the sport for Event, Get Many can be picked from a searchable list or typed as a key such as `soccer_epl`. Most
operations also take a **Region** (left empty, the API uses `uk`); the odds operations take an **Odds Format**
(decimal or moneyline) and a **Date Format** (ISO 8601 or Unix seconds).

## Token Spend

Board, Get Matched; Board, Get Raw; and Event, Get Odds spend tokens from your account. Their **Token Spend**
setting decides how:

- **Check Price First** (the default): the node asks the API what the call costs (a quote, which spends nothing)
  and makes the call only if the price fits in **Max Tokens**. Otherwise it stops with the price, and nothing is
  spent. Max Tokens is the most the node may spend per input item: when Get Raw pages through results, each page is
  priced first, and a page that would go over stops the paging, keeps the rows already read and says so.
- **Price Only**: returns the quote (`cost`, `remaining`, `rate_card`) and spends nothing. Use it to see what a set
  of filters costs before you schedule it.
- **No Check**: makes the call without asking its price.

The price is set by the filters you send: one sport and a few bookmakers cost less than a whole board.
Cutting the output with Limit on Get Matched does not change the price; on Get Raw, Limit sets the page size, so a
smaller Limit is cheaper.

## Use with AI agents

The node is usable as a tool, so an n8n AI Agent can call it: add **OddsRelay** under the agent's Tool connection
and let the model fill the parameters you choose. Leave Token Spend on Check Price First with a small Max Tokens:
when a call would cost more, the agent gets the price and a note to narrow the filters, and nothing is spent.
Give the agent Sport, Get Many and Bookmaker, Get Many as tools too, so it can look up the keys the other
operations take.

If OddsRelay does not appear among the agent's tools on a self-hosted n8n, check n8n's documentation for your
version on using community nodes as tools.

## Example workflows

**A matched board for one sport.** [`examples/matched-board.json`](examples/matched-board.json) is a workflow you
can import (Workflows, Import from File): a manual trigger, then OddsRelay reading the Standard board for soccer at
Ladbrokes and William Hill, the `h2h` market only, capped at 500 tokens, first 20 events. Pick your OddsRelay
API credential on the OddsRelay node, then run it. Each output item is one event, with its markets, the back price
at each bookmaker and the lay prices beside them.

**Odds into a sheet on a schedule.** Schedule Trigger, then OddsRelay (Board, Get Matched, with your filters),
then Google Sheets (Append or Update Row), mapping `event_id`, `commence_time` and the prices you need. Run Board,
Get Matched once with Token Spend set to Price Only to see what each run will cost.

**An odds assistant.** Chat Trigger, then an AI Agent with a chat model and OddsRelay as a tool (Board, Get
Matched with Token Spend on Check Price First, plus Sport, Get Many and Bookmaker, Get Many). Ask it, for example,
which of tonight's events have prices at the bookmakers you name.

## Output

Lists come back as one n8n item per row: per event for the boards and events, per sport, per bookmaker or
exchange. Coverage, Account and Event, Get Odds come back as one item. Fields keep the API's names, such as
`event_id`, `commence_time`, `markets` and `outcomes`; see the [API docs](https://oddsrelay.io/docs).

## Errors

| What happened | What the node says |
|---|---|
| The key was not accepted (401) | Check the API key in the OddsRelay credential |
| Not enough tokens left (402) | The price and your balance, as the API states them, and that nothing was spent |
| The key's plan does not include the data asked for (403) | The API's reason, and to check your plan with Account, Get Usage |
| A filter value the API does not know (400) | The API's message and, where it sends them, the values it accepts |
| Too many requests (429) | The node waits for the time the API asks (up to a minute) and tries again, up to three tries in all; then it says how long to wait |
| A call priced above Max Tokens | The price and what is left of Max Tokens; nothing was spent |

Every error from the API carries its request ID. Turn on the node's **On Error** setting (Continue) to get errors
as output items instead of stopping the workflow.

## Compatibility

Built with n8n's `@n8n/node-cli` 0.50.2 against `n8n-workflow` 2.41, on n8n's community node API version 1. It
has no runtime dependencies.

## Develop

```sh
npm ci --ignore-scripts
npm run lint
npm test            # builds, then runs the node against the API's example responses; no network calls
npm run dev         # n8n with this node loaded, for trying it by hand
```

`test/smoke.mjs` makes a few real calls through the built node with your own key:
`ODDSRELAY_KEY=your_key node test/smoke.mjs` after `npm run build`. It spends a handful of tokens at most.

## Resources

- [OddsRelay API docs](https://oddsrelay.io/docs)
- [OddsRelay](https://oddsrelay.io) and [plans](https://oddsrelay.io/pricing)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- The [`oddsrelay`](https://www.npmjs.com/package/oddsrelay) TypeScript client and the
  [`oddsrelay-mcp`](https://www.npmjs.com/package/oddsrelay-mcp) server for other AI tools
- Contact: hello@oddsrelay.io

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
