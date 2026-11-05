"use strict";
// Traducao de protocolo Anthropic Messages <-> OpenAI Chat Completions.
// E aqui que o Juno faz a "ponte": o Claude Code fala Anthropic,
// e o Juno traduz para a linguagem de cada provedor.

const crypto = require("crypto");

function rnd() { return crypto.randomBytes(10).toString("hex"); }
function estTokens(s) { return Math.max(1, Math.ceil(String(s || "").length / 4)); }

// ---------------------------------------------------------------- utils

function blockText(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const b of c) {
    if (b.type === "text" && typeof b.text === "string") out += b.text;
    else if (b.type === "tool_result") {
      if (typeof b.content === "string") out += b.content;
      else if (Array.isArray(b.content)) out += b.content.filter((x) => x && x.type === "text").map((x) => x.text).join("\n");
    }
  }
  return out;
}

function systemToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.filter((b) => b && b.type === "text").map((b) => b.text).join("\n\n");
  return "";
}

function imageToDataURL(src) {
  if (!src) return null;
  if (src.type === "base64" && src.data) return "data:" + (src.media_type || "image/png") + ";base64," + src.data;
  if (src.type === "url" && src.url) return src.url;
  return null;
}

// ---------------------------------------------------------------- Anthropic -> OpenAI

function userBlocksToOpenAI(content) {
  if (typeof content === "string") return [{ role: "user", content }];
  const toolMsgs = [];
  const parts = [];
  for (const b of content || []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "tool_result") {
      let text = "";
      if (typeof b.content === "string") text = b.content;
      else if (Array.isArray(b.content)) text = b.content.filter((x) => x && x.type === "text").map((x) => x.text).join("\n");
      toolMsgs.push({ role: "tool", tool_call_id: b.tool_use_id || "toolu_unknown", content: text || "(vazio)" });
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const url = imageToDataURL(b.source);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    } else if (b.type === "image_url") {
      parts.push({ type: "image_url", image_url: { url: (b.image_url && b.image_url.url) || "" } });
    }
    // thinking / redacted_thinking / document: ignorados no caminho OpenAI
  }
  const out = [];
  out.push(...toolMsgs); // mensagens tool precisam vir logo apos o assistant com tool_calls
  if (parts.length === 1 && parts[0].type === "text") out.push({ role: "user", content: parts[0].text });
  else if (parts.length) out.push({ role: "user", content: parts });
  return out;
}

function assistantToOpenAI(content) {
  if (typeof content === "string") return { role: "assistant", content };
  let text = "";
  const toolCalls = [];
  for (const b of content || []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id || "toolu_" + rnd(),
        type: "function",
        function: { name: b.name || "unknown", arguments: JSON.stringify(b.input || {}) },
      });
    }
  }
  const msg = { role: "assistant", content: text || null };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  return msg;
}

function anthropicToOpenAI(body) {
  const messages = [];
  const sys = systemToText(body.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of body.messages || []) {
    if (!m) continue;
    if (m.role === "user") messages.push(...userBlocksToOpenAI(m.content));
    else messages.push(assistantToOpenAI(m.content));
  }
  const out = { model: body.model, messages, max_tokens: body.max_tokens ?? 4096 };
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
    const tc = body.tool_choice;
    if (tc) {
      if (tc.type === "auto") out.tool_choice = "auto";
      else if (tc.type === "any") out.tool_choice = "required";
      else if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
      else if (tc.type === "none") out.tool_choice = "none";
    }
  }
  return out;
}

// ---------------------------------------------------------------- OpenAI -> Anthropic (resposta completa)

const STOP_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

function mapFinish(f) { return STOP_MAP[f] || "end_turn"; }

function openAIToAnthropicResponse(oai, model, estInputTokens) {
  const choice = (oai.choices && oai.choices[0]) || {};
  const m = choice.message || {};
  const content = [];
  let txt = "";
  if (typeof m.content === "string") txt = m.content;
  else if (Array.isArray(m.content)) txt = m.content.filter((p) => p && p.type === "text").map((p) => p.text).join("");
  if (txt) content.push({ type: "text", text: txt });
  for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse((tc.function && tc.function.arguments) || "{}"); }
    catch { input = { _raw: (tc.function && tc.function.arguments) || "" }; }
    content.push({
      type: "tool_use",
      id: tc.id || "toolu_" + rnd(),
      name: (tc.function && tc.function.name) || "unknown",
      input,
    });
  }
  const usage = oai.usage || {};
  return {
    id: "msg_" + rnd(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinish(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? estInputTokens ?? 0,
      output_tokens: usage.completion_tokens ?? estTokens(txt),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0,
    },
  };
}

// ---------------------------------------------------------------- streaming

