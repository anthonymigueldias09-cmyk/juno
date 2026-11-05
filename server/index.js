"use strict";
// Juno - servidor local (sem dependencias externas, so Node puro)
// - POST /v1/messages  : API no formato Anthropic (o Claude Code fala aqui)
// - POST /api/chat     : chat multi-IA do painel (uma pergunta, varios modelos)
// - estaticos em public/ : painel web

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("./store");
const { PRESETS } = require("./providers");
const T = require("./translate");
const R = require("./router");
const patch = require("./claudepatch");

const VERSION = "1.0.0";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

let cfg = store.load();

function log(...a) {
  if (process.env.JUNO_QUIET) return;
  console.log(new Date().toISOString().slice(11, 19), "[juno]", ...a);
}

// ---------------------------------------------------------------- helpers http

function sendJSON(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

function anthropicError(res, status, type, message) {
  sendJSON(res, status, { type: "error", error: { type, message } });
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("corpo grande demais")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function tokenOf(req) {
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return bearer || String(req.headers["x-api-key"] || "").trim();
}

function authOk(req) {
  const tok = tokenOf(req);
  if (!tok) return false;
  return tok === cfg.masterToken;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end("not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
}

// ---------------------------------------------------------------- provedores (painel)

function providerView(p) {
  return {
    id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl,
    model: p.model, smallModel: p.smallModel || "", free: !!p.free,
    note: p.note || "", keyMask: store.maskKey(p.apiKey), hasKey: !!p.apiKey,
    keyUrl: p.keyUrl || "",
  };
}

function upsertProvider(input) {
  const name = String(input.name || "").trim() || "Provider";
  let id = String(input.id || "").trim() || store.slugify(name);
  if (cfg.providers[id] && input.rename) id = store.slugify(name + "-" + Date.now().toString(36));
  const prov = {
    id,
    name,
    type: input.type === "anthropic" ? "anthropic" : "openai",
    baseUrl: String(input.baseUrl || "").trim().replace(/\/+$/, ""),
    apiKey: input.apiKey !== undefined ? String(input.apiKey).trim() : (cfg.providers[id] ? cfg.providers[id].apiKey : ""),
    model: String(input.model || "").trim(),
    smallModel: String(input.smallModel || "").trim(),
    free: !!input.free,
    note: String(input.note || "").trim(),
    keyUrl: String(input.keyUrl || "").trim(),
  };
  if (!/^https?:\/\//i.test(prov.baseUrl)) throw new Error("baseUrl invalida (precisa comecar com http:// ou https://)");
  cfg.providers[id] = prov;
  if (!cfg.activeProfile || !cfg.providers[cfg.activeProfile]) cfg.activeProfile = id;
  store.save(cfg);
  return prov;
}

// ---------------------------------------------------------------- chamadas

async function testProvider(prov, modelOverride) {
  const t0 = Date.now();
  const model = modelOverride || prov.model || "gpt-4o-mini";
  const body = {
    model,
    max_tokens: 32,
    messages: [{ role: "user", content: "Responda apenas com a palavra: OK" }],
  };
  try {
    const { res: up } = await R.upstream(prov, model, body, false);
    if (!up.ok) {
      const detail = await R.errorText(up, 300);
      return { ok: false, status: up.status, latencyMs: Date.now() - t0, error: "HTTP " + up.status + ": " + detail };
    }
    const j = await up.json();
    const sample = prov.type === "anthropic"
      ? T.anthropicTextFromResponse(j)
      : T.openAITextFromResponse(j);
    return { ok: true, status: 200, latencyMs: Date.now() - t0, sample: (sample || "(resposta vazia)").slice(0, 120) };
  } catch (e) {
    return { ok: false, status: 0, latencyMs: Date.now() - t0, error: String((e && e.message) || e) };
  }
}

async function handleV1Messages(req, res) {
  if (!authOk(req)) {
    anthropicError(res, 401, "authentication_error", "Token invalido. Gere o comando em http://127.0.0.1:" + cfg.port + " (aba Claude Code) e rode `juno claude`.");
    return;
  }
  let body;
  try { body = JSON.parse((await readBody(req)).toString("utf8")); }
  catch { anthropicError(res, 400, "invalid_request_error", "JSON invalido"); return; }

  if (typeof body.max_tokens !== "number" || !body.messages) {
    anthropicError(res, 400, "invalid_request_error", "max_tokens e messages sao obrigatorios");
    return;
  }

  const target = R.resolveTarget(cfg, body.model);
  if (!target) {
    anthropicError(res, 503, "api_error", "Nenhum provedor configurado no painel Juno. Adicione uma API key em http://127.0.0.1:" + cfg.port);
    return;
  }
  const { provider: prov, model } = target;
  const wantStream = !!body.stream;
  const estIn = T.estTokens(JSON.stringify(body));
  const t0 = Date.now();
  log("POST /v1/messages", prov.id + "/" + model, wantStream ? "stream" : "sync");

  let extraHeaders = {};
  const beta = req.headers["anthropic-beta"];
  if (beta) extraHeaders["anthropic-beta"] = String(beta);

  let up;
  try {
    ({ res: up } = await R.upstream(prov, model, body, wantStream, extraHeaders));
  } catch (e) {
    anthropicError(res, 502, "api_error", "Falha ao conectar em " + prov.name + ": " + ((e && e.message) || e));
    return;
  }

  if (!up.ok) {
    const detail = await R.errorText(up, 500);
    const status = up.status === 401 || up.status === 403 ? 401 : up.status === 429 ? 429 : 502;
    const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error";
    log("erro upstream", prov.id, up.status, detail.slice(0, 120));
    anthropicError(res, status, type, prov.name + " (HTTP " + up.status + "): " + detail);
    return;
  }

  if (wantStream) {
    if (prov.type === "anthropic") {
      // passthrough: o stream ja vem no formato Anthropic
      res.writeHead(200, {
        "Content-Type": up.headers.get("content-type") || "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      try {
        for await (const chunk of up.body) res.write(Buffer.from(chunk));
        res.end();
        log("200 /v1/messages", prov.id, Date.now() - t0 + "ms");
      } catch (e) { try { res.end(); } catch {} }
    } else {
      try {
        await T.pipeOpenAIStreamAsAnthropic(up, res, body.model, estIn);
        log("200 /v1/messages stream traduzido", prov.id, Date.now() - t0 + "ms");
      } catch (e) { log("stream interrompido:", (e && e.message) || e); }
    }
    return;
  }

  // nao-stream
  if (prov.type === "anthropic") {
    const j = await up.json().catch(() => null);
    sendJSON(res, 200, j || { type: "message", role: "assistant", model: body.model, content: [], usage: {} });
  } else {
    const j = await up.json().catch(() => null);
    if (!j) { anthropicError(res, 502, "api_error", prov.name + " devolveu resposta ilegivel"); return; }
    sendJSON(res, 200, T.openAIToAnthropicResponse(j, body.model, estIn));
  }
  log("200 /v1/messages", prov.id, Date.now() - t0 + "ms");
}

// /v1/chat/completions no formato OpenAI (para outras ferramentas usarem o Juno)
async function handleV1Chat(req, res) {
  if (!authOk(req)) { sendJSON(res, 401, { error: { message: "Token invalido", type: "invalid_request_error" } }); return; }
  let body;
  try { body = JSON.parse((await readBody(req)).toString("utf8")); }
  catch { sendJSON(res, 400, { error: { message: "JSON invalido" } }); return; }
  const wantStream = !!body.stream;
  const target = R.resolveTarget(cfg, body.model);
  if (!target) { sendJSON(res, 503, { error: { message: "Nenhum provedor configurado" } }); return; }
  const { provider: prov, model } = target;

  if (prov.type === "openai") {
    const upBody = Object.assign({}, body, { model });
    const up = await fetch(R.joinUrl(prov.baseUrl, "/chat/completions"), {
      method: "POST", headers: R.openAIHeaders(prov), body: JSON.stringify(upBody),
    });
    if (!up.ok) { sendJSON(res, up.status === 401 ? 401 : 502, { error: { message: await R.errorText(up) } }); return; }
    // formato identico: repassa direto
    res.writeHead(200, { "Content-Type": up.headers.get("content-type") || (wantStream ? "text/event-stream" : "application/json") });
    for await (const chunk of up.body) res.write(Buffer.from(chunk));
    res.end();
    return;
  }

  // provedor anthropic: traduz openai -> anthropic, chama, traduz de volta
  const anthBody = {
    model, max_tokens: body.max_tokens ?? 4096, messages: [],
  };
  for (const m of body.messages || []) {
    if (m.role === "system") anthBody.system = (anthBody.system ? anthBody.system + "\n\n" : "") + String(m.content ?? "");
    else anthBody.messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") });
  }
  anthBody.stream = wantStream;
  const up = await fetch(R.joinUrl(prov.baseUrl, "/v1/messages"), {
    method: "POST", headers: R.anthropicHeaders(prov), body: JSON.stringify(anthBody),
  });
  if (!up.ok) { sendJSON(res, up.status === 401 ? 401 : 502, { error: { message: await R.errorText(up) } }); return; }
  if (wantStream) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
    let id = "chatcmpl-juno";
    let created = Math.floor(Date.now() / 1000);
    const sendChunk = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
    sendChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    await T.parseSSE(up.body, (evt) => {
      if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
        sendChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }] });
      }
      if (evt.type === "message_delta" && evt.delta && evt.delta.stop_reason) {
        sendChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  const j = await up.json();
  const text = T.anthropicTextFromResponse(j);
  sendJSON(res, 200, {
    id: "chatcmpl-juno", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: (j.usage && j.usage.input_tokens) || 0, completion_tokens: (j.usage && j.usage.output_tokens) || 0 },
  });
}

// ---------------------------------------------------------------- chat multi-IA do painel

function fanout(res, payload) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => { try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch {} };
  const profiles = Array.isArray(payload.profiles) ? payload.profiles.slice(0, 8) : [];
  if (!profiles.length) { send({ type: "end" }); res.end(); return; }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = payload.system || "";

  const jobs = profiles.map(async (sel) => {
    const prov = cfg.providers[sel.id];
    send({ type: "start", profile: sel.id });
    if (!prov) { send({ type: "error", profile: sel.id, error: "Provedor inexistente" }); return; }
    const model = sel.model || prov.model;
    const t0 = Date.now();
    try {
      let text = "";
      if (prov.type === "openai") {
        const body = T.panelToOpenAI(messages, system, model, payload.maxTokens || 4096);
        body.stream = true;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 180000);
        const up = await fetch(R.joinUrl(prov.baseUrl, "/chat/completions"), {
          method: "POST", headers: R.openAIHeaders(prov), body: JSON.stringify(body), signal: ctrl.signal,
        });
        if (!up.ok) throw new Error("HTTP " + up.status + ": " + (await R.errorText(up, 300)));
        text = await T.collectOpenAIStreamText(up.body, (d) => send({ type: "delta", profile: sel.id, text: d }));
        clearTimeout(timer);
      } else {
        const body = T.panelToAnthropic(messages, system, model, payload.maxTokens || 4096);
        body.stream = true;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 180000);
        const up = await fetch(R.joinUrl(prov.baseUrl, "/v1/messages"), {
          method: "POST", headers: R.anthropicHeaders(prov), body: JSON.stringify(body), signal: ctrl.signal,
        });
        if (!up.ok) throw new Error("HTTP " + up.status + ": " + (await R.errorText(up, 300)));
        text = await T.collectAnthropicStreamText(up.body, (d) => send({ type: "delta", profile: sel.id, text: d }));
        clearTimeout(timer);
      }
      send({ type: "done", profile: sel.id, ms: Date.now() - t0, chars: text.length, model });
    } catch (e) {
      send({ type: "error", profile: sel.id, error: String((e && e.message) || e).slice(0, 400) });
    }
  });

  Promise.allSettled(jobs).then(() => { send({ type: "end" }); res.end(); });
}

