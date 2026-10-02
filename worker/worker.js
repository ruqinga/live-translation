// 同声字幕中转层（Cloudflare Workers）
//   POST /translate        流式翻译，统一输出  data: {"t":"文本片段"}  ...  data: [DONE]
//   POST /summary          流式长文本摘要，格式同上，但允许更长的输入和输出
//   GET  /deepgram-token   签发 Deepgram 短期令牌（手机端不需要保存 Deepgram 长期密钥）
//   GET  /soniox-token     签发 Soniox 实时转录的临时 API 密钥（真正的密钥只放在这里的 SONIOX_API_KEY）
//   OneDrive 同步（Worker 代管微软登录；刷新令牌只存在 KV 里，绝不下发到浏览器）：
//   POST /onedrive/login-ticket  用 ACCESS_TOKEN 换一个一次性登录码（不要把 ACCESS_TOKEN 放进网址）
//   GET  /onedrive/login?ticket= 凭一次性登录码跳转到微软登录页（不需要 Authorization）
//   GET  /onedrive/callback      微软登录完成后的回调（校验 state，换令牌，存 KV，再跳回页面）
//   GET  /onedrive/token         用刷新令牌换短期访问令牌，页面直接拿它调用 Microsoft Graph
//   GET  /onedrive/status        是否已登录、账号名称 / 邮箱
//   POST /onedrive/logout        删除 KV 里的令牌
// 除 /onedrive/login 和 /onedrive/callback（浏览器跳转，靠一次性登录码和 state 保护）外，所有请求都要带  Authorization: Bearer <ACCESS_TOKEN>
//
// 需要的 Secret / 变量（见 README）：
//   ACCESS_TOKEN（必填）  ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY / DEEPGRAM_API_KEY / SONIOX_API_KEY（用到哪个填哪个）
//   OneDrive 同步用：MS_CLIENT_ID、MS_CLIENT_SECRET（Secret），以及 KV 绑定 ONEDRIVE_KV（在 wrangler.toml 里声明）
//   ALLOWED_ORIGIN（可选，例如 https://ruqinga.github.io，不填则允许任何来源）

const PROVIDERS = {
  anthropic: { key: "ANTHROPIC_API_KEY", models: ["claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5"] },
  deepseek:  { key: "DEEPSEEK_API_KEY",  models: ["deepseek-chat"] },
  openai:    { key: "OPENAI_API_KEY",    models: ["gpt-4o-mini", "gpt-4o"] },
};
const LIMITS = {
  translate: { maxBody: 30000, maxTokens: 1024 },
  summary:   { maxBody: 200000, maxTokens: 4096 },
};

function cors(env, req) {
  const allow = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "content-type": "application/json; charset=utf-8" } });
}
function safeEqual(a, b) {
  const enc = new TextEncoder(), x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}

// 把上游 SSE 转成统一格式
function normalize(upstream, extract) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  const out = (o) => enc.encode("data: " + (typeof o === "string" ? o : JSON.stringify(o)) + "\n\n");
  const handle = (block, ctl) => {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return;
    let ev; try { ev = JSON.parse(payload); } catch (_) { return; }
    const r = extract(ev);
    if (r && r.error) ctl.enqueue(out({ error: r.error }));
    else if (r && r.text) ctl.enqueue(out({ t: r.text }));
  };
  return upstream.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { handle(buf.slice(0, i), ctl); buf = buf.slice(i + 2); }
    },
    flush(ctl) { if (buf.trim()) handle(buf, ctl); ctl.enqueue(out("[DONE]")); },
  }));
}
const extractAnthropic = (ev) =>
  ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" ? { text: ev.delta.text }
  : ev.type === "error" ? { error: (ev.error && ev.error.message) || "上游错误" } : null;
const extractOpenAI = (ev) => {
  const c = ev.choices && ev.choices[0];
  return c && c.delta && c.delta.content ? { text: c.delta.content } : null;
};

