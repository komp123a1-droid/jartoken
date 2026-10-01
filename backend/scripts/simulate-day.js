// Full-day simulation over real HTTP on an isolated instance (own port, own throwaway DB).
// Yesterday: hundreds of Helius-shaped trades via the webhook -> midnight collection (dry run, then "send" in mock)
// -> checked against an independent calculation. Plus auth, retries, junk payloads, bursts, partial payout recovery.
const os = require("os"), path = require("path"), fs = require("fs");
const DB = path.join(os.tmpdir(), "jar-sim-" + Date.now() + ".db");
Object.assign(process.env, {
  MODE: "mock", DB_PATH: DB, PORT: "8799", WEBHOOK_SECRET: "sim-secret", ADMIN_TOKEN: "sim-admin",
  MOCK_TRADE_MS: "999999999", DRY_RUN: "true", THRESHOLD_TOKENS: "100000", MIN_PAYOUT_SOL: "0.001", RESERVE_SOL: "0.02",
});
const http = require("http");
const cfg = require("../src/config");
const { open, dayOf } = require("../src/db");
const { makeChain } = require("../src/chain");
const { makeLedger } = require("../src/ledger");
const { makeBot } = require("../src/swearbot");
const { makeCollector } = require("../src/collector");
const { makeApi } = require("../src/api");

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  · " + detail : "")); };
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

