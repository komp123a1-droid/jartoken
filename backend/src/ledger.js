// Turns Helius "enhanced transactions" into buy / sell / transfer events and keeps the sinner list.
// Rule (v1): ANY $JAR leaving a wallet is a swear (sell or transfer). Buying is fine.
const cfg = require("./config");
const { dayOf } = require("./db");

function makeLedger({ q, excluded, onSwear, onEvent }) {
  const isExcluded = (w) => !w || excluded.has(w);

  // Primary: the net $JAR balance change of every OWNER in the tx (accountData.tokenBalanceChanges) — ground truth.
  // tokenTransfers name the transfer AUTHORITY as "fromUserAccount", which is wrong for delegated sells and routers
  // (seen on mainnet: a delegate sold 1.9M tokens out of someone else's account via a temp account).
  // Fallback for payloads without accountData: the tokenTransfers list.
  function parseByBalances(tx, ts) {
    const net = new Map();
    for (const a of tx.accountData || []) for (const c of a.tokenBalanceChanges || []) {
      if (c.mint !== cfg.mint || !c.userAccount) continue;
      const raw = c.rawTokenAmount || {};
      net.set(c.userAccount, (net.get(c.userAccount) || 0) + Number(raw.tokenAmount || 0) / 10 ** (raw.decimals ?? cfg.decimals));
    }
    if (!net.size) return null;
    const exGained = [...net].some(([w, d]) => isExcluded(w) && d > 0);
    const exLost = [...net].some(([w, d]) => isExcluded(w) && d < 0);
    const events = [];
    for (const [w, d] of net) {
      if (isExcluded(w) || Math.abs(d) < 1e-9) continue;
      if (d < 0) events.push({ sig: tx.signature, wallet: w, kind: exGained || tx.type === "SWAP" ? "sell" : "transfer", tokens: -d, ts });
      else if (exLost || tx.type === "SWAP") events.push({ sig: tx.signature, wallet: w, kind: "buy", tokens: d, ts });
    }
    return events;
  }

  function parse(tx) {
    const ts = (tx.timestamp || Math.floor(Date.now() / 1000)) * 1000;
    const byBalances = parseByBalances(tx, ts);
    if (byBalances) return byBalances;
    const events = [];
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
        q.owedForfeit?.run(Date.now(), e.wallet); // a swear forfeits the unpaid balance back into the jar
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
