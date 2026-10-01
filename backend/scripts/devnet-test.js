// DEVNET ONLY test of the real payout path (solana.js sendPayouts + collector split/collect).
// Usage: node --no-warnings scripts/devnet-test.js <phase>
//   phase: size | fund | direct | collect | partial | all
// Keys live in backend/keys/devnet (gitignored). Never points at mainnet.
const path = require("path");
const fs = require("fs");

// Keys + test DB live in backend/keys/devnet (gitignored). DEVNET ONLY: never put a mainnet key here.
const SCRATCH = process.env.DEVNET_SCRATCH || path.join(__dirname, "..", "keys", "devnet");
fs.mkdirSync(SCRATCH, { recursive: true });
const KP_PATH = path.join(SCRATCH, "payout.json");

const RPC = process.env.DEVNET_RPC || "https://api.devnet.solana.com";
if (!/devnet/.test(RPC)) throw new Error("refusing: RPC is not devnet");

process.env.RPC_URL = RPC;
process.env.MODE = "live";
process.env.PAYOUT_KEYPAIR = KP_PATH;
process.env.DB_PATH = path.join(SCRATCH, "jar-devnet.db");
process.env.DRY_RUN = "false";
process.env.RESERVE_SOL = "0.01";
process.env.MIN_PAYOUT_SOL = "0.001";

const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

if (!fs.existsSync(KP_PATH)) fs.writeFileSync(KP_PATH, JSON.stringify([...Keypair.generate().secretKey]));

const cfg = require("../src/config");
if (!/devnet/.test(cfg.rpcUrl)) throw new Error("refusing: cfg.rpcUrl is not devnet");
const sol = require("../src/solana");
const { split, makeCollector } = require("../src/collector");
const { open } = require("../src/db");

