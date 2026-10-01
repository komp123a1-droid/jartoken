# $JAR backend — the swear jar

Every sell is a swear. At 00:00 UTC the jar is shared, in SOL, with the clean mouths.

```
Helius webhook ──► ledger (SQLite) ──► swear bot (Telegram / X)
                        │
   00:00 UTC cron ──► collector: snapshot ≥100,000 $JAR − sinners − excluded ──► batch SOL payouts
                        │
                     public API ──► swearjar.fun
```

## Run

```
npm install
cp .env.example .env     # MODE=mock works with no keys
npm start                # http://127.0.0.1:8788
npm test                 # end-to-end self-test in mock mode
npm run simulate         # full-day simulation over HTTP: 600+ trades, collection, crash/timeout recovery (53 checks)
npm run localnet     # real local validator (docker): real token, trades, SOL payouts, killed process mid-payout (27 checks)
node scripts/devnet-test.js offline   # real payout code on an in-memory chain with Solana rules (atomic tx, rent, 1232 B)
node scripts/devnet-test.js all       # same on devnet; needs ~1 SOL on the devnet payout wallet (faucet.solana.com)
npm run collect          # manual collection for yesterday (dry run)
```

## Parts

| file | what it does |
|---|---|
| `src/ledger.js` | Parses Helius enhanced txs. Any $JAR leaving a wallet = swear (sell or transfer, v1). Dedupes by signature. Keeps sinners per UTC day. |
| `src/swearbot.js` | Sister Agnes reads each swear aloud. Telegram gets all; X only sells ≥ `X_MIN_TOKENS`, max `X_MAX_PER_HOUR`. No tokens → logged to `outbox`. |
| `src/collector.js` | Midnight collection. Jar balance − reserve, split pro rata among holders ≥ threshold who did not swear, minus excluded wallets. Shares < 0.001 SOL stay in the jar. Idempotent per day. |
| `src/solana.js` | Balance, holder snapshot (Helius DAS `getTokenAccounts`; without Helius: `getProgramAccounts` over Token + Token-2022), batched `SystemProgram.transfer` payouts, creator-fee claim from both pump vaults via the official `@pump-fun/pump-sdk` (bonding curve + PumpSwap; WSOL unwrapped). |
| `src/chain.js` | `live` or `mock`. Mock produces fake trades in the exact Helius shape, so the same code path is exercised. |
| `src/api.js` | `GET /api/state`, `/api/feed`, `/api/wallet/:addr`, `/api/collections[/:day]`, `POST /webhook/helius`. |
| `src/db.js` | Tables: `events`, `sinners`, `collections`, `payouts`, `outbox`. |

## Going live

1. Launch on pump.fun with the jar wallet as creator. Set `MINT`.
2. `PAYOUT_KEYPAIR` = jar wallet keypair file. Hot wallet: keep about one day of fees in it.
3. `EXCLUDED_WALLETS` = bonding curve, pool, dev, burn.
4. Helius dashboard → webhook (enhanced, account = mint) → `https://<host>/webhook/helius`, auth header = `WEBHOOK_SECRET`.
5. `MODE=live`, keep `DRY_RUN=true` for the first day, check `/api/collections/<day>`, then `DRY_RUN=false`.

Payout safety: every tx is signed before sending and its signature stored (`sending`); a send/confirm error is resolved on-chain (landed / failed / expired) before anything is re-sent; a crashed or partial day resumes with the original amounts. A batch that fails on-chain is retried one transfer per tx. MIN_PAYOUT_SOL has a rent floor (0.00089), BATCH_SIZE a 21 cap (tx size). Tx fees (5000 lamports/tx) come out of the pot, the reserve stays whole.

Known limits (v1): moving tokens between your own wallets counts as a sell. Fee claim is tested on the real pump programs cloned from mainnet (npm run pump-validator && npm run pump-test): launch, curve trades, claim, graduation to PumpSwap, AMM trades, AMM-vault claim, midnight split.