async function fanoutSync(payload) {
  const profiles = Array.isArray(payload.profiles) ? payload.profiles.slice(0, 8) : [];
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = payload.system || "";
  const results = await Promise.allSettled(profiles.map(async (sel) => {
    const prov = cfg.providers[sel.id];
    if (!prov) throw new Error("Provedor inexistente");
    const model = sel.model || prov.model;
    const t0 = Date.now();
    let text = "";
    if (prov.type === "openai") {
      const body = T.panelToOpenAI(messages, system, model, payload.maxTokens || 4096);
      const up = await fetch(R.joinUrl(prov.baseUrl, "/chat/completions"), { method: "POST", headers: R.openAIHeaders(prov), body: JSON.stringify(body) });
      if (!up.ok) throw new Error("HTTP " + up.status + ": " + (await R.errorText(up, 300)));
      text = T.openAITextFromResponse(await up.json());
    } else {
      const body = T.panelToAnthropic(messages, system, model, payload.maxTokens || 4096);
      const up = await fetch(R.joinUrl(prov.baseUrl, "/v1/messages"), { method: "POST", headers: R.anthropicHeaders(prov), body: JSON.stringify(body) });
      if (!up.ok) throw new Error("HTTP " + up.status + ": " + (await R.errorText(up, 300)));
      text = T.anthropicTextFromResponse(await up.json());
    }
    return { profile: sel.id, model, ok: true, text, ms: Date.now() - t0 };
  }));
  return results.map((r, i) => r.status === "fulfilled"
    ? r.value
    : { profile: profiles[i].id, ok: false, error: String((r.reason && r.reason.message) || r.reason) });
}

