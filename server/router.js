"use strict";
// Roteador: decide para qual provedor cada chamada vai e monta a requisicao upstream.

const T = require("./translate");

function joinUrl(base, p) {
  return String(base || "").replace(/\/+$/, "") + p;
}

// Resolve qual provedor/modelo atende a chamada.
// - "juno:<provider>/<model>" força um destino
// - qualquer outro nome (claude-*, alias, etc) usa o perfil ativo
function resolveTarget(cfg, requestedModel) {
  let prov = cfg.providers[cfg.activeProfile];
  if (!prov) {
    const first = Object.values(cfg.providers)[0];
    if (!first) return null;
    prov = first;
  }
  let model = prov.model;
  if (typeof requestedModel === "string" && requestedModel.startsWith("juno:")) {
    const rest = requestedModel.slice(5);
    const slash = rest.indexOf("/");
    const pid = slash === -1 ? rest : rest.slice(0, slash);
    const m = slash === -1 ? "" : rest.slice(slash + 1);
    const p2 = cfg.providers[pid];
    if (p2) return { provider: p2, model: m || p2.model };
  }
  return { provider: prov, model };
}

function openAIHeaders(prov, extra) {
  const h = Object.assign({ "Content-Type": "application/json" }, extra || {});
  if (prov.apiKey && !/^(ollama|none|local|)$/i.test(prov.apiKey)) h["Authorization"] = "Bearer " + prov.apiKey;
  // headers recomendados pelo OpenRouter; ignorados pelos demais
  h["HTTP-Referer"] = "http://127.0.0.1";
  h["X-Title"] = "Juno";
  return h;
}

function anthropicHeaders(prov, extra) {
  return Object.assign({
    "Content-Type": "application/json",
    "x-api-key": prov.apiKey || "",
    "anthropic-version": "2023-06-01",
  }, extra || {});
}

// Executa a chamada upstream em formato OpenAI (stream ou nao)
async function callOpenAI(prov, model, anthropicBody, stream, extraHeaders) {
  const body = T.anthropicToOpenAI(anthropicBody);
  body.model = model;
  body.stream = !!stream;
  const url = joinUrl(prov.baseUrl, "/chat/completions");
  const res = await fetch(url, {
    method: "POST",
    headers: openAIHeaders(prov, extraHeaders),
    body: JSON.stringify(body),
  });
  return { res, url };
}

// Executa a chamada upstream em formato Anthropic nativo
async function callAnthropic(prov, model, anthropicBody, stream, extraHeaders) {
  const body = Object.assign({}, anthropicBody, { model });
  body.stream = !!stream;
  const url = joinUrl(prov.baseUrl, "/v1/messages");
  const res = await fetch(url, {
    method: "POST",
    headers: anthropicHeaders(prov, extraHeaders),
    body: JSON.stringify(body),
  });
  return { res, url };
}

// Chamada generica usada pelo /v1/messages e pelos testes
async function upstream(prov, model, anthropicBody, stream, extraHeaders) {
  if (prov.type === "anthropic") return callAnthropic(prov, model, anthropicBody, stream, extraHeaders);
  return callOpenAI(prov, model, anthropicBody, stream, extraHeaders);
}

async function errorText(upRes, limit = 600) {
  let txt = "";
  try { txt = await upRes.text(); } catch {}
  try {
    const j = JSON.parse(txt);
    if (j.error) {
      if (typeof j.error === "string") txt = j.error;
      else if (j.error.message) txt = j.error.message;
    }
  } catch {}
  txt = String(txt || ("HTTP " + upRes.status)).slice(0, limit);
  return txt;
}

module.exports = { joinUrl, resolveTarget, upstream, callOpenAI, callAnthropic, openAIHeaders, anthropicHeaders, errorText };
