"use strict";
// Provedor MOCK (compativel com OpenAI) para testar o Juno sem gastar creditos.
// uso: node scripts/mock-provider.js [porta]   (padrao 9911)
// Se a ultima mensagem do usuario contem "USE_TOOL", responde com tool_calls.

const http = require("http");
const port = Number(process.argv[2] || 9911);

function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const c = messages[i].content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => (p && p.text) || "").join(" ");
    }
  }
  return "";
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model" }] }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let j = {};
    try { j = JSON.parse(body || "{}"); } catch {}
    const userText = lastUserText(j.messages || []);
    const wantsTool = body.includes("USE_TOOL");
    const reply = "Ola! Sou o MOCK-JUNO. Recebi: " + userText.slice(0, 120);

    if (!j.stream) {
      const msg = { role: "assistant", content: reply };
      if (wantsTool) {
        msg.content = null;
        msg.tool_calls = [{ id: "call_mock_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Sao Paulo"}' } }];
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-mock", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: j.model || "mock-model",
        choices: [{ index: 0, message: msg, finish_reason: wantsTool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
    let n = 0;
    const chunk = (delta, finish) => send({
      id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: j.model || "mock-model",
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    });

    chunk({ role: "assistant", content: "" });
    if (wantsTool) {
      chunk({ tool_calls: [{ index: 0, id: "call_mock_1", type: "function", function: { name: "get_weather", arguments: "" } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Sao ' } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'Paulo"}' } }] });
      chunk({}, "tool_calls");
    } else {
      const parts = reply.match(/.{1,18}/gs) || [reply];
      const tick = () => {
        if (n < parts.length) {
          chunk({ content: parts[n++] });
          setTimeout(tick, 12);
        } else {
          chunk({}, "stop");
          send({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: j.model || "mock-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } });
          res.write("data: [DONE]\n\n");
          res.end();
        }
      };
      tick();
      return;
    }
    send({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: j.model || "mock-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(port, "127.0.0.1", () => console.log("[mock-provider] no ar em http://127.0.0.1:" + port + "/v1/chat/completions"));
