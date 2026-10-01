// Home-PC hosting safety net: if the webhook was unreachable (PC off, internet down, sleep), pull the missed
// $JAR transactions from Helius' history API and run them through the same ledger. Signatures dedupe, so
// overlapping with the webhook is harmless. Without this, a seller missed during downtime would still get paid.
const cfg = require("./config");

const HISTORY = (mint, before) =>
  `https://api.helius.xyz/v0/addresses/${mint}/transactions?api-key=${cfg.heliusKey}&limit=100` + (before ? `&before=${before}` : "");

// Walks back from the newest tx until it passes `sinceMs`. Returns the number of new events recorded.
async function backfill({ ledger, sinceMs, fetchImpl = fetch, maxPages = 50 }) {
  if (!cfg.heliusKey || !cfg.mint) return 0;
  let before = null, recorded = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchImpl(HISTORY(cfg.mint, before));
    if (!res.ok) throw new Error("helius history " + res.status);
    const txs = await res.json();
    if (!Array.isArray(txs) || !txs.length) break;
    recorded += ledger.ingest(txs).length;
    const oldest = txs[txs.length - 1];
    if (oldest.timestamp * 1000 < sinceMs) break;
    before = oldest.signature;
  }
  return recorded;
}

// Checkpoint = moment up to which history is known to be fully scanned. A gap (PC off for hours) stays covered
// even after the webhook comes back, because the scan always starts from the checkpoint, not the newest event.
const yesterdayStart = () => Date.parse(new Date(Date.now() - 864e5).toISOString().slice(0, 10) + "T00:00:00Z");
function sinceFor(q) {
  const cp = Number(q.kvGet.get("backfill_until")?.v || 0);
  return Math.max(yesterdayStart(), cp - 5 * 60e3);
}

// One scan from the checkpoint; on success the checkpoint moves to when this scan started.
async function backfillFromCheckpoint({ q, ledger, fetchImpl }) {
  const startedAt = Date.now();
  const n = await backfill({ ledger, sinceMs: sinceFor(q), fetchImpl });
  q.kvSet.run("backfill_until", String(startedAt));
  return n;
}

module.exports = { backfill, sinceFor, backfillFromCheckpoint };
