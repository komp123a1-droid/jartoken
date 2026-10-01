// Telegram Bot API: token from @BotFather, chat = channel/group id (e.g. -1001234567890) or @publicchannel.
const cfg = require("./config");

const configured = () => !!(cfg.telegram.token && cfg.telegram.chat);
const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${cfg.telegram.token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
  }).then((r) => r.json());

const getMe = () => api("getMe");
const getUpdates = () => api("getUpdates", { allowed_updates: ["message", "channel_post", "my_chat_member"] });
const send = (text, chat = cfg.telegram.chat) => api("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });

module.exports = { configured, getMe, getUpdates, send };
