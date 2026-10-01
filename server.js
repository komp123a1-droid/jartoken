// Serves the site (and /test/) and forwards /api, /admin, /webhook to the backend on :8788,
// so one tunnel exposes everything on the same origin. Never serves backend files (db, token, .env).
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname;
const BACKEND = { host: '127.0.0.1', port: Number(process.env.BACKEND_PORT) || 8788 };
const types = {'.html':'text/html; charset=utf-8','.svg':'image/svg+xml','.js':'text/javascript','.css':'text/css','.png':'image/png','.json':'application/json'};
const PROXY = /^\/(api|admin|webhook)\//;
const BLOCKED = /^\/(backend|node_modules)(\/|$)|\/\.|\.(db|env|yml|key|js)$/i;

http.createServer((req, res) => {
  if (PROXY.test(req.url)) {
    const up = http.request({ ...BACKEND, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502, {'content-type':'application/json'}); res.end('{"error":"backend is not running (cd backend && npm start)"}'); });
    return req.pipe(up);
  }
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); return res.end(); }
  if (BLOCKED.test(p)) { res.writeHead(404); return res.end('404'); }
  let f = path.join(root, path.normalize(p));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, {'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store'}); res.end(d);
  });
}).listen(8787, '127.0.0.1', () => console.log('http://127.0.0.1:8787'));
