// Read-only check of the trade parser against REAL pump.fun / PumpSwap transactions on mainnet (needs HELIUS_API_KEY).
//   npm run real-check                    -> picks a recent pump coin on the bonding curve and a graduated one
//   npm run real-check -- <mint> [<mint>] -> specific coins
// For every recent transaction it compares what ledger.parse() decided (buy / sell / transfer) with the wallet's actual
// token balance change reported for that transaction. Nothing is sent anywhere.
process.env.DB_PATH = ":memory:";
const { PublicKey, Connection } = require("@solana/web3.js");
const P = require("@pump-fun/pump-sdk");
const A = require("@pump-fun/pump-swap-sdk");
const cfg = require("../src/config");
const { open } = require("../src/db");
const { makeLedger } = require("../src/ledger");

if (!cfg.heliusKey) { console.log("HELIUS_API_KEY missing in .env"); process.exit(2); }
const API = "https://api.helius.xyz";
const hist = (addr, limit = 100) => fetch(`${API}/v0/addresses/${addr}/transactions?api-key=${cfg.heliusKey}&limit=${limit}`).then((r) => r.json());
const conn = new Connection(cfg.rpcUrl, "confirmed");

async function findMints() {
  // recent pump program activity -> distinct mints ending in "pump"; split by graduated or not
  const txs = await hist(P.PUMP_PROGRAM_ID?.toBase58?.() || "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", 100);
  const mints = [...new Set(txs.flatMap((t) => (t.tokenTransfers || []).map((x) => x.mint)).filter((m) => m && m.endsWith("pump")))];
  const sdk = new P.OnlinePumpSdk(conn);
  let curve = null, grad = null;
  for (const m of mints) {
    const bc = await sdk.fetchBondingCurve(new PublicKey(m)).catch(() => null);
    if (!bc) continue;
    if (!bc.complete && !curve) curve = m;
    if (bc.complete && !grad) grad = m;
    if (curve && grad) break;
  }
  if (!grad) {
    const amm = await hist("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", 100);
    grad = [...new Set(amm.flatMap((t) => (t.tokenTransfers || []).map((x) => x.mint)).filter((m) => m && m.endsWith("pump")))][0];
  }
  return [curve, grad].filter(Boolean);
}

async function check(mint) {
  const m = new PublicKey(mint);
  const curve = P.bondingCurvePda(m).toBase58();
  const pool = P.canonicalPumpPoolPda(m).toBase58();
  cfg.mint = mint;
  cfg.excluded.length = 0; cfg.excluded.push(curve, pool); // what EXCLUDED_WALLETS must contain
  const { q } = open(":memory:");
  const ledger = makeLedger({ q, excluded: new Set(cfg.excluded) });
  const txs = await hist(mint, 100);
  let n = 0, agree = 0, buys = 0, sells = 0, transfers = 0, missed = 0, noMint = 0;
  const bad = [];
  const excl = new Set(cfg.excluded);
  for (const tx of txs) {
    const events = ledger.parse(tx);
    for (const e of events) { n++; e.kind === "buy" ? buys++ : e.kind === "sell" ? sells++ : transfers++; }
    // ground truth per wallet: its token balance change for this mint in this tx
    const truth = new Map();
    for (const a of tx.accountData || []) for (const c of a.tokenBalanceChanges || []) {
      if (c.mint !== mint || excl.has(c.userAccount)) continue;
      truth.set(c.userAccount, (truth.get(c.userAccount) || 0) + Number(c.rawTokenAmount.tokenAmount) / 10 ** c.rawTokenAmount.decimals);
    }
    const seen = new Map();
    for (const e of events) seen.set(e.wallet, (seen.get(e.wallet) || 0) + (e.kind === "buy" ? e.tokens : -e.tokens));
    if (!truth.size && !events.length) { noMint++; continue; }
    // every wallet whose balance went DOWN must have a swear event (that is the rule that pays or blocks people)
    for (const [w, d] of truth) {
      const ev = events.filter((e) => e.wallet === w);
      if (d < -1e-9 && !ev.some((e) => e.kind !== "buy")) { missed++; bad.push({ sig: tx.signature.slice(0, 12), wallet: w.slice(0, 6), delta: d, type: tx.type, note: "balance fell, no swear" }); }
    }
    for (const [w, net] of seen) {
      const d = truth.get(w) || 0;
      if (Math.abs(net - d) <= Math.max(1e-6, Math.abs(d) * 1e-6)) agree++;
      else bad.push({ sig: tx.signature.slice(0, 12), wallet: w.slice(0, 6), parsedNet: net, chainNet: d, type: tx.type });
    }
  }
  n = [...new Set(txs.flatMap((t) => ledger.parse(t).map((e) => t.signature + e.wallet)))].length; // (tx, wallet) pairs
  const types = [...new Set(txs.map((t) => t.type + "/" + t.source))].join(", ");
  console.log(`\n${mint}\n  curve ${curve.slice(0, 8)}… pool ${pool.slice(0, 8)}… · ${txs.length} txs (${types})`);
  console.log(`  events: ${buys} buys, ${sells} sells, ${transfers} transfers · (tx, wallet) net matches chain: ${agree}/${n} · balance fell without a swear: ${missed} · txs without this token moving: ${noMint}`);
  for (const b of bad.slice(0, 5)) console.log("  MISMATCH", JSON.stringify(b));
  return n > 0 && agree === n && missed === 0;
}

(async () => {
  const mints = process.argv.slice(2).length ? process.argv.slice(2) : await findMints();
  if (!mints.length) { console.log("no recent pump coins found"); process.exit(2); }
  let all = true;
  for (const m of mints) all = (await check(m)) && all;
  console.log(all ? "\nPASS parser agrees with the chain on every event" : "\nFAIL see mismatches above");
  process.exit(all ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(2); });
