// End-to-end check in mock mode with a throwaway DB: parser, sinner list, dedupe, split math, collection, API.
process.env.MODE = "mock";
process.env.DB_PATH = ":memory:";
process.env.MIN_PAYOUT_SOL = "0.001";
const assert = require("assert");
const cfg = require("../src/config");
const { open, dayOf } = require("../src/db");
const { makeChain } = require("../src/chain");
const { makeLedger } = require("../src/ledger");
const { makeCollector, split } = require("../src/collector");
const { makeApi } = require("../src/api");

(async () => {
  const chain = makeChain();
  const { q } = open(cfg.dbPath);
  const said = [];
  const bot = { swear: (e, o) => said.push([e.kind, o.firstToday]), collection: (s) => said.push(["collection", s.paidCount]) };
  const ledger = makeLedger({ q, excluded: new Set([...cfg.excluded, chain.jarWallet()]), onSwear: bot.swear });
  const holders = await chain.holders();
  const A = holders[0].owner, B = holders[1].owner, curve = chain.curve;
  const now = Math.floor(Date.now() / 1000);
  const tx = (sig, type, from, to, amt) => ({ signature: sig, timestamp: now, type, tokenTransfers: [{ fromUserAccount: from, toUserAccount: to, mint: cfg.mint, tokenAmount: amt }] });

  // 1. parser: buy, sell, transfer
  assert.deepStrictEqual(ledger.parse(tx("s1", "SWAP", curve, A, 5e5)).map((e) => e.kind), ["buy"]);
  assert.deepStrictEqual(ledger.parse(tx("s2", "SWAP", A, curve, 5e5)).map((e) => e.kind), ["sell"]);
  assert.deepStrictEqual(ledger.parse(tx("s3", "TRANSFER", A, B, 5e5)).map((e) => e.kind), ["transfer"]);
  assert.strictEqual(ledger.parse({ ...tx("s4", "SWAP", A, curve, 5e5), tokenTransfers: [{ fromUserAccount: A, toUserAccount: curve, mint: "OTHER", tokenAmount: 1 }] }).length, 0);
  console.log("ok  parser: buy / sell / transfer / other mint ignored");

  // 2. record + dedupe + sinners
  ledger.ingest(tx("s1", "SWAP", curve, A, 5e5));
  assert.strictEqual(q.sinnersOf.all(dayOf(Date.now())).length, 0);
  ledger.ingest(tx("s2", "SWAP", A, curve, 5e5));
  ledger.ingest(tx("s2", "SWAP", A, curve, 5e5)); // webhook retry
  ledger.ingest(tx("s5", "SWAP", A, curve, 1e5)); // swears again
  const sin = q.isSinner.get(dayOf(Date.now()), A);
  assert.strictEqual(sin.swears, 2);
  assert.deepStrictEqual(said, [["sell", true], ["sell", false]]);
  console.log("ok  ledger: buy is fine, sell = sinner, retry deduped, repeat swear counted");

  // 3. split math
  const r = split({
    jarSol: 1.02, excluded: new Set(["X"]), sinners: new Set(["S"]),
    holders: [{ owner: "a", tokens: 300000 }, { owner: "b", tokens: 100000 }, { owner: "small", tokens: 99999 }, { owner: "S", tokens: 5e6 }, { owner: "X", tokens: 5e8 }, { owner: "dust", tokens: 100000 }],
  });
  assert.deepStrictEqual(r.clean.map((h) => h.owner), ["a", "b", "dust"]);
  assert.ok(Math.abs(r.pay[0].lamports / 1e9 - 0.6) < 1e-6, "a gets 3/5 of 1.00 SOL");
  assert.ok(Math.abs(r.paidSol + r.carrySol - 1.0) < 1e-9);
  console.log("ok  split: threshold, sinners, excluded, pro rata, reserve, carry");

  // 4. dust stays in the jar
  const d = split({ jarSol: 0.025, excluded: new Set(), sinners: new Set(), holders: [{ owner: "a", tokens: 1e5 }, { owner: "b", tokens: 1e7 }] });
  assert.deepStrictEqual(d.pay.map((p) => p.wallet), ["b"]);
  assert.ok(d.carrySol > 0);
  console.log("ok  carry-over: share under 0.001 SOL is not sent");

  // 5. collection for today (A swore -> not paid), dry run then idempotent paid run
  const col = makeCollector({ q, chain, bot });
  const today = dayOf(Date.now());
  const dry = await col.collect({ day: today, send: false });
  assert.strictEqual(dry.status, "dry-run");
  assert.ok(!q.payoutsOf.all(today).some((p) => p.wallet === A), "sinner not paid");
  const before = await chain.jarSol();
  const paid = await col.collect({ day: today, send: true });
  assert.strictEqual(paid.status, "paid");
  assert.ok((await chain.jarSol()) < before);
  assert.strictEqual((await col.collect({ day: today, send: true })).skipped, "already paid");
  console.log(`ok  collection: dry-run, paid ${paid.paidCount} wallets ${paid.paidSol.toFixed(4)} SOL, sinner skipped, no double pay`);

  // 6. API
  const api = makeApi({ q, chain, ledger, collector: col });
  const call = (method, url, body) => new Promise((resolve) => {
    const req = require("stream").Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: {} });
    let status; const res = { writeHead: (s) => (status = s), end: (b) => resolve({ status, body: b ? JSON.parse(b) : null }) };
    api(req, res);
  });
  const st = await call("GET", "/api/state");
  assert.strictEqual(st.status, 200); assert.strictEqual(st.body.sinnersToday, 1);
  const w = await call("GET", "/api/wallet/" + A);
  assert.strictEqual(w.body.swore, true); assert.strictEqual(w.body.eligible, false);
  assert.strictEqual((await call("GET", "/api/wallet/0xabc")).status, 400);
  const hook = await call("POST", "/webhook/helius", [tx("s9", "SWAP", B, curve, 2e5)]);
  assert.strictEqual(hook.body.recorded, 1);
  assert.strictEqual((await call("GET", "/api/feed?limit=3")).body.length, 3);
  console.log("ok  api: state, wallet, bad address, webhook, feed");

  console.log("\nall good.");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
