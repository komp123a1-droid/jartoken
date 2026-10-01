// X setup helper.
//   npm run x            -> checks the 4 keys (GET /2/users/me)
//   npm run x -- --post  -> posts one test post as Sister Agnes (counts against your monthly limit)
const x = require("../src/x");

(async () => {
  if (!x.configured()) {
    console.log(`X ključevi nisu upisani. Koraci:
1) developer.x.com → uloguj se SA NALOGOM BOTA (Sister Agnes), ne svojim.
2) Projects & Apps → app → User authentication settings → App permissions: "Read and write".
3) Keys and tokens → API Key and Secret → X_API_KEY, X_API_SECRET.
4) Keys and tokens → Access Token and Secret → Generate (POSLE koraka 2, inače je read-only) → X_ACCESS_TOKEN, X_ACCESS_SECRET.
5) npm run x`);
    process.exit(1);
  }
  const r = await x.me();
  if (!r.ok) {
    console.log("Ključevi ne rade:", r.status, r.json?.detail || r.json?.title || r.text.slice(0, 200));
    if (r.status === 401) console.log("→ proveri da su sva 4 ključa iz ISTE aplikacije i da access token nije regenerisan posle upisa.");
    if (r.status === 403) console.log("→ app nema Read and write, ili tvoj nivo API-ja ne dozvoljava ovaj poziv.");
    process.exit(1);
  }
  console.log("X nalog: @" + r.json.data.username + " ✓");
  if (process.argv.includes("--post")) {
    const p = await x.post("Testing, testing.\n\nThe jar is listening.\n\n— Sr. Agnes");
    console.log(p.ok ? "Objavljeno ✓ id " + p.json.data.id : "Nije objavljeno: " + p.status + " " + (p.json?.detail || p.text.slice(0, 200)));
    if (p.status === 403) console.log("→ najčešće: access token je generisan dok je app bio read-only. Regeneriši ga.");
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
