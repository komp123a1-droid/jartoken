// Sister Agnes reads every swear aloud. Telegram gets every one; X only big ones, rate-limited.
// Without tokens configured, messages are only logged + stored in the outbox table.
const cfg = require("./config");
const x = require("./x");
const telegram = require("./telegram");

const short = (w) => w.slice(0, 4) + "…" + w.slice(-4);
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : Math.round(n / 1e3) + "K");
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const H = () => cfg.sinWindowHours;
const SELL = [
  (w, t) => `Language, ${w}.

That is a sell. ${t} $JAR. Into the jar.

No drops for you for ${H()} hours, dear, and your unpaid balance goes back in the jar. I am not angry. I am writing it down.

— Sr. Agnes`,
  (w, t) => `${w}. I heard that.

${t} $JAR, sold. Into the jar.

The clean mouths thank you for your contribution. You may try again in ${H()} hours.

— Sr. Agnes`,
  (w, t) => `${w}, at this hour?

A sell of ${t} $JAR. No drops for ${H()} hours.

The ruler is right here.

— Sr. Agnes`,
];
const AGAIN = (w, n) => `Again, ${w}? That is ${n} today.

The clock starts over. ${H()} more hours without a drop. I am running out of ink.

— Sr. Agnes`;
const TRANSFER = (w, t) => `${w} moved ${t} $JAR to another wallet.

I know, dear. It counts. For now, a move is a sell.

No drops for ${H()} hours.

— Sr. Agnes`;
const hhmm = (id) => (id.length > 10 ? id.slice(11, 16) : "00:00");

function makeBot({ q }) {
  async function send(channel, text, { preview = false } = {}) {
    const now = Date.now();
    if (preview) return q.outbox.run(channel, text, "preview", now); // dry run: shown on the test page, never posted
    // Mock trades are fake: never post them to real accounts unless explicitly testing the bot.
    if (cfg.mode === "mock" && !cfg.botInMock) return q.outbox.run(channel, text, "log", now);
    try {
      if (channel === "telegram") {
        if (!telegram.configured()) return q.outbox.run(channel, text, "log", now);
        const r = await telegram.send(text);
        q.outbox.run(channel, text, r.ok ? "sent" : "error " + (r.description || r.error_code), now);
      } else if (channel === "x") {
        if (!x.configured()) return q.outbox.run(channel, text, "log", now);
        if (q.outboxSince.get("x", now - 3600e3).n >= cfg.x.maxPerHour) return q.outbox.run(channel, text, "rate-limited", now);
        if (q.outboxSince.get("x", now - 864e5).n >= cfg.x.maxPerDay) return q.outbox.run(channel, text, "daily-cap", now);
        const r = await x.post(text);
        q.outbox.run(channel, text, r.ok ? "sent" : "error " + r.status + " " + (r.json?.detail || r.json?.title || ""), now);
      }
    } catch (e) {
      q.outbox.run(channel, text, "error " + e.message, now);
    }
  }

  function swear(e, { firstToday }) {
    const w = short(e.wallet), t = fmt(e.tokens);
    let text;
    if (e.kind === "transfer") text = TRANSFER(w, t);
    else if (!firstToday) text = AGAIN(w, q.isSinner.get(new Date(e.ts).toISOString().slice(0, 10), e.wallet)?.swears || 2);
    else text = pick(SELL)(w, t);
    console.log("[agnes]", text.split("\n")[0]);
    send("telegram", text);
    if (e.tokens >= cfg.x.minTokens && firstToday) send("x", text);
  }

  // Telegram: one short line per drop that actually paid someone (empty drops stay quiet).
  // X: a summary at most every X_DROP_POST_EVERY_H hours, so frequent drops do not burn the post limit.
  function collection(s, { preview = false } = {}) {
    if (!s.paidCount) return;
    const tg = `Drop at ${hhmm(s.day)} UTC: ${s.paidSol.toFixed(4)} SOL to ${s.paidCount.toLocaleString("en-US")} clean mouths.

Bless you. Keep quiet.

— Sr. Agnes`;
    send("telegram", tg, { preview });
    const lastX = Number(q.kvGet?.get("x_drop_post")?.v || 0);
    if (preview || Date.now() - lastX < cfg.x.dropPostEveryH * 3600e3) return;
    const text = `The jar dropped again at ${hhmm(s.day)} UTC.

${s.paidSol.toFixed(3)} SOL, shared among ${s.paidCount.toLocaleString("en-US")} clean mouths.

${s.sinnerCount} wallets swore in the last ${H()} hours. They know who they are. So do I.

— Sr. Agnes`;
    q.kvSet?.run("x_drop_post", String(Date.now()));
    send("x", text);
  }

  return { swear, collection };
}

module.exports = { makeBot, short };
