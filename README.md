# JUNO — Painel Multi-IA + Claude Code sem login (só API key)

Painel web local onde você cadastra **qualquer provedor de IA (gratuito ou pago) apenas com a API key**, conversa com **várias IAs ao mesmo tempo** vendo qual está respondendo, e usa o **Claude Code no CMD/PowerShell sem pedir login na Anthropic** — ele passa a usar as keys que estão no painel.

Funciona em **Windows e Linux**. Zero dependências: só Node.js (sem `npm install` de pacotes).

---

## Como funciona (a "engenharia reversa")

O Claude Code não precisa de login quando estas variáveis de ambiente estão definidas:

| Variável | Efeito |
|---|---|
| `ANTHROPIC_BASE_URL` | Redireciona TODAS as chamadas de API para outro endereço (neste caso, o servidor local do Juno) |
| `ANTHROPIC_AUTH_TOKEN` | Token enviado no header `Authorization: Bearer` — com ele presente, **nunca aparece o prompt de login/OAuth** |
| `ANTHROPIC_MODEL` | Modelo principal que o Claude Code vai pedir |
| `ANTHROPIC_SMALL_FAST_MODEL` | Modelo das tarefas rápidas de fundo |
| `ANTHROPIC_DEFAULT_HAIKU/SONNET/OPUS_MODEL` | Mapeia os apelidos haiku/sonnet/opus para o seu modelo |

O Juno sobe um **servidor local em `http://127.0.0.1:8787`** que fala o protocolo Anthropic (`/v1/messages`, SSE, tool use) e **traduz para o formato de cada provedor** (OpenAI-compatível ou Anthropic nativo). O Claude Code acha que está falando com a Anthropic — na verdade está falando com o provedor que você escolheu no painel, com a sua key.

> Não é preciso modificar o binário do Claude Code: a integração usa os pontos oficiais de configuração (env vars + `settings.json`), que é exatamente como gateways corporativos (LiteLLM, Bedrock etc.) se conectam.

---

## Instalação em 1 comando (depois de publicar no GitHub)

**Windows (CMD ou PowerShell):**
```cmd
curl -fsSL https://raw.githubusercontent.com/anthonymigueldias09-cmyk/juno/main/install.ps1 -o juno-install.ps1 && powershell -NoProfile -ExecutionPolicy Bypass -File juno-install.ps1 && del juno-install.ps1
```

**Linux / macOS:**
```bash
curl -fsSL https://raw.githubusercontent.com/anthonymigueldias09-cmyk/juno/main/install.sh | bash
```

(Instalação local, sem GitHub: rode `install.bat` no Windows ou `bash install.sh` no Linux, dentro da pasta.)

## Uso

```bash
juno                       # sobe o servidor e abre o painel: http://127.0.0.1:8787
juno key groq gsk_xxx      # salva a key de um provedor (groq, gemini, openai, anthropic, ...)
juno key anthropic sk-ant-xxx --model claude-sonnet-4-5
juno providers             # lista os configurados
juno use groq              # troca o provedor ativo do Claude Code
juno claude                # abre o Claude Code SEM LOGIN, usando a key do painel
juno status
juno claude-install        # (opcional) integração persistente via settings.json
juno claude-uninstall      # desfaz
juno stop
```

Dentro do painel (aba **Provedores**) dá para adicionar pelo catálogo:
- **GRÁTIS:** Gemini, Groq, OpenRouter (`:free`), Mistral, Cerebras, NVIDIA, Hugging Face, Ollama (local), LM Studio (local)
- **PAGOS:** OpenAI, Anthropic, DeepSeek, xAI (Grok), Moonshot (Kimi), Qwen, GLM (Zhipu), Perplexity, Fireworks, Together, DeepInfra, Novita, MiniMax — e **Personalizado** para qualquer API compatível com OpenAI.

Na aba **Chat Multi-IA** você marca vários provedores, manda a mesma pergunta e vê **todas respondendo ao vivo, lado a lado**, com nome do provedor, modelo, tempo e erros.

Na aba **Claude Code** você copia o comando pronto (CMD / PowerShell / Bash) com as env vars do provedor ativo, ou aplica a integração persistente.

## Commit pro GitHub

```bash
juno repo https://github.com/SEU-USUARIO/SEU-REPO.git   # só na primeira vez
juno commit "melhorias no painel"                        # add + commit + push
```

`juno commit` roda no diretório atual (funciona em qualquer repositório seu, Windows e Linux).

## Endpoints técnicos

- `POST /v1/messages` — protocolo Anthropic (o Claude Code fala aqui). Autenticação: `Authorization: Bearer <token do Juno>`.
- `POST /v1/messages/count_tokens` — estimativa local.
- `POST /v1/chat/completions` — protocolo OpenAI (outras ferramentas também podem usar o Juno).
- `GET/POST /api/*` — painel (config, teste de provedor, chat em fan-out via SSE).

## Segurança

- As API keys ficam em `~/.juno/config.json` (fora do repositório; `chmod 600` no Linux). **Nunca** commite esse arquivo.
- Por padrão o servidor escuta só em `127.0.0.1` (nada aparece na rede). Para acessar pelo celular, mude o Host para `0.0.0.0` nos Ajustes — aí qualquer um na sua rede poderia ver o painel, use com cuidado.
- O token do Juno autentica o `/v1/messages`; sem ele a chamada é rejeitada.

## Solução de problemas

- **Claude Code pede login**: você rodou `claude` direto — use `juno claude` (ou aplique a integração persistente).
- **401 no /v1/messages**: o token mudou — gere o comando de novo na aba Claude Code.
- **429 do provedor**: cota grátis estourou — troque de modelo/provedor no painel.
- **Modelos `:free` do OpenRouter somem**: os IDs mudam com frequência; edite o modelo no painel.
- **Porta ocupada**: o Juno sobe automaticamente na próxima (8788, 8799...).
