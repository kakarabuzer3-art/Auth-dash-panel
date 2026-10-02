# Technology Context

## Stack
- **Runtime:** Node.js (CommonJS, `"type": "commonjs"`), Electron ^29.1.4 (devDependency)
- **Build:** electron-builder ^24.13.3 (NSIS target for Windows, icon from
  `src/renderer/assets/icons/icon.ico`, appId `com.autodash.controlpanel`)
- **Frontend (ACTIVE): React 19 + Vite 8 + Tailwind v4 utilities + Bootstrap 5.3 base CSS +
  framer-motion + lucide-react** — source in `ui/`, production build emitted to
  `src/renderer/react/` (`base: './'` so file:// works). `main.js` loads
  `src/renderer/react/index.html` when it exists.
- **Frontend (LEGACY fallback only):** vanilla HTML/CSS/JS
  (`src/renderer/index.html`, `src/renderer/css/styles.css`, `src/renderer/js/app.js`, xterm vendor
  bundle, FontAwesome webfonts). Loaded only when the React build is missing.

## Dependencies (from package.json)
| Package | Version | Used for |
|---|---|---|
| @google/genai | ^2.23.0 | Google Gemini API |
| @nut-tree-fork/nut-js | ^4.2.6 | Keyboard/mouse automation for VS Code (Cline) |
| axios | ^1.6.8 | HTTP calls to provider APIs |
| clipboardy | 2.3.0 | Clipboard-based prompt injection |
| electron-log | ^5.1.2 | Logging (main + renderer stream) |
| electron-store | ^8.2.0 | Persistent config storage |
| fs-extra | ^11.2.0 | File system helpers (ensureDir, move, outputFile) |
| node-notifier | ^10.0.1 | Windows toast/balloon notifications |
| node-schedule | ^2.1.1 | Daily cron scheduling |

## Encryption
- API keys encrypted with **AES-256-CTR** (`src/modules/encryption.js`) plus
  Electron **safeStorage**; stored via electron-store.
- Renderer never receives raw crypto; config access only via IPC
  (`config:get` / `config:save`).

## Local XAMPP facts (verified 2026-09-25 on this machine)
- XAMPP root: **`D:\xamp`** (`D:\XAMP` = same folder case-insensitively; `C:\xampp` only holds a stray
  `htdocs`). Apache `:80`, MySQL `:3306`, phpMyAdmin `http://localhost/phpmyadmin/`, DB user `root`
  with an **empty** password.
- Start scripts mirrored by `src/modules/xampp.js`: `apache_start.bat` → `apache\bin\httpd.exe` (cwd =
  XAMPP root); `mysql_start.bat` → `mysql\bin\mysqld --defaults-file=mysql\bin\my.ini --standalone`.
- Generated projects deploy to `htdocs\autodash-dashboard`; the generated `API_BASE` must therefore be
  `http://localhost/autodash-dashboard/backend/api.php`.
- `.sql` file association (fixed 2026-09-25): `HKCU\Software\Classes\.sql` (default) = `VSCode.sql`, so
  generated schemas show the VS Code SQL icon and open in VS Code; `main.js files:open` additionally falls
  back to `Code.exe` → `notepad.exe` when Windows has no handler.
- PowerShell `Invoke-WebRequest` to localhost times out on this machine (system proxy) — verify with
  `curl.exe --noproxy "*"`, and keep axios requests at `proxy: false`.

## Development Workflow (Windows / PowerShell)
- Run: `npm start` · Debug: `npm run dev` (inspect on 5858) · Build: `npm run build`
- **Desktop launcher (fast path)**: `launch-autodash.vbs` runs
  `node_modules\electron\dist\electron.exe "<project folder>"` — no `cmd`, no `npm`, no `cli.js` node
  process. Measured on this machine: `npm --version` ≈ 1.4 s, `.bin\electron.cmd --version` ≈ 0.7 s, so the
  old `cmd /c npm start` chain was the dominant startup cost. Use `npm start` only for development, or when
  `node_modules\electron\dist\electron.exe` is missing (the VBS falls back to npm automatically).
- **Boot timing how-to**: launch the app, then read the timestamps in
  `%APPDATA%\autodash-control-panel\logs\main.log` (`Logger initialized successfully.` →
  `Application window initialized and displayed.`). `Second launch request - existing window restored and
  focused.` proves the single-instance restore path fired.
- Syntax validation after every JS edit: `node --check <file>`
- JSON validation: `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`
- Line endings: repository is **CRLF** — keep new files CRLF.
- Encoding: all source files UTF-8; prompts support any language
  (UTF-8 → UTF-16 → latin1 read fallback in promptManager).
- No formal test framework; validation via `node --check`, temp test scripts in
  `%TEMP%`, and the temporary Electron UI harness `test-ui-harness.js`.

## Verification tooling (temp scripts in `%TEMP%`, never committed)
- `brace-scan.js <file>` - tokenizer-based bracket open->close map; the only
  reliable way to catch balanced-but-wrongly-nested code (`node --check` cannot).
- `autodash-probe.js` - loads the real `index.html` + `preload.js` + `app.js`
  with stubbed IPC; reports `rendererErrors[]` and init probes.
- `autodash-stream-probe.js` - emits synthetic `StreamBus` chunks and asserts the
  renderer log panel received them; also asserts the bridge snippet matches
  `main.js`.
- `autodash-chat-smoke.js` - calls `ApiManager.chatStream()` in-process with dummy
  keys (expects an HTTP/auth error, never "is not a function").
- `encoding-check.js <files...>` - UTF-8 vs CP1252-mojibake detection + CRLF/LF
  statistics (repository convention: pure CRLF).
- `node verify-all.js` - project self-check (HTML/CSS/JS wiring); exit 0 required.
- Electron stdout in this environment is not attached to the console: capture with
  `Start-Process -RedirectStandardOutput <file>` and read the file.
