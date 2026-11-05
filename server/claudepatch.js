"use strict";
// Integracao persistente com o Claude Code via ~/.claude/settings.json
// (bloco "env"). O Claude Code le esse bloco em toda inicializacao,
// entao com ele o `claude` comum ja sai apontando para o Juno - sem login.

const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("./store");

const CLAUDE_SETTINGS = process.env.JUNO_CLAUDE_SETTINGS || path.join(os.homedir(), ".claude", "settings.json");

// chaves que o Juno controla (nao mexemos em outras)
const OUR_KEYS = [
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
];

function readSettings() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")); } catch { return {}; }
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(obj, null, 2) + "\n");
}

function envForProfile(cfg, prov) {
  const base = "http://127.0.0.1:" + cfg.port;
  const model = (prov && prov.model) || "";
  const small = (prov && (prov.smallModel || prov.model)) || model;
  const env = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: cfg.masterToken,
    // evita aviso de "modelo fora do catalogo" (modelos de terceiros)
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
  };
  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_SMALL_FAST_MODEL = small;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  }
  return env;
}

function install(cfg, prov) {
  const settings = readSettings();
  // backup antes de mexer
  try {
    fs.mkdirSync(store.JUNO_DIR, { recursive: true });
    fs.copyFileSync(CLAUDE_SETTINGS, CLAUDE_SETTINGS + ".juno-backup-" + Date.now());
  } catch {}
  settings.env = Object.assign({}, settings.env || {}, envForProfile(cfg, prov));
  writeSettings(settings);
  fs.writeFileSync(store.CLAUDE_ENV_PATH, JSON.stringify({ env: envForProfile(cfg, prov), at: Date.now() }, null, 2));
  return envForProfile(cfg, prov);
}

function uninstall() {
  let ours = {};
  try { ours = (JSON.parse(fs.readFileSync(store.CLAUDE_ENV_PATH, "utf8")) || {}).env || {}; } catch {}
  const settings = readSettings();
  if (settings.env) {
    for (const k of OUR_KEYS) {
      // so removemos se o valor atual foi escrito pelo Juno
      if (ours[k] === undefined || settings.env[k] === ours[k]) delete settings.env[k];
    }
    if (!Object.keys(settings.env).length) delete settings.env;
  }
  writeSettings(settings);
  try { fs.unlinkSync(store.CLAUDE_ENV_PATH); } catch {}
  return true;
}

function status() {
  let ours = {};
  try { ours = (JSON.parse(fs.readFileSync(store.CLAUDE_ENV_PATH, "utf8")) || {}).env || {}; } catch {}
  const settings = readSettings();
  const env = settings.env || {};
  const installed = OUR_KEYS.some((k) => env[k] !== undefined);
  return { installed, env, ourKeys: Object.keys(ours) };
}

function commandStrings(cfg, prov) {
  const env = envForProfile(cfg, prov);
  const pairs = Object.entries(env);
  const cmdLine = pairs.map(([k, v]) => 'set "' + k + "=" + v + '"').join("&& ") + "&& claude";
  const psLine = pairs.map(([k, v]) => "$env:" + k + "='" + v + "'").join("; ") + "; claude";
  const bashLine = pairs.map(([k, v]) => k + "='" + v + "'").join(" ") + " claude";
  return { cmd: cmdLine, powershell: psLine, bash: bashLine };
}

module.exports = { OUR_KEYS, install, uninstall, status, commandStrings, envForProfile, CLAUDE_SETTINGS };
