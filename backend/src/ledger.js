// Turns Helius "enhanced transactions" into buy / sell / transfer events and keeps the sinner list.
// Rule (v1): ANY $JAR leaving a wallet is a swear (sell or transfer). Buying is fine.
const cfg = require("./config");
const { dayOf } = require("./db");

function makeLedger({ q, excluded, onSwear, onEvent }) {
  const isExcluded = (w) => !w || excluded.has(w);

  function parse(tx) {
    const events = [];
    const ts = (tx.timestamp || Math.floor(Date.now() / 1000)) * 1000;
    for (const t of tx.tokenTransfers || []) {
      if (t.mint !== cfg.mint) continue;
      const tokens = Number(t.tokenAmount) || 0;
      if (tokens <= 0) continue;
      const from = t.fromUserAccount, to = t.toUserAccount;
      if (!isExcluded(from)) {
        const kind = tx.type === "SWAP" || isExcluded(to) ? "sell" : "transfer";
        events.push({ sig: tx.signature, wallet: from, kind, tokens, ts });
      }
      if (!isExcluded(to) && (isExcluded(from) || tx.type === "SWAP")) {
        events.push({ sig: tx.signature, wallet: to, kind: "buy", tokens, ts });
      }
    }
    return events;
  }

  // Returns only events that were new (webhooks retry; signatures dedupe).
  function record(events) {
    const fresh = [];
    for (const e of events) {
      const day = dayOf(e.ts);
      const { changes } = q.insertEvent.run(e.sig, e.wallet, e.kind, e.tokens, e.ts, day);
      if (!changes) continue;
      fresh.push(e);
      if (e.kind !== "buy") {
        const before = q.isSinner.get(day, e.wallet);
        q.insertSinner.run(day, e.wallet, e.sig, e.ts);
        onSwear?.(e, { firstToday: !before });
      }
      onEvent?.(e);
    }
    return fresh;
  }

  const ingest = (txs) => record((Array.isArray(txs) ? txs : [txs]).flatMap(parse));

  return { parse, record, ingest };
}

module.exports = { makeLedger };