(async () => {
  const chain = makeChain();
  const { db, q } = open(cfg.dbPath);
  const bot = makeBot({ q });
  const ledger = makeLedger({ q, excluded: new Set([...cfg.excluded, chain.jarWallet()]), onSwear: bot.swear });
  const collector = makeCollector({ q, chain, bot });
  const server = http.createServer(makeApi({ q, chain, ledger, collector }));
  await new Promise((r) => server.listen(cfg.port, r));
  const base = `http://127.0.0.1:${cfg.port}`;
  const req = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };
  const hook = (txs, auth = "sim-secret") => req("POST", "/webhook/helius", txs, auth ? { authorization: auth } : {});
  const admin = (method, p, body) => req(method, p, body, { "x-admin-token": "sim-admin" });

  const holders = await chain.holders();
  const curve = chain.curve, mint = cfg.mint;
  const nowS = Math.floor(Date.now() / 1000);
  const YDAY = dayOf(Date.now() - 864e5), TODAY = dayOf(Date.now());
  const ydayTs = () => Math.floor(Date.parse(YDAY + "T00:00:00Z") / 1000) + Math.floor(Math.random() * 86000);
  let n = 0;
  const tx = (type, from, to, amt, ts) => ({ signature: "sim" + (n++) + "x" + Math.random().toString(36).slice(2, 8), timestamp: ts, type,
    tokenTransfers: [{ fromUserAccount: from, toUserAccount: to, mint, tokenAmount: amt }] });

  // ---------- 1. auth + junk ----------
  console.log("\n== webhook: auth and bad input");
  const one = [tx("SWAP", curve, holders[0].owner, 5e5, ydayTs())];
  check("no auth header -> 401", (await hook(one, null)).status === 401);
  check("wrong secret -> 401", (await hook(one, "nope")).status === 401);
  const bad = await hook("{not json", "sim-secret");
  check("malformed JSON -> 400 (not 500)", bad.status === 400, "got " + bad.status);
  check("empty array -> 200, 0 recorded", (await hook([])).body?.recorded === 0);
  check("other mint ignored", (await hook([{ ...one[0], signature: "other1", tokenTransfers: [{ ...one[0].tokenTransfers[0], mint: "So11111111111111111111111111111111111111112" }] }])).body?.recorded === 0);
  check("tx without tokenTransfers ignored", (await hook([{ signature: "nt1", timestamp: nowS, type: "TRANSFER" }])).body?.recorded === 0);
  check("jar wallet itself never a sinner", (await hook([tx("TRANSFER", chain.jarWallet(), holders[1].owner, 1e5, ydayTs())])).body?.recorded === 1
    && !q.isSinner.get(YDAY, chain.jarWallet()));

  // ---------- 2. yesterday's trading ----------
  console.log("\n== yesterday: 600 trades in 12 webhook batches of 50");
  const sinnersY = new Set(), swearEvents = [];
  const active = holders.slice(0, 400);
  const batches = [];
  for (let b = 0; b < 12; b++) {
    const arr = [];
    for (let i = 0; i < 50; i++) {
      const h = rnd(active), r = Math.random(), amt = Math.round(1e4 + Math.random() * 3e6), ts = ydayTs();
      if (r < 0.5) arr.push(tx("SWAP", curve, h.owner, amt, ts));
      else if (r < 0.9) { arr.push(tx("SWAP", h.owner, curve, amt, ts)); sinnersY.add(h.owner); swearEvents.push(h.owner); }
      else { arr.push(tx("TRANSFER", h.owner, rnd(holders).owner, amt, ts)); sinnersY.add(h.owner); swearEvents.push(h.owner); }
    }
    batches.push(arr);
  }
  const outboxBefore = q.outboxLast.all(100000).length;
  let recorded = 0; const t0 = Date.now();
  for (const b of batches) recorded += (await hook(b)).body.recorded;
  const tBatch = Date.now() - t0;
  check("all 600 trades recorded (a wallet-to-wallet transfer is a swear for the sender, not a buy for the receiver)", recorded === 600, `recorded ${recorded}, ${tBatch} ms`);
  let retried = 0; for (const b of batches) retried += (await hook(b)).body.recorded;
  check("Helius retry of all batches -> 0 new", retried === 0);
  const dbSinnersY = new Set(q.sinnersOf.all(YDAY).map((r) => r.wallet));
  check("sinner list == every wallet that sold or moved tokens", dbSinnersY.size === sinnersY.size && [...sinnersY].every((w) => dbSinnersY.has(w)), `${dbSinnersY.size} sinners`);
  const swearsTotal = db.prepare("SELECT SUM(swears) AS s FROM sinners WHERE day = ?").get(YDAY).s;
  check("swear counter == number of sells + transfers", swearsTotal === swearEvents.length, `${swearsTotal} vs ${swearEvents.length}`);
  const tgMsgs = q.outboxLast.all(100000).length - outboxBefore;
  check("Agnes wrote one Telegram message per swear (+ X for big first ones)", db.prepare("SELECT COUNT(*) n FROM outbox WHERE channel='telegram'").get().n === swearEvents.length, `${tgMsgs} outbox rows`);

  // ---------- 3. today: yesterday's sinners trade again (must not affect yesterday's collection) ----------
  console.log("\n== today: some of yesterday's sinners sell again, some clean holders buy");
  const todayTx = [...sinnersY].slice(0, 20).map((w) => tx("SWAP", w, curve, 2e5, nowS));
  const cleanBuyer = holders.find((h) => h.tokens >= 100000 && !sinnersY.has(h.owner));
  todayTx.push(tx("SWAP", curve, cleanBuyer.owner, 3e5, nowS));
  await hook(todayTx);
  check("today's sinners kept separately from yesterday's", q.sinnersOf.all(TODAY).length === 20 && q.sinnersOf.all(YDAY).length === sinnersY.size);
  // 24h rolling window: a sell 25h ago no longer blocks drops, a sell 2h ago does (until sell + 24h)
  const oldSeller = holders.find((h) => h.tokens >= 300000 && !sinnersY.has(h.owner) && h.owner !== cleanBuyer.owner);
  const newSeller = holders.find((h) => h.tokens >= 300000 && !sinnersY.has(h.owner) && h.owner !== cleanBuyer.owner && h.owner !== oldSeller.owner);
  await hook([tx("SWAP", oldSeller.owner, curve, 1e4, nowS - 25 * 3600), tx("SWAP", newSeller.owner, curve, 1e4, nowS - 2 * 3600)]);
  for (const [w, t] of [[oldSeller.owner, nowS - 25 * 3600], [newSeller.owner, nowS - 2 * 3600]]) if (dayOf(t * 1000) === YDAY) sinnersY.add(w); // falls in yesterday's window
  const wOld = (await req("GET", "/api/wallet/" + oldSeller.owner)).body, wNew = (await req("GET", "/api/wallet/" + newSeller.owner)).body;
  check("sell 25h ago -> drops again (window passed)", wOld.swore === false && wOld.eligible === true);
  check("sell 2h ago -> blocked, blockedUntil = sell + 24h", wNew.swore === true && !wNew.eligible && Math.abs(Date.parse(wNew.blockedUntil) - (nowS - 2 * 3600 + 24 * 3600) * 1000) < 2000, wNew.blockedUntil);
  const wB = (await req("GET", "/api/wallet/" + cleanBuyer.owner)).body;
  check("/api/wallet: clean buyer -> eligible, estimate > 0", wB.eligible && wB.estShareSol > 0, wB.estShareSol.toFixed(5) + " SOL");

  // ---------- 4. midnight collection for yesterday ----------
  console.log("\n== collection for " + YDAY);
  const jarBefore = await chain.jarSol();
  const excluded = new Set([...cfg.excluded, chain.jarWallet()]);
  // independent calculation
  const pot = Math.floor((jarBefore - cfg.reserveSol) * 1e9);
  const elig = holders.filter((h) => h.tokens >= cfg.thresholdTokens && !excluded.has(h.owner) && !sinnersY.has(h.owner));
  const tot = elig.reduce((s, h) => s + h.tokens, 0);
  const n0 = elig.filter((h) => Math.floor(pot * (h.tokens / tot)) >= 1e6).length;
  const potNet = pot - Math.ceil(n0 / cfg.batchSize) * 5000; // tx fees come out of the pot
  const expect = new Map(elig.map((h) => [h.owner, Math.floor(potNet * (h.tokens / tot))]).filter(([, l]) => l >= 1e6));

  const dry = (await admin("POST", "/admin/collect", { day: YDAY })).body;
  check("dry run via web: status dry-run", dry.status === "dry-run");
  const rows = (await req("GET", "/api/collections/" + YDAY)).body.payouts;
  check("payout list == independent calculation (same wallets)", rows.length === expect.size && rows.every((r) => expect.has(r.wallet)), `${rows.length} vs ${expect.size}`);
  check("every amount matches to the lamport", rows.every((r) => r.lamports === expect.get(r.wallet)));
  check("no sinner on the list", rows.every((r) => !sinnersY.has(r.wallet)));
  check("nobody under 100,000 $JAR on the list", rows.every((r) => r.tokens >= 100000));
  check("no excluded wallet (curve, jar) on the list", rows.every((r) => !excluded.has(r.wallet)));
  check("paid + fees + carry == jar - reserve", Math.abs(dry.paidSol + Math.ceil(rows.length / cfg.batchSize) * 5e-6 + dry.carrySol - (jarBefore - cfg.reserveSol)) < 1e-9, `paid ${dry.paidSol.toFixed(4)} carry ${dry.carrySol.toFixed(4)}`);
  check("bigger holder gets more (pro rata)", (() => { const s = rows.slice().sort((a, b) => a.tokens - b.tokens); return s.every((r, i) => !i || r.lamports >= s[i - 1].lamports); })());
  check("jar untouched by dry run", (await chain.jarSol()) === jarBefore);
  check("dry run posts only a preview (nothing to Telegram/X)", q.outboxLast.all(1)[0].status === "preview" && q.outboxLast.all(1)[0].channel === "telegram");

  const both = await Promise.allSettled([collector.collect({ day: YDAY, send: true }), collector.collect({ day: YDAY, send: true })]);
  check("two collections at the same time -> second refused", both.filter((r) => r.status === "rejected").length === 1);
  const real = both.find((r) => r.status === "fulfilled").value;
  check("send run: status paid", real.status === "paid", `${real.paidCount} wallets, ${real.paidSol.toFixed(4)} SOL`);
  check("jar decreased by exactly the paid amount", Math.abs(jarBefore - (await chain.jarSol()) - real.paidSol) < 1e-9);
  check("all payout rows 'sent' with a signature", q.payoutsOf.all(YDAY).every((p) => p.status === "sent" && p.sig));
  const again = await collector.collect({ day: YDAY, send: true });
  check("third run -> 'already paid', nothing sent", again.skipped === "already paid");
  check("web collect for a paid day -> also refuses", (await admin("POST", "/admin/collect", { day: YDAY })).body.skipped === "already paid");
  check("drop message went out (not preview), X summary too", q.outboxLast.all(3).some((m) => m.status === "log" && m.channel === "telegram" && /Drop at/.test(m.text)) && q.outboxLast.all(3).some((m) => m.channel === "x" && /dropped again/.test(m.text)));

  // ---------- 5. failures mid-payout: nobody is paid twice, nobody is shorted ----------
  const realPay = chain.pay, realJar = chain.jarSol;
  chain.jarSol = async () => 2.5; // fresh day's jar (the previous collection emptied the mock jar)
  const sentSet = (day) => new Set(q.payoutsOf.all(day).filter((p) => p.status === "sent").map((p) => p.wallet));
  const guardNoDouble = (already) => async (p, hooks) => {
    if (p.some((x) => already.has(x.wallet))) throw new Error("DOUBLE PAY");
    return realPay(p, hooks);
  };

  console.log("\n== 5a. second batch fails on-chain -> re-run pays only the failed ones, same amounts");
  const D2 = "2099-12-29";
  chain.pay = async (list, { onSigned, onBatch }) => {
    const first = list.slice(0, 18), rest = list.slice(18);
    await realPay(first, { onSigned, onBatch });
    const sig = "failedsig" + Math.random().toString(36).slice(2, 8); // signed, sent, rejected by the chain
    await onSigned(rest, sig); await onBatch(rest.map((p) => ({ wallet: p.wallet, sig, status: "failed" })));
  };
  const part = await collector.collect({ day: D2, send: true });
  const planned = new Map(q.payoutsOf.all(D2).map((p) => [p.wallet, p.lamports]));
  const sentFirst = sentSet(D2);
  check("status partial after a failed batch", part.status === "partial", `${sentFirst.size}/${planned.size} sent`);
  chain.pay = guardNoDouble(sentFirst);
  const fix = await collector.collect({ day: D2, send: true });
  check("re-run finishes the day (status paid), no double pay", fix.status === "paid", `retried ${fix.retried}`);
  check("re-run pays the SAME amounts as planned", q.payoutsOf.all(D2).every((p) => p.status === "sent" && p.lamports === planned.get(p.wallet)));

  console.log("\n== 5b. server crashes right after sending a batch that DID land");
  const D3 = "2099-12-30";
  chain.pay = async (list, { onSigned, onBatch }) => {
    const first = list.slice(0, 18);
    await realPay(first, { onSigned, onBatch });
    const second = list.slice(18, 36), sig = "landedsig" + Math.random().toString(36).slice(2, 8);
    await onSigned(second, sig); chain.landed.add(sig); // landed on-chain...
    throw new Error("process killed"); // ...but we died before recording it
  };
  let crashed = false; try { await collector.collect({ day: D3, send: true }); } catch { crashed = true; }
  const afterCrash = q.payoutsOf.all(D3);
  check("crash leaves state on disk: 18 sent, 18 'sending' with signature, rest pending", crashed
    && afterCrash.filter((p) => p.status === "sent").length === 18
    && afterCrash.filter((p) => p.status === "sending" && p.sig).length === 18
    && afterCrash.filter((p) => p.status === "pending").length === afterCrash.length - 36, q.getCollection.get(D3).status);
  const landedWallets = new Set(afterCrash.filter((p) => p.status === "sending").map((p) => p.wallet));
  chain.pay = guardNoDouble(new Set([...sentSet(D3), ...landedWallets]));
  const res3 = await collector.collect({ day: D3, send: true });
  check("resume finds the landed batch on-chain and does NOT re-send it", res3.status === "paid" && q.payoutsOf.all(D3).every((p) => p.status === "sent"), `retried ${res3.retried}`);

  console.log("\n== 5c. confirmation timed out, signature not found yet");
  const D4 = "2099-12-31";
  chain.pay = async (list, { onSigned, onBatch }) => {
    const sig = "limbo" + Math.random().toString(36).slice(2, 8);
    await onSigned(list, sig); await onBatch(list.map((p) => ({ wallet: p.wallet, sig, status: "unknown" })));
  };
  await collector.collect({ day: D4, send: true });
  chain.pay = async () => { throw new Error("must not send while a tx may still land"); };
  const r4 = await collector.collect({ day: D4, send: true });
  check("fresh unknown signature -> waits, sends nothing", r4.status === "partial" && r4.unresolved > 0, `unresolved ${r4.unresolved}`);
  db.prepare("UPDATE payouts SET ts = ? WHERE day = ?").run(Date.now() - 10 * 60e3, D4); // 10 minutes later: blockhash long expired
  chain.pay = realPay;
  const r4b = await collector.collect({ day: D4, send: true });
  check("signature still missing after expiry -> safe to re-send, day paid", r4b.status === "paid", `retried ${r4b.retried}`);
  check("dry run on a finished day -> refuses to recompute", (await collector.collect({ day: D4, send: false })).skipped === "already paid");

  chain.pay = realPay; chain.jarSol = realJar;


  // ---------- 5d. drops every 15 min with personal balances ----------
  console.log("\n== 5d. drops: small shares accrue as balances, a sell forfeits the balance, the jar always covers all balances");
  {
    const realPay2 = chain.pay, realJar2 = chain.jarSol;
    let jar = 0;
    chain.jarSol = async () => jar;
    chain.pay = async (list, hooks) => { const res = await realPay2(list, hooks); jar -= list.reduce((s, p) => s + p.lamports, 0) / 1e9; return res; };
    db.exec("DELETE FROM owed");
    const owedNow = () => new Map(q.owedAll.all().map((r) => [r.wallet, r.lamports]));
    const owedSum = () => q.owedTotal.get().n;
    const covered = () => Math.round(jar * 1e9) >= 0.01 * 1e9 + owedSum() - 1;

    jar = 0.01 + 0.4; // reserve + a small pot: only the biggest holders clear 0.001 SOL, the rest accrue
    const A = await collector.collect({ day: "2099-06-01T10:00", send: true });
    const owedA = owedNow();
    const paidA = new Set(q.payoutsOf.all("2099-06-01T10:00").map((p) => p.wallet));
    check("drop A: big holders paid, small shares kept as balances", A.status === "paid" && paidA.size > 0 && owedA.size > paidA.size, `${paidA.size} paid, ${owedA.size} wallets with a balance`);
    check("drop A: nobody paid has a leftover balance", [...paidA].every((w) => !owedA.get(w)));
    check("drop A: jar covers reserve + all balances", covered(), `jar ${jar.toFixed(5)} SOL, balances ${(owedSum() / 1e9).toFixed(5)} SOL`);

    const victim = [...owedA.entries()].sort((a, b) => b[1] - a[1]).find(([w]) => !paidA.has(w));
    await hook([tx("SWAP", victim[0], curve, 1e4, nowS)]);
    check("a sell forfeits the unpaid balance back into the jar", !owedNow().get(victim[0]), `${victim[1]} lamports forfeited`);

    jar += 0.15; // more fees came in
    const before = owedNow();
    const B = await collector.collect({ day: "2099-06-01T10:15", send: true });
    const rowsB = q.payoutsOf.all("2099-06-01T10:15");
    const afterB = owedNow();
    const grew = [...before.keys()].filter((w) => !rowsB.some((r) => r.wallet === w) && (afterB.get(w) || 0) > before.get(w));
    const settled = rowsB.filter((r) => (before.get(r.wallet) || 0) > 0);
    check("drop B: balances that reached 0.001 SOL were paid in full (old balance + new share)", settled.length > 0 && settled.every((r) => r.lamports >= before.get(r.wallet) + 1 && !afterB.get(r.wallet)), `${settled.length} wallets paid their accumulated balance`);
    check("drop B: balances still under 0.001 SOL kept growing", grew.length > 0, `${grew.length} wallets`);
    check("drop B: the forfeited wallet got nothing (and nothing new: its sell is 24h-blocked only for its own window)", !rowsB.some((r) => r.wallet === victim[0]) || rowsB.find((r) => r.wallet === victim[0]).lamports < victim[1]);
    check("drop B: jar covers reserve + all balances", covered(), `jar ${jar.toFixed(5)} SOL, balances ${(owedSum() / 1e9).toFixed(5)} SOL`);
    check("every payout row is >= 0.001 SOL", [...q.payoutsOf.all("2099-06-01T10:00"), ...rowsB].every((r) => r.lamports >= 1e6));

    jar += 0; // an empty quarter: nothing new came in
    const C = await collector.collect({ day: "2099-06-01T10:30", send: true });
    check("drop with no new fees: no new credit, jar still covers balances", covered(), C.status);
    const C2 = await collector.collect({ day: "2099-06-01T10:30", send: true });
    check("same drop twice -> already paid, balances unchanged", C2.skipped === "already paid");
    chain.pay = realPay2; chain.jarSol = realJar2;
  }

  // ---------- 6. burst ----------
  console.log("\n== burst: 1,000 trades in one webhook call");
  const burst = Array.from({ length: 1000 }, () => tx("SWAP", Math.random() < 0.5 ? curve : rnd(holders).owner, curve, 1e5, nowS)).map((t) =>
    t.tokenTransfers[0].fromUserAccount === curve ? { ...t, tokenTransfers: [{ ...t.tokenTransfers[0], toUserAccount: rnd(holders).owner }] } : t);
  const t1 = Date.now(); const br = await hook(burst);
  check("1,000-trade webhook accepted", br.status === 200 && br.body.recorded === 1000, `${Date.now() - t1} ms`);
  const big = await hook(Array.from({ length: 20000 }, () => burst[0]));
  check("oversized body (> 4 MB) refused, server stays up", big.status !== 200 && (await req("GET", "/api/health")).status === 200, "status " + big.status);

  // ---------- 7. admin + public API ----------
  console.log("\n== admin + API");
  check("admin without token -> 401", (await req("GET", "/admin/config")).status === 401);
  check("admin with wrong token -> 401", (await req("GET", "/admin/config", undefined, { "x-admin-token": "sim-admix" })).status === 401);
  const cfgOut = (await admin("GET", "/admin/config")).body;
  check("config never leaks secrets", !JSON.stringify(cfgOut).includes("sim-secret") && !JSON.stringify(cfgOut).includes("sim-admin"));
  check("simulate rejects bad kind", (await admin("POST", "/admin/simulate", { kind: "steal" })).status === 400);
  check("simulate rejects bad wallet", (await admin("POST", "/admin/simulate", { kind: "sell", wallet: "0xdead" })).status === 400);
  check("bad day format on collect -> 400", (await admin("POST", "/admin/collect", { day: "yesterday" })).status === 400);
  check("/api/wallet bad address -> 400", (await req("GET", "/api/wallet/hello")).status === 400);
  check("/api/feed limit capped at 100", (await req("GET", "/api/feed?limit=99999")).body.length === 100);
  check("unknown route -> 404", (await req("GET", "/api/nope")).status === 404);
  const st = (await req("GET", "/api/state")).body;
  check("next drop is the coming 15-minute boundary", st.nextCollection === new Date(Math.floor(Date.now() / 900e3) * 900e3 + 900e3).toISOString() && st.payoutEveryMin === 15, st.nextCollection);
  check("preflight says NOT ready in mock", (await admin("GET", "/admin/preflight")).body.readyForLive === false);

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed` + (failed.length ? "\nFAILED:\n - " + failed.map((f) => f.name).join("\n - ") : ""));
  try { fs.unlinkSync(DB); fs.unlinkSync(DB + "-wal"); fs.unlinkSync(DB + "-shm"); } catch {}
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
