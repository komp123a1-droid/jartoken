# $JAR — the swear jar

Meme coin na Solani (pump.fun) sa pravom mehanikom: **svaka prodaja je psovka**. Sestra Agnes javno proziva prodavca, a u **00:00 UTC** tegla (100% creator fee-jeva) se deli u SOL-u svima koji drže **≥ 100,000 $JAR** i tog dana **nisu prodali**.

CA: `[coming soon]`

## Struktura

```
site/            landing sajt (kuhinja + tegla). Sam, bez backenda, radi kao demo; sa backendom čita /api.
test/            "launch control" — stranica za testiranje backenda pre launcha (srpski)
backend/         Node 22: Helius webhook → lista grešnika (SQLite) → swear bot (Telegram/X) → ponoćna isplata → API
server.js        servira site/ i test/ i prosleđuje /api /admin /webhook na backend (jedan origin, jedan tunel)
run.js           pokreće i čuva backend + server.js (restart ako padnu, logovi u logs/)
windows/         autostart sa Windowsom, isključivanje spavanja
logo.svg
```

Detalji backenda: [`backend/README.md`](backend/README.md).

## Pokretanje lokalno

```bash
cd backend
npm install
cp .env.example .env        # MODE=mock radi bez ijednog ključa (lažni trejdovi)
npm start                   # backend na :8788, ispiše admin token
# drugi terminal, iz root foldera:
node server.js              # http://127.0.0.1:8787  (sajt) i /test/ (launch control)
```

Javni link za druge (opciono): `cloudflared tunnel --url http://127.0.0.1:8787`
Ako imaš `~/.cloudflared/config.yml` za drugi projekat, dodaj `--config prazan.yml` (inače quick tunel vraća 404).

## Testovi

```bash
cd backend
npm run test:all     # self-test + simulacija dana (53 provere) + isplate na offline Solana lancu (8 provera)
npm run pump-validator  # lokalni validator sa PRAVIM pump.fun programima kloniranim sa mainneta (Docker)
npm run pump-test    # launch → trejdovi → klejm → graduacija na PumpSwap → AMM klejm → ponoćna isplata (19 provera)
npm run localnet     # token, 60 holdera, pravi trejdovi, prave SOL isplate, ubijen proces usred isplate (27 provera)
npm run devnet all   # isto na DEVNETU (treba ~1 SOL na devnet test wallet, vidi dole)
```

Na `/test/` stranici: "pokreni sve redom" (8 koraka) — treba admin token iz `backend/.admin-token`.

## Podela posla

| Ko | Šta | Gde |
|---|---|---|
| **Blockchain** | devnet test pravih isplata, Helius webhook, CA, jar wallet, isključeni walleti, preflight → SPREMNO | `backend/src/solana.js`, `collector.js`, `scripts/devnet-test.js` |
| **Drugi deo** | Telegram + X za Sestru Agnes, sajt, test stranica | `backend/src/telegram.js`, `x.js`, `swearbot.js`, `site/`, `test/` |

Pravilo: posle izmene `npm run test:all` mora da prođe pre pusha.

## Telegram (Agnes proziva svaku prodaju)

1. U Telegramu otvori **@BotFather** → `/newbot` → ime npr. *Sister Agnes* → dobiješ token → `TG_BOT_TOKEN` u `backend/.env`.
2. Napravi kanal ili grupu za $JAR, dodaj bota kao **admina** (pravo da piše poruke).
3. Napiši bilo šta u grupu (u kanalu objavi post).
4. `npm run tg` → ispiše chat id (`-100…`) → upiši u `TG_CHAT_ID`. Javni kanal može i `@imekanala`.
5. `npm run tg -- --send` → stiže probna poruka od Agnes.

## X (Agnes piše samo velike prodaje + ponoćnu isplatu)

1. Napravi X nalog za Sestru Agnes. Na **developer.x.com** se uloguj **tim nalogom** i napravi app (free nivo je dovoljan za početak).
2. App → *User authentication settings* → **App permissions: Read and write**. (Uradi ovo PRE koraka 4.)
3. *Keys and tokens* → **API Key and Secret** → `X_API_KEY`, `X_API_SECRET`.
4. *Keys and tokens* → **Access Token and Secret** → Generate → `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`.
5. `npm run x` → "X nalog: @… ✓". `npm run x -- --post` → jedan probni post.

Koriste se OAuth 1.0a ključevi jer ne ističu (OAuth2 token traje 2 sata). Free nivo ima mali mesečni limit objava, zato `X_MAX_PER_DAY=15` i na X idu samo prodaje ≥ `X_MIN_TOKENS` (prva psovka walleta tog dana). Telegram dobija sve.

**Zaštita:** u `MODE=mock` bot NIKAD ne objavljuje lažne trejdove na prave naloge (sve ide u outbox na test stranici). Samo za test bota: `BOT_IN_MOCK=true`.

## Blockchain test (lokalni validator — bez faucet-a)

```bash
docker run -d --name jar-validator -p 127.0.0.1:8899:8899 -p 127.0.0.1:8900:8900 solanalabs/solana:v1.18.26 solana-test-validator --reset
cd backend && npm run localnet
```

## Blockchain test (devnet)

