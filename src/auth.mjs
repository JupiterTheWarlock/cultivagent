// Cultivagent server 端 auth。
// 三种凭据来源，任一通过即可：
//   1. Authorization: Bearer <token>   —— agent hook 用（hook-lib.mjs 发）
//   2. x-cultivagent-token: <token>    —— 备用 header
//   3. cookie cultivagent_token        —— 浏览器访问 dashboard，登录页设置
// 浏览器走「登录页 → POST /api/login → Set-Cookie」；agent 走 Bearer。
// token 未配置（本地 127.0.0.1）时 isAuthorized 一律放行，保持本地零配置体验。

import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "cultivagent_token";
const COOKIE_MAX_AGE = 2592000; // 30 天

// timing-safe 字符串比较；长度不等直接 false（不泄露长度）
function safeEq(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length || bb.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookie(header) {
  const out = {};
  for (const pair of String(header).split(";")) {
    const i = pair.indexOf("=");
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

// 从 Bearer / x-token / cookie 收集候选 token
function candidateTokens(req) {
  const out = [];
  const auth = req.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) out.push(auth.slice(7));
  const x = req.headers["x-cultivagent-token"];
  if (x) out.push(x);
  const cookie = parseCookie(req.headers.cookie ?? "");
  if (cookie[COOKIE_NAME]) out.push(cookie[COOKIE_NAME]);
  return out;
}

export function isAuthorized(req, token) {
  if (!token) return true; // 本地模式：未配置 token 一律放行
  return candidateTokens(req).some((c) => safeEq(c, token));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(body));
}

// POST /api/login：验 token → 设 HttpOnly/Secure/SameSite=Lax cookie（30 天）
export async function handleLogin(req, res, token) {
  if (!token) return json(res, 200, { ok: true }); // 本地无 auth，无需登录
  const body = await readJson(req);
  if (!safeEq(body.token ?? "", token)) return json(res, 401, { error: "invalid token" });
  const cookie =
    `${COOKIE_NAME}=${encodeURIComponent(body.token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
  return json(res, 200, { ok: true }, { "set-cookie": cookie });
}

// POST /api/logout：清 cookie
export function handleLogout(res) {
  const cookie = `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  return json(res, 200, { ok: true }, { "set-cookie": cookie });
}

// 登录页：最简 form，POST /api/login，成功后 reload 进 dashboard
export function loginPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cultivagent</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 2rem; width: 320px; }
  h1 { margin: 0 0 1.5rem; font-size: 1.25rem; font-weight: 600; }
  label { display: block; margin-bottom: .375rem; font-size: .8rem; color: #8b949e; }
  input { width: 100%; padding: .5rem .625rem; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #c9d1d9; font-size: .9rem; }
  input:focus { outline: none; border-color: #58a6ff; }
  button { margin-top: 1rem; width: 100%; padding: .5rem; border: 0; border-radius: 6px; background: #238636; color: #fff; cursor: pointer; font-size: .9rem; font-weight: 500; }
  button:hover { background: #2ea043; }
  .err { color: #f85149; margin-top: .75rem; font-size: .8rem; min-height: 1em; }
</style>
</head>
<body>
<form class="card" id="f" autocomplete="on">
  <h1>Cultivagent</h1>
  <label for="t">Token</label>
  <input id="t" name="token" type="password" autocomplete="current-password" required autofocus>
  <button type="submit">Sign in</button>
  <div class="err" id="e"></div>
</form>
<script>
  const f = document.getElementById('f'), e = document.getElementById('e');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    e.textContent = '';
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: document.getElementById('t').value }),
    });
    if (r.ok) location.reload();
    else e.textContent = 'Invalid token';
  });
</script>
</body>
</html>`;
}
