// SQLite (built into Node 22). One file: trades, sinners per UTC day, collections, payouts, bot outbox.
const { DatabaseSync } = require("node:sqlite");

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function open(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      sig TEXT NOT NULL, wallet TEXT NOT NULL, kind TEXT NOT NULL,   -- buy | sell | transfer
      tokens REAL NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL,
      PRIMARY KEY (sig, wallet, kind)
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events (ts DESC);
    CREATE TABLE IF NOT EXISTS sinners (
      day TEXT NOT NULL, wallet TEXT NOT NULL, first_sig TEXT, ts INTEGER, swears INTEGER DEFAULT 1,
      PRIMARY KEY (day, wallet)
    );
    CREATE TABLE IF NOT EXISTS collections (
      day TEXT PRIMARY KEY, jar_sol REAL, distributable_sol REAL, clean_count INTEGER, sinner_count INTEGER,
      paid_count INTEGER, paid_sol REAL, carry_sol REAL, status TEXT, ts INTEGER   -- status: dry-run | paid | partial | empty
    );
    CREATE TABLE IF NOT EXISTS payouts (
      day TEXT NOT NULL, wallet TEXT NOT NULL, tokens REAL, lamports INTEGER, sig TEXT, status TEXT, ts INTEGER,
      PRIMARY KEY (day, wallet)
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, text TEXT, status TEXT, ts INTEGER
    );
  `);

  try { db.exec("ALTER TABLE payouts ADD COLUMN ts INTEGER"); } catch {} // DBs created before the column existed

  const q = {
    insertEvent: db.prepare("INSERT OR IGNORE INTO events (sig, wallet, kind, tokens, ts, day) VALUES (?, ?, ?, ?, ?, ?)"),
    insertSinner: db.prepare(`INSERT INTO sinners (day, wallet, first_sig, ts) VALUES (?, ?, ?, ?)
      ON CONFLICT (day, wallet) DO UPDATE SET swears = swears + 1`),
    isSinner: db.prepare("SELECT swears, first_sig, ts FROM sinners WHERE day = ? AND wallet = ?"),
    sinnersOf: db.prepare("SELECT wallet FROM sinners WHERE day = ?"),
    sinnerCount: db.prepare("SELECT COUNT(*) AS n FROM sinners WHERE day = ?"),
    feed: db.prepare("SELECT sig, wallet, kind, tokens, ts FROM events ORDER BY ts DESC LIMIT ?"),
    walletDay: db.prepare("SELECT kind, COUNT(*) AS n, SUM(tokens) AS tokens FROM events WHERE wallet = ? AND day = ? GROUP BY kind"),
    getCollection: db.prepare("SELECT * FROM collections WHERE day = ?"),
    lastCollections: db.prepare("SELECT * FROM collections ORDER BY day DESC LIMIT ?"),
    putCollection: db.prepare(`INSERT OR REPLACE INTO collections
      (day, jar_sol, distributable_sol, clean_count, sinner_count, paid_count, paid_sol, carry_sol, status, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    putPayout: db.prepare("INSERT OR REPLACE INTO payouts (day, wallet, tokens, lamports, sig, status, ts) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    setPayoutState: db.prepare("UPDATE payouts SET sig = ?, status = ?, ts = ? WHERE day = ? AND wallet = ?"),
    setCollectionStatus: db.prepare("UPDATE collections SET status = ?, ts = ? WHERE day = ?"),
    payoutsOf: db.prepare("SELECT * FROM payouts WHERE day = ? ORDER BY lamports DESC"),
    walletPayouts: db.prepare("SELECT day, lamports, sig, status FROM payouts WHERE wallet = ? ORDER BY day DESC LIMIT 30"),
    outboxLast: db.prepare("SELECT id, channel, text, status, ts FROM outbox ORDER BY id DESC LIMIT ?"),
    sinnersFull: db.prepare("SELECT wallet, swears, first_sig, ts FROM sinners WHERE day = ? ORDER BY ts DESC"),
    clearUnsentPayouts: db.prepare("DELETE FROM payouts WHERE day = ? AND status = 'dry-run'"),
    sentPayouts: db.prepare("SELECT wallet FROM payouts WHERE day = ? AND status = 'sent'"),
    outbox: db.prepare("INSERT INTO outbox (channel, text, status, ts) VALUES (?, ?, ?, ?)"),
    outboxSince: db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = ? AND status = 'sent' AND ts > ?"),
  };

  return { db, q };
}

module.exports = { open, dayOf };
