// X (Twitter) API v2 with OAuth 1.0a user context: 4 keys from the developer portal, they do not expire.
// (OAuth2 user tokens expire after 2 hours, which would silence the bot on day one.)
const crypto = require("crypto");
const cfg = require("./config");

const enc = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method, url) {
  const { apiKey, apiSecret, accessToken, accessSecret } = cfg.x;
  const o = {
    oauth_consumer_key: apiKey, oauth_nonce: crypto.randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000), oauth_token: accessToken, oauth_version: "1.0",
  };
  const u = new URL(url);
  const params = { ...o };
  u.searchParams.forEach((v, k) => (params[k] = v)); // JSON bodies are not part of the signature
  const paramStr = Object.keys(params).sort().map((k) => enc(k) + "=" + enc(params[k])).join("&");
  const base = [method.toUpperCase(), enc(u.origin + u.pathname), enc(paramStr)].join("&");
  o.oauth_signature = crypto.createHmac("sha1", enc(apiSecret) + "&" + enc(accessSecret)).update(base).digest("base64");
  return "OAuth " + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k])}"`).join(", ");
}

const configured = () => !!(cfg.x.apiKey && cfg.x.apiSecret && cfg.x.accessToken && cfg.x.accessSecret);

async function call(method, url, body) {
  const r = await fetch(url, {
    method, headers: { authorization: authHeader(method, url), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, json, text };
}

const me = () => call("GET", "https://api.x.com/2/users/me");
const post = (text) => call("POST", "https://api.x.com/2/tweets", { text });

module.exports = { configured, me, post, authHeader };
