// Home-PC runner: keeps the backend and the site server up, restarts them if they crash, writes logs/.
// Started at boot by Windows (windows/install-autostart.cmd). Manual: node run.js
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const LOGS = path.join(ROOT, "logs");
fs.mkdirSync(LOGS, { recursive: true });
const MAX_LOG = 20 * 1024 * 1024; // keep each log under ~20 MB

const services = [
  { name: "backend", cwd: path.join(ROOT, "backend"), args: ["--no-warnings", "--env-file-if-exists=.env", "src/index.js"] },
  { name: "site", cwd: ROOT, args: ["server.js"] },
];

function log(name, line) {
  const file = path.join(LOGS, name + ".log");
  try { if (fs.statSync(file).size > MAX_LOG) fs.renameSync(file, file + ".old"); } catch {}
  fs.appendFileSync(file, line);
}

function start(svc, delay = 1000) {
  const p = spawn(process.execPath, svc.args, { cwd: svc.cwd, env: process.env, windowsHide: true });
  const started = Date.now();
  const stamp = () => new Date().toISOString();
  log(svc.name, `${stamp()} [run] started pid ${p.pid}\n`);
  p.stdout.on("data", (d) => log(svc.name, d.toString()));
  p.stderr.on("data", (d) => log(svc.name, d.toString()));
  p.on("exit", (code) => {
    // crash loop protection: back off up to 1 minute, reset after a healthy minute
    const next = Date.now() - started > 60e3 ? 1000 : Math.min(delay * 2, 60e3);
    log(svc.name, `${stamp()} [run] exited with ${code}, restarting in ${next / 1000}s\n`);
    setTimeout(() => start(svc, next), next);
  });
  svc.proc = p;
}

fs.writeFileSync(path.join(LOGS, "run.pid"), String(process.pid)); // uninstall-autostart.cmd stops the whole tree
services.forEach((s) => start(s));
const stop = () => { services.forEach((s) => s.proc && s.proc.kill()); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("running: backend (:8788) + site (:8787). logs in " + LOGS);
