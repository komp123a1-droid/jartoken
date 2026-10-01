// Admin endpoints for the test page (/test/). Header x-admin-token required.
// Nothing here can send SOL: web collections are always dry-run; real payouts only via `npm run collect -- --send`.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cfg = require("./config");
const { dayOf } = require("./db");
const sol = require("./solana");

// ADMIN_TOKEN from env, otherwise generated once and kept in .admin-token (gitignored).
function adminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const file = path.join(__dirname, "..", ".admin-token");
  try { return fs.readFileSync(file, "utf8").trim(); } catch {}
  const t = crypto.randomBytes(12).toString("hex");
  fs.writeFileSync(file, t);
  return t;
}

function parseJson(s) {
  try { return JSON.parse(s || "{}"); } catch { const e = new Error("invalid JSON"); e.status = 400; throw e; }
}

function makeAdmin({ q, chain, ledger, collector }) {
  const token = adminToken();
  const authed = (req) => {
    const got = Buffer.from(String(req.headers["x-admin-token"] || ""));
    const want = Buffer.from(token);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  function config() {
    return {
      mode: chain.mode, dryRun: cfg.dryRun, claimFees: cfg.claimFees,
      mint: chain.mode === "mock" ? cfg.mint + " (mock)" : cfg.mint || null, decimals: cfg.decimals,
      thresholdTokens: cfg.thresholdTokens, payoutEveryMin: cfg.payoutEveryMin, sinWindowHours: cfg.sinWindowHours, minPayoutSol: cfg.minPayoutSol, reserveSol: cfg.reserveSol, batchSize: cfg.batchSize,
      excluded: cfg.excluded, jarWallet: safe(() => chain.jarWallet()),
      heliusSet: !!cfg.heliusKey, webhookSecretSet: !!cfg.webhookSecret, payoutKeypairSet: !!cfg.payoutKeypair,
      telegramSet: !!(cfg.telegram.token && cfg.telegram.chat), xSet: require("./x").configured(), botInMock: cfg.botInMock,
      xMaxPerDay: cfg.x.maxPerDay,
      xMaxPerHour: cfg.x.maxPerHour, xMinTokens: cfg.x.minTokens,
    };
  }
  function safe(fn) { try { return fn(); } catch (e) { return null; } }

  // What has to be true before MODE=live. Checks the env, not the mock.
  async function preflight() {
    const checks = [];
    const add = (id, label, ok, detail = "") => checks.push({ id, label, ok, detail });
    const env = process.env;

    add("mode", "Mod rada", chain.mode === "live", chain.mode === "live" ? "live" : "mock — test podaci, ništa nije na lancu");
    add("dryrun", "Isplate (DRY_RUN)", null, cfg.dryRun ? "DRY_RUN=true: isplate se samo računaju. Prvi live dan ostavi ovako." : "DRY_RUN=false: u ponoć se šalje pravi SOL.");

    const mint = env.MINT || "";
    add("mint", "CA (MINT)", mint ? (sol.isAddressAny(mint) ? true : false) : false, mint ? (sol.isAddressAny(mint) ? mint : "nije ispravna Solana adresa") : "nije upisan — CA [coming soon]");

    let heliusOk = false;
    if (!cfg.heliusKey) add("helius", "Helius API ključ", false, "HELIUS_API_KEY nije upisan");
    else {
      try {
        const r = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }) }).then((x) => x.json());
        heliusOk = !r.error; add("helius", "Helius API ključ", heliusOk, heliusOk ? "RPC odgovara, slot " + r.result : r.error.message);
      } catch (e) { add("helius", "Helius API ključ", false, e.message); }
    }
    if (heliusOk && mint && sol.isAddressAny(mint)) {
      try {
        const r = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccounts", params: { mint, limit: 1, page: 1 } }) }).then((x) => x.json());
        add("holders", "Snapshot holdera (DAS)", !r.error, r.error ? r.error.message : "radi, ukupno naloga: " + (r.result?.total ?? "?"));
      } catch (e) { add("holders", "Snapshot holdera (DAS)", false, e.message); }
    } else add("holders", "Snapshot holdera (DAS)", null, "treba Helius ključ i CA");

    if (!env.PAYOUT_KEYPAIR) add("keypair", "Jar wallet (PAYOUT_KEYPAIR)", false, "nije upisan put do keypair fajla");
    else {
      try {
        const kp = sol.loadKeypair();
        let detail = kp.publicKey.toBase58();
        if (heliusOk) detail += " · balans " + (await sol.balanceSol(kp.publicKey)).toFixed(4) + " SOL";
        add("keypair", "Jar wallet (PAYOUT_KEYPAIR)", true, detail);
      } catch (e) { add("keypair", "Jar wallet (PAYOUT_KEYPAIR)", false, e.message); }
    }

    const ex = (env.EXCLUDED_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const badEx = ex.filter((w) => !sol.isAddressAny(w));
    add("excluded", "Isključeni walleti (curve, pool, dev, burn)", ex.length >= 2 && !badEx.length,
      !ex.length ? "prazno — bonding curve bi dobio isplatu!" : badEx.length ? "neispravne adrese: " + badEx.join(", ") : ex.length + " upisano" + (ex.length < 2 ? " (očekuje se bar curve + dev)" : ""));

    add("webhook", "Webhook tajna (WEBHOOK_SECRET)", !!cfg.webhookSecret, cfg.webhookSecret ? "upisana; ista vrednost ide u Helius 'Authorization header'" : "bez nje bilo ko može da šalje lažne trejdove");

    if (!cfg.telegram.token) add("telegram", "Telegram bot", false, "TG_BOT_TOKEN / TG_CHAT_ID nisu upisani (poruke idu samo u log)");
    else {
      try {
        const r = await fetch(`https://api.telegram.org/bot${cfg.telegram.token}/getMe`).then((x) => x.json());
        add("telegram", "Telegram bot", !!(r.ok && cfg.telegram.chat), r.ok ? "@" + r.result.username + (cfg.telegram.chat ? " → chat " + cfg.telegram.chat : " · TG_CHAT_ID fali") : r.description);
      } catch (e) { add("telegram", "Telegram bot", false, e.message); }
    }
    const x = require("./x");
    if (!x.configured()) add("x", "X nalog (4 ključa)", null, "opciono — bez njega Agnes piše samo na Telegram");
    else {
      try {
        const r = await x.me();
        add("x", "X nalog (4 ključa)", r.ok, r.ok ? "@" + r.json.data.username + " · limit " + cfg.x.maxPerDay + "/dan" : "greška " + r.status + ": " + (r.json?.detail || r.json?.title || r.text.slice(0, 120)));
      } catch (e) { add("x", "X nalog (4 ključa)", false, e.message); }
    }
    add("claim", "Klejm creator fee-jeva", cfg.claimFees ? true : null, cfg.claimFees ? "automatski pre svake isplate, iz oba vaulta (bonding curve + PumpSwap) — testirano na pravim pump programima" : "CLAIM_FEES=false: klejmuješ ručno na pump.fun pre ponoći");

    const required = ["mint", "helius", "holders", "keypair", "excluded", "webhook"];
    const readyForLive = required.every((id) => checks.find((c) => c.id === id)?.ok === true);
    return { readyForLive, checks };
  }

  return async function handleAdmin(req, res, url, send, readBody) {
    if (!authed(req)) return send(401, { error: "pogrešan ili prazan admin token" });
    if (req.method === "GET" && url.pathname === "/admin/config") return send(200, config());
    if (req.method === "GET" && url.pathname === "/admin/preflight") return send(200, await preflight());
    if (req.method === "GET" && url.pathname === "/admin/outbox") {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 20));
      return send(200, q.outboxLast.all(limit));
    }
    if (req.method === "GET" && url.pathname === "/admin/sinners") {
      const day = url.searchParams.get("day") || dayOf(Date.now());
      return send(200, q.sinnersFull.all(day));
    }
    if (req.method === "POST" && url.pathname === "/admin/simulate") {
      if (chain.mode !== "mock") return send(403, { error: "simulacija radi samo u mock modu" });
      const b = parseJson(await readBody(req));
      if (b.kind && !["buy", "sell", "transfer"].includes(b.kind)) return send(400, { error: "kind: buy | sell | transfer" });
      if (b.wallet && !sol.isAddressAny(b.wallet)) return send(400, { error: "neispravna Solana adresa" });
      const tx = chain.fakeTx({ kind: b.kind, wallet: b.wallet, tokens: Number(b.tokens) || 0 });
      const fresh = ledger.ingest(tx);
      return send(200, { recorded: fresh.length, events: fresh });
    }
    if (req.method === "POST" && url.pathname === "/admin/collect") {
      const b = parseJson(await readBody(req));
      const day = b.day || b.period || collector.currentPeriod();
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(day)) return send(400, { error: "day: YYYY-MM-DD ili period YYYY-MM-DDTHH:MM" });
      return send(200, await collector.collect({ day, send: false })); // never sends from the web
    }
    return send(404, { error: "not found" });
  };
}

module.exports = { makeAdmin, adminToken };