// Parser incremental de SSE que funciona para OpenAI e Anthropic (so olha "data:")
async function parseSSE(stream, onData) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        const stop = onData(evt);
        if (stop === true) return;
      }
    }
  }
}

// Converte um stream OpenAI em eventos Anthropic SSE e escreve na resposta
async function pipeOpenAIStreamAsAnthropic(upstream, res, model, estInputTokens) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");

  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_" + rnd(), type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: estInputTokens || 0, output_tokens: 0 },
    },
  });

  let inText = false, textIndex = -1, nextIndex = 0;
  const tools = new Map(); // indexOpenAI -> {id, name, args, blockIndex}
  let finish = null, usageOut = null, sawText = "";
  let lastPing = Date.now();

  const ensureTextBlock = () => {
    if (!inText) {
      inText = true;
      textIndex = nextIndex++;
      send("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } });
    }
  };
  const closeTextBlock = () => {
    if (inText) { inText = false; send("content_block_stop", { type: "content_block_stop", index: textIndex }); }
  };

  try {
    await parseSSE(upstream.body, (evt) => {
      if (evt.usage) usageOut = evt.usage;
      const choice = evt.choices && evt.choices[0];
      if (!choice) return;
      const d = choice.delta || {};
      if (d.content) {
        ensureTextBlock();
        sawText += d.content;
        send("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: d.content } });
      }
      for (const tc of d.tool_calls || []) {
        let t = tools.get(tc.index);
        if (!t) {
          closeTextBlock();
          t = { id: tc.id || "toolu_" + rnd(), name: (tc.function && tc.function.name) || "", args: "", blockIndex: nextIndex++ };
          tools.set(tc.index, t);
          send("content_block_start", { type: "content_block_start", index: t.blockIndex, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } });
        }
        if (tc.function && tc.function.name && !t.name) t.name = tc.function.name;
        if (tc.function && tc.function.arguments) {
          t.args += tc.function.arguments;
          send("content_block_delta", { type: "content_block_delta", index: t.blockIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      if (Date.now() - lastPing > 15000) { lastPing = Date.now(); send("ping", { type: "ping" }); }
    });
  } catch (e) {
    // upstream caiu no meio do stream: encerra com erro visivel
    closeTextBlock();
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: estTokens(sawText) },
    });
    send("message_stop", { type: "message_stop" });
    res.end();
    throw e;
  }

  closeTextBlock();
  const sorted = [...tools.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, t] of sorted) send("content_block_stop", { type: "content_block_stop", index: t.blockIndex });

  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: mapFinish(finish), stop_sequence: null },
    usage: { output_tokens: (usageOut && usageOut.completion_tokens) || estTokens(sawText) },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

// Extrai apenas texto de um stream OpenAI (para o chat do painel)
async function collectOpenAIStreamText(stream, onDelta) {
  let text = "";
  await parseSSE(stream, (evt) => {
    const choice = evt.choices && evt.choices[0];
    const d = choice && choice.delta;
    if (d && typeof d.content === "string" && d.content) {
      text += d.content;
      if (onDelta) onDelta(d.content);
    }
  });
  return text;
}

// Extrai apenas texto de um stream Anthropic nativo (para o chat do painel)
async function collectAnthropicStreamText(stream, onDelta) {
  let text = "";
  await parseSSE(stream, (evt) => {
    if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta" && evt.delta.text) {
      text += evt.delta.text;
      if (onDelta) onDelta(evt.delta.text);
    }
  });
  return text;
}

// ---------------------------------------------------------------- helpers do painel

function panelToOpenAI(messages, system, model, maxTokens) {
  const out = [];
  if (system) out.push({ role: "system", content: String(system) });
  for (const m of messages || []) out.push({ role: m.role, content: String(m.content ?? "") });
  return { model, messages: out, max_tokens: maxTokens || 4096 };
}

function panelToAnthropic(messages, system, model, maxTokens) {
  const body = { model, max_tokens: maxTokens || 4096, messages: [] };
  if (system) body.system = String(system);
  for (const m of messages || []) body.messages.push({ role: m.role, content: String(m.content ?? "") });
  return body;
}

function openAITextFromResponse(oai) {
  const m = (oai.choices && oai.choices[0] && oai.choices[0].message) || {};
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
  return "";
}

function anthropicTextFromResponse(resp) {
  if (!resp || !Array.isArray(resp.content)) return "";
  return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

module.exports = {
  rnd, estTokens,
  blockText, systemToText,
  anthropicToOpenAI, openAIToAnthropicResponse, mapFinish,
  parseSSE, pipeOpenAIStreamAsAnthropic,
  collectOpenAIStreamText, collectAnthropicStreamText,
  panelToOpenAI, panelToAnthropic,
  openAITextFromResponse, anthropicTextFromResponse,
};
