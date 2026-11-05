"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let CFG = null;              // configuração vinda do servidor
let chatMessages = [];       // [{role, content}]
const chatSel = new Map();   // providerId -> modelo escolhido

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toast(msg, cls = "") {
  const t = document.createElement("div");
  t.className = "toast " + cls;
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok && j.error) throw new Error(typeof j.error === "string" ? j.error : (j.error.message || res.status));
  return j;
}

// ---------------------------------------------------------------- abas
$$(".tab").forEach((b) => b.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === b));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
  if (b.dataset.tab === "claude") renderClaude();
}));

// ---------------------------------------------------------------- health
async function pingHealth() {
  try {
    const j = await api("/api/health");
    $("#healthDot").className = "dot on";
    $("#healthTxt").textContent = `juno v${j.version} · ${j.providers} provedor(es) · ativo: ${j.active || "—"}`;
  } catch {
    $("#healthDot").className = "dot off";
    $("#healthTxt").textContent = "servidor offline";
  }
}

// ---------------------------------------------------------------- provedores
async function loadConfig() {
  CFG = await api("/api/config");
  fillPresetSelect();
  renderProviders();
  renderChatChips();
  $("#setPort").value = CFG.port;
  $("#setHost").value = CFG.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  $("#cfgPath").textContent = "C:\\Users\\<voce>\\.juno\\config.json (Linux: ~/.juno/config.json)";
}

function fillPresetSelect() {
  const sel = $("#fPreset");
  sel.innerHTML = "";
  const groups = [["Gratuitos", true], ["Pagos", false]];
  for (const [label, free] of groups) {
    const og = document.createElement("optgroup");
    og.label = label;
    for (const p of (window._presets || []).filter(x => x.free === free)) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}

let provFilter = "all";
$$("[data-filter]").forEach((c) => c.addEventListener("click", () => {
  provFilter = c.dataset.filter;
  $$("[data-filter]").forEach((x) => x.classList.toggle("on", x === c));
  renderProviders();
}));

function renderProviders() {
  const list = $("#provList");
  const items = CFG.providers.filter((p) => provFilter === "all" || (provFilter === "free" ? p.free : !p.free));
  list.innerHTML = items.map((p) => `
    <div class="prov ${p.id === CFG.activeProfile ? "active" : ""}" data-id="${esc(p.id)}">
      <div class="head">
        <span class="nm">${esc(p.name)}</span>
        <span class="badge ${p.free ? "free" : "paid"}">${p.free ? "GRÁTIS" : "PAGO"}</span>
        <span class="badge type">${esc(p.type)}</span>
        ${p.id === CFG.activeProfile ? '<span class="badge type">ATIVO no Claude</span>' : ""}
      </div>
      <div class="url">${esc(p.baseUrl)}</div>
      <div class="keyline">🔑 <span class="mono">${esc(p.keyMask || "sem key")}</span></div>
      <label>Modelo <input class="mEdit" value="${esc(p.model)}" placeholder="modelo"></label>
      <div class="test" data-testid="${esc(p.id)}"></div>
      <div class="acts">
        <button class="btn mini primary" data-act="test">Testar</button>
        <button class="btn mini" data-act="save">Salvar modelo</button>
        <button class="btn mini" data-act="active">Usar no Claude</button>
        <button class="btn mini" data-act="rekey">Trocar key</button>
        <button class="btn mini ghost" data-act="del">Excluir</button>
      </div>
    </div>`).join("") || '<p class="hint">Nenhum provedor ainda — adicione acima.</p>';

  list.querySelectorAll(".prov").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector('[data-act="test"]').onclick = async () => {
      const box = el.querySelector(".test");
      box.className = "test";
      box.textContent = "testando…";
      try {
        const r = await api("/api/providers/test", { method: "POST", body: { id } });
        box.className = "test " + (r.ok ? "ok" : "bad");
        box.textContent = r.ok ? `✓ OK ${r.latencyMs}ms — ${r.sample}` : `✗ ${r.error}`;
      } catch (e) { box.className = "test bad"; box.textContent = "✗ " + e.message; }
    };
    el.querySelector('[data-act="save"]').onclick = async () => {
      const model = el.querySelector(".mEdit").value.trim();
      const p = CFG.providers.find((x) => x.id === id);
      await api("/api/providers", { method: "POST", body: { ...p, apiKey: undefined, id, model } });
      toast("Modelo salvo", "ok");
      loadConfig();
    };
    el.querySelector('[data-act="active"]').onclick = async () => {
      await api("/api/active", { method: "POST", body: { id } });
      toast("Agora é o provedor do Claude Code", "ok");
      loadConfig();
    };
    el.querySelector('[data-act="rekey"]').onclick = async () => {
      const k = prompt("Cole a nova API key para " + id + ":");
      if (!k) return;
      const p = CFG.providers.find((x) => x.id === id);
      await api("/api/providers", { method: "POST", body: { ...p, apiKey: k } });
      toast("Key atualizada", "ok");
      loadConfig();
    };
    el.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm("Excluir " + id + "?")) return;
      await api("/api/providers/" + encodeURIComponent(id), { method: "DELETE" });
      loadConfig();
    };
  });
}

