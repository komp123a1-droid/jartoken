// Sister Agnes reads every swear aloud. Telegram gets every one; X only big ones, rate-limited.
// Without tokens configured, messages are only logged + stored in the outbox table.
const cfg = require("./config");
const x = require("./x");
const telegram = require("./telegram");

const short = (w) => w.slice(0, 4) + "…" + w.slice(-4);
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : Math.round(n / 1e3) + "K");
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const SELL = [
  (w, t) => `Language, ${w}.\n\nThat is a sell. ${t} $JAR. Into the jar.\n\nNo share for you tonight, dear. I am not angry. I am writing it down.\n\n— Sr. Agnes`,
  (w, t) => `${w}. I heard that.\n\n${t} $JAR, sold. Into the jar.\n\nThe clean mouths thank you for your contribution.\n\n— Sr. Agnes`,
  (w, t) => `${w}, at this hour?\n\nA sell of ${t} $JAR. You will not be collecting at midnight.\n\nThe ruler is right here.\n\n— Sr. Agnes`,
];
const AGAIN = (w, n) => `Again, ${w}? That is ${n} today.\n\nI have run out of patience and I am running out of ink.\n\n— Sr. Agnes`;
const TRANSFER = (w, t) => `${w} moved ${t} $JAR to another wallet.\n\nI know, dear. It counts. For now, a move is a sell.\n\nNo share tonight.\n\n— Sr. Agnes`;

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

  function collection(s, { preview = false } = {}) {
    const text = s.paidCount
      ? `The jar was emptied at 00:00 UTC.\n\n${s.paidSol.toFixed(3)} SOL, shared among ${s.paidCount.toLocaleString("en-US")} clean mouths.\n\n${s.sinnerCount} wallets swore yesterday. They know who they are. So do I.\n\nBless you, clean mouths.\n\n— Sr. Agnes`
      : `Midnight. The jar held ${s.jarSol.toFixed(3)} SOL, too little to share fairly.\n\nIt stays in the jar for tomorrow. Waste not.\n\n— Sr. Agnes`;
    console.log("[agnes] collection:", text.split("\n")[2] || text.split("\n")[0]);
    send("telegram", text, { preview });
    send("x", text, { preview });
  }

  return { swear, collection };
}

module.exports = { makeBot, short };
