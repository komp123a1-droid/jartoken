// Public read API for the site + the Helius webhook endpoint. Plain node:http, no framework.
const cfg = require("./config");
const { dayOf } = require("./db");
const { isAddress } = require("./solana");

const { makeAdmin } = require("./admin");

function makeApi({ q, chain, ledger, collector }) {
  const admin = makeAdmin({ q, chain, ledger, collector });
  // Holder snapshot cache (DAS calls are not free): refreshed at most every 5 minutes.
  let snap = { at: 0, byOwner: new Map(), eligibleTokens: 0, eligibleCount: 0 };
  async function snapshot() {
    if (Date.now() - snap.at < (chain.mode === "mock" ? 3e3 : 5 * 60e3)) return snap; // DAS calls cost credits in live
    const excluded = new Set([...cfg.excluded, chain.jarWallet()]);
    const list = await chain.holders();
    const byOwner = new Map(list.map((h) => [h.owner, h.tokens]));
    const eligible = list.filter((h) => h.tokens >= cfg.thresholdTokens && !excluded.has(h.owner));
    snap = { at: Date.now(), byOwner, eligibleTokens: eligible.reduce((s, h) => s + h.tokens, 0), eligibleCount: eligible.length };
    return snap;
  }

  // Wallets that may not receive drops right now: swore within the last SIN_WINDOW_HOURS.
  const blockedNow = () => new Set(q.swearersBetween.all(Date.now() - cfg.sinWindowHours * 3600e3, Date.now()).map((r) => r.wallet));

  async function state() {
    const day = dayOf(Date.now());
    const s = await snapshot();
    const blocked = blockedNow();
    let cleanCount = 0, cleanTokens = 0;
    for (const [owner, tokens] of s.byOwner) {
      if (tokens >= cfg.thresholdTokens && !blocked.has(owner) && !cfg.excluded.includes(owner) && owner !== chain.jarWallet()) { cleanCount++; cleanTokens += tokens; }
    }
    const owedTotalSol = q.owedTotal.get().n / 1e9;
    const jarSol = await chain.jarSol();
    return {
      mode: chain.mode, demo: chain.mode === "mock", day,
      ca: chain.mode === "mock" ? "[coming soon]" : cfg.mint || "[coming soon]",
      jarWallet: chain.mode === "mock" ? null : chain.jarWallet(),
      jarSol, owedTotalSol, nextDropPotSol: Math.max(0, jarSol - cfg.reserveSol - owedTotalSol),
      cleanCount, cleanTokens, sinnersToday: q.sinnerCount.get(day).n, blockedNow: blocked.size,
      thresholdTokens: cfg.thresholdTokens, minPayoutSol: cfg.minPayoutSol,
      payoutEveryMin: cfg.payoutEveryMin, sinWindowHours: cfg.sinWindowHours,
      nextCollection: collector.nextCollection().toISOString(),
    };
  }

  async function wallet(addr) {
    if (!isAddress(addr)) return { status: 400, body: { error: "That is not a Solana wallet, dear." } };
    const day = dayOf(Date.now());
    const s = await snapshot();
    const tokens = s.byOwner.get(addr) || 0;
    const sin = q.isSinner.get(day, addr);
    const last = q.lastSwear.get(addr)?.ts || 0;
    const until = last ? last + cfg.sinWindowHours * 3600e3 : 0;
    const blocked = until > Date.now();
    const today = Object.fromEntries(q.walletDay.all(addr, day).map((r) => [r.kind, { count: r.n, tokens: r.tokens }]));
    const st = await state();
    const eligible = !blocked && tokens >= cfg.thresholdTokens;
    const estShareSol = eligible && st.cleanTokens ? st.nextDropPotSol * (tokens / st.cleanTokens) : 0; // next drop
    return {
      status: 200,
      body: {
        wallet: addr, day, tokens, swore: blocked, swearsToday: sin?.swears || 0, firstSwearSig: sin?.first_sig || null,
        blockedUntil: blocked ? new Date(until).toISOString() : null,
        owedSol: (q.owedOf.get(addr)?.lamports || 0) / 1e9,
        today, eligible, estShareSol, estimate: true, nextDrop: st.nextCollection,
        payouts: q.walletPayouts.all(addr),
      },
    };
  }

  function readBody(req, limit = 4e6) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      // Over the limit: stop keeping data, drain the rest, answer 413 (destroying the socket would hide the answer).
      req.on("data", (c) => { size += c.length; if (size > limit) { chunks.length = 0; reject(new Error("too large")); } else chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": cfg.corsOrigin, "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": cfg.corsOrigin, "access-control-allow-headers": "content-type, x-admin-token", "access-control-allow-methods": "GET, POST" }); return res.end(); }

      if (req.method === "POST" && url.pathname === "/webhook/helius") {
        if (cfg.webhookSecret && req.headers.authorization !== cfg.webhookSecret) return send(401, { error: "unauthorized" });
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch (e) { return send(e.message === "too large" ? 413 : 400, { error: e.message === "too large" ? "payload too large" : "invalid JSON" }); }
        const fresh = ledger.ingest(payload);
        return send(200, { ok: true, recorded: fresh.length });
      }
      if (url.pathname.startsWith("/admin/")) return admin(req, res, url, send, readBody);
      if (req.method !== "GET") return send(405, { error: "method not allowed" });

      if (url.pathname === "/api/health") return send(200, { ok: true, mode: chain.mode });
      if (url.pathname === "/api/state") return send(200, await state());
      if (url.pathname === "/api/feed") {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
        return send(200, q.feed.all(limit));
      }
      if (url.pathname.startsWith("/api/wallet/")) { const r = await wallet(decodeURIComponent(url.pathname.slice(12))); return send(r.status, r.body); }
      if (url.pathname === "/api/collections") return send(200, q.lastCollections.all(14));
      if (url.pathname.startsWith("/api/collections/")) {
        const day = url.pathname.slice(17);
        return send(200, { collection: q.getCollection.get(day) || null, payouts: q.payoutsOf.all(day) });
      }
      return send(404, { error: "not found" });
    } catch (e) {
      if (e.status) return send(e.status, { error: e.message });
      console.error("[api]", e.message);
      return send(500, { error: e.message });
    }
  };
}

module.exports = { makeApi };
