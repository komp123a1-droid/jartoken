// Manual collection. Dry run by default (computes + records, sends nothing).
//   npm run collect                     -> yesterday, dry run
//   npm run collect -- --day=2026-10-01 -> a given UTC day
//   npm run collect -- --send           -> actually send SOL (also needs DRY_RUN=false in .env as a second lock)
const cfg = require("../src/config");
const { open } = require("../src/db");
const { makeChain } = require("../src/chain");
const { makeBot } = require("../src/swearbot");
const { makeCollector, yesterday } = require("../src/collector");

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}`));
const day = arg("day")?.split("=")[1] || yesterday();
const send = !!arg("send") && !cfg.dryRun;
if (arg("send") && cfg.dryRun) console.warn("--send ignored: DRY_RUN is still true in .env");

const chain = makeChain();
const { q } = open(cfg.dbPath);
makeCollector({ q, chain, bot: makeBot({ q }) })
  .collect({ day, send })
  .then((s) => { console.log(s); process.exit(0); })
  .catch((e) => { console.error(e.message); process.exit(1); });
