#!/usr/bin/env bash
# JUNO - instalador Linux / macOS / Git Bash
set -e

echo "=============================================="
echo "  JUNO - instalador Linux/macOS"
echo "=============================================="

command -v node >/dev/null 2>&1 || { echo "[ERRO] Node.js nao encontrado. Instale: https://nodejs.org"; exit 1; }

cd "$(dirname "$0")"

echo "[1/2] Instalando via npm (global)..."
if npm install -g . --no-fund --no-audit >/dev/null 2>&1; then
  echo "      instalado no prefixo global do npm"
else
  echo "      sem permissao global -> instalando em ~/.local"
  npm install -g . --prefix "$HOME/.local" --no-fund --no-audit
  mkdir -p "$HOME/.local/bin"
fi

echo "[2/2] Verificando..."
if ! command -v juno >/dev/null 2>&1; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v juno >/dev/null 2>&1; then
  echo "[AVISO] 'juno' fora do PATH. Adicione ao ~/.bashrc ou ~/.zshrc:"
  echo '        export PATH="$HOME/.local/bin:$PATH"'
  exit 0
fi

echo ""
echo "Instalado! Comandos:"
echo "  juno              - abre o painel no navegador"
echo "  juno claude       - Claude Code sem login (keys do painel)"
echo "  juno key groq gsk_xxx - salva uma key"
echo '  juno commit "msg" - commita e envia pro GitHub'
echo ""
juno status || true
