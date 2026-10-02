# System Patterns & Architecture

## Process layout
- **Main process** (`main.js`): window lifecycle, security
  (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`), System Tray,
  notification bridge, all `ipcMain.handle` channels.
- **Preload** (`preload.js`): `contextBridge.exposeInMainWorld('electronAPI', ...)`
  — the ONLY bridge between renderer and main. Renderer calls
  `window.electronAPI.*` exclusively.
- **Renderer** (`src/renderer/`): vanilla JS views toggled via nav
  (`data-target` → `view-section` sections).
- **Startup path (2026-09-29, measured)**: the desktop shortcut `AutoDash.lnk` targets
  `launch-autodash.vbs`, which now launches `node_modules\electron\dist\electron.exe "<project folder>"`
  directly (the folder IS the app path, so the same `package.json`/`userData` are used). The old
  `cmd /c npm start` chain cost ~1.4 s of npm boot plus an extra node/cmd process and was kept only as a
  fallback. `main.js` takes the **single-instance lock at the very top** (before the heavy module graph), so
  a duplicate launch exits in milliseconds; the primary instance restores its window through the shared
  `restoreMainWindow()` (`second-instance`), with `pendingRestore` covering a click that lands mid-boot.
  `whenReady` is window-first: `Logger.init → createWindow → createTray → initSchedule`, then the
  prompt-folder setup and config migrations. Result: window open 16 027 ms (cold) / 6 011 ms (warm) → **3.5 s**.

## Main-process modules (`src/modules/`)
- **scheduler.js** — orchestrator. `executeWorkflow()` runs 3 phases:
  1. **frontend/** prompts (AI API, in order, `promptDelaySec` gap between prompts)
  2. **backend/** prompts (same)
  3. VS Code launched ONCE (`ClineAuto.launchVsCodeOnce`), remaining legacy
     extension prompts via `ClineAuto.sendPromptToCline(prompt, typingSpeedMs)`.
  Supports stop/pause/resume/forceRun; broadcasts `automation:status`
  `{state, step, total, message, phase, current, promptTotal, name}`.
- **apiManager.js** — multi-provider AI router (Gemini/Groq/Kimi/OpenRouter).
  Strategies: `priority` (default), `cost-optimized`, `latency-optimized`,
  `round-robin`; fallback chain + `maxRetries`. `generateStructureCode(prompt)`
  returns `{ text, provider }`. Injects `aiConfig.systemPrompt` + design style.
- **promptManager.js** — folder-based ordered prompt system:
  `prompts/frontend/` (Phase 1) + `prompts/backend/` (Phase 2); files executed in
  numeric order (`01_`, `02_`...); `_`-prefixed and empty files ignored; any
  language (UTF-8 → UTF-16 → latin1 read fallback, UTF-8 write); auto-numbering
  on save; crash-safe 2-phase reorder. Legacy `prompts.txt` (`===` delimiter)
  kept as fallback when both folders are empty.
- **fileManager.js** — output scaffold + timestamped backups
  (`backupBeforeOverwrite`), writes generated code into
  `fileConfig.outputDirectory` (default `~/Desktop/Dashboard`).
- **clineAutomation.js** — VS Code automation (`launchVsCodeOnce(workspacePath)`,
  `sendPromptToCline(promptText, typingSpeed, openShortcut)`) via nut-js +
  clipboard; `vscodeAutomation.backgroundMode` / `reuseWindow` config.
- **encryption.js** — AES-256-CTR + safeStorage, `getConfig(moduleName)` /
  `saveConfig(moduleName, data)`; UI uses read-merge-write to avoid clobbering.
- **logger.js** — electron-log; streams `log:new` to renderer terminal.
- **xampp.js** (2026-09-25) — XAMPP integration: `detectXampp` (D:\xamp → D:\XAMP → C:\xampp),
  `startApache` (spawns `apache/bin/httpd.exe`, cwd = XAMPP root, waits for :80), `startMysql`
  (`mysql/bin/mysqld --defaults-file=mysql\bin\my.ini --standalone`, waits for :3306),
  `parseDbIdentity` (schema.sql `CREATE DATABASE` → config.php `define()` → `autodash_dashboard`),
  `importSchema` (mysqldump backup → `runs/db-backups/`, CREATE DATABASE utf8mb4_general_ci, stream
  schema.sql into `mysql <db>`, count `information_schema.tables`), `deployProject`
  (`htdocs/autodash-dashboard` + timestamped backup), `verifyHealth` (axios GET health.php, `proxy:false`),
  `connect()` = services → deploy → import → health, `status()` for the Settings card.
  Flags: `fileConfig.xamppRoot| xamppAutoDeploy | xamppAutoStart | xamppImportSchema` (last three default true).

## Style system
- `prompts/styles/`: auto, glassmorphism, neumorphism, cyberpunk, minimal,
  material3, neubrutalism (`designStyle` in `aiConfig`; `auto` = AI chooses).
- `prompts/master-system-prompt.txt`: injected master prompt with mandatory
  design-quality rules and the multi-file marker format
  `--- FILE: path ---` / `--- END FILE ---` parsed by `_writeFilesFromResponse`.

## Config (`src/config/default-config.json`, electron-store overlay)
`scheduler`, `providers` (per-provider model/temperature/maxTokens/priority),
`routing`, `aiConfig`, `vscodeAutomation`, `fileConfig`
(`outputDirectory`, `promptDelaySec`, `promptsDirectory`), `appConfig`
(tray, silent notifications).

## IPC channels (main ↔ preload)
`config:get|save`, `automation:start|stop|pause|resume|force-run`,
`scheduler:reload`, `api:test`, `api:fetch-models`, `cline:test`,
`prompts:read|save|savePromptFile` (legacy),
`prompts:readFolders|saveOne|deleteOne|reorder|retryOne|detectLanguage|openInExplorer`,
`system:notify`, `system:openUrl` (shell.openExternal, http(s) only), `dialog:openFile|dialog:browse`,
`xampp:status`, `xampp:deploy` (validate → connect: services + deploy + import + live health);
streams: `log:new`, `automation:status` (+ `tray-notify` state bridge in main.js).
