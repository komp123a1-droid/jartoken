// Chain access: jar balance, holder snapshot (Helius DAS), batch SOL payouts, optional creator-fee claim.
const fs = require("fs");
const {
  Connection, PublicKey, Keypair, SystemProgram, Transaction, VersionedTransaction,
  LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const cfg = require("./config");

let _conn;
const conn = () => (_conn ||= new Connection(cfg.rpcUrl, "confirmed"));

function isAddress(s) {
  try { return PublicKey.isOnCurve(new PublicKey(s).toBytes()); } catch { return false; }
}

// Any valid public key, incl. PDAs (bonding curve, pool) which are off-curve.
function isAddressAny(s) {
  try { return new PublicKey(s).toBase58() === s; } catch { return false; }
}

function loadKeypair() {
  if (!cfg.payoutKeypair) throw new Error("PAYOUT_KEYPAIR is not set");
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(cfg.payoutKeypair, "utf8")));
  return Keypair.fromSecretKey(secret);
}

async function balanceSol(pubkey) {
  return (await conn().getBalance(new PublicKey(pubkey))) / LAMPORTS_PER_SOL;
}

// All $JAR holders, summed per owner: [{ owner, tokens }]
// Without Helius (or on a local validator): plain getProgramAccounts over SPL Token and Token-2022.
// Reads only owner + amount (bytes 32..72 of the account) to keep it light.
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
async function holdersViaRpc() {
  const mint = new PublicKey(cfg.mint);
  const byOwner = new Map();
  for (const pid of TOKEN_PROGRAMS) {
    const filters = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
    if (pid.startsWith("Tokenkeg")) filters.push({ dataSize: 165 });
    const accs = await conn().getProgramAccounts(new PublicKey(pid), { filters, dataSlice: { offset: 32, length: 40 } });
    for (const { account } of accs) {
      const d = account.data;
      const owner = new PublicKey(d.subarray(0, 32)).toBase58();
      const amount = Number(d.readBigUInt64LE(32)) / 10 ** cfg.decimals;
      if (amount > 0) byOwner.set(owner, (byOwner.get(owner) || 0) + amount);
    }
  }
  return [...byOwner].map(([owner, tokens]) => ({ owner, tokens }));
}

async function holders() {
  if (!cfg.heliusKey) return holdersViaRpc();
  const byOwner = new Map();
  for (let page = 1; ; page++) {
    const res = await fetch(cfg.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "jar", method: "getTokenAccounts", params: { mint: cfg.mint, page, limit: 1000 } }),
    }).then((r) => r.json());
    if (res.error) throw new Error("getTokenAccounts: " + res.error.message);
    const accs = res.result?.token_accounts || [];
    if (!accs.length) break;
    for (const a of accs) byOwner.set(a.owner, (byOwner.get(a.owner) || 0) + Number(a.amount) / 10 ** cfg.decimals);
  }
  return [...byOwner].map(([owner, tokens]) => ({ owner, tokens }));
}

// ---------- payouts ----------
// Safety rules (a payout must never be sent twice):
//  - every tx is signed BEFORE sending; its signature is reported via onSigned and stored as "sending"
//  - a send/confirm error is NOT a failure until the chain says so: we look the signature up, and only call it
//    "failed" once it is absent AND its blockhash has expired (then it can never land)
//  - otherwise the rows stay "unknown" and are re-checked, never re-sent, on the next run
//  - a batch that failed on-chain (e.g. one bad recipient) is retried one transfer per tx
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bs58 = require("bs58");
const b58 = (bytes) => (bs58.default || bs58).encode(bytes);

// "landed" | "failed" (on-chain error) | "missing" (not found)
async function sigStatus(sig) {
  const st = (await conn().getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
  if (!st) return "missing";
  return st.err ? "failed" : "landed";
}

async function sendBatch(keypair, chunk, onSigned) {
  const tx = new Transaction();
  for (const p of chunk) tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(p.wallet), lamports: p.lamports }));
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash; tx.feePayer = keypair.publicKey; tx.sign(keypair);
  const sig = b58(tx.signature);
  await onSigned?.(chunk, sig);
  try {
    await conn().sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  } catch (e) {
    // Rejected in preflight simulation: the RPC never forwarded it, so it cannot land.
    if (e.name === "SendTransactionError" || /simulation failed/i.test(e.message)) return { sig, status: "failed", error: e.message.split("\n")[0] };
    return await settleUnknown(sig, lastValidBlockHeight, e);
  }
  try {
    await conn().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return { sig, status: "sent" };
  } catch (e) {
    return await settleUnknown(sig, lastValidBlockHeight, e);
  }
}