// preenchimento do form ao escolher preset
$("#fPreset").addEventListener("change", () => {
  const p = (window._presets || []).find((x) => x.id === $("#fPreset").value);
  if (!p) return;
  if (p.id === "custom") {
    $("#fName").value = ""; $("#fBase").value = ""; $("#fModel").value = ""; $("#modelList").innerHTML = "";
    $("#fName").focus();
    return;
  }
  $("#fName").value = p.name;
  $("#fBase").value = p.baseUrl || "";
  $("#fType").value = p.type;
  $("#fModel").value = p.model || "";
  $("#fFree").checked = !!p.free;
  $("#modelList").innerHTML = (p.models || []).map((m) => `<option value="${esc(m)}">`).join("");
  if (p.keyUrl) toast("Pegue a key em: " + p.keyUrl);
});

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const body = {
      id: $("#fPreset").value === "custom" ? store_slug($("#fName").value) : $("#fPreset").value,
      name: $("#fName").value,
      type: $("#fType").value,
      baseUrl: $("#fBase").value,
      apiKey: $("#fKey").value,
      model: $("#fModel").value,
      smallModel: $("#fSmall").value,
      free: $("#fFree").checked,
    };
    await api("/api/providers", { method: "POST", body });
    $("#fKey").value = "";
    toast("Provedor salvo ✓", "ok");
    loadConfig();
  } catch (err) { toast(err.message, "err"); }
});

function store_slug(name) {
  return String(name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
}

// ---------------------------------------------------------------- chat multi-IA
function renderChatChips() {
  const box = $("#chatChips");
  box.innerHTML = CFG.providers.map((p) => {
    const on = chatSel.has(p.id);
    const model = chatSel.get(p.id) || p.model;
    const opts = (window._presets || []).find((x) => x.id === p.id);
    const list = (opts && opts.models || []).map((m) => `<option value="${esc(m)}">`).join("");
    return `<div class="chip model ${on ? "on" : ""}" data-id="${esc(p.id)}">
      <input type="checkbox" ${on ? "checked" : ""}>
      <span>${esc(p.name)}</span>
      <span class="badge ${p.free ? "free" : "paid"}">${p.free ? "G" : "$"}</span>
      <input list="dl-${esc(p.id)}" value="${esc(model)}" data-model="${esc(p.id)}" placeholder="modelo">
      <datalist id="dl-${esc(p.id)}">${list}</datalist>
    </div>`;
  }).join("");

  box.querySelectorAll(".chip").forEach((chip) => {
    const id = chip.dataset.id;
    const cb = chip.querySelector("input[type=checkbox]");
    const min = chip.querySelector("input[data-model]");
    cb.addEventListener("change", () => {
      if (cb.checked) chatSel.set(id, min.value.trim());
      else chatSel.delete(id);
      chip.classList.toggle("on", cb.checked);
    });
    min.addEventListener("input", () => { if (chatSel.has(id)) chatSel.set(id, min.value.trim()); });
    chip.addEventListener("click", (e) => {
      if (e.target === min) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });
  });
}

async function sendChat() {
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  if (!chatSel.size) { toast("Marque pelo menos um provedor", "err"); return; }
  input.value = "";

  chatMessages.push({ role: "user", content: text });

  const round = document.createElement("div");
  round.className = "round";
  round.innerHTML = `<div class="ask"><b>você ▸</b> ${esc(text)}</div><div class="cards"></div>`;
  $("#chatLog").appendChild(round);
  const cards = round.querySelector(".cards");

  const profiles = [...chatSel.entries()].map(([id, model]) => ({ id, model }));
  const cardByProfile = new Map();
  for (const p of profiles) {
    const prov = CFG.providers.find((x) => x.id === p.id);
    const c = document.createElement("div");
    c.className = "ai streaming";
    c.innerHTML = `<div class="hd"><span class="nm">${esc(prov ? prov.name : p.id)}</span>
      <span class="badge ${prov && prov.free ? "free" : "paid"}">${prov && prov.free ? "GRÁTIS" : "PAGO"}</span>
      <span class="mono">${esc(p.model)}</span></div>
      <div class="body"></div>
      <div class="ft"><span class="meta"></span><button class="btn mini ghost use">usar esta na conversa</button></div>`;
    cards.appendChild(c);
    cardByProfile.set(p.id, c);
    c.querySelector(".use").onclick = () => {
      const txt = c.querySelector(".body").textContent;
      if (!txt) return;
      chatMessages.push({ role: "assistant", content: txt });
      toast("Resposta adicionada à conversa", "ok");
    };
  }

  try {
    const resp = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profiles, messages: chatMessages, system: $("#chatSystem").value.trim() }),
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let ended = false;
    while (!ended) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let evt;
          try { evt = JSON.parse(line.slice(5)); } catch { continue; }
          if (evt.type === "start") continue;
          const card = cardByProfile.get(evt.profile);
          if (!card) continue;
          if (evt.type === "delta") card.querySelector(".body").textContent += evt.text;
          else if (evt.type === "done") {
            card.classList.remove("streaming");
            card.querySelector(".meta").textContent = `${(evt.ms / 1000).toFixed(1)}s · ${evt.chars} chars`;
          } else if (evt.type === "error") {
            card.classList.remove("streaming", "err");
            card.classList.add("err");
            card.querySelector(".body").textContent = "✗ " + evt.error;
          } else if (evt.type === "end") ended = true;
        }
      }
    }
  } catch (e) {
    toast("Falha no chat: " + e.message, "err");
  }
}