async function translate(req, env, h, lim) {
  const len = +(req.headers.get("content-length") || 0);
  if (len > lim.maxBody * 3) return json({ error: "请求太大" }, 413, h);
  let b; try { b = await req.json(); } catch (_) { return json({ error: "请求格式错误" }, 400, h); }
  const provider = b.provider || "anthropic";
  const p = PROVIDERS[provider];
  if (!p) return json({ error: "不支持的翻译服务商" }, 400, h);
  const apiKey = env[p.key];
  if (!apiKey) return json({ error: "Worker 里没有配置 " + p.key }, 500, h);
  const model = b.model || p.models[0];
  if (!p.models.includes(model)) return json({ error: "不支持的模型：" + model }, 400, h);
  const system = String(b.system || ""), user = String(b.user || "");
  if (!user || system.length + user.length > lim.maxBody) return json({ error: "内容为空或过长" }, 400, h);
  const maxTokens = Math.max(64, Math.min(lim.maxTokens, +b.max_tokens || lim.maxTokens));

  let res;
  try {
    if (provider === "anthropic") {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, system, messages: [{ role: "user", content: user }] }),
      });
    } else {
      const url = provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions";
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
        body: JSON.stringify({ model, stream: true, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
    }
  } catch (e) { return json({ error: "连接上游服务失败" }, 502, h); }

  if (!res.ok) {
    let msg = "";
    try { const j = await res.json(); msg = (j.error && (j.error.message || j.error)) || ""; } catch (_) {}
    return json({ error: String(msg) || "上游返回 " + res.status, upstream: res.status }, res.status === 401 ? 502 : res.status, h);
  }
  return new Response(normalize(res.body, provider === "anthropic" ? extractAnthropic : extractOpenAI), {
    headers: { ...h, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  });
}

async function deepgramToken(env, h) {
  if (!env.DEEPGRAM_API_KEY) return json({ error: "Worker 里没有配置 DEEPGRAM_API_KEY" }, 500, h);
  let res;
  try {
    res = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: { Authorization: "Token " + env.DEEPGRAM_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 300 }),
    });
  } catch (e) { return json({ error: "连接 Deepgram 失败" }, 502, h); }
  if (!res.ok) return json({ error: "Deepgram 签发令牌失败", upstream: res.status }, res.status === 401 ? 502 : res.status, h);
  const j = await res.json();
  return json({ access_token: j.access_token, expires_in: j.expires_in }, 200, { ...h, "cache-control": "no-store" });
}

// Soniox 临时 API key：POST https://api.soniox.com/v1/auth/temporary-api-key（官方的临时密钥服务示例也是这个请求）
//   usage_type 限定为 transcribe_websocket（只能用于实时 WebSocket 转录），expires_in_seconds 60 秒内要用它建立连接。
//   真正的 SONIOX_API_KEY 只在这里使用，绝不下发到浏览器；返回给页面的只有短期有效的临时密钥。
async function sonioxToken(env, h) {
  if (!env.SONIOX_API_KEY) return json({ error: "Worker 里没有配置 SONIOX_API_KEY" }, 500, h);
  let res;
  try {
    res = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.SONIOX_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ usage_type: "transcribe_websocket", expires_in_seconds: 60 }),
    });
  } catch (e) { return json({ error: "连接 Soniox 失败" }, 502, h); }
  if (!res.ok) {
    let msg = "";
    try { const j = await res.json(); msg = j.error_message || j.error || j.message || ""; } catch (_) {}
    // 上游 401（密钥无效）用 502 转出，避免页面把它误认成“中转访问口令无效”，真实状态放在 upstream 里
    return json({ error: String(msg) || "Soniox 签发临时密钥失败", upstream: res.status }, res.status === 401 ? 502 : res.status, h);
  }
  const j = await res.json();
  if (!j.api_key) return json({ error: "Soniox 没有返回临时密钥", upstream: res.status }, 502, h);
  return json({ token: j.api_key, expires_in_seconds: 60 }, 200, { ...h, "cache-control": "no-store" });
}

// ---------------- OneDrive（Microsoft 身份平台 v2.0 授权码流程 + Microsoft Graph）----------------
// 授权端点用 common：同时支持个人账户和组织账户。权限范围：Files.ReadWrite.AppFolder（只能访问应用专属文件夹）、
// offline_access（拿刷新令牌）、User.Read（读账号名称）。这是单用户应用：一个 Worker 只绑定一个 OneDrive 账号，
// 刷新令牌放在 KV 的固定键里。页面只拿到短期访问令牌，并直接调用 Graph 读写文件（文件内容不经过 Worker）。
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const MS_SCOPE = "Files.ReadWrite.AppFolder offline_access User.Read";
const KV_REFRESH = "refresh", KV_ACCOUNT = "account";

