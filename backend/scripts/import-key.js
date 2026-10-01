// Converts a Phantom / Solflare private key (base58 string) into the keypair JSON file the backend reads.
// Runs locally; the key is read from your terminal and never printed or sent anywhere.
//   npm run import-key                 -> writes keys/jar.json
//   npm run import-key -- keys/x.json  -> another path
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const decode = (s) => (bs58.default || bs58).decode(s);

const out = path.resolve(process.argv[2] || "keys/jar.json");
if (fs.existsSync(out)) { console.log("Već postoji: " + out + " (obriši ga ručno ako želiš da ga zameniš)"); process.exit(1); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl._writeToOutput = (s) => { if (s.includes("Privatni")) process.stdout.write(s); }; // hide what you type
rl.question("Privatni ključ (Phantom: Settings → Manage accounts → Show private key), pa Enter: ", (input) => {
  rl.close(); process.stdout.write("\n");
  let kp;
  try {
    const s = input.trim();
    kp = Keypair.fromSecretKey(s.startsWith("[") ? Uint8Array.from(JSON.parse(s)) : decode(s));
  } catch (e) { console.log("Nije ispravan ključ."); process.exit(1); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  console.log("Sačuvano: " + out + "\nAdresa walleta: " + kp.publicKey.toBase58() + "\nU .env stavi: PAYOUT_KEYPAIR=" + path.relative(process.cwd(), out).replace(/\\/g, "/"));
});