const conn = new Connection(RPC, "confirmed");
const kp = sol.loadKeypair();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gen = () => Keypair.generate().publicKey.toBase58();
const link = (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`;
const results = { pass: [], fail: [], info: [] };
const ok = (m) => { results.pass.push(m); console.log("PASS", m); };
const bad = (m) => { results.fail.push(m); console.log("FAIL", m); };
const info = (m) => { results.info.push(m); console.log("INFO", m); };

// ---------- phase: tx size ----------
async function phaseSize() {
  const { blockhash } = await conn.getLatestBlockhash();
  const sizeOf = (n) => {
    const tx = new Transaction();
    for (let i = 0; i < n; i++) tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(gen()), lamports: 1_000_000 }));
    tx.recentBlockhash = blockhash; tx.feePayer = kp.publicKey;
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length; }
    catch (e) { return "ERR " + e.message; }
  };
  const s18 = sizeOf(18), s25 = sizeOf(25);
  info(`legacy tx size: 18 transfers = ${s18} bytes, 25 transfers = ${s25}`);
  let max = 0;
  for (let n = 1; n <= 40; n++) { const s = sizeOf(n); if (typeof s === "number" && s <= 1232) max = n; else break; }
  info(`max transfers per legacy tx within 1232 bytes = ${max} (size at max = ${sizeOf(max)}, at max+1 = ${sizeOf(max + 1)})`);
  if (typeof s18 === "number" && s18 <= 1232) ok(`BATCH_SIZE 18 fits (${s18} <= 1232)`); else bad(`BATCH_SIZE 18 does not fit: ${s18}`);
  const rent = await conn.getMinimumBalanceForRentExemption(0);
  info(`rent-exempt minimum (0-byte system account) = ${rent} lamports`);
  const min = Math.ceil(cfg.minPayoutSol * LAMPORTS_PER_SOL);
  if (min >= rent) ok(`MIN_PAYOUT_SOL ${cfg.minPayoutSol} = ${min} lamports >= rent-exempt ${rent} (margin ${min - rent})`);
  else bad(`MIN_PAYOUT_SOL ${min} < rent ${rent}: payouts to new wallets would fail`);
}

// ---------- phase: fund ----------
async function phaseFund(target = 1) {
  const bal = await conn.getBalance(kp.publicKey);
  info(`payout wallet ${kp.publicKey.toBase58()} balance ${bal / LAMPORTS_PER_SOL} SOL`);
  if (bal >= target * LAMPORTS_PER_SOL * 0.9) return true;
  for (const url of [RPC, "https://rpc.ankr.com/solana_devnet"]) {
    const c = new Connection(url, "confirmed");
    for (let i = 0, wait = 3000; i < 4; i++, wait *= 2) {
      try {
        const sig = await c.requestAirdrop(kp.publicKey, target * LAMPORTS_PER_SOL);
        const bh = await c.getLatestBlockhash();
        await c.confirmTransaction({ signature: sig, ...bh }, "confirmed");
        info(`airdrop ok via ${url}: ${sig}`);
        return true;
      } catch (e) {
        console.log(`airdrop via ${url} attempt ${i + 1} failed: ${e.message.slice(0, 160)}`);
        await sleep(wait);
      }
    }
  }
  bad("FUNDING FAILED: devnet airdrop unavailable on both RPCs");
  return false;
}

// ---------- phase: direct sendPayouts ----------
async function phaseDirect() {
  // 20 brand-new wallets x 0.001 SOL (exactly MIN_PAYOUT) -> expect 2 txs (18 + 2)
  const pay = Array.from({ length: 20 }, () => ({ wallet: gen(), lamports: 1_000_000 }));
  const out = await sol.sendPayouts(kp, pay);
  const sigs = [...new Set(out.map((o) => o.sig).filter(Boolean))];
  info(`direct: ${out.filter((o) => o.status === "sent").length}/20 sent, txs ${sigs.length}: ${sigs.map(link).join(" ")}`);
  if (sigs.length === Math.ceil(20 / cfg.batchSize) && out.every((o) => o.status === "sent")) ok("direct sendPayouts: 20 new wallets @ 1,000,000 lamports, 2 txs");
  else bad("direct sendPayouts unexpected result " + JSON.stringify(out));
  await verifyBalances(pay, "direct");

  // Failure case: one transfer below rent-exemption to a NEW account in a batch of 3
  const goodA = gen(), goodB = gen(), tiny = gen();
  const out2 = await sol.sendPayouts(kp, [{ wallet: goodA, lamports: 1_000_000 }, { wallet: tiny, lamports: 500_000 }, { wallet: goodB, lamports: 1_000_000 }]);
  const balA = await conn.getBalance(new PublicKey(goodA));
  info(`rent-fail batch: statuses ${out2.map((o) => o.status).join(",")}; goodA balance after = ${balA}`);
  if (out2.every((o) => o.status === "failed") && balA === 0) ok("sub-rent transfer to new account fails the WHOLE batch atomically (all 3 marked failed, no lamports moved)");
  else bad("rent-fail batch unexpected: " + JSON.stringify(out2));

  // Sub-rent top-up to an EXISTING funded account is fine
  const out3 = await sol.sendPayouts(kp, [{ wallet: pay[0].wallet, lamports: 500_000 }]);
  if (out3[0].status === "sent") ok("sub-rent transfer to an already-funded account succeeds: " + link(out3[0].sig));
  else bad("sub-rent top-up to existing account failed");
}

async function verifyBalances(pay, label, extra = {}) {
  let good = 0;
  for (let i = 0; i < pay.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(pay.slice(i, i + 100).map((p) => new PublicKey(p.wallet)));
    infos.forEach((a, j) => {
      const p = pay[i + j];
      const want = p.lamports + (extra[p.wallet] || 0);
      if ((a?.lamports || 0) === want) good++; else console.log(`  mismatch ${p.wallet}: have ${a?.lamports} want ${want}`);
    });
  }
  if (good === pay.length) ok(`${label}: all ${pay.length} on-chain balances equal their lamports`);
  else bad(`${label}: ${pay.length - good} balance mismatches`);
}

// ---------- fake holders ----------
function fakeHolders(n = 40) {
  const hs = [];
  for (let i = 0; i < n; i++) {
    let tokens;
    if (i < 6) tokens = Math.round(10_000 + Math.random() * 80_000); // under 100k threshold
    else if (i === 6) tokens = 100_000;                              // tiny but eligible -> share < 0.001 SOL
    else tokens = Math.round(1e6 + Math.random() * 30e6);
    hs.push({ owner: gen(), tokens });
  }
  return hs;
}

// ---------- phase: collect (full collector path, real chain) ----------
async function phaseCollect(day = "2099-01-01") {
  const dbPath = path.join(SCRATCH, `jar-devnet-${Date.now()}.db`);
  const { q } = open(dbPath);
  const holders = fakeHolders(40);
  const sinners = [holders[7].owner, holders[8].owner, holders[9].owner];
  const excludedW = holders[10].owner;
  cfg.excluded.push(excludedW);
  for (const w of sinners) { const t = Date.parse(day + "T12:00:00Z"); q.insertEvent.run("devnet-sig" + w, w, "sell", 1, t, day); q.insertSinner.run(day, w, "devnet-sig", t); } // a sell inside that day's window
  holders.push({ owner: kp.publicKey.toBase58(), tokens: 5e7 }); // jar wallet itself holds tokens -> must be excluded

  const startBal = await conn.getBalance(kp.publicKey);
  let payCalls = 0;
  const chain = {
    mode: "live",
    jarWallet: () => kp.publicKey.toBase58(),
    jarSol: () => sol.balanceSol(kp.publicKey),
    holders: async () => holders.map((h) => ({ ...h })),
    pay: (p) => { payCalls++; return sol.sendPayouts(kp, p); },
    claim: async () => { throw new Error("not on devnet"); },
  };
  const said = [];
  const bot = { collection: (s, o) => said.push([s.status, o]) };
  const col = makeCollector({ q, chain, bot });

  // Preview the math the collector will use
  const pre = split({ jarSol: startBal / LAMPORTS_PER_SOL, holders, sinners: new Set(sinners), excluded: new Set([...cfg.excluded, kp.publicKey.toBase58()]) });
  info(`split preview: jar ${startBal / LAMPORTS_PER_SOL} SOL, clean ${pre.clean.length}, pay ${pre.pay.length}, paidSol ${pre.paidSol}, carry ${pre.carrySol}`);
  if (pre.clean.length === 40 - 6 - 3 - 1) ok("split: under-threshold (6), sinners (3), excluded (1) and jar wallet dropped -> 30 clean");
  else bad(`split clean count ${pre.clean.length} != 30`);
  const dust = pre.clean.length - pre.pay.length;
  if (dust >= 1) ok(`split: ${dust} share(s) under MIN_PAYOUT left in jar`); else info("no dust share (random amounts)");

  const s1 = await col.collect({ day, send: true });
  info("collect #1 summary: " + JSON.stringify(s1));
  const rows = q.payoutsOf.all(day);
  const sigs = [...new Set(rows.map((r) => r.sig).filter(Boolean))];
  const expectedTx = Math.ceil(rows.length / cfg.batchSize);
  if (s1.status === "paid" && rows.length && rows.every((r) => r.status === "sent" && r.sig)) ok(`collect #1: status paid, ${rows.length} payout rows all 'sent' with signatures`);
  else bad("collect #1 rows: " + JSON.stringify(rows.map((r) => r.status)));
  if (sigs.length === expectedTx) ok(`collect #1: ${sigs.length} txs = ceil(${rows.length}/${cfg.batchSize})`);
  else bad(`collect #1: ${sigs.length} txs, expected ${expectedTx}`);
  info("collect #1 sigs: " + sigs.map(link).join(" "));
  for (const s of sigs) {
    const st = await conn.getSignatureStatus(s, { searchTransactionHistory: true });
    if (!st.value || st.value.err) bad(`sig ${s} not confirmed: ${JSON.stringify(st.value)}`);
  }
  await verifyBalances(rows.map((r) => ({ wallet: r.wallet, lamports: r.lamports })), "collect #1");
  const banned = new Set([...sinners, excludedW, kp.publicKey.toBase58(), ...holders.slice(0, 6).map((h) => h.owner)]);
  if (!rows.some((r) => banned.has(r.wallet))) ok("collect #1: no sinner / excluded / under-threshold / jar wallet was paid");
  else bad("collect #1 paid a banned wallet");
  const endBal = await conn.getBalance(kp.publicKey);
  const spent = startBal - endBal, paid = rows.reduce((s, r) => s + r.lamports, 0);
  info(`jar: start ${startBal}, end ${endBal}, paid ${paid}, fees ${spent - paid} lamports (${sigs.length} txs x 5000 = ${sigs.length * 5000})`);
  if (endBal >= cfg.reserveSol * LAMPORTS_PER_SOL - 50_000) ok(`jar kept ~reserve: ${endBal / LAMPORTS_PER_SOL} SOL left`);

  // Re-run: must not send again
  const before = payCalls;
  const s2 = await col.collect({ day, send: true });
  info("collect #2: " + JSON.stringify(s2).slice(0, 200));
  if (s2.skipped === "already paid" && payCalls === before && (await conn.getBalance(kp.publicKey)) === endBal) ok("collect #2: 'already paid', no pay() call, jar balance unchanged");
  else bad("collect #2 re-run did something: " + JSON.stringify(s2));
  return { sigs };
}