function odConfigError(env) {
  if (!env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET) return "Worker 里没有配置 MS_CLIENT_ID / MS_CLIENT_SECRET（见 README 的 OneDrive 部分）";
  if (!env.ONEDRIVE_KV) return "Worker 没有绑定 KV 命名空间 ONEDRIVE_KV（见 README：在 wrangler.toml 里声明并重新部署）";
  return "";
}
function rand(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
}
const redirectUri = (req) => new URL(req.url).origin + "/onedrive/callback";
function htmlPage(msg, status) {
  const body = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>OneDrive</title>"
    + "<body style='font:16px/1.6 -apple-system,sans-serif;padding:32px;max-width:520px;margin:auto'><h2>OneDrive 登录</h2><p>" + msg.replace(/[<>&]/g, "") + "</p>";
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
// 返回页面的地址只能是登录码里记下的那个（取自请求登录码时浏览器带的 Origin），不接受任何 URL 参数里的地址，避免被利用做开放重定向
function backTo(ret, ok, msg) {
  const u = new URL(ret); u.searchParams.set("od", ok ? "ok" : "error"); if (msg) u.searchParams.set("msg", msg.slice(0, 120));
  return new Response(null, { status: 302, headers: { Location: u.toString(), "cache-control": "no-store" } });
}
async function msToken(env, form) {
  const body = new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: MS_SCOPE, ...form });
  const res = await fetch(MS_AUTH + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  let j = {}; try { j = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, j };
}

