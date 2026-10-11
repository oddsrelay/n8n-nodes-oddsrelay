# Changelog

## 0.1.0 (unreleased)

First version, written against the OddsRelay API's OpenAPI document `2026-07-08`.

- One node, OddsRelay, with six resources: Board (Get Matched, Get Raw), Event (Get Many, Get Odds), Sport
  (Get Many), Bookmaker (Get Many), Coverage (Get) and Account (Get Usage).
- An OddsRelay API credential: the key in a password field, sent only as a Bearer header, tested against
  `/v2/usage`, which costs no tokens.
- Token Spend on the three operations that spend tokens: Check Price First (the default) asks the API for the
  price and refuses a call above Max Tokens; Price Only returns the price and spends nothing; No Check skips it.
- Return All and Limit on every list. Cursor paging for the raw board, events and sports. The raw board asks
  for no more rows than it returns.
- Bookmaker and exchange pickers loaded from the API, and a searchable sport list.
- Usable as an AI Agent tool.
- Errors that say what to change for 400, 401, 402, 403 and 429; a 429 waits for Retry-After and tries again,
  up to three tries in all.
- `Accept-Encoding: gzip` on every request.
