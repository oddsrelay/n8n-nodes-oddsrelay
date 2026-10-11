# Submitting n8n-nodes-oddsrelay

What goes where, in order. Sources, read on 11 Oct 2026:

- https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/ (standards, provenance, the
  Creator Portal)
- https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/ (technical rules)
- https://docs.n8n.io/integrations/creating-nodes/build/reference/ux-guidelines/ (UX rules)
- https://docs.n8n.io/integrations/creating-nodes/build/n8n-node/ (the `n8n-node` tool)
- https://github.com/n8n-io/n8n-nodes-starter/blob/master/.github/workflows/publish.yml (the publish workflow)
- https://github.blog/changelog/ (2 Oct 2026: unvalidated npm trusted publishing configurations now expire)

## 1. Where it stands

| Rule (n8n) | State |
|---|---|
| Name `n8n-nodes-*`, keyword `n8n-community-node-package`, `n8n` block in package.json | Done |
| Scaffolded with `n8n-node` (`@n8n/node-cli` 0.50.2, at least 0.23.0 needed for provenance) | Done |
| `npm run lint` (n8n's rules, cloud mode on) | Passes, no warnings |
| `@n8n/scan-community-package` 0.38.0, both legs (source and packed package) run locally | Both pass. The full scan also needs the provenance statement, so it can only run after the first publish (step 4) |
| No runtime dependencies, no environment variables or files in the node, English only, MIT | Done |
| A credential with a test request, the key in a password field | Done (`/v2/usage`, which costs no tokens) |
| README with usage, example workflow and authentication | Done (`README.md`, `examples/matched-board.json`) |
| Published from GitHub Actions with provenance | `.github/workflows/publish.yml`, waiting on the push |
| Repository public, its URL equal to package.json's `repository` | Waiting on `github.com/oddsrelay` being visible again |
| npm author or maintainer equal to the repository's | package.json author: OddsRelay, hello@oddsrelay.io; the npm account `oddsrelay` is on hello@oddsrelay.io |

## 2. Push the repository (after `github.com/oddsrelay` answers again)

```sh
cd /Users/omfp/Dev/oddsrelay-oss/n8n-nodes-oddsrelay && gh auth switch && gh repo create oddsrelay/n8n-nodes-oddsrelay --public --description "n8n community node for the OddsRelay odds API" --homepage https://oddsrelay.io --source . --remote origin --push; gh auth switch
```

The CI workflow runs lint, build and tests on that push. No secrets are needed for it.

## 3. npm trusted publishing (one time)

On npmjs.com, signed in as `oddsrelay`: try to add a trusted publisher for the package name
`n8n-nodes-oddsrelay`: GitHub Actions, owner `oddsrelay`, repository `n8n-nodes-oddsrelay`, workflow
`publish.yml`, no environment. A new trusted-publisher setting lapses if it is not used within 48 hours, so do
step 4 the same day.

If npm will not take a trusted publisher before the package exists: create a granular access token (read and
write, for new packages), save it in the GitHub repository as the Actions secret `NPM_TOKEN`, do step 4, then
delete the secret and the token and add the trusted publisher on the now-existing package. The release still
carries provenance either way.

## 4. Release 0.1.0

```sh
cd /Users/omfp/Dev/oddsrelay-oss/n8n-nodes-oddsrelay && git tag 0.1.0 && gh auth switch && git push origin 0.1.0; gh auth switch
```

The tag has no `v`: n8n's workflow and release tool use bare versions. The Publish workflow checks the tag equals
package.json's version, tests, lints, builds and publishes with provenance. Then check it:

```sh
npx @n8n/scan-community-package n8n-nodes-oddsrelay
```

It must end with "has passed all security checks". Later releases: `npm run release` on this Mac bumps the
version, writes the changelog, tags and pushes; the workflow publishes.

## 5. Creator Portal (verification)

Sign up at https://creators.n8n.io with hello@oddsrelay.io: the portal account, the npm owner and package.json's
author email should be the same address. Then submit the node. Texts for the form:

**Name:** OddsRelay

**npm package:** n8n-nodes-oddsrelay

**Repository:** https://github.com/oddsrelay/n8n-nodes-oddsrelay

**Short description** (the node's own, 109 characters):
Read pre-match odds from UK and Irish bookmakers and exchanges: matched boards, raw prices, events and sports

**Long description:**
OddsRelay is a pre-match odds API for UK and Irish bookmakers, with Betfair, Smarkets, Matchbook and BETDAQ lay
prices. This node reads it in any workflow or as an AI Agent tool: matched boards (bookmaker back prices paired
with exchange lay prices, on Standard, 2Up, Dutching, Each Way, Extra Place and BOG boards), the raw board of every
bookmaker and exchange price, one event's prices, and the sport, event, bookmaker, coverage and account lists
behind them. Calls that spend tokens can ask the API for their price first, which is free, and stop above a cap
the user sets, so a workflow or an agent cannot run down the account by accident. One credential (an API key,
tested against a free route), no runtime dependencies.

**Categories:** Data & Storage, Development

**Documentation:** https://github.com/oddsrelay/n8n-nodes-oddsrelay#readme

**Service docs:** https://oddsrelay.io/docs

**Logo:** the node ships its own SVG icons (`nodes/OddsRelay/oddsrelay.svg` and `.dark.svg`, the OddsRelay mark on
a 64 by 64 view box). If the form wants a picture file, use a 400 by 400 PNG of the same mark.

**Test account for the reviewers** (if the form asks): a key made for the review alone, on an account with enough
tokens for it, never a key in use elsewhere. Free (50,000 tokens for 14 days from sign-up) covers a review that
keeps the default cap.

**How to test it** (for a notes field):
1. Create an OddsRelay API credential with the key; the credential test reads `/v2/usage`, which costs no tokens.
2. Account, Get Usage: one item with the plan and balance.
3. Bookmaker, Get Many and Sport, Get Many: free lists.
4. Board, Get Matched, Standard, Sports `soccer`, Bookmakers Ladbrokes and William Hill, Token Spend Check Price First: priced first,
   then one item per event. With no filters it stops with the price above Max Tokens and spends nothing.
5. Import `examples/matched-board.json` for a ready workflow.

**Demo video** (if asked; a short screen recording, a minute or two): the credential test passing; Account, Get Usage;
Board, Get Matched with Token Spend set to Price Only (the price, nothing spent); the same with Check Price First
and narrow filters (events out); the same with no filters (refused with the price); an AI Agent asking a question
with the node as a tool.

## 6. After it is verified

n8n lists verified nodes in the nodes panel, including on n8n Cloud. Record the outcome as `devrel: done L45`
with the listing URL.