// ---------- phase: partial (one failed batch, then re-run) ----------
async function phasePartial(day = "2099-01-02") {
  const dbPath = path.join(SCRATCH, `jar-devnet-partial-${Date.now()}.db`);
  const { q } = open(dbPath);
  const holders = Array.from({ length: 24 }, () => ({ owner: gen(), tokens: 1e6 })); // equal shares -> 2 batches (18 + 6)
  let failSecond = true;
  const chain = {
    mode: "live",
    jarWallet: () => kp.publicKey.toBase58(),
    jarSol: () => sol.balanceSol(kp.publicKey),
    holders: async () => holders.map((h) => ({ ...h })),
    // first run: inject a rent-fail into the 2nd batch -> that real tx fails on-chain (simulation)
    pay: (p) => {
      if (!failSecond) return sol.sendPayouts(kp, p);
      failSecond = false;
      const bad = p.map((x, i) => (i === 18 ? { ...x, lamports: 1000 } : x));
      return sol.sendPayouts(kp, bad);
    },
    claim: async () => { throw new Error("no"); },
  };
  const col = makeCollector({ q, chain, bot: { collection: () => {} } });
  const s1 = await col.collect({ day, send: true });
  const rows1 = q.payoutsOf.all(day);
  const owed = new Map(rows1.map((r) => [r.wallet, r.lamports]));
  info(`partial #1: status ${s1.status}, sent ${rows1.filter((r) => r.status === "sent").length}, failed ${rows1.filter((r) => r.status === "failed").length}`);
  if (s1.status === "partial") ok("partial: one failing transfer -> its whole batch failed, collection marked 'partial'");
  else bad("partial expected, got " + s1.status);
  const s2 = await col.collect({ day, send: true });
  const rows2 = q.payoutsOf.all(day);
  const retried = rows2.filter((r) => rows1.find((x) => x.wallet === r.wallet && x.status === "failed"));
  const sentTwice = rows2.length !== 24;
  info(`partial #2: status ${s2.status}; retried wallets got ${retried[0]?.lamports} lamports each vs originally owed ${owed.get(retried[0]?.wallet)}`);
  if (s2.status === "paid" && retried.every((r) => r.status === "sent")) ok("partial re-run: failed batch retried, now 'paid', already-sent wallets not paid twice");
  else bad("partial re-run: " + JSON.stringify(s2));
  if (retried.length && retried[0].lamports < owed.get(retried[0].wallet) * 0.5) info(`RISK confirmed: re-run recomputes shares from the REDUCED jar balance -> retried wallets got ${(retried[0].lamports / owed.get(retried[0].wallet) * 100).toFixed(1)}% of what they were owed`);
  if (sentTwice) bad("row count changed");
}

