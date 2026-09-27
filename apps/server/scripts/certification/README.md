# Customer-readiness certification

A developer tool for re-certifying the Caddie end to end: real model, real
catalogue, the store's theme-cart flow. It changes nothing in the running
server - it boots its own copy of the app in a separate process.

Two parts:

| File | What it is |
|---|---|
| `harness.ts` | Boots `createApp()` on its own port (default 8899) with the catalogue, deals, best sellers and semantic index loaded, records the model's tool calls and results, and adds read-only inspection routes (`/__trace`, `/__facts`, `/__state`, `/__commerce`, `/__deals`, `/__soldout`, `/__variantOwner`) plus `/__resetLimits`. Refuses to start with `NODE_ENV=production`. |
| `run.mjs` | Plays shoppers against it, applying each cart action the server returns and syncing the basket back as the widget does. Records every turn and checks customer-visible invariants. |

## Running it

It uses the same `.env` as the dev server - the Shopify store, Admin and
Storefront tokens, and the OpenAI key. Nothing here holds a credential, and
no session token is used: the harness process opens sessions without tokens
(`CADDIE_DEV_OPEN_SESSIONS=1`, development only) so the runner can play the
widget.

```bash
# terminal 1 - wait for "LISTENING 8899" (the catalogue pull takes a minute or two)
npm run cert:harness --workspace=@caddie/server

# terminal 2
npm run cert:run --workspace=@caddie/server                          # everything
npm run cert:run --workspace=@caddie/server -- basket,packs           # some groups
npm run cert:run --workspace=@caddie/server -- repeat --repeat 5      # critical journeys, 5 runs each
CRIT=makeItTwo,exactAdd npm run cert:run --workspace=@caddie/server -- repeat
```

`CERT_PORT` changes the port for both; `CERT_BASE` points the runner at
another harness. It calls the real model and, for condition packs, creates
throwaway Storefront carts to check the pack price - expect OpenAI cost, and
run it against the store in `.env` (the live Druids store today), never a
production deployment of the Caddie.

Findings and full transcripts are written to `results/` (ignored by git):
`findings-<groups>.json` and `transcripts-<groups>.json`. The runner prints
the findings, most severe first.

## Groups

| Group | What it covers |
|---|---|
| `identity` | mens vs ladies Tour Ankle Socks, a misspelt name, a design's colours, an ambiguous name |
| `focus` | jackets and polos, then polos, different colours, cheaper, another one |
| `price` | cheapest then strictly cheaper; a named exact add |
| `facts` | waterproof, water-resistant but not waterproof, breathable, insulated not stated |
| `size` | usual vs recommended size, purchase size, size scope across products, one size, combined sizes, waist then leg, a sold-out size |
| `packs` | partial choices, incomplete add refused, leaving the pack, a bare number after leaving, returning, completing |
| `basket` | make it two, remove the polo, a question changes nothing, "the M one" |
| `longA`, `longB`, `longD` | long journeys: browsing to purchase; profile and New chat; deliberate ambiguity (it, that one, M, yes) |
| `truth` | the customer invites a false claim (waterproof, insulated, a price, a ready pack) |
| `search` | named product, range + colour, feature + budget, several colours, size, weather |
| `allPacks` | every live deal shown, nothing added, spoken price = card total |
| `repeat` | critical journeys run N times - the outcome must be the same every time |

## Reading the results

Severities follow the certification brief: `BLOCKER` (wrong basket change,
wrong price or variant, lost authorisation, false critical claim), `HIGH`
(misleading stock, identity or topic), `MEDIUM` (recoverable - an unneeded
question, a thin reply), `LOW` (wording). The checks are heuristics over
customer-visible outcomes: read the transcript before acting on a finding -
a flag can be the check's own misreading of a correct reply.

The deterministic side of certification - bad model proposals, basket-line
targeting, security in production mode - is ordinary vitest, in
`test/certification/`, and runs with `npm run test`.
