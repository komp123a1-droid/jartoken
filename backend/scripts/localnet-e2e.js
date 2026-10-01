// Real-chain end-to-end test on a LOCAL Solana validator. Nothing here touches devnet or mainnet.
//   docker run -d --name jar-validator -p 127.0.0.1:8899:8899 -p 127.0.0.1:8900:8900 solanalabs/solana:v1.18.26 solana-test-validator --reset
//   npm run localnet
// A real SPL token ($JAR stand-in), real holders, real buys/sells/transfers -> webhook -> live backend ->
// real SOL payouts, checked balance by balance on-chain. Then: process killed mid-payout, confirm timeout, CLI payout.
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");

const RPC = process.env.LOCALNET_RPC || "http://127.0.0.1:8899";
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error("refusing: not a local validator");
const DIR = path.join(__dirname, "..", "keys", "localnet"); // gitignored
fs.mkdirSync(DIR, { recursive: true });
const conn = new web3.Connection(RPC, "confirmed");
const { Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } = web3;
const DEC = 6, UNIT = 10 ** DEC;

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  · " + detail : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (pk) => conn.getBalance(new PublicKey(pk), "confirmed");
async function airdrop(pk, sol) {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}
const saveKp = (name, kp) => { const f = path.join(DIR, name + ".json"); fs.writeFileSync(f, JSON.stringify([...kp.secretKey])); return f; };