async function odLoginTicket(req, env, h) {
  const bad = odConfigError(env); if (bad) return json({ error: bad, configured: false }, 501, h);
  let b = {}; try { b = await req.json(); } catch (_) {}
  const origin = req.headers.get("Origin") || "";
  let ret;
  try { ret = new URL(String(b.return || "")); } catch (_) { return json({ error: "缺少返回地址" }, 400, h); }
  const okProto = ret.protocol === "https:" || (ret.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(ret.hostname));
  if (!okProto || (origin && ret.origin !== origin) || (env.ALLOWED_ORIGIN && ret.origin !== env.ALLOWED_ORIGIN)) return json({ error: "返回地址不被允许" }, 400, h);
  ret.search = ""; ret.hash = "";
  const ticket = rand(24);
  await env.ONEDRIVE_KV.put("tk:" + ticket, JSON.stringify({ ret: ret.toString() }), { expirationTtl: 120 });
  return json({ ticket }, 200, { ...h, "cache-control": "no-store" });
}
async function odLogin(req, env) {
  const bad = odConfigError(env); if (bad) return htmlPage(bad, 501);
  const ticket = new URL(req.url).searchParams.get("ticket") || "";
  const raw = ticket ? await env.ONEDRIVE_KV.get("tk:" + ticket) : null;
  if (!raw) return htmlPage("登录码无效或已过期，请回到「同声字幕」重新点「登录 OneDrive」。", 400);
  await env.ONEDRIVE_KV.delete("tk:" + ticket);                    // 一次性
  const state = rand(24);
  await env.ONEDRIVE_KV.put("st:" + state, raw, { expirationTtl: 600 });
  const u = new URL(MS_AUTH + "/authorize");
  u.search = new URLSearchParams({ client_id: env.MS_CLIENT_ID, response_type: "code", redirect_uri: redirectUri(req), response_mode: "query", scope: MS_SCOPE, state, prompt: "select_account" }).toString();
  return new Response(null, { status: 302, headers: { Location: u.toString(), "cache-control": "no-store" } });
}
async function odCallback(req, env) {
  const bad = odConfigError(env); if (bad) return htmlPage(bad, 501);
  const q = new URL(req.url).searchParams, state = q.get("state") || "";
  const raw = state ? await env.ONEDRIVE_KV.get("st:" + state) : null;
  if (!raw) return htmlPage("登录状态无效或已过期（可能是登录时间太长），请回到「同声字幕」重新登录。", 400);
  await env.ONEDRIVE_KV.delete("st:" + state);                     // 一次性，防重放
  const { ret } = JSON.parse(raw);
  if (q.get("error")) return backTo(ret, false, q.get("error_description") || q.get("error"));
  const code = q.get("code"); if (!code) return backTo(ret, false, "微软没有返回授权码");
  let t;
  try { t = await msToken(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri(req) }); }
  catch (e) { return backTo(ret, false, "连接微软失败"); }
  if (!t.ok || !t.j.refresh_token) return backTo(ret, false, (t.j && (t.j.error_description || t.j.error)) || "换取令牌失败");
  let name = "", email = "";
  try {
    const me = await (await fetch("https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName", { headers: { Authorization: "Bearer " + t.j.access_token } })).json();
    name = me.displayName || ""; email = me.mail || me.userPrincipalName || "";
  } catch (_) {}
  await env.ONEDRIVE_KV.put(KV_REFRESH, t.j.refresh_token);        // 刷新令牌只存在 KV，不下发给浏览器
  await env.ONEDRIVE_KV.put(KV_ACCOUNT, JSON.stringify({ name, email, at: Date.now() }));
  return backTo(ret, true, "");
}
async function odToken(env, h) {
  const bad = odConfigError(env); if (bad) return json({ error: bad, configured: false }, 501, h);
  const refresh = await env.ONEDRIVE_KV.get(KV_REFRESH);
  if (!refresh) return json({ error: "还没有登录 OneDrive", reauth: true, code: "not_logged_in" }, 401, h);
  let t;
  try { t = await msToken(env, { grant_type: "refresh_token", refresh_token: refresh }); }
  catch (e) { return json({ error: "连接微软失败，稍后重试" }, 502, h); }
  if (!t.ok) {
    const code = t.j && t.j.error;
    if (code === "invalid_grant" || code === "interaction_required") return json({ error: "OneDrive 登录已失效，请重新登录", reauth: true, code: "invalid_grant" }, 401, h);
    if (code === "invalid_client") return json({ error: "微软拒绝了应用凭据（MS_CLIENT_SECRET 错误或已到期，需要在 Azure 里重新生成）", upstream: t.status }, 502, h);
    return json({ error: (t.j && t.j.error_description) || "微软返回 " + t.status, upstream: t.status }, t.status >= 500 ? 502 : 400, h);
  }
  if (t.j.refresh_token && t.j.refresh_token !== refresh) await env.ONEDRIVE_KV.put(KV_REFRESH, t.j.refresh_token);   // 微软换发了新的刷新令牌：更新
  return json({ access_token: t.j.access_token, expires_in: t.j.expires_in || 3600 }, 200, { ...h, "cache-control": "no-store" });
}
async function odStatus(env, h) {
  const bad = odConfigError(env); if (bad) return json({ error: bad, configured: false }, 501, h);
  const has = !!(await env.ONEDRIVE_KV.get(KV_REFRESH));
  let acc = {}; try { acc = JSON.parse((await env.ONEDRIVE_KV.get(KV_ACCOUNT)) || "{}"); } catch (_) {}
  return json({ configured: true, loggedIn: has, name: has ? acc.name || "" : "", email: has ? acc.email || "" : "" }, 200, { ...h, "cache-control": "no-store" });
}
async function odLogout(env, h) {
  const bad = odConfigError(env); if (bad) return json({ error: bad, configured: false }, 501, h);
  await env.ONEDRIVE_KV.delete(KV_REFRESH); await env.ONEDRIVE_KV.delete(KV_ACCOUNT);
  return json({ ok: true }, 200, h);
}

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const path0 = new URL(req.url).pathname.replace(/\/+$/, "");
    // 浏览器跳转的两个地址不能带 Authorization：登录靠一次性登录码，回调靠一次性 state
    if (path0 === "/onedrive/login" && req.method === "GET") return odLogin(req, env);
    if (path0 === "/onedrive/callback" && req.method === "GET") return odCallback(req, env);
    const auth = req.headers.get("Authorization") || "";
    if (!env.ACCESS_TOKEN || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), env.ACCESS_TOKEN)) {
      return json({ error: "访问口令无效" }, 401, h);
    }
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (path === "/translate" && req.method === "POST") return translate(req, env, h, LIMITS.translate);
    if (path === "/summary" && req.method === "POST") return translate(req, env, h, LIMITS.summary);
    if (path === "/deepgram-token" && req.method === "GET") return deepgramToken(env, h);
    if (path === "/soniox-token" && req.method === "GET") return sonioxToken(env, h);
    if (path === "/onedrive/login-ticket" && req.method === "POST") return odLoginTicket(req, env, h);
    if (path === "/onedrive/token" && req.method === "GET") return odToken(env, h);
    if (path === "/onedrive/status" && req.method === "GET") return odStatus(env, h);
    if (path === "/onedrive/logout" && req.method === "POST") return odLogout(env, h);
    return json({ error: "未找到" }, 404, h);
  },
};
