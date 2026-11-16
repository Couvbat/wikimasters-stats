@echo off
setlocal EnableExtensions
rem Pool de prix partage, mode local : sur ce PC, sans NAS ni tunnel.
rem Double-clic : cree son dossier, une cle la premiere fois, puis demarre le pool sur http://127.0.0.1:8787.
rem Il n'ecoute que ce PC : les autres machines du reseau ne peuvent pas l'atteindre.
rem Synchro vers le pool du NAS : ecris "adresse cle" sur une ligne dans amont.txt, dans le dossier du pool, puis relance.
rem Dossier par defaut : Documents\wm-pool. Variables facultatives : WM_POOL_DIR, WM_POOL_PORT.
set "HERE=%~dp0"
if not defined WM_POOL_DIR set "WM_POOL_DIR=%USERPROFILE%\Documents\wm-pool"
if not defined WM_POOL_PORT set "WM_POOL_PORT=8787"

where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 23 ? 0 : 1)"
if errorlevel 1 goto :oldnode

if not exist "%WM_POOL_DIR%" mkdir "%WM_POOL_DIR%"
if not exist "%WM_POOL_DIR%\cle.txt" node -e "require('fs').writeFileSync(process.argv[1], require('crypto').randomBytes(24).toString('base64url'))" "%WM_POOL_DIR%\cle.txt"
set /p GROUP_KEY=<"%WM_POOL_DIR%\cle.txt"
set "DB_PATH=%WM_POOL_DIR%\pool.db"
set "PORT=%WM_POOL_PORT%"
set "HOST=127.0.0.1"
set "UPSTREAM_URL="
set "UPSTREAM_KEY="
if exist "%WM_POOL_DIR%\amont.txt" for /f "usebackq tokens=1,2" %%a in ("%WM_POOL_DIR%\amont.txt") do (
  set "UPSTREAM_URL=%%a"
  set "UPSTREAM_KEY=%%b"
)

echo.
echo   Pool local : http://127.0.0.1:%PORT%  - ce PC seulement
echo   Cle        : %GROUP_KEY%
echo   Donnees    : %DB_PATH%
if defined UPSTREAM_URL goto :withsync
echo   Synchro    : aucune - ajoute amont.txt pour envoyer ce pool vers celui du NAS
goto :run
:withsync
echo   Synchro    : vers %UPSTREAM_URL%, toutes les 5 minutes, des qu'il repond
:run
echo.
echo   Dans le script, onglet Reglages, groupe Pool partage du groupe :
echo   colle l'adresse et la cle, clique Tester, puis coche Partager et recevoir les prix.
echo   Laisse cette fenetre ouverte ou reduis-la. Ctrl+C pour arreter le pool.
echo.
node "%HERE%server.js"
echo.
echo   Le pool s'est arrete.
pause
exit /b

:nonode
echo Node.js est introuvable. Installe Node 24 ou plus recent depuis https://nodejs.org, puis relance ce fichier.
pause
exit /b 1

:oldnode
echo Ce pool a besoin de Node 24 ou plus recent. Mets Node a jour depuis https://nodejs.org, puis relance ce fichier.
pause
exit /b 1
