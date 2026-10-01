// Creator-fee CLAIM + PAYOUT against the REAL pump.fun programs, cloned from mainnet into a local validator.
// Full coin lifecycle: launch (create_v2, jar wallet = creator) -> trades on the bonding curve -> claim ->
// graduation (bonding curve complete -> migrate to PumpSwap) -> trades on the AMM -> claim from the AMM vault ->
// midnight collection (claim + split + SOL payouts), checked on-chain. Setup: README "pump.fun test".
//   npm run pump-test
const path = require("path");
const fs = require("fs");
const web3 = require("@solana/web3.js");
const spl = require("@solana/spl-token");
const BN = require("bn.js");
const P = require("@pump-fun/pump-sdk");
const A = require("@pump-fun/pump-swap-sdk");
const { Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction, ComputeBudgetProgram } = web3;

const RPC = process.env.LOCALNET_RPC || "http://127.0.0.1:8899";
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error("refusing: not a local validator");
const CREATOR_FEE_BPS = Number(process.env.CREATOR_FEE_BPS || 100); // what we would launch with (pump allows up to 300)
const DIR = path.join(__dirname, "..", "keys", "pumpnet");
fs.mkdirSync(DIR, { recursive: true });
const conn = new web3.Connection(RPC, "confirmed");
const sdk = new P.OnlinePumpSdk(conn);
const amm = new A.OnlinePumpAmmSdk(conn);

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  · " + detail : "")); };
const bal = (pk) => conn.getBalance(new PublicKey(pk), "confirmed");
const sol = (l) => (Number(l) / 1e9).toFixed(6);
async function airdrop(pk, n) { const s = await conn.requestAirdrop(pk, n * LAMPORTS_PER_SOL); await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) }, "confirmed"); }
async function send(ixs, signers) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 800000 }), ...ixs);
  tx.feePayer = signers[0].publicKey;
  return web3.sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}
const why = (e) => [(e.message || "").split("\n")[0], ...((e.logs || e.transactionLogs || []).filter((l) => /Error|failed|AnchorError/.test(l)).slice(-3))].join("\n     ");

