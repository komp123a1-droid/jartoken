// $JAR backend: webhook -> ledger (sinners) -> swear bot; midnight collection; public API.
const http = require("http");
const cfg = require("./config");
const { open, dayOf } = require("./db");
const { makeChain } = require("./chain");
const { makeLedger } = require("./ledger");
const { makeBot } = require("./swearbot");
const { makeCollector, yesterday } = require("./collector");
const { makeApi } = require("./api");
const { adminToken } = require("./admin");
const { backfillFromCheckpoint } = require("./backfill");

const chain = makeChain(); // must come first: mock mode registers its fake curve as excluded
const { q } = open(cfg.dbPath);
const bot = makeBot({ q });
const ledger = makeLedger({ q, excluded: new Set([...cfg.excluded, chain.jarWallet()]), onSwear: bot.swear });
// Before every split: pull any trades the webhook missed, so no seller slips onto the payout list.
const catchTrades = async () => {
  if (chain.mode !== "live" || !cfg.backfillMin) return;
  const n = await backfillFromCheckpoint({ q, ledger });
  if (n) console.log("[backfill] recorded " + n + " missed events");
};
const collector = makeCollector({ q, chain, bot, beforeCollect: catchTrades });
const api = makeApi({ q, chain, ledger, collector });

if (chain.mode === "live") {
  const missing = ["HELIUS_API_KEY", "MINT", "PAYOUT_KEYPAIR"].filter((k) => !process.env[k]);
  if (missing.length) { console.error("live mode needs:", missing.join(", ")); process.exit(1); }
}

chain.startFeed(ledger.ingest);
const next = collector.schedule();

if (chain.mode === "live") {
  // Start-up after downtime: backfill trades, then finish yesterday's collection if it was missed.
  (async () => {
    try { await catchTrades(); } catch (e) { console.error("[backfill]", e.message); }
    try { await collector.catchUp(); } catch (e) { console.error("[collect] catch-up failed:", e.message); }
  })();
  if (cfg.backfillMin) setInterval(() => catchTrades().catch((e) => console.error("[backfill]", e.message)), cfg.backfillMin * 60e3);
}

http.createServer(api).listen(cfg.port, () => {
  console.log(`$JAR backend · ${chain.mode} · http://127.0.0.1:${cfg.port}`);
  console.log(`  test page: /test/ · admin token: ${adminToken()}`);
  console.log(`  payouts: ${cfg.dryRun ? "DRY RUN (nothing is sent)" : "LIVE — SOL will be sent"} · next collection ${next.toISOString()} · today ${dayOf(Date.now())}`);
});