// Sent but not confirmed: did it land anyway? Poll until found or the blockhash is past its last valid height.
async function settleUnknown(sig, lastValidBlockHeight, e) {
  for (let i = 0; i < 60; i++) {
    let st = "missing";
    try { st = await sigStatus(sig); } catch {}
    if (st === "landed") return { sig, status: "sent" };
    if (st === "failed") return { sig, status: "failed", error: e.message };
    try { if ((await conn().getBlockHeight("confirmed")) > lastValidBlockHeight) return { sig, status: "failed", error: e.message }; } catch {}
    await sleep(2000);
  }
  return { sig, status: "unknown", error: e.message }; // still in limbo: the next run re-checks, never re-sends blindly
}

// payouts: [{ wallet, lamports }]. Hooks: onSigned(chunk, sig) before sending, onBatch(results) after each tx.
async function sendPayouts(keypair, payouts, { onSigned, onBatch } = {}) {
  const out = [];
  const report = async (chunk, r) => {
    const res = chunk.map((p) => ({ wallet: p.wallet, sig: r.sig, status: r.status }));
    out.push(...res); await onBatch?.(res);
  };
  for (let i = 0; i < payouts.length; i += cfg.batchSize) {
    const chunk = payouts.slice(i, i + cfg.batchSize);
    const r = await sendBatch(keypair, chunk, onSigned);
    if (r.status === "failed" && chunk.length > 1) {
      console.error("[payout] batch failed on-chain, retrying one by one:", r.error);
      for (const p of chunk) await report([p], await sendBatch(keypair, [p], onSigned));
    } else {
      if (r.status !== "sent") console.error("[payout] batch", r.status, r.sig, r.error);
      await report(chunk, r);
    }
  }
  return out;
}

// Claim pump.fun creator fees into the jar wallet with the official SDK: drains BOTH vaults in one tx —
// the bonding-curve creator vault (SOL) and, after graduation, the PumpSwap coin-creator vault (WSOL, unwrapped).
// Returns the signature, or null when nothing is waiting. Tested on the real programs: scripts/pump-e2e.js.
async function pendingCreatorFeesLamports(creator) {
  const { OnlinePumpSdk } = require("@pump-fun/pump-sdk");
  return Number(await new OnlinePumpSdk(conn()).getCreatorVaultBalanceBothPrograms(new PublicKey(creator)));
}

async function claimCreatorFees(keypair) {
  const { OnlinePumpSdk } = require("@pump-fun/pump-sdk");
  const sdk = new OnlinePumpSdk(conn());
  if (!(await pendingCreatorFeesLamports(keypair.publicKey))) return null;
  let ixs = await sdk.collectCoinCreatorFeeInstructions(keypair.publicKey, keypair.publicKey);
  // Before graduation the PumpSwap vault does not exist yet; the SDK would create its WSOL account at the jar's
  // expense (~0.002 SOL rent) for nothing. Until it exists, only the bonding-curve collect is sent.
  const { coinCreatorVaultAuthorityPda, coinCreatorVaultAtaPda } = require("@pump-fun/pump-swap-sdk");
  const { NATIVE_MINT, TOKEN_PROGRAM_ID } = require("@solana/spl-token");
  const ammVault = coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(keypair.publicKey), NATIVE_MINT, TOKEN_PROGRAM_ID);
  if (!(await conn().getAccountInfo(ammVault))) ixs = ixs.slice(0, 1);
  return sendAndConfirmTransaction(conn(), new Transaction().add(...ixs), [keypair], { commitment: "confirmed" });
}

module.exports = { isAddress, isAddressAny, loadKeypair, balanceSol, holders, sendPayouts, sigStatus, claimCreatorFees, pendingCreatorFeesLamports, LAMPORTS_PER_SOL };
