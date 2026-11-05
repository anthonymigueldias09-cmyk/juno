"use strict";
// CLI do Juno: juno | juno serve | juno claude | juno key | juno use | juno commit ...

const { spawn, execSync } = require("child_process");
const path = require("path");
const http = require("http");
const store = require("./store");
const { PRESETS } = require("./providers");
const patch = require("./claudepatch");

const SERVER_PATH = path.join(__dirname, "index.js");

function out(...a) { console.log(...a); }
function fail(msg, code = 1) { console.error("[juno] ERRO:", msg); process.exit(code); }

function sh(cmd, opts = {}) {
  return execSync(cmd, Object.assign({ stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" }, opts));
}

function baseUrl(cfg) { return "http://127.0.0.1:" + cfg.port; }

function ping(cfg, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(baseUrl(cfg) + "/api/health", { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
  });
}

async function ensureServer(cfg) {
  if (await ping(cfg)) return { started: false, port: cfg.port };
  const child = spawn(process.execPath, [SERVER_PATH], {
    detached: true,
    stdio: "ignore",
    env: Object.assign({}, process.env, { JUNO_QUIET: "1" }),
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await ping(cfg)) return { started: true, port: cfg.port };
  }
  fail("nao consegui iniciar o servidor Juno em " + baseUrl(cfg));
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") execSync('start "" "' + url + '"', { shell: "cmd.exe", stdio: "ignore" });
    else if (process.platform === "darwin") execSync("open " + JSON.stringify(url), { stdio: "ignore" });
    else execSync("xdg-open " + JSON.stringify(url) + " </dev/null", { shell: "/bin/bash", stdio: "ignore" });
  } catch {}
}

// ---------------------------------------------------------------- comandos

function cmdServe(args) {
  const noOpen = args.includes("--no-open");
  const { spawn: sp } = require("child_process");
  if (!noOpen) {
    const cfg = store.load();
    (async () => {
      if (await ping(cfg)) { out("[juno] servidor ja esta no ar em " + baseUrl(cfg)); openBrowser(baseUrl(cfg)); process.exit(0); }
      const child = sp(process.execPath, [SERVER_PATH], { detached: false, stdio: "inherit" });
      // abre o navegador quando o servidor responder
      const t = setInterval(async () => {
        if (await ping(cfg)) { clearInterval(t); openBrowser(baseUrl(cfg)); }
      }, 300);
      child.on("exit", () => process.exit(0));
    })();
    return;
  }
  const child = sp(process.execPath, [SERVER_PATH], { stdio: "inherit" });
  child.on("exit", (c) => process.exit(c || 0));
}

async function cmdClaude(args) {
  const cfg = store.load();
  const prov = cfg.providers[cfg.activeProfile];
  if (!prov) {
    out("[juno] Nenhum provedor configurado ainda.");
    out("Adicione uma key:  juno key <provedor> <API_KEY>");
    out("Provedores validos: " + PRESETS.map((p) => p.id).join(", "));
    process.exit(1);
  }
  const { started, port } = await ensureServer(cfg);
  if (started) out("[juno] servidor iniciado em http://127.0.0.1:" + port);

  const env = Object.assign({}, process.env, patch.envForProfile(cfg, prov), {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  });

  let bin = "claude";
  if (process.platform === "win32") {
    try {
      const where = sh("where claude", { shell: "cmd.exe" }).trim().split(/\r?\n/)[0].trim();
      if (where) bin = where;
    } catch {}
  }
  out("[juno] Claude Code -> " + prov.name + " | modelo: " + prov.model);
  const child = spawn(bin, args, { stdio: "inherit", env, shell: process.platform === "win32" && !/\.exe$/i.test(bin) });
  child.on("error", (e) => fail("nao achei o `claude` no PATH: " + e.message + "\nInstale com: npm install -g @anthropic-ai/claude-code"));
  child.on("exit", (c, sig) => process.exit(c == null ? (sig ? 1 : 0) : c));
}

function cmdKey(args) {
  const cfg = store.load();
  const [pid, key] = args.filter((a) => !a.startsWith("--"));
  if (!pid || !key) fail("uso: juno key <provedor> <API_KEY> [--model <modelo>] [--base <url>] [--type openai|anthropic] [--free|--paid]");
  const preset = PRESETS.find((p) => p.id === pid);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const prov = {
    id: preset ? preset.id : store.slugify(pid),
    name: preset ? preset.name : pid,
    type: get("--type") || (preset ? preset.type : "openai"),
    baseUrl: get("--base") || (preset ? preset.baseUrl : ""),
    apiKey: key,
    model: get("--model") || (preset ? preset.model : ""),
    free: preset ? !!preset.free : args.includes("--free"),
    note: preset ? preset.note : "",
    keyUrl: preset ? preset.keyUrl : "",
  };
  if (!prov.baseUrl) fail("provedor desconhecido: informe --base <url> (endpoint compativel com OpenAI)");
  cfg.providers[prov.id] = prov;
  cfg.activeProfile = prov.id;
  store.save(cfg);
  out("[juno] provedor salvo: " + prov.name + " | modelo: " + prov.model + " | ativo p/ Claude Code");
}

function cmdUse(args) {
  const cfg = store.load();
  const [pid, model] = args;
  const prov = cfg.providers[pid] || (PRESETS.some((p) => p.id === pid) ? null : null);
  if (!prov) fail("provedor nao configurado. Veja a lista: juno providers");
  if (model) prov.model = model;
  cfg.activeProfile = pid;
  store.save(cfg);
  out("[juno] ativo: " + prov.name + " (" + prov.model + ")");
}

function cmdProviders() {
  const cfg = store.load();
  if (!Object.keys(cfg.providers).length) { out("(nenhum provedor configurado)"); return; }
  for (const p of Object.values(cfg.providers)) {
    const act = p.id === cfg.activeProfile ? "*" : " ";
    out(act + " " + p.id.padEnd(14) + (p.free ? "[FREE]" : "[PAGO]") + " " + p.type.padEnd(9) + " " + p.model);
  }
}

async function cmdStatus() {
  const cfg = store.load();
  const up = await ping(cfg);
  out("Juno      : " + (up ? "rodando em " + baseUrl(cfg) : "parado (use `juno`)"));
  out("Pasta     : " + store.JUNO_DIR);
  out("Ativo     : " + (cfg.activeProfile || "(nenhum)"));
  const prov = cfg.providers[cfg.activeProfile];
  if (prov) out("Modelo    : " + prov.model);
  out("Provedores: " + Object.keys(cfg.providers).length);
  const cs = patch.status();
  out("Claude    : " + (cs.installed ? "integrado via settings.json (persistente)" : "via wrapper `juno claude`"));
}

async function cmdTest(args) {
  const cfg = store.load();
  const id = args[0] || cfg.activeProfile;
  const prov = cfg.providers[id];
  if (!prov) fail("provedor nao encontrado: " + id);
  await ensureServer(cfg);
  out("[juno] testando " + prov.name + " (" + prov.model + ") ...");
  const res = await fetch(baseUrl(cfg) + "/api/providers/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const j = await res.json();
  if (j.ok) out("[juno] OK em " + j.latencyMs + "ms  ->  " + j.sample);
  else out("[juno] FALHOU: " + j.error);
}

function cmdCommit(args) {
  const noPush = args.includes("--no-push");
  const msgIdx = args.findIndex((a) => !a.startsWith("--"));
  const msg = msgIdx >= 0 ? args[msgIdx] : "";
  try { sh("git rev-parse --is-inside-work-tree"); } catch {
    fail("esta pasta nao e um repositorio git. Use: juno repo <URL-do-seu-repositorio>");
  }
  try { sh("git add -A"); } catch (e) { fail("git add falhou: " + e.stderr); }
  let staged = "";
  try { staged = sh("git diff --cached --name-only").trim(); } catch {}
  if (!staged) { out("[juno] nada para commitar."); return; }
  if (!msg) fail('uso: juno commit "mensagem do commit"');
  try { sh('git commit -m ' + JSON.stringify(msg)); out("[juno] commit criado:\n" + sh("git log -1 --oneline").trim()); }
  catch (e) { fail("git commit falhou: " + ((e.stderr || "") + (e.message || ""))); }
  if (noPush) return;
  const branch = (() => { try { return sh("git rev-parse --abbrev-ref HEAD").trim(); } catch { return "main"; } })();
  try {
    sh("git push origin " + branch);
    out("[juno] enviado para o GitHub (origin/" + branch + ")");
  } catch {
    try {
      sh("git push -u origin " + branch);
      out("[juno] enviado para o GitHub (origin/" + branch + ")");
    } catch (e) {
      out("[juno] commit criado, mas o push falhou:");
      out(String((e.stderr || "") + (e.message || "")).trim());
      out("Configure o remoto: juno repo https://github.com/SEU-USUARIO/SEU-REPO.git");
    }
  }
}

function cmdRepo(args) {
  const url = args[0];
  if (!url) fail("uso: juno repo https://github.com/SEU-USUARIO/SEU-REPO.git");
  try { sh("git rev-parse --is-inside-work-tree"); } catch { sh("git init -b main"); out("[juno] repositorio git iniciado"); }
  try { sh('git remote add origin "' + url + '"'); }
  catch { sh('git remote set-url origin "' + url + '"'); }
  out("[juno] remote origin = " + url);
  const branch = (() => { try { return sh("git rev-parse --abbrev-ref HEAD").trim(); } catch { return ""; } })();
  if (branch) {
    try { sh("git push -u origin " + branch); out("[juno] enviado para " + url); }
    catch (e) { out("[juno] push falhou (verifique auth/permissao): " + String((e.stderr || "") + (e.message || "")).trim()); }
  } else {
    out('[juno] faca o primeiro commit: juno commit "primeiro commit"');
  }
}

function cmdStop() {
  let pid = 0;
  try { pid = Number(fsRead(store.PID_PATH).trim()); } catch {}
  if (!pid) fail("servidor nao esta rodando (nenhum pid salvo).");
  try {
    if (process.platform === "win32") sh("taskkill /PID " + pid + " /F", { shell: "cmd.exe" });
    else process.kill(pid);
    out("[juno] servidor parado (pid " + pid + ")");
  } catch (e) {
    out("[juno] pid " + pid + " nao estava mais rodando.");
  }
  try { require("fs").unlinkSync(store.PID_PATH); } catch {}
}

function fsRead(p) { return require("fs").readFileSync(p, "utf8"); }

function cmdHelp() {
  out(`
JUNO - painel multi-IA + Claude Code sem login (so API key)

  juno                     inicia o servidor e abre o painel no navegador
  juno serve --no-open     inicia o servidor sem abrir o navegador
  juno stop                para o servidor
  juno claude [args...]    abre o Claude Code (TUI normal) usando as keys do painel
  juno key <provedor> <API_KEY> [--model m] [--base url] [--type openai|anthropic]
                           salva a key de um provedor e o deixa ativo
  juno use <provedor> [modelo]   troca o provedor ativo
  juno providers           lista provedores configurados
  juno status              mostra o estado geral
  juno commit "mensagem"   git add + commit + push (no repositorio atual)
  juno repo <URL>          liga a pasta atual a um repositorio do GitHub
  juno claude-install      integra persistente: o 'claude' comum passa a usar o Juno
  juno claude-uninstall    desfaz a integracao persistente

Provedores pre-configurados:
  GRATIS : ${PRESETS.filter((p) => p.free).map((p) => p.id).join(", ")}
  PAGOS  : ${PRESETS.filter((p) => !p.free && p.id !== "custom").map((p) => p.id).join(", ")}, custom
`);
}

async function cmdClaudeInstall() {
  const cfg = store.load();
  const prov = cfg.providers[cfg.activeProfile];
  if (!prov) fail("configure um provedor primeiro: juno key <provedor> <API_KEY>");
  await ensureServer(cfg);
  const env = patch.install(cfg, prov);
  out("[juno] integracao persistente aplicada em " + patch.CLAUDE_SETTINGS);
  out("       (backup salvo na mesma pasta; desfaça com `juno claude-uninstall`)");
  out("       AGORA o comando `claude` normal ja usa " + prov.name + " (" + prov.model + ")");
  out("       base url: " + env.ANTHROPIC_BASE_URL);
}

function cmdClaudeUninstall() {
  patch.uninstall();
  out("[juno] integracao removida. O `claude` volta a se comportar padrao.");
}

// ---------------------------------------------------------------- dispatcher

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd || "help") {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return cmdHelp();
    case "serve":
    case "start":
      return cmdServe(args);
    case "claude":
      return cmdClaude(args);
    case "key":
      return cmdKey(args);
    case "use":
      return cmdUse(args);
    case "providers":
      return cmdProviders();
    case "status":
      return cmdStatus();
    case "commit":
      return cmdCommit(args);
    case "repo":
      return cmdRepo(args);
    case "stop":
      return cmdStop();
    case "claude-install":
      return cmdClaudeInstall();
    case "claude-uninstall":
      return cmdClaudeUninstall();
    default:
      out("comando desconhecido: " + cmd + "\n");
      return cmdHelp();
  }
}

module.exports = { main };