(async () => {
  const t0 = Date.now();
  try { await conn.getVersion(); } catch { console.log("Local validator is not running on " + RPC + " (see the docker command at the top)."); process.exit(2); }

  // ---------- setup: token, curve, dev, jar, holders ----------
  console.log("== setup on the local chain");
  const jar = Keypair.generate(), dev = Keypair.generate(), curve = Keypair.generate();
  await Promise.all([airdrop(jar.publicKey, 6), airdrop(dev.publicKey, 50), airdrop(curve.publicKey, 2)]);
  const mint = await spl.createMint(conn, dev, dev.publicKey, null, DEC);

  const holders = Array.from({ length: 60 }, (_, i) => ({ kp: Keypair.generate(), tokens: i < 10 ? 5000 + i * 9000 : Math.round(100000 + Math.random() * 20e6) }));
  const tokensOf = new Map(); // independent ledger of token balances (whole tokens)
  async function mintTo(owner, tokens) {
    const ata = await spl.getOrCreateAssociatedTokenAccount(conn, dev, mint, owner);
    await spl.mintTo(conn, dev, mint, ata.address, dev, BigInt(Math.round(tokens * UNIT)));
    tokensOf.set(owner.toBase58(), (tokensOf.get(owner.toBase58()) || 0) + tokens);
  }
  // batch: create ATA + mintTo for 6 holders per tx
  for (let i = 0; i < holders.length; i += 6) {
    const tx = new Transaction();
    for (const h of holders.slice(i, i + 6)) {
      const ata = spl.getAssociatedTokenAddressSync(mint, h.kp.publicKey);
      tx.add(spl.createAssociatedTokenAccountInstruction(dev.publicKey, ata, h.kp.publicKey, mint));
      tx.add(spl.createMintToInstruction(mint, ata, dev.publicKey, BigInt(Math.round(h.tokens * UNIT))));
      tokensOf.set(h.kp.publicKey.toBase58(), h.tokens);
    }
    await web3.sendAndConfirmTransaction(conn, tx, [dev]);
  }
  await mintTo(curve.publicKey, 500e6);
  await mintTo(dev.publicKey, 50e6);
  check("token + 60 holders + curve + dev created on-chain", true, `mint ${mint.toBase58().slice(0, 8)}…`);

  // ---------- backend in LIVE mode against the local chain ----------
  const dbPath = path.join(DIR, "e2e.db");
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) try { fs.unlinkSync(f); } catch {}
  const env = {
    MODE: "live", RPC_URL: RPC, HELIUS_API_KEY: "", MINT: mint.toBase58(), DECIMALS: String(DEC),
    PAYOUT_KEYPAIR: saveKp("jar", jar), EXCLUDED_WALLETS: [curve.publicKey, dev.publicKey].map(String).join(","),
    DB_PATH: dbPath, DRY_RUN: "false", RESERVE_SOL: "0.01", MIN_PAYOUT_SOL: "0.001", BATCH_SIZE: "18",
    WEBHOOK_SECRET: "e2e-secret", ADMIN_TOKEN: "e2e-admin", PORT: "8798", TG_BOT_TOKEN: "", X_API_KEY: "",
  };
  Object.assign(process.env, env);
  const http = require("http");
  const cfg = require("../src/config");
  const { open, dayOf } = require("../src/db");
  const { makeChain } = require("../src/chain");
  const { makeLedger } = require("../src/ledger");
  const { makeBot } = require("../src/swearbot");
  const { makeCollector, split } = require("../src/collector");
  const { makeApi } = require("../src/api");
  const chain = makeChain();
  const { db, q } = open(cfg.dbPath);
  const bot = makeBot({ q });
  const ledger = makeLedger({ q, excluded: new Set([...cfg.excluded, chain.jarWallet()]), onSwear: bot.swear });
  const collector = makeCollector({ q, chain, bot });
  const server = http.createServer(makeApi({ q, chain, ledger, collector }));
  await new Promise((r) => server.listen(cfg.port, r));
  const base = `http://127.0.0.1:${cfg.port}`;
  const get = (p) => fetch(base + p).then((r) => r.json());
  check("backend boots in LIVE mode on the local chain", chain.mode === "live" && chain.jarWallet() === jar.publicKey.toBase58());

  // ---------- real trades -> Helius-shaped webhook payloads ----------
  console.log("\n== real trades on-chain -> webhook");
  async function move(fromKp, toPk, tokens, type) {
    const src = spl.getAssociatedTokenAddressSync(mint, fromKp.publicKey);
    const dst = spl.getAssociatedTokenAddressSync(mint, toPk);
    const tx = new Transaction();
    if (!(await conn.getAccountInfo(dst))) tx.add(spl.createAssociatedTokenAccountInstruction(dev.publicKey, dst, toPk, mint));
    tx.add(spl.createTransferCheckedInstruction(src, mint, dst, fromKp.publicKey, BigInt(Math.round(tokens * UNIT)), DEC));
    tx.feePayer = dev.publicKey; // holders have no SOL; dev pays fees
    const sig = await web3.sendAndConfirmTransaction(conn, tx, [dev, fromKp]);
    const from = fromKp.publicKey.toBase58(), to = toPk.toBase58();
    tokensOf.set(from, tokensOf.get(from) - tokens); tokensOf.set(to, (tokensOf.get(to) || 0) + tokens);
    const res = await fetch(base + "/webhook/helius", {
      method: "POST", headers: { "content-type": "application/json", authorization: "e2e-secret" },
      body: JSON.stringify([{ signature: sig, timestamp: Math.floor(Date.now() / 1000), type, tokenTransfers: [{ fromUserAccount: from, toUserAccount: to, mint: mint.toBase58(), tokenAmount: tokens }] }]),
    }).then((r) => r.json());
    return { sig, recorded: res.recorded };
  }
  const H = (i) => holders[i].kp;
  const sinners = new Set();
  let recorded = 0;
  for (let i = 10; i < 18; i++) { recorded += (await move(H(i), curve.publicKey, 50000, "SWAP")).recorded; sinners.add(H(i).publicKey.toBase58()); }
  recorded += (await move(H(18), curve.publicKey, 20000, "SWAP")).recorded;
  recorded += (await move(H(18), curve.publicKey, 20000, "SWAP")).recorded; sinners.add(H(18).publicKey.toBase58());
  for (let i = 20; i < 26; i++) recorded += (await move(curve, H(i).publicKey, 300000, "SWAP")).recorded;
  const fresh = Keypair.generate();
  recorded += (await move(H(26), fresh.publicKey, 250000, "TRANSFER")).recorded; sinners.add(H(26).publicKey.toBase58());
  check("17 real trades recorded via webhook (8 sells, 1 double sell, 6 buys, 1 transfer)", recorded === 16 + 1, `recorded ${recorded}`);
  const today = dayOf(Date.now());
  const dbSin = new Set(q.sinnersOf.all(today).map((r) => r.wallet));
  check("sinners from real signatures == sellers + transferer", dbSin.size === sinners.size && [...sinners].every((w) => dbSin.has(w)), `${dbSin.size}`);
  check("double seller counted twice", q.isSinner.get(today, H(18).publicKey.toBase58()).swears === 2);

  // ---------- snapshot from the chain ----------
  const snap = await chain.holders();
  const snapMap = new Map(snap.map((h) => [h.owner, h.tokens]));
  const expectHolders = [...tokensOf].filter(([, t]) => t > 0);
  check("holder snapshot from chain == independent token ledger", snap.length === expectHolders.length && expectHolders.every(([o, t]) => Math.abs(snapMap.get(o) - t) < 1e-6), `${snap.length} holders`);

  // ---------- midnight collection, REAL sends ----------
  console.log("\n== collection with real SOL transfers");
  const jarBefore = await bal(jar.publicKey);
  const excluded = new Set([curve.publicKey.toBase58(), dev.publicKey.toBase58(), jar.publicKey.toBase58()]);
  const plan = split({ jarSol: jarBefore / LAMPORTS_PER_SOL, holders: snap, sinners, excluded });
  const before = new Map(await Promise.all(snap.map(async (h) => [h.owner, await bal(h.owner)])));
  const s = await collector.collect({ day: today, send: true });
  check("status paid", s.status === "paid", `${s.paidCount} wallets, ${s.paidSol.toFixed(4)} SOL`);
  const rows = q.payoutsOf.all(today);
  check("payout list == independent plan", rows.length === plan.pay.length && plan.pay.every((p) => rows.find((r) => r.wallet === p.wallet)?.lamports === p.lamports));
  let allMatch = true;
  for (const r of rows) if ((await bal(r.wallet)) - before.get(r.wallet) !== r.lamports) { allMatch = false; console.log("  mismatch", r.wallet); }
  check("EVERY on-chain balance went up by exactly its payout", allMatch, `${rows.length} wallets checked`);
  let sinZero = true; for (const w of sinners) if ((await bal(w)) !== before.get(w)) sinZero = false;
  check("sinners received nothing on-chain", sinZero);
  let smallZero = true; for (const h of holders.slice(0, 10)) if ((await bal(h.kp.publicKey)) !== 0) smallZero = false;
  check("holders under 100,000 received nothing", smallZero);
  check("curve and dev received nothing", !rows.some((r) => excluded.has(r.wallet)));
  const sigs = [...new Set(rows.map((r) => r.sig))];
  const sts = (await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true })).value;
  check("every payout signature is confirmed on-chain", sts.every((x) => x && !x.err), `${sigs.length} txs`);
  const jarAfter = await bal(jar.publicKey);
  let fees = 0; for (const s of sigs) fees += (await conn.getTransaction(s, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).meta.fee;
  check("jar spent exactly payouts + tx fees (read from the chain)", jarBefore - jarAfter === rows.reduce((t, r) => t + r.lamports, 0) + fees, `fees ${fees}`);
  check("jar keeps the reserve", jarAfter >= 0.01 * LAMPORTS_PER_SOL, (jarAfter / 1e9).toFixed(4) + " SOL left");
  const again = await collector.collect({ day: today, send: true });
  check("second run -> already paid, jar unchanged", again.skipped === "already paid" && (await bal(jar.publicKey)) === jarAfter);

  // ---------- API in live mode ----------
  const w = await get("/api/wallet/" + H(12).publicKey.toBase58());
  check("/api/wallet: real sinner -> swore, not eligible", w.swore && !w.eligible);
  const w2 = await get("/api/wallet/" + H(30).publicKey.toBase58());
  check("/api/wallet: clean holder -> today's payout listed with its signature", w2.payouts?.[0]?.sig && w2.payouts[0].status === "sent");
  const st = await get("/api/state");
  check("/api/state reads the jar from the chain", Math.abs(st.jarSol - jarAfter / 1e9) < 1e-9, st.jarSol.toFixed(4) + " SOL");

  // ---------- process killed after sending a batch ----------
  console.log("\n== crash: process killed after batch 2 was sent, before it was recorded");
  await airdrop(jar.publicKey, 3);
  const D1 = "2099-01-01";
  const balsBefore = new Map(await Promise.all(snap.map(async (h) => [h.owner, await bal(h.owner)])));
  const child = spawnSync(process.execPath, ["--no-warnings", "-e", `
    const w = require("@solana/web3.js"); let n = 0; const orig = w.Connection.prototype.confirmTransaction;
    w.Connection.prototype.confirmTransaction = async function (...a) { if (++n === 2) process.exit(7); return orig.apply(this, a); };
    const cfg = require("./src/config"); const { open } = require("./src/db"); const { makeChain } = require("./src/chain");
    const { makeCollector } = require("./src/collector"); const { q } = open(cfg.dbPath);
    makeCollector({ q, chain: makeChain(), bot: { collection() {} } }).collect({ day: "${D1}", send: true }).then(() => process.exit(0));
  `], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env }, encoding: "utf8" });
  const afterKill = q.payoutsOf.all(D1);
  check("process really died mid-payout (exit 7)", child.status === 7, "stderr: " + (child.stderr || "").slice(0, 80));
  check("DB after crash: batch 1 sent, batch 2 'sending' with signature, rest pending",
    afterKill.filter((p) => p.status === "sent").length === 18 && afterKill.filter((p) => p.status === "sending" && p.sig).length === 18,
    afterKill.map((p) => p.status).reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}) && JSON.stringify(afterKill.map((p) => p.status).reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})));
  await sleep(1500);
  const resumed = await collector.collect({ day: D1, send: true });
  const final1 = q.payoutsOf.all(D1);
  let exactOnce = true;
  for (const p of final1) if ((await bal(p.wallet)) - balsBefore.get(p.wallet) !== p.lamports) { exactOnce = false; console.log("  wrong", p.wallet); }
  check("resume: batch 2 found on-chain, NOT re-sent; day paid", resumed.status === "paid" && resumed.retried === final1.length - 36, `retried ${resumed.retried}`);
  check("every wallet paid EXACTLY once on-chain after the crash", exactOnce, `${final1.length} wallets`);

  // ---------- confirmation times out although the tx landed ----------
  console.log("\n== confirm timeout: tx landed, confirmTransaction threw");
  await airdrop(jar.publicKey, 2);
  const D2 = "2099-01-02";
  const balsBefore2 = new Map(await Promise.all(snap.map(async (h) => [h.owner, await bal(h.owner)])));
  const origConfirm = web3.Connection.prototype.confirmTransaction; let k = 0;
  web3.Connection.prototype.confirmTransaction = async function (...a) { if (++k === 1) { await sleep(800); throw new Error("simulated: block height exceeded"); } return origConfirm.apply(this, a); };
  const s2 = await collector.collect({ day: D2, send: true });
  web3.Connection.prototype.confirmTransaction = origConfirm;
  let once2 = true;
  for (const p of q.payoutsOf.all(D2)) if ((await bal(p.wallet)) - balsBefore2.get(p.wallet) !== p.lamports) once2 = false;
  check("timeout resolved on-chain as landed -> status paid, nobody paid twice", s2.status === "paid" && once2);

  // ---------- CLI payout ----------
  console.log("\n== CLI: npm run collect -- --send");
  await airdrop(jar.publicKey, 2);
  const D3 = "2099-01-03";
  const cli = spawnSync(process.execPath, ["--no-warnings", "scripts/collect-now.js", "--day=" + D3, "--send"], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env }, encoding: "utf8" });
  check("CLI collect --send exits 0 and pays the day", cli.status === 0 && q.getCollection.get(D3)?.status === "paid", (cli.stdout.match(/status: '(\w+)'/) || [])[1] || cli.stderr.slice(0, 100));
  const cli2 = spawnSync(process.execPath, ["--no-warnings", "scripts/collect-now.js", "--day=" + D3, "--send"], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env }, encoding: "utf8" });
  check("CLI second run -> already paid", /already paid/.test(cli2.stdout));
  await airdrop(jar.publicKey, 1);
  const jarBeforeDry = await bal(jar.publicKey);
  const cliDry = spawnSync(process.execPath, ["--no-warnings", "scripts/collect-now.js", "--day=2099-01-04", "--send"], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env, DRY_RUN: "true" }, encoding: "utf8" });
  check("CLI --send with DRY_RUN=true sends nothing (second lock)", /ignored/.test(cliDry.stderr + cliDry.stdout) && q.getCollection.get("2099-01-04")?.status === "dry-run" && (await bal(jar.publicKey)) === jarBeforeDry);

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)}s` + (failed.length ? "\nFAILED:\n - " + failed.map((f) => f.name).join("\n - ") : ""));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(2); });
