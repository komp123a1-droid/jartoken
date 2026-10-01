// Starts a local Solana validator (Docker) with the REAL pump.fun programs + their global accounts cloned from mainnet
// (read-only: nothing is sent to mainnet). Fee recipients change over time, so the list is read live.
//   npm run pump-validator        then: npm run pump-test / npm run localnet
//   docker rm -f jar-pump         to stop
const { spawnSync } = require("child_process");
const { Connection, PublicKey } = require("@solana/web3.js");
const { getAssociatedTokenAddressSync, NATIVE_MINT } = require("@solana/spl-token");
const P = require("@pump-fun/pump-sdk");
const A = require("@pump-fun/pump-swap-sdk");

const MAINNET = process.env.MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const IMAGE = process.env.AGAVE_IMAGE || "anzaxyz/agave:v3.1.14";
const PROGRAMS = [
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump (bonding curve)
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // pump AMM (PumpSwap)
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump fees
  "MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e", // mayhem (create_v2 accounts)
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", // metaplex token metadata
];

(async () => {
  const conn = new Connection(MAINNET, "confirmed");
  const g = await new P.OnlinePumpSdk(conn).fetchGlobal();
  const gc = await new A.OnlinePumpAmmSdk(conn).fetchGlobalConfigAccount();
  const set = new Set();
  const add = (k) => k && set.add(new PublicKey(k).toBase58());
  [P.GLOBAL_PDA, P.GLOBAL_VOLUME_ACCUMULATOR_PDA, P.PUMP_FEE_CONFIG_PDA, A.GLOBAL_CONFIG_PDA, A.PUMP_AMM_FEE_CONFIG_PDA, A.GLOBAL_VOLUME_ACCUMULATOR_PDA, g.withdrawAuthority].forEach(add);
  const recipients = [g.feeRecipient, ...(g.feeRecipients || []), ...(g.buybackFeeRecipients || []), g.reservedFeeRecipient, ...(g.reservedFeeRecipients || []),
    ...(gc.protocolFeeRecipients || []), gc.reservedFeeRecipient, ...(gc.reservedFeeRecipients || [])].filter(Boolean);
  for (const r of recipients) { add(r); add(getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(r), true)); }
  const list = [...set];
  const infos = await conn.getMultipleAccountsInfo(list.map((k) => new PublicKey(k)));
  const clones = list.filter((_, i) => infos[i]);
  console.log(`cloning ${PROGRAMS.length} programs + ${clones.length} accounts from mainnet (read-only)`);

  spawnSync("docker", ["rm", "-f", "jar-pump"], { stdio: "ignore" });
  const args = ["run", "-d", "--name", "jar-pump", "--security-opt", "seccomp=unconfined", "--platform", "linux/amd64",
    "--entrypoint", "solana-test-validator", "-p", "127.0.0.1:8899:8899", "-p", "127.0.0.1:8900:8900", IMAGE,
    "--reset", "--quiet", "--ledger", "/tmp/ledger", "--url", MAINNET,
    ...PROGRAMS.flatMap((p) => ["--clone-upgradeable-program", p]), ...clones.flatMap((c) => ["--clone", c])];
  const r = spawnSync("docker", args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
  const local = new Connection("http://127.0.0.1:8899");
  for (let i = 0; i < 60; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    try { if ((await local.getAccountInfo(new PublicKey(PROGRAMS[0])))?.executable) { console.log("validator up on http://127.0.0.1:8899 with pump.fun"); process.exit(0); } } catch {}
  }
  console.error("validator did not come up: docker logs jar-pump"); process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
