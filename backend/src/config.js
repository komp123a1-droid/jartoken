// All settings come from env (.env). See .env.example.
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
const env = process.env;

const heliusKey = env.HELIUS_API_KEY || "";

module.exports = {
  mode: env.MODE === "live" ? "live" : "mock",
  port: num(env.PORT, 8788),

  heliusKey,
  rpcUrl: env.RPC_URL || (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : "https://api.mainnet-beta.solana.com"),
  mint: env.MINT || "",
  decimals: num(env.DECIMALS, 6),
  payoutKeypair: env.PAYOUT_KEYPAIR || "",
  excluded: list(env.EXCLUDED_WALLETS),

  thresholdTokens: num(env.THRESHOLD_TOKENS, 100000),
  // floor: a transfer to a brand-new account below rent-exemption (~0.00089 SOL) fails and sinks its whole tx
  minPayoutSol: Math.max(num(env.MIN_PAYOUT_SOL, 0.001), 0.00089088),
  reserveSol: num(env.RESERVE_SOL, 0.02),
  batchSize: Math.min(Math.max(1, num(env.BATCH_SIZE, 18)), 21), // 21 transfers = 1195 B, 22 > 1232 B tx limit
  dryRun: env.DRY_RUN !== "false",
  claimFees: env.CLAIM_FEES === "true",

  webhookSecret: env.WEBHOOK_SECRET || "",

  telegram: { token: env.TG_BOT_TOKEN || "", chat: env.TG_CHAT_ID || "" },
  x: {
    apiKey: env.X_API_KEY || "", apiSecret: env.X_API_SECRET || "", accessToken: env.X_ACCESS_TOKEN || "", accessSecret: env.X_ACCESS_SECRET || "",
    maxPerHour: num(env.X_MAX_PER_HOUR, 4), maxPerDay: num(env.X_MAX_PER_DAY, 15), minTokens: num(env.X_MIN_TOKENS, 1000000),
  },
  botInMock: env.BOT_IN_MOCK === "true", // post mock (fake) swears to the real TG/X accounts: only for testing the bot

  dbPath: env.DB_PATH || (env.MODE === "live" ? "./jar.db" : "./jar-mock.db"), // mock never touches the real ledger
  corsOrigin: env.CORS_ORIGIN || "*",
  mockTradeMs: num(env.MOCK_TRADE_MS, 7000),
};
