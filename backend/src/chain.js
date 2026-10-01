// One interface for both modes. live = Solana via Helius. mock = in-memory jar + fake holders + fake trades
// shaped exactly like Helius enhanced transactions, so the same parser runs in both.
const cfg = require("./config");
const sol = require("./solana");

function live() {
  let kp = null;
  const keypair = () => (kp ||= sol.loadKeypair());
  return {
    mode: "live",
    jarWallet: () => keypair().publicKey.toBase58(),
    jarSol: () => sol.balanceSol(keypair().publicKey),
    holders: () => sol.holders(),
    pay: (payouts, hooks) => sol.sendPayouts(keypair(), payouts, hooks),
    sigStatus: (sig) => sol.sigStatus(sig),
    claim: () => sol.claimCreatorFees(keypair()),
    startFeed: () => {},
  };
}

function mock() {
  const { Keypair } = require("@solana/web3.js");
  const addr = () => Keypair.generate().publicKey.toBase58();
  const CURVE = addr(), JAR = addr();
  cfg.mint ||= "MOCKjar" + addr().slice(7);
  cfg.excluded.push(CURVE);

  let jar = 3.84; // SOL, demo
  const landed = new Set(); // mock "chain": signatures that landed
  const holders = Array.from({ length: 1400 }, () => ({ owner: addr(), tokens: Math.round(10 ** (4 + Math.random() * 3.2)) }));
  let n = 0;

  // opts (from the test page simulator): { kind: "buy"|"sell"|"transfer", wallet, tokens }
  function fakeTx(opts = {}) {
    let h = opts.wallet && holders.find((x) => x.owner === opts.wallet);
    if (opts.wallet && !h) holders.push((h = { owner: opts.wallet, tokens: 0 }));
    h ||= holders[Math.floor(Math.random() * holders.length)];
    const r = Math.random();
    const type = opts.kind ? (opts.kind === "transfer" ? "TRANSFER" : "SWAP") : r < 0.08 ? "TRANSFER" : "SWAP";
    const sell = opts.kind ? opts.kind !== "buy" : type === "TRANSFER" || r < 0.42;
    const tokens = Math.round(opts.tokens > 0 ? opts.tokens : 5e4 + Math.random() * 3e6);
    const to = type === "TRANSFER" ? addr() : sell ? CURVE : h.owner;
    const from = sell ? h.owner : CURVE;
    if (sell) h.tokens = Math.max(0, h.tokens - tokens); else h.tokens += tokens;
    if (type === "SWAP") jar += 0.0005 + Math.random() * 0.004; // creator fee, demo
    return {
      signature: "mock" + Date.now().toString(36) + (n++).toString(36) + Math.random().toString(36).slice(2, 10),
      timestamp: Math.floor(Date.now() / 1000), type, source: type === "SWAP" ? "PUMP_FUN" : "SYSTEM_PROGRAM",
      tokenTransfers: [{ fromUserAccount: from, toUserAccount: to, mint: cfg.mint, tokenAmount: tokens }],
    };
  }

  return {
    mode: "mock",
    curve: CURVE,
    fakeTx,
    jarWallet: () => JAR,
    jarSol: async () => jar,
    holders: async () => holders.map((h) => ({ ...h })),
    // Same contract as solana.sendPayouts: batches, onSigned before "sending", onBatch after.
    pay: async (payouts, { onSigned, onBatch } = {}) => {
      const out = [];
      for (let i = 0; i < payouts.length; i += cfg.batchSize) {
        const chunk = payouts.slice(i, i + cfg.batchSize);
        const sig = "mockpay" + Math.random().toString(36).slice(2, 14);
        await onSigned?.(chunk, sig);
        jar -= chunk.reduce((s, p) => s + p.lamports, 0) / sol.LAMPORTS_PER_SOL;
        landed.add(sig);
        const res = chunk.map((p) => ({ wallet: p.wallet, sig, status: "sent" }));
        out.push(...res); await onBatch?.(res);
      }
      return out;
    },
    sigStatus: async (sig) => (landed.has(sig) ? "landed" : "missing"),
    landed,
    claim: async () => "mockclaim",
    startFeed: (ingest) => setInterval(() => ingest(fakeTx()), cfg.mockTradeMs),
  };
}

module.exports = { makeChain: () => (cfg.mode === "live" ? live() : mock()) };