// ---------- phase: offline (no funds needed) ----------
// Runs the REAL sendPayouts + collector code, but Connection.sendTransaction/confirmTransaction/getBalance are
// replaced by an in-memory ledger with Solana's semantics: atomic tx, 5000 lamports fee per signature,
// a new (0-lamport) account must end >= rent-exempt minimum or the whole tx fails, tx must serialize <= 1232 bytes.
// Use only when devnet funding is unavailable; it proves the JS logic, not the network.
async function phaseOffline() {
  const RENT = 890_880; // mainnet value for a 0-byte account (devnet currently reports 650,240)
  const ledger = new Map([[kp.publicKey.toBase58(), 1 * LAMPORTS_PER_SOL]]);
  const bal = (w) => ledger.get(w) || 0;
  const landed = [];
  let mode = "normal"; // "timeout" = tx lands but confirmation throws
  const P = Connection.prototype;
  const { Transaction: Tx } = require("@solana/web3.js");
  const bs58 = require("bs58"); const enc = (b) => (bs58.default || bs58).encode(b);
  const sigs = new Map(); // signature -> { err }
  let height = 100;
  P.getLatestBlockhash = async function () { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height + 150 }; };
  P.getBlockHeight = async function () { return height; };
  P.getSignatureStatuses = async function (list) { return { value: list.map((s) => (sigs.has(s) ? { err: sigs.get(s).err, confirmationStatus: "confirmed" } : null)) }; };
  P.sendRawTransaction = async function (raw) {
    if (raw.length > 1232) throw new Error("simulated: Transaction too large");
    const tx = Tx.from(raw); const sig = enc(tx.signature);
    const next = new Map(ledger);
    const payer = tx.feePayer.toBase58();
    next.set(payer, (next.get(payer) || 0) - 5000);
    const touched = new Set();
    for (const ix of tx.instructions) {
      const lamports = Number(ix.data.readBigUInt64LE(4));
      const from = ix.keys[0].pubkey.toBase58(), to = ix.keys[1].pubkey.toBase58();
      next.set(from, (next.get(from) || 0) - lamports); next.set(to, (next.get(to) || 0) + lamports); touched.add(to);
    }
    const fail = [...touched].some((w) => bal(w) === 0 && next.get(w) < RENT) || next.get(payer) < 0;
    if (fail) { const e = new Error("Simulation failed. Message: insufficient funds for rent"); e.name = "SendTransactionError"; throw e; }
    for (const [k, v] of next) ledger.set(k, v);
    sigs.set(sig, { err: null });
    landed.push({ sig, n: tx.instructions.length, bytes: raw.length });
    return sig;
  };
  P.confirmTransaction = async function () {
    if (mode === "timeout") throw new Error("simulated: TransactionExpiredBlockheightExceededError (tx actually landed)");
    return { value: { err: null } };
  };
  P.getBalance = async function (pk) { return bal(pk.toBase58()); };

  const run = async (label, holders, day, sinners = [], payWrap) => {
    const { q } = open(":memory:");
    for (const w of sinners) { const t = Date.parse(day + "T12:00:00Z"); q.insertEvent.run("x" + w, w, "sell", 1, t, day); q.insertSinner.run(day, w, "x", t); } // a sell inside that day's window
    const chain = {
      mode: "live", jarWallet: () => kp.publicKey.toBase58(), jarSol: () => sol.balanceSol(kp.publicKey),
      holders: async () => holders.map((h) => ({ ...h })), pay: payWrap || ((p, h) => sol.sendPayouts(kp, p, h)), sigStatus: (s) => sol.sigStatus(s), claim: async () => "",
    };
    return { q, col: makeCollector({ q, chain, bot: { collection: () => {} } }) };
  };

  // A) happy path, 40 holders
  ledger.set(kp.publicKey.toBase58(), LAMPORTS_PER_SOL);
  const holders = fakeHolders(40);
  const sinners = [holders[7].owner, holders[8].owner, holders[9].owner];
  cfg.excluded.push(holders[10].owner);
  holders.push({ owner: kp.publicKey.toBase58(), tokens: 5e7 });
  let { q, col } = await run("A", holders, "2099-01-01", sinners);
  const n0 = landed.length;
  const s1 = await col.collect({ day: "2099-01-01", send: true });
  const rows = q.payoutsOf.all("2099-01-01");
  const txs = landed.length - n0;
  if (s1.status === "paid" && rows.every((r) => r.status === "sent" && bal(r.wallet) === r.lamports)) ok(`offline A: collect paid ${rows.length} wallets, every ledger balance == lamports`);
  else bad("offline A: " + JSON.stringify(s1));
  if (txs === Math.ceil(rows.length / cfg.batchSize)) ok(`offline A: ${txs} txs = ceil(${rows.length}/${cfg.batchSize}); sizes ${landed.slice(n0).map((l) => l.n + "ix/" + l.bytes + "B").join(", ")}`);
  else bad(`offline A: ${txs} txs`);
  if (s1.cleanCount === 30) ok("offline A: 30 clean (6 under threshold, 3 sinners, 1 excluded, jar wallet dropped)"); else bad("offline A clean " + s1.cleanCount);
  info(`offline A: jar left ${bal(kp.publicKey.toBase58())} lamports (reserve ${cfg.reserveSol * LAMPORTS_PER_SOL}, fees ${txs * 5000}); carrySol ${s1.carrySol}`);
  const n1 = landed.length;
  const s2 = await col.collect({ day: "2099-01-01", send: true });
  if (s2.skipped === "already paid" && landed.length === n1) ok("offline A: re-run -> 'already paid', no tx sent"); else bad("offline A rerun " + JSON.stringify(s2));

  // B) partial: 24 equal holders, 2nd batch contains one sub-rent transfer -> whole batch fails; then re-run
  ledger.set(kp.publicKey.toBase58(), LAMPORTS_PER_SOL);
  const hB = Array.from({ length: 24 }, () => ({ owner: gen(), tokens: 1e6 }));
  let first = true;
  ({ q, col } = await run("B", hB, "2099-01-02", [], (p, h) => {
    if (!first) return sol.sendPayouts(kp, p, h);
    first = false;
    return sol.sendPayouts(kp, p.map((x, i) => (i === 18 ? { ...x, lamports: 1000 } : x)), h);
  }));
  const b1 = await col.collect({ day: "2099-01-02", send: true });
  const rB1 = q.payoutsOf.all("2099-01-02");
  const failed = rB1.filter((r) => r.status === "failed");
  if (b1.status === "partial" && failed.length === 1 && failed.every((r) => bal(r.wallet) === 0) && rB1.filter((r) => r.status === "sent").every((r) => bal(r.wallet) === r.lamports)) ok("offline B: one sub-rent transfer sank its batch; batch retried one by one -> 23 paid, only the bad one failed");
  else bad("offline B1 " + JSON.stringify(b1));
  const owedEach = failed[0]?.lamports;
  const b2 = await col.collect({ day: "2099-01-02", send: true });
  const rB2 = q.payoutsOf.all("2099-01-02");
  const retried = rB2.filter((r) => failed.some((f) => f.wallet === r.wallet));
  const sentOnce = rB2.filter((r) => !failed.some((f) => f.wallet === r.wallet)).every((r) => bal(r.wallet) === r.lamports);
  if (b2.status === "paid" && retried.every((r) => r.status === "sent") && sentOnce) ok("offline B: re-run retried only the failed wallet; the 23 already-sent were not paid twice");
  else bad("offline B2 " + JSON.stringify(b2));
  if (retried.length === 1 && retried.every((r) => r.lamports === owedEach && bal(r.wallet) === owedEach)) ok(`offline B: retried wallets got the ORIGINAL amount ${owedEach} (not recomputed from the drained jar)`);
  else bad(`offline B: retried wallets got ${retried[0]?.lamports}, owed ${owedEach}`);

  // C) confirmation timeout although tx landed -> marked failed -> re-run pays AGAIN
  ledger.set(kp.publicKey.toBase58(), LAMPORTS_PER_SOL);
  const hC = Array.from({ length: 5 }, () => ({ owner: gen(), tokens: 1e6 }));
  ({ q, col } = await run("C", hC, "2099-01-03"));
  mode = "timeout";
  const c1 = await col.collect({ day: "2099-01-03", send: true });
  mode = "normal";
  ledger.set(kp.publicKey.toBase58(), bal(kp.publicKey.toBase58()) + LAMPORTS_PER_SOL); // jar refilled by new fees before the retry
  const afterFirst = bal(hC[0].owner);
  const c2 = await col.collect({ day: "2099-01-03", send: true });
  const afterSecond = bal(hC[0].owner);
  if (afterSecond > afterFirst && afterFirst > 0) bad(`offline C: DOUBLE PAY — tx landed but confirm threw -> rows 'failed' (status ${c1.status}); re-run paid again: wallet had ${afterFirst}, now ${afterSecond} lamports`);
  else ok("offline C: no double pay on confirm timeout");
}

(async () => {
  const phase = process.argv[2] || "all";
  if (phase === "offline") { await phaseOffline(); console.log("\n=== SUMMARY ===\n" + JSON.stringify(results, null, 2)); process.exit(results.fail.length ? 1 : 0); }
  console.log(`devnet test, phase=${phase}, rpc=${cfg.rpcUrl}, payout=${kp.publicKey.toBase58()}, batch=${cfg.batchSize}`);
  if (phase === "size" || phase === "all") await phaseSize();
  if (phase === "fund" || phase === "all") await phaseFund(Number(process.argv[3] || 1));
  if (phase === "direct" || phase === "all") await phaseDirect();
  if (phase === "collect" || phase === "all") await phaseCollect(process.argv[3]);
  if (phase === "partial" || phase === "all") await phasePartial(process.argv[3]);
  console.log("\n=== SUMMARY ===\n" + JSON.stringify(results, null, 2));
  process.exit(results.fail.length ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(2); });
