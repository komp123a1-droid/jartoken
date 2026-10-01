// Telegram setup helper.
//   npm run tg            -> checks the bot token, lists chats the bot has seen (to find TG_CHAT_ID)
//   npm run tg -- --send  -> sends a test message from Sister Agnes to TG_CHAT_ID
const cfg = require("../src/config");
const tg = require("../src/telegram");

(async () => {
  if (!cfg.telegram.token) {
    console.log("TG_BOT_TOKEN nije upisan u .env.\n1) U Telegramu otvori @BotFather → /newbot → kopiraj token u TG_BOT_TOKEN.\n2) Dodaj bota u kanal/grupu kao ADMINA.\n3) Napiši bilo šta u grupu (ili objavi post u kanalu), pa ponovo pokreni: npm run tg");
    process.exit(1);
  }
  const me = await tg.getMe();
  if (!me.ok) { console.log("Token ne radi:", me.description); process.exit(1); }
  console.log("Bot: @" + me.result.username);

  const up = await tg.getUpdates();
  const chats = new Map();
  for (const u of up.result || []) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, `${c.id}  ·  ${c.type}  ·  ${c.title || c.username || c.first_name || ""}`);
  }
  if (chats.size) { console.log("\nChatovi koje bot vidi (stavi id u TG_CHAT_ID):"); for (const s of chats.values()) console.log("  " + s); }
  else console.log("\nBot još ne vidi nijedan chat. Dodaj ga kao admina u kanal/grupu i napiši poruku, pa pokreni ponovo.\n(Za javni kanal možeš i TG_CHAT_ID=@imekanala)");
  console.log("\nTG_CHAT_ID sada: " + (cfg.telegram.chat || "(prazno)"));

  if (process.argv.includes("--send")) {
    if (!cfg.telegram.chat) { console.log("Prvo upiši TG_CHAT_ID."); process.exit(1); }
    const r = await tg.send("Testing, testing.\n\nThis is Sister Agnes. The jar is listening.\n\n— Sr. Agnes");
    console.log(r.ok ? "Poslato ✓" : "Nije poslato: " + r.description);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
