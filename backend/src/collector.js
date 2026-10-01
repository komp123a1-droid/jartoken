// The drop: every PAYOUT_EVERY_MIN minutes (default 15) the jar is split pro rata among clean holders
// (>= THRESHOLD_TOKENS, no sell or transfer-out in the last SIN_WINDOW_HOURS). Each share is added to the wallet's
// personal balance ("owed"); a balance is sent once it reaches MIN_PAYOUT_SOL, smaller ones keep accumulating.
// A swear forfeits the wallet's balance back into the jar (ledger.js). Owed SOL stays in the jar wallet, so the
// pot of a drop is: jar balance - reserve - everything already owed - tx fees.
const cfg = require("./config");
const { dayOf } = require("./db");
const { LAMPORTS_PER_SOL } = require("./solana");

const TX_FEE = 5000; // lamports per signature (no priority fee)
const PERIOD_MS = () => cfg.payoutEveryMin * 60e3;

// Period id = UTC time of the drop, "YYYY-MM-DDTHH:MM". A bare date "YYYY-MM-DD" means the drop at the end of
// that UTC day (its 24h window = that day), which is what the daily tests and the test page use.
const periodId = (ms) => new Date(ms).toISOString().slice(0, 16);
const currentPeriod = () => periodId(Math.floor(Date.now() / PERIOD_MS()) * PERIOD_MS());
const nextDrop = () => new Date(Math.floor(Date.now() / PERIOD_MS()) * PERIOD_MS() + PERIOD_MS());
function periodEnd(id) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return Date.parse(id + "T00:00:00Z") + 864e5;
  return Date.parse(id + ":00Z");
}
const yesterday = () => dayOf(Date.now() - 864e5);

// Pure math, exported for tests. owed: Map wallet -> lamports already owed (not part of jarSol).
function split({ jarSol, holders, sinners, excluded, owed = new Map() }) {
  const distributable = Math.max(0, jarSol - cfg.reserveSol);
  const pot = Math.floor(distributable * LAMPORTS_PER_SOL);
  const clean = holders.filter((h) => h.tokens >= cfg.thresholdTokens && !excluded.has(h.owner) && !sinners.has(h.owner));
  const total = clean.reduce((s, h) => s + h.tokens, 0);
  const minLamports = Math.ceil(cfg.minPayoutSol * LAMPORTS_PER_SOL);
  const sharesFor = (p) => new Map(total ? clean.map((h) => [h.owner, Math.floor(p * (h.tokens / total))]) : []);
  const tokensOf = new Map(holders.map((h) => [h.owner, h.tokens]));
  const payList = (shares) => {
    const out = [];
    for (const w of new Set([...shares.keys(), ...owed.keys()])) {
      if (excluded.has(w) || sinners.has(w)) continue;
      const lamports = (owed.get(w) || 0) + (shares.get(w) || 0);
      if (lamports >= minLamports) out.push({ wallet: w, tokens: tokensOf.get(w) || 0, lamports });
    }
    return out;
  };
  // Tx fees (paid by the jar) come out of the pot, so the reserve stays whole.
  let shares = sharesFor(pot), pay = payList(shares);
  const fees = Math.ceil(pay.length / cfg.batchSize) * TX_FEE;
  if (fees) { shares = sharesFor(Math.max(0, pot - fees)); pay = payList(shares); }
  const feeSol = Math.ceil(pay.length / cfg.batchSize) * TX_FEE / LAMPORTS_PER_SOL;
  const sharedLamports = [...shares.values()].reduce((s, l) => s + l, 0);
  const paidLamports = pay.reduce((s, p) => s + p.lamports, 0);
  const owedPaid = pay.reduce((s, p) => s + (owed.get(p.wallet) || 0), 0);
  return {
    distributable, clean, pay, shares, feeSol,
    paidSol: paidLamports / LAMPORTS_PER_SOL,
    accruedSol: (sharedLamports - (paidLamports - owedPaid)) / LAMPORTS_PER_SOL, // new shares kept as balances
    carrySol: distributable - feeSol - (paidLamports - owedPaid) / LAMPORTS_PER_SOL, // stays in the jar (incl. new balances)
  };
}

