@echo off
setlocal
echo ==============================================
echo   JUNO - instalador Windows
echo ==============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org e rode de novo.
  exit /b 1
)

cd /d "%~dp0"
echo [1/3] Instalando via npm (global)...
npm install -g . --no-fund --no-audit
if errorlevel 1 (
  echo [AVISO] npm global falhou. Instalando no perfil do usuario...
  npm install -g . --prefix "%USERPROFILE%\.npm-global" --no-fund --no-audit
)

echo [2/3] Garantindo shim em %%USERPROFILE%%\.local\bin ...
if not exist "%USERPROFILE%\.local\bin" mkdir "%USERPROFILE%\.local\bin"
copy /y "%~dp0bin\juno-shim.cmd" "%USERPROFILE%\.local\bin\juno.cmd" >nul 2>nul
copy /y "%~dp0bin\juno-shim.cmd" "%USERPROFILE%\.local\bin\juno.ps1" >nul 2>nul

echo [3/3] Verificando...
where juno >nul 2>nul
if errorlevel 1 (
  echo [AVISO] 'juno' ainda nao esta no PATH deste terminal.
  echo         Feche e abra um novo terminal ^^^^^@- se nao aparecer, adicione ao PATH:
  echo         %USERPROFILE%\.local\bin
)

echo.
echo Instalado! Comandos principais:
echo   juno              - abre o painel no navegador (http://127.0.0.1:8787)
echo   juno claude       - Claude Code sem login, usando as keys do painel
echo   juno key groq gsk_xxx - salva uma key
echo   juno commit "msg" - commita e envia pro GitHub
echo.
call juno status
endlocal