// ---------------------------------------------------------------- rotas da API do painel

async function handleApi(req, res, pathname, query) {
  const method = req.method;

  if (pathname === "/api/health" && method === "GET") {
    return sendJSON(res, 200, { ok: true, version: VERSION, active: cfg.activeProfile, providers: Object.keys(cfg.providers).length, uptime: process.uptime() });
  }

  if (pathname === "/api/config" && method === "GET") {
    const nets = os.networkInterfaces();
    let lan = "";
    for (const list of Object.values(nets)) {
      for (const n of list || []) {
        if (n.family === "IPv4" && !n.internal) { lan = n.address; break; }
      }
      if (lan) break;
    }
    return sendJSON(res, 200, {
      version: VERSION,
      port: cfg.port, host: cfg.host,
      activeProfile: cfg.activeProfile,
      providers: Object.values(cfg.providers).map(providerView),
      presets: PRESETS,
      tokenTail: cfg.masterToken.slice(-6),
      lanIp: lan,
      claudeStatus: patch.status(),
    });
  }

  if (pathname === "/api/providers" && method === "POST") {
    try {
      const input = JSON.parse((await readBody(req)).toString("utf8"));
      const prov = upsertProvider(input);
      return sendJSON(res, 200, { ok: true, provider: providerView(prov) });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }

  let m = pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (m && method === "DELETE") {
    const id = decodeURIComponent(m[1]);
    delete cfg.providers[id];
    if (cfg.activeProfile === id) cfg.activeProfile = Object.keys(cfg.providers)[0] || "";
    store.save(cfg);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === "/api/providers/test" && method === "POST") {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    const prov = cfg.providers[input.id];
    if (!prov) return sendJSON(res, 404, { ok: false, error: "Provedor nao encontrado" });
    const r = await testProvider(prov, input.model);
    return sendJSON(res, 200, r);
  }

  if (pathname === "/api/active" && method === "POST") {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    if (!cfg.providers[input.id]) return sendJSON(res, 404, { ok: false, error: "Provedor nao encontrado" });
    cfg.activeProfile = input.id;
    store.save(cfg);
    return sendJSON(res, 200, { ok: true, activeProfile: cfg.activeProfile });
  }

  if (pathname === "/api/settings" && method === "POST") {
    const input = JSON.parse((await readBody(req)).toString("utf8"));
    if (Number(input.port) > 0 && Number(input.port) < 65536) cfg.port = Number(input.port);
    if (typeof input.host === "string" && input.host) cfg.host = input.host;
    store.save(cfg);
    return sendJSON(res, 200, { ok: true, note: "Reinicie o servidor (juno stop && juno) para aplicar." });
  }

  if (pathname === "/api/token/rotate" && method === "POST") {
    cfg.masterToken = store.newToken();
    store.save(cfg);
    return sendJSON(res, 200, { ok: true, note: "Gere novamente os comandos do Claude Code." });
  }

  if (pathname === "/api/config/import" && method === "POST") {
    try {
      const input = JSON.parse((await readBody(req)).toString("utf8"));
      if (input.providers && typeof input.providers === "object") cfg.providers = input.providers;
      if (typeof input.activeProfile === "string") cfg.activeProfile = input.activeProfile;
      if (Number(input.port) > 0) cfg.port = Number(input.port);
      if (input.host) cfg.host = input.host;
      if (!cfg.providers[cfg.activeProfile]) cfg.activeProfile = Object.keys(cfg.providers)[0] || "";
      store.save(cfg);
      return sendJSON(res, 200, { ok: true });
    } catch (e) { return sendJSON(res, 400, { ok: false, error: String((e && e.message) || e) }); }
  }

  // ---- Claude Code ----
  if (pathname === "/api/claude/cmd" && method === "GET") {
    const prov = cfg.providers[cfg.activeProfile];
    return sendJSON(res, 200, Object.assign({ active: cfg.activeProfile, hasProfile: !!prov }, patch.commandStrings(cfg, prov)));
  }
  if (pathname === "/api/claude/install" && method === "POST") {
    const prov = cfg.providers[cfg.activeProfile];
    if (!prov) return sendJSON(res, 400, { ok: false, error: "Nenhum provedor ativo" });
    const env = patch.install(cfg, prov);
    return sendJSON(res, 200, { ok: true, env, note: "Agora o comando `claude` normal ja usa o Juno." });
  }
  if (pathname === "/api/claude/uninstall" && method === "POST") {
    patch.uninstall();
    return sendJSON(res, 200, { ok: true });
  }
  if (pathname === "/api/claude/status" && method === "GET") {
    return sendJSON(res, 200, patch.status());
  }

  // ---- chat ----
  if (pathname === "/api/chat/stream" && method === "POST") {
    const payload = JSON.parse((await readBody(req)).toString("utf8"));
    fanout(res, payload);
    return;
  }
  if (pathname === "/api/chat" && method === "POST") {
    const payload = JSON.parse((await readBody(req)).toString("utf8"));
    return sendJSON(res, 200, { results: await fanoutSync(payload) });
  }

  return sendJSON(res, 404, { error: "rota desconhecida: " + pathname });
}

// ---------------------------------------------------------------- servidor

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const pathname = u.pathname;
  try {
    if (pathname === "/v1/messages" || pathname === "/v1/messages/count_tokens") {
      if (pathname.endsWith("/count_tokens")) {
        if (!authOk(req)) return anthropicError(res, 401, "authentication_error", "Token invalido");
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        return sendJSON(res, 200, { input_tokens: T.estTokens(JSON.stringify(body)) });
      }
      return await handleV1Messages(req, res);
    }
    if (pathname === "/v1/chat/completions") return await handleV1Chat(req, res);
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname, u.searchParams);
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, pathname);
    res.writeHead(404); res.end();
  } catch (e) {
    log("ERRO", pathname, (e && e.stack) || e);
    try { anthropicError(res, 500, "api_error", String((e && e.message) || e)); } catch {}
  }
});

function lanUrls() {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) urls.push("http://" + n.address + ":" + cfg.port);
    }
  }
  return urls;
}

function listen(port, host, attemptsLeft = 10) {
  server.listen(port, host, () => {
    store.ensureDir();
    try { fs.writeFileSync(store.PID_PATH, String(process.pid)); } catch {}
    log("Juno v" + VERSION + " no ar em http://" + host + ":" + port + (host === "127.0.0.1" ? "  (painel)" : ""));
    for (const u of lanUrls()) log("rede local: " + u);
    log("Claude Code: rode `juno claude` (sem login, usa as keys do painel)");
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && attemptsLeft > 0) {
      log("porta " + port + " ocupada, tentando " + (port + 1) + "...");
      cfg.port = port + 1;
      store.save(cfg);
      listen(port + 1, host, attemptsLeft - 1);
    } else {
      log("falha ao escutar:", e.message);
      process.exit(1);
    }
  });
}

listen(cfg.port, cfg.host);
module.exports = { server };