Test wallet je u `backend/keys/devnet/payout.json` (gitignored — pošalji ga drugu van gita ili neka `npm run devnet` napravi novi).

1. Adresa: `npm run devnet fund` je ispiše (trenutni: `79KfiiWpCSzKZxSCC5qFtSzmyyrPyTiuM9c7vcgRQvzA`).
2. https://faucet.solana.com → devnet → 1–2 SOL na tu adresu.
3. `npm run devnet all` → isplate na pravom devnet lancu + linkovi na explorer.

## Za live (redosled)

1. Novi **jar wallet** samo za launch i fee-jeve (hot wallet: drži samo dnevni iznos; dev buy iz DRUGOG walleta).
2. Launch na pump.fun iz jar walleta → CA → `MINT`.
3. `npm run import-key` → privatni ključ iz Phantoma lokalno u `backend/keys/jar.json` → `PAYOUT_KEYPAIR=keys/jar.json`. **Ključ nikad u git, chat ili poruku.**
4. `HELIUS_API_KEY` (helius.dev), `WEBHOOK_SECRET` (nasumičan string), `EXCLUDED_WALLETS` (bonding curve, pool, dev, burn).
5. Hostovanje: tvoj PC + Cloudflare Tunnel (vidi "Hostovanje sa svog PC-ja"). Quick tunel (trycloudflare) menja adresu — ne koristiti za live.
6. Helius webhook: enhanced, account = mint, URL `https://<host>/webhook/helius`, auth header = `WEBHOOK_SECRET`.
7. `MODE=live`, **`DRY_RUN=true` prvi dan**, `/test/` → preflight mora da kaže SPREMNO, proveri probnu isplatu.
8. `DRY_RUN=false`. Ručno: `npm run collect -- --send`.

Klejm creator fee-jeva (`CLAIM_FEES=true`, podrazumevano) ide automatski pre svake isplate, iz oba vaulta: bonding curve i PumpSwap posle graduacije. Testirano na **pravim pump.fun programima** kloniranim sa mainneta (`npm run pump-validator && npm run pump-test`).

**Koliko tegla dobija** (pump fee config na mainnetu, 2026-10-01): **0.30%** svakog trejda na bonding curve-u; posle graduacije na PumpSwap **0.95%** pri ~420–1,470 SOL market capa, pa postepeno do 0.05% pri ~98,000 SOL. Primer: 1,000 SOL obima na curve-u = 3 SOL u tegli.

## Hostovanje sa svog PC-ja (bez VPS-a)

Sve radi sa jednog Windows računara: `run.js` drži backend (:8788) i sajt (:8787) upaljenim, a Cloudflare Tunnel vodi domen do računara (bez otvaranja portova, SSL rešava Cloudflare).

1. **Domen u Cloudflare-u.** Kupi domen (`jartoken.xyz`) i dodaj ga u Cloudflare (Add a domain); kod registrara stavi Cloudflare nameservere.
2. **Tunel.** Cloudflare dashboard → Zero Trust → Networks → Tunnels → *Create a tunnel* → Cloudflared → ime `jar` → Windows → kopiraj komandu `cloudflared.exe service install <TOKEN>` i pokreni je u **Command Prompt kao administrator**. Tunel postaje Windows servis i pali se sam.
3. **Public hostname** (u istom tunelu): `jartoken.xyz` → Service `HTTP` → `localhost:8787`. Isto za `www`.
4. **Autostart:** desni klik na `windows/install-autostart.cmd` → *Run as administrator*. Backend i sajt se pale sa Windowsom (i pre logovanja); ako padnu, `run.js` ih podiže. Logovi: `logs/`.
5. **Bez spavanja:** `windows/stay-awake.cmd` kao administrator. U Windows Update podesi *Active hours* tako da restart ne pada oko 00:00 UTC (02:00 leti / 01:00 zimi).
6. Provera: `https://jartoken.xyz` (sajt) i `https://jartoken.xyz/test/` (admin token iz `backend/.admin-token`).

**Ako je PC bio ugašen ili bez interneta** — backend to sam nadoknađuje:
- pri paljenju i na svakih 10 min povuče propuštene trejdove iz Helius istorije (`BACKFILL_MIN`), pa nijedan prodavac ne promakne,
- ako je ponoćna isplata propuštena, uradi jučerašnji dan čim se upali (samo jednom),
- prekinuta isplata se nastavlja bez duplog plaćanja.

Ograničenje: dok je PC ugašen, sajt ne radi, a isplata kasni do paljenja. Privatni ključ jar walleta stoji na tom PC-ju — drži na njemu samo dnevni iznos i ne koristi taj PC za sumnjive stvari.

Isključi autostart: `windows/uninstall-autostart.cmd` (kao administrator).

## Bezbednost (ne menjati bez razloga)

- Sa weba se ne može poslati SOL: `/admin/collect` je uvek dry run. Pravo slanje: `DRY_RUN=false` + `npm run collect -- --send` ili ponoćni cron.
- Isplata: svaka tx se potpiše pre slanja, potpis se upiše u bazu; greška se razrešava na lancu pre bilo kakvog ponovnog slanja; prekinut dan nastavlja sa ISTIM iznosima. Nema duple isplate (pokriveno testovima).
- `server.js` ne servira `backend/`, `.db`, `.env`, skrivene fajlove.
