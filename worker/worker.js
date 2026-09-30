// 同声字幕中转层（Cloudflare Workers）
//   POST /translate        流式翻译，统一输出  data: {"t":"文本片段"}  ...  data: [DONE]
//   POST /summary          流式长文本摘要，格式同上，但允许更长的输入和输出
//   GET  /deepgram-token   签发 Deepgram 短期令牌（手机端不需要保存 Deepgram 长期密钥）
// 所有请求都要带  Authorization: Bearer <ACCESS_TOKEN>
//
// 需要的 Secret / 变量（见 README）：
//   ACCESS_TOKEN（必填）  ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY / DEEPGRAM_API_KEY（用到哪个填哪个）
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

export default {
  async fetch(req, env) {
    const h = cors(env, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const auth = req.headers.get("Authorization") || "";
    if (!env.ACCESS_TOKEN || !auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), env.ACCESS_TOKEN)) {
      return json({ error: "访问口令无效" }, 401, h);
    }
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (path === "/translate" && req.method === "POST") return translate(req, env, h, LIMITS.translate);
    if (path === "/summary" && req.method === "POST") return translate(req, env, h, LIMITS.summary);
    if (path === "/deepgram-token" && req.method === "GET") return deepgramToken(env, h);
    return json({ error: "未找到" }, 404, h);
  },
};
