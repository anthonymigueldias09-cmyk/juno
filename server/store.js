"use strict";
// Armazenamento da configuracao do Juno: ~/.juno/config.json
// As API keys ficam NESTE arquivo, fora do repositorio git.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const JUNO_DIR = process.env.JUNO_HOME || path.join(os.homedir(), ".juno");
const CONFIG_PATH = path.join(JUNO_DIR, "config.json");
const CLAUDE_ENV_PATH = path.join(JUNO_DIR, "claude-env.json");
const PID_PATH = path.join(JUNO_DIR, "server.pid");

const DEFAULTS = {
  port: 8787,
  host: "127.0.0.1",
  masterToken: "",
  activeProfile: "",
  providers: {},
};

function ensureDir() {
  fs.mkdirSync(JUNO_DIR, { recursive: true });
  try { fs.chmodSync(JUNO_DIR, 0o700); } catch {}
}

function newToken() {
  return "juno-" + crypto.randomBytes(18).toString("hex");
}

function load() {
  ensureDir();
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch {}
  const cfg = Object.assign(structuredClone(DEFAULTS), onDisk || {});
  if (!cfg.providers || typeof cfg.providers !== "object") cfg.providers = {};
  if (!cfg.masterToken) {
    cfg.masterToken = newToken();
    save(cfg);
  }
  return cfg;
}

function save(cfg) {
  ensureDir();
  const tmp = CONFIG_PATH + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}

function maskKey(k) {
  if (!k) return "";
  const s = String(k);
  if (s.length <= 10) return "***";
  return s.slice(0, 5) + "..." + s.slice(-4);
}

function slugify(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "provider";
}

module.exports = { JUNO_DIR, CONFIG_PATH, CLAUDE_ENV_PATH, PID_PATH, ensureDir, load, save, maskKey, newToken, slugify };