(async () => {
  const t0 = Date.now();
  if (!(await conn.getAccountInfo(P.PUMP_PROGRAM_ID || new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")))?.executable) { console.log("pump program missing on " + RPC + " — start the validator with the clones (README)"); process.exit(2); }
  const global = await sdk.fetchGlobal();
  const feeConfig = await sdk.fetchFeeConfig().catch(() => null);
  console.log(`pump (cloned from mainnet): protocol fee ${global.feeBasisPoints} bps · default creator fee ${global.creatorFeeBasisPoints} bps · configurable up to ${global.maxConfigurableCreatorFeeBps} bps`);

  // ---------- 1. launch ----------
  console.log(`\n== 1. launch: jar wallet creates the coin with create_v2, creator fee ${CREATOR_FEE_BPS} bps`);
  const jar = Keypair.generate(), mint = Keypair.generate();
  await airdrop(jar.publicKey, 20);
  try {
    const ix = await P.PUMP_SDK.createV2Instruction({ mint: mint.publicKey, name: "the swear jar", symbol: "JAR", uri: "https://jartoken.xyz/meta.json",
      creator: jar.publicKey, user: jar.publicKey, mayhemMode: false, creatorFeeBps: new BN(CREATOR_FEE_BPS) });
    await send([ix], [jar, mint]);
  } catch (e) { console.log("     " + why(e)); }
  const bc0 = await sdk.fetchBondingCurve(mint.publicKey).catch(() => null);
  check("coin launched on the real pump program, jar wallet = creator", bc0 && bc0.creator.equals(jar.publicKey), bc0 ? `creator_fee_bps on curve: ${bc0.creatorFeeBps}` : "");
  if (!bc0) return finish();
  const tokenProgram = (await conn.getAccountInfo(mint.publicKey)).owner;

  // ---------- 2. bonding curve trades ----------
  console.log("\n== 2. bonding curve: 10 traders buy, 4 sell");
  const traders = Array.from({ length: 10 }, () => Keypair.generate());
  await Promise.all(traders.map((t) => airdrop(t.publicKey, 5)));
  let vol = 0n;
  async function buy(t, solIn) {
    const st = await sdk.fetchBuyState(mint.publicKey, t.publicKey, tokenProgram);
    const lamports = new BN(Math.floor(solIn * LAMPORTS_PER_SOL));
    const amount = P.getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: lamports });
    const ixs = await P.PUMP_SDK.buyInstructions({ global, ...st, mint: mint.publicKey, user: t.publicKey, amount, solAmount: lamports, slippage: 5, tokenProgram });
    await send(ixs, [t]); vol += BigInt(lamports.toString());
    return amount;
  }
  async function sell(t, amount) {
    const st = await sdk.fetchSellState(mint.publicKey, t.publicKey, tokenProgram);
    const solOut = P.getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount });
    const ixs = await P.PUMP_SDK.sellInstructions({ global, ...st, mint: mint.publicKey, user: t.publicKey, amount, solAmount: solOut, slippage: 5, tokenProgram, mayhemMode: false });
    await send(ixs, [t]); vol += BigInt(solOut.toString());
  }
  let ok2 = true;
  try {
    const got = [];
    for (const t of traders) got.push(await buy(t, 1 + Math.random() * 2));
    for (let i = 0; i < 4; i++) await sell(traders[i], got[i].divn(2));
  } catch (e) { ok2 = false; console.log("     " + why(e)); }
  check("14 real trades on the bonding curve", ok2, `~${sol(vol)} SOL volume`);
  if (!ok2) return finish();
  const pending1 = Number(await sdk.getCreatorVaultBalanceBothPrograms(jar.publicKey));
  check("creator fees accrued in the creator vault", pending1 > 0, `${sol(pending1)} SOL = ${(pending1 / Number(vol) * 1e4).toFixed(1)} bps of volume`);

  // ---------- 3. claim with the backend's code ----------
  console.log("\n== 3. claim (backend: solana.claimCreatorFees)");
  Object.assign(process.env, { RPC_URL: RPC, MODE: "live", HELIUS_API_KEY: "", MINT: mint.publicKey.toBase58(), PAYOUT_KEYPAIR: path.join(DIR, "jar.json"),
    DB_PATH: path.join(DIR, "pump.db"), DRY_RUN: "false", CLAIM_FEES: "true", RESERVE_SOL: "0.01", THRESHOLD_TOKENS: "100000" });
  fs.writeFileSync(process.env.PAYOUT_KEYPAIR, JSON.stringify([...jar.secretKey]));
  for (const f of [process.env.DB_PATH, process.env.DB_PATH + "-wal", process.env.DB_PATH + "-shm"]) try { fs.unlinkSync(f); } catch {}
  const solana = require("../src/solana");
  let jb = await bal(jar.publicKey), sig1 = null;
  try { sig1 = await solana.claimCreatorFees(solana.loadKeypair()); } catch (e) { console.log("     " + why(e)); }
  let gained = (await bal(jar.publicKey)) - jb;
  check("claim confirmed", !!sig1);
  const fee1 = sig1 ? (await conn.getTransaction(sig1, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).meta.fee : 0;
  check("jar received exactly the pending fees (minus the tx fee read from the chain)", gained === pending1 - fee1, `+${sol(gained)} SOL, pending ${sol(pending1)}, tx fee ${fee1}, diff ${pending1 - fee1 - gained} lamports`);
  check("vault empty after claim", Number(await sdk.getCreatorVaultBalanceBothPrograms(jar.publicKey)) === 0);
  jb = await bal(jar.publicKey);
  const sig0 = await solana.claimCreatorFees(solana.loadKeypair());
  check("claim with nothing pending: no tx, no cost", sig0 === null && (await bal(jar.publicKey)) === jb);

  // ---------- 4. graduation ----------
  console.log("\n== 4. graduation: whales finish the curve, then migrate to PumpSwap");
  const whales = Array.from({ length: 3 }, () => Keypair.generate());
  await Promise.all(whales.map((w) => airdrop(w.publicKey, 60)));
  let complete = false, wi = 0, gradErr = null;
  try {
    while (!complete && wi < 30) {
      const bc = await sdk.fetchBondingCurve(mint.publicKey);
      if (bc.complete) { complete = true; break; }
      const left = bc.realTokenReserves;
      const w = whales[wi++ % whales.length];
      const st = await sdk.fetchBuyState(mint.publicKey, w.publicKey, tokenProgram);
      const want = BN.min(left, new BN(200_000_000).mul(new BN(10).pow(new BN(6))));
      const cost = P.getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply: st.bondingCurve.tokenTotalSupply, bondingCurve: st.bondingCurve, amount: want });
      await send(await P.PUMP_SDK.buyInstructions({ global, ...st, mint: mint.publicKey, user: w.publicKey, amount: want, solAmount: cost, slippage: 10, tokenProgram }), [w]);
      vol += BigInt(cost.toString());
    }
    complete = (await sdk.fetchBondingCurve(mint.publicKey)).complete;
  } catch (e) { gradErr = e; console.log("     " + why(e)); }
  check("bonding curve completed", complete, `${wi} whale buys`);
  let migrated = false;
  if (complete) {
    try {
      const ix = await P.PUMP_SDK.migrateInstruction({ withdrawAuthority: global.withdrawAuthority, mint: mint.publicKey, user: jar.publicKey, tokenProgram });
      await send([ix], [jar]);
      migrated = true;
    } catch (e) { console.log("     " + why(e)); }
  }
  const poolKey = P.canonicalPumpPoolPda(mint.publicKey);
  check("migrated to a PumpSwap pool", migrated && !!(await conn.getAccountInfo(poolKey)), poolKey.toBase58().slice(0, 8) + "…");

  // ---------- 5. AMM trades + claim from the AMM vault ----------
  let ammOk = false;
  if (migrated) {
    console.log("\n== 5. PumpSwap: trades on the AMM, creator fee lands in the AMM vault, claim");
    const pendingBefore = Number(await sdk.getCreatorVaultBalanceBothPrograms(jar.publicKey));
    try {
      for (const t of traders.slice(4, 8)) {
        const st = await amm.swapSolanaState(poolKey, t.publicKey);
        await send(await A.PUMP_AMM_SDK.buyQuoteInput(st, new BN(LAMPORTS_PER_SOL), 5), [t]);
      }
      const t = whales[0];
      const st = await amm.swapSolanaState(poolKey, t.publicKey);
      const ata = spl.getAssociatedTokenAddressSync(mint.publicKey, t.publicKey, false, tokenProgram);
      const have = new BN((await conn.getTokenAccountBalance(ata)).value.amount);
      await send(await A.PUMP_AMM_SDK.sellBaseInput(st, have.divn(10), 5), [t]);
      ammOk = true;
    } catch (e) { console.log("     " + why(e)); }
    check("5 real trades on the PumpSwap pool", ammOk);
    const pendingAmm = Number(await sdk.getCreatorVaultBalanceBothPrograms(jar.publicKey));
    check("creator fee accrued in the PumpSwap coin-creator vault", pendingAmm > pendingBefore, `${sol(pendingAmm)} SOL pending`);
    jb = await bal(jar.publicKey);
    let sig2 = null; try { sig2 = await solana.claimCreatorFees(solana.loadKeypair()); } catch (e) { console.log("     " + why(e)); }
    gained = (await bal(jar.publicKey)) - jb;
    check("post-graduation claim pulls the AMM fees into the jar as SOL (WSOL unwrapped)", !!sig2 && gained >= pendingAmm - 5000 - 2_100_000 && gained > 0, `+${sol(gained)} SOL (pending was ${sol(pendingAmm)})`);
    check("both vaults empty after claim", Number(await sdk.getCreatorVaultBalanceBothPrograms(jar.publicKey)) === 0);
    const wsolAta = spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, jar.publicKey);
    const leftover = await conn.getAccountInfo(wsolAta);
    check("no WSOL stuck in the jar's token account", !leftover || Number((await conn.getTokenAccountBalance(wsolAta)).value.amount) === 0, leftover ? "WSOL ATA open" : "WSOL ATA closed");
  }

  // ---------- 6. midnight collection: claim + split + pay ----------
  console.log("\n== 6. midnight collection with CLAIM_FEES=true");
  if (migrated) { for (const t of traders.slice(8, 10)) { const st = await amm.swapSolanaState(poolKey, t.publicKey); await send(await A.PUMP_AMM_SDK.buyQuoteInput(st, new BN(LAMPORTS_PER_SOL / 2), 5), [t]); } }
  else { await buy(traders[9], 1); }
  const pending3 = Number(await sdk.getCreatorVaultBalanceBothPrograms(jar.publicKey));
  const curve = P.bondingCurvePda(mint.publicKey);
  const poolAuth = migrated ? (await amm.fetchPool(poolKey)) : null;
  const excluded = [curve, poolKey, ...(poolAuth ? [poolAuth.creator] : [])].map((k) => k.toBase58());
  process.env.EXCLUDED_WALLETS = excluded.join(",");
  delete require.cache[require.resolve("../src/config")];
  const cfg = require("../src/config");
  const { open } = require("../src/db");
  const { makeChain } = require("../src/chain");
  const { makeCollector } = require("../src/collector");
  const { q } = open(cfg.dbPath);
  const sinner = traders[0].publicKey.toBase58(); // sold on the curve
  { const t = Date.parse("2099-03-01" + "T12:00:00Z"); q.insertEvent.run("x" + sinner, sinner, "sell", 1, t, "2099-03-01"); q.insertSinner.run("2099-03-01", sinner, "x", t); } // sold inside that day's window
  const chain = makeChain();
  const holders = await chain.holders();
  const jarPre = await bal(jar.publicKey);
  const s = await makeCollector({ q, chain, bot: { collection() {} } }).collect({ day: "2099-03-01", send: true });
  const rows = q.payoutsOf.all("2099-03-01");
  check("collect() claimed pending fees before splitting", Math.round(s.jarSol * 1e9) >= jarPre + pending3 - 5000, `vault had ${sol(pending3)}, jar at split ${s.jarSol.toFixed(4)} SOL`);
  check("pool / curve never on the payout list", !rows.some((r) => excluded.includes(r.wallet)), `${holders.length} holders on-chain`);
  check("sinner got nothing", !rows.some((r) => r.wallet === sinner));
  check("payouts sent and confirmed", s.status === "paid" && rows.length > 0, `${rows.length} wallets, ${s.paidSol.toFixed(4)} SOL`);
  const sts = (await conn.getSignatureStatuses([...new Set(rows.map((r) => r.sig))], { searchTransactionHistory: true })).value;
  check("payout signatures on-chain", sts.every((x) => x && !x.err));

  finish();
  function finish() {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)}s` + (failed.length ? "\nFAILED:\n - " + failed.map((f) => f.name).join("\n - ") : ""));
    process.exit(failed.length ? 1 : 0);
  }
})().catch((e) => { console.error("CRASH", why(e), e.stack.split("\n").slice(1, 3).join(" ")); process.exit(2); });
