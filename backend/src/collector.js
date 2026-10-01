// The midnight collection: snapshot holders, drop sinners + excluded wallets, split the jar pro rata in SOL.
// Shares under MIN_PAYOUT_SOL are not sent; that SOL simply stays in the jar for tomorrow.
const cfg = require("./config");
const { dayOf } = require("./db");
const { LAMPORTS_PER_SOL } = require("./solana");

const yesterday = () => dayOf(Date.now() - 864e5);

// Pure math, exported for tests.
function split({ jarSol, holders, sinners, excluded }) {
  const distributable = Math.max(0, jarSol - cfg.reserveSol);
  const pot = Math.floor(distributable * LAMPORTS_PER_SOL);
  const clean = holders.filter((h) => h.tokens >= cfg.thresholdTokens && !excluded.has(h.owner) && !sinners.has(h.owner));
  const total = clean.reduce((s, h) => s + h.tokens, 0);
  const minLamports = Math.ceil(cfg.minPayoutSol * LAMPORTS_PER_SOL);
  const shares = total ? clean.map((h) => ({ wallet: h.owner, tokens: h.tokens, lamports: Math.floor(pot * (h.tokens / total)) })) : [];
  const pay = shares.filter((s) => s.lamports >= minLamports);
  const paidLamports = pay.reduce((s, p) => s + p.lamports, 0);
  return { distributable, clean, pay, paidSol: paidLamports / LAMPORTS_PER_SOL, carrySol: distributable - paidLamports / LAMPORTS_PER_SOL };
}

function makeCollector({ q, chain, bot }) {
  let running = false;

  // Payout row states: dry-run | pending (not signed yet) | sending (signed, outcome unknown) | sent | failed | unknown.
  // Collection states: dry-run | empty | sending (payout running / crashed mid-way) | partial | paid.
  const STALE_MS = 3 * 60e3; // a blockhash expires in ~60-90s; a signature still missing after 3 min never landed

  async function collect({ day = yesterday(), send = !cfg.dryRun } = {}) {
    if (running) throw new Error("collection already running");
    running = true;
    try {
      const prev = q.getCollection.get(day);
      if (prev && prev.status === "paid") return { day, skipped: "already paid", ...prev };
      if (prev && (prev.status === "partial" || prev.status === "sending")) return await resume(day, prev, send);

      if (send && cfg.claimFees) {
        try { console.log("[collect] claimed creator fees:", await chain.claim()); }
        catch (e) { console.error("[collect] fee claim failed (continuing):", e.message); }
      }

      const excluded = new Set([...cfg.excluded, chain.jarWallet()]);
      const sinners = new Set(q.sinnersOf.all(day).map((r) => r.wallet));
      const jarSol = await chain.jarSol();
      const holders = await chain.holders();
      const r = split({ jarSol, holders, sinners, excluded });
      q.clearUnsentPayouts.run(day); // old dry-run rows

      const sending = send && r.pay.length > 0;
      const now = Date.now();
      for (const p of r.pay) q.putPayout.run(day, p.wallet, p.tokens, p.lamports, null, sending ? "pending" : "dry-run", now);
      const base = { day, jarSol, distributableSol: r.distributable, cleanCount: r.clean.length, sinnerCount: sinners.size, paidCount: r.pay.length, paidSol: r.paidSol, carrySol: r.carrySol };
      const save = (status) => q.putCollection.run(day, jarSol, r.distributable, r.clean.length, sinners.size, r.pay.length, r.paidSol, r.carrySol, status, Date.now());

      if (!sending) {
        const status = r.pay.length ? "dry-run" : "empty";
        save(status);
        return finish({ ...base, status });
      }
      save("sending"); // if the process dies from here on, the next run resumes instead of recomputing
      await pay(day, r.pay);
      return finish({ ...base, status: settle(day) });
    } finally {
      running = false;
    }
  }

  // Sign -> mark "sending" with the signature -> send -> mark the outcome. Every step hits the DB before the next.
  function pay(day, list) {
    const mark = (wallet, sig, status) => q.setPayoutState.run(sig, status, Date.now(), day, wallet);
    return chain.pay(list, {
      onSigned: (chunk, sig) => chunk.forEach((p) => mark(p.wallet, sig, "sending")),
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
        if (st === "landed") { q.setPayoutState.run(p.sig, "sent", Date.now(), day, p.wallet); continue; }
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

  // setTimeout to the next 00:00 UTC, then again every day.
  function schedule() {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5);
    setTimeout(async () => {
      try { await collect(); } catch (e) { console.error("[collect] failed:", e.message); }
      schedule();
    }, next - now.getTime());
    return new Date(next);
  }

  return { collect, schedule, nextCollection: () => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)) };
}

module.exports = { makeCollector, split, yesterday };