// beforeCollect: optional async hook run first (index.js uses it to backfill missed trades before splitting).
function makeCollector({ q, chain, bot, beforeCollect }) {
  let running = false;

  // Payout row states: dry-run | pending (not signed yet) | sending (signed, outcome unknown) | sent | failed | unknown.
  // Collection states: dry-run | empty | sending (payout running / crashed mid-way) | partial | paid.
  const STALE_MS = 3 * 60e3; // a blockhash expires in ~60-90s; a signature still missing after 3 min never landed

  const sinnersFor = (period) => {
    const end = periodEnd(period);
    return new Set(q.swearersBetween.all(end - cfg.sinWindowHours * 3600e3, end).map((r) => r.wallet));
  };

  async function collect({ day = currentPeriod(), send = !cfg.dryRun } = {}) {
    if (running) throw new Error("collection already running");
    running = true;
    try {
      const prev = q.getCollection.get(day);
      if (prev && prev.status === "paid") return { day, skipped: "already paid", ...prev };
      if (prev && (prev.status === "partial" || prev.status === "sending")) return await resume(day, prev, send);
      if (beforeCollect) { try { await beforeCollect(day); } catch (e) { console.error("[collect] beforeCollect failed:", e.message); } }

      if (send && cfg.claimFees) {
        try { const sig = await chain.claim(); if (sig) console.log("[collect] claimed creator fees:", sig); }
        catch (e) { console.error("[collect] fee claim failed (continuing):", e.message); }
      }

      const excluded = new Set([...cfg.excluded, chain.jarWallet()]);
      const sinners = sinnersFor(day);
      const owed = new Map(q.owedAll.all().map((r) => [r.wallet, r.lamports]));
      const owedTotal = [...owed.values()].reduce((s, l) => s + l, 0);
      const jarSol = await chain.jarSol();
      const holders = await chain.holders();
      const r = split({ jarSol: jarSol - owedTotal / LAMPORTS_PER_SOL, holders, sinners, excluded, owed });
      q.clearUnsentPayouts.run(day); // old dry-run rows

      const sending = send && (r.pay.length > 0 || r.shares.size > 0);
      const now = Date.now();
      const base = { day, jarSol, distributableSol: r.distributable, cleanCount: r.clean.length, sinnerCount: sinners.size, paidCount: r.pay.length, paidSol: r.paidSol, accruedSol: r.accruedSol, carrySol: r.carrySol, owedBeforeSol: owedTotal / LAMPORTS_PER_SOL };
      const save = (status) => q.putCollection.run(day, jarSol, r.distributable, r.clean.length, sinners.size, r.pay.length, r.paidSol, r.carrySol, status, Date.now());

      if (!sending) {
        for (const p of r.pay) q.putPayout.run(day, p.wallet, p.tokens, p.lamports, null, "dry-run", now);
        const status = r.pay.length ? "dry-run" : "empty";
        save(status);
        return finish({ ...base, status });
      }
      // One transaction: credit every share to its balance, record what will be sent, mark the drop in progress.
      // If the process dies after this, the next run resumes the same list instead of crediting twice.
      q.tx(() => {
        for (const [w, l] of r.shares) if (l > 0) q.owedAdd.run(w, l, now);
        for (const p of r.pay) q.putPayout.run(day, p.wallet, p.tokens, p.lamports, null, "pending", now);
        save(r.pay.length ? "sending" : "paid");
      });
      if (!r.pay.length) return finish({ ...base, status: "paid" }); // shares only accrued this time
      await pay(day, r.pay);
      return finish({ ...base, status: settle(day) });
    } finally {
      running = false;
    }
  }

  // A payout leaving the jar settles that much of the wallet's balance.
  const markSent = (day, wallet, sig, lamports) => q.tx(() => {
    q.setPayoutState.run(sig, "sent", Date.now(), day, wallet);
    q.owedSub.run(lamports, Date.now(), wallet);
  });

  // Sign -> mark "sending" with the signature -> send -> mark the outcome. Every step hits the DB before the next.
  function pay(day, list) {
    const amount = new Map(list.map((p) => [p.wallet, p.lamports]));
    const mark = (wallet, sig, status) => (status === "sent" ? markSent(day, wallet, sig, amount.get(wallet)) : q.setPayoutState.run(sig, status, Date.now(), day, wallet));
    return chain.pay(list, {
      onSigned: (chunk, sig) => chunk.forEach((p) => q.setPayoutState.run(sig, "sending", Date.now(), day, p.wallet)),
      onBatch: (res) => res.forEach((x) => mark(x.wallet, x.sig, x.status)),
    });
  }

  function settle(day) {
    const rows = q.payoutsOf.all(day);
    const status = rows.every((p) => p.status === "sent") ? "paid" : "partial";
    q.setCollectionStatus.run(status, Date.now(), day);
    return status;
  }

  // Finish a payout that was cut short. Rows with a signature are looked up on-chain first, never blindly re-sent.
  async function resume(day, prev, send) {
    const rows = q.payoutsOf.all(day);
    const base = { day, jarSol: prev.jar_sol, distributableSol: prev.distributable_sol, cleanCount: prev.clean_count, sinnerCount: prev.sinner_count, paidCount: prev.paid_count, paidSol: prev.paid_sol, carrySol: prev.carry_sol };
    if (!send) return { ...base, status: prev.status, skipped: "payout in progress; resume with sending enabled", open: rows.filter((p) => p.status !== "sent").length };

    const retry = [], unresolved = [];
    for (const p of rows) {
      if (p.status === "sent") continue;
      if (p.sig && (p.status === "sending" || p.status === "unknown")) {
        let st = "missing";
        try { st = await chain.sigStatus(p.sig); } catch {}
        if (st === "landed") { markSent(day, p.wallet, p.sig, p.lamports); continue; }
        if (st === "missing" && Date.now() - (p.ts || 0) < STALE_MS) { unresolved.push(p.wallet); continue; }
      }
      retry.push({ wallet: p.wallet, tokens: p.tokens, lamports: p.lamports }); // pending, failed, or provably never landed
    }
    if (unresolved.length) {
      console.warn("[collect] " + unresolved.length + " payouts still in flight; not re-sending. Run again in a few minutes.");
      q.setCollectionStatus.run("partial", Date.now(), day);
      return { ...base, status: "partial", unresolved: unresolved.length };
    }
    if (retry.length) await pay(day, retry);
    return finish({ ...base, status: settle(day), retried: retry.length });
  }

  function finish(summary) {
    bot.collection(summary, { preview: summary.status !== "paid" && summary.status !== "empty" });
    console.log("[collect]", JSON.stringify(summary));
    return summary;
  }

  // A drop at every period boundary (UTC-aligned: :00/:15/:30/:45 for 15 min, 00:00 for 1440).
  function schedule() {
    const at = nextDrop().getTime() + 3000;
    setTimeout(async () => {
      try { await collect({ day: periodId(at - 3000) }); } catch (e) { console.error("[collect] failed:", e.message); }
      schedule();
    }, at - Date.now());
    return new Date(at - 3000);
  }

  // Start-up after downtime: an unfinished drop is resumed; if no drop happened for over a period, drop now.
  // Nothing is lost while the PC was off: balances and the pot simply wait for the next drop.
  async function catchUp() {
    const open = q.openCollections.all();
    for (const c of open) { console.log("[collect] resuming " + c.day); await collect({ day: c.day }); }
    const last = q.lastCollections.all(1)[0];
    if (last && Date.now() - last.ts < PERIOD_MS()) return open.length ? { resumed: open.length } : null;
    const day = currentPeriod();
    const c = q.getCollection.get(day);
    if (c && (c.status === "paid" || c.status === "empty" || (c.status === "dry-run" && cfg.dryRun))) return null;
    console.log("[collect] catching up: drop " + day);
    return collect({ day });
  }

  return { collect, schedule, catchUp, nextCollection: nextDrop, currentPeriod };
}

module.exports = { makeCollector, split, yesterday, periodId, periodEnd, currentPeriod };