$("#chatSend").addEventListener("click", sendChat);
$("#chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$("#chatClear").addEventListener("click", () => { chatMessages = []; $("#chatLog").innerHTML = ""; });

// ---------------------------------------------------------------- claude code
async function renderClaude() {
  const [st, cmds] = await Promise.all([api("/api/claude/status"), api("/api/claude/cmd")]);
  const active = CFG.providers.find((p) => p.id === CFG.activeProfile);
  $("#claudeStatus").innerHTML =
    `Provedor ativo: <b>${esc(active ? active.name : "nenhum")}</b> · modelo <span class="mono">${esc(active ? active.model : "—")}</span><br>` +
    `Integração persistente: ${st.installed ? '<b class="ok">ATIVA</b> (o `claude` comum já usa o Juno)' : '<b class="no">inativa</b> (use `juno claude` para modo pontual)'}` +
    (CFG.lanIp ? `<br>Painel acessível na rede: <span class="mono">http://${esc(CFG.lanIp)}:${CFG.port}</span> (mude o Host nos Ajustes)` : "");

  const boxes = [
    ["CMD (Windows)", cmds.cmd],
    ["PowerShell (Windows)", cmds.powershell],
    ["Git Bash / Linux / macOS", cmds.bash],
  ];
  $("#cmdBoxes").innerHTML = boxes.map(([t, code]) => `
    <div class="cmdhead"><span>${t}</span><button class="btn mini" data-copy="${esc(code)}">copiar</button></div>
    <pre class="cmdbox">${esc(code)}</pre>`).join("");
  $$("#cmdBoxes [data-copy]").forEach((b) => b.onclick = () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => toast("Comando copiado ✓", "ok"));
  });
}

$("#btnClaudeInstall").addEventListener("click", async () => {
  try {
    const r = await api("/api/claude/install", { method: "POST" });
    toast("Integração aplicada: `claude` agora usa o Juno ✓", "ok");
    renderClaude();
  } catch (e) { toast(e.message, "err"); }
});
$("#btnClaudeUninstall").addEventListener("click", async () => {
  await api("/api/claude/uninstall", { method: "POST" });
  toast("Integração removida", "ok");
  renderClaude();
});

// ---------------------------------------------------------------- ajustes
$("#setSave").addEventListener("click", async () => {
  await api("/api/settings", { method: "POST", body: { port: Number($("#setPort").value), host: $("#setHost").value } });
  toast("Salvo. Reinicie com `juno stop` e `juno`.", "ok");
});
$("#btnRotate").addEventListener("click", async () => {
  await api("/api/token/rotate", { method: "POST" });
  toast("Novo token gerado — atualize os comandos do Claude Code", "ok");
});
$("#btnExport").addEventListener("click", () => {
  const data = JSON.stringify({ port: CFG.port, host: CFG.host, activeProfile: CFG.activeProfile, providers: Object.fromEntries(CFG.providers.map((p) => [p.id, p])) }, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "juno-config.json";
  a.click();
});
$("#btnImportToggle").addEventListener("click", () => $("#importBox").classList.toggle("hidden"));
$("#btnImportDo").addEventListener("click", async () => {
  try {
    const j = JSON.parse($("#importText").value);
    await api("/api/config/import", { method: "POST", body: j });
    toast("Configuração importada ✓", "ok");
    loadConfig();
  } catch (e) { toast("JSON inválido: " + e.message, "err"); }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    CFG = await api("/api/config");
    window._presets = CFG.presets;
    await loadConfig();
  } catch (e) {
    toast("Não consegui carregar a config: " + e.message, "err");
  }
  pingHealth();
  setInterval(pingHealth, 8000);
})();
