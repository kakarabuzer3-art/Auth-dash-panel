## SESSION (2026-10-01, later) — MCP fulfilled: real tools server + auto-connect + model-driven tool calls

**User's ask (verbatim):** *"jo skills plugins i think MCPs ka option diya hea ossea fulfill karkea connection dea
do smart advnaced inteligent tareqea sea workabel banado"* — i.e. make the Skills & MCP option actually connected
and genuinely useful/intelligent, not a decorative panel.

**EVIDENCE (measured, not guessed)**
- Stored config probe: `mcpServers.servers = []` → **no server existed at all**, so MCP was permanently empty.
- Code reading: `mcpManager.js` header said servers start *only* on an explicit human click, so even after adding
  one it was disconnected again on every launch.
- `mcp-servers/example-tools-server.js` shipped only 3 toy tools (echo / system_time / seo_audit_checklist).
- Chat could use tools **only** via a hand-typed `/tool <name> {json}`; the model itself had no path to a real fact.
- `mcpToolsBlock()` listed tool names without argument names, so a model had to guess arg keys.
- `client.tools` dropped `inputSchema` at handshake time; `toolCatalog()` had nothing to expose.

**FIX 1 — a genuinely useful bundled server (NEW `mcp-servers/autodash-tools-server.js`)**
- Dependency-free stdio JSON-RPC (same wire format as the existing fixture), **10 real tools**:
  `workspace_list`, `workspace_read`, `workspace_search`, `port_status` (Apache/MySQL/any port),
  `http_status` (headers only), `system_info`, `system_time`, `json_validate`, `seo_audit_checklist`, `echo`.
- Workspace tools read `AUTODASH_OUTPUT_DIR` (injected at spawn) and are **confined** (rejects `..`/absolute),
  **read-only**, and capped (entries/bytes/lines) so one call cannot flood the model's context.
- MCP-correct error channel: a failing tool answers `isError:true` with a readable reason (so the model can
  correct itself) while an unknown tool name stays a JSON-RPC protocol error.

**FIX 2 — connection actually happens (`src/modules/mcpManager.js`)**
- `bundledServers()`, `autodashToolsServer()`; `ensureSeeded()` seeds the first-party server on first run and
  writes `seeded:true` — **deleting it stays deleted** (never resurrected).
- `autoConnect()` starts every enabled server at launch; global switch `mcpServers.autoConnect:false`, per-server
  `autoConnect:false`. Failures are logged and reported, never thrown.
- `callToolRunning()` — the model-side path — only touches **already-running** servers; a model can never spawn a
  local process. Honest reason fed back when no running server provides the tool.
- Spawn now injects `AUTODASH_OUTPUT_DIR` (from `fileConfig.outputDirectory`) + `AUTODASH_APP_ROOT`; user `env`
  still wins. `inputSchema` is retained at handshake and exposed through `toolCatalog()`.

**FIX 3 — intelligent, streaming-safe tool use (NEW `src/modules/chatToolLoop.js`, pure)**
- Parses the request forms: fenced ```` ```tool_call {json} ``` ```` plus an inline `TOOLCALL: {json}` fallback,
  with a brace-balanced extractor that survives braces inside string args; caps 3 calls/round, 3 rounds/turn.
- `createToolStreamGuard()` — probe/text/block state machine that **holds text back while a tool block is still
  possible**, so raw JSON never scrolls past the user and never lands in a saved conversation. Nothing is lost:
  an unterminated/invalid block is flushed back as plain text.
- `buildToolResultMessage()` / `summarizeToolRun()` for the real-output turn and the UI notice.

**FIX 4 — wiring (`main.js`, `preload.js`)**
- `chat:stream-route` body wrapped in `runChain()` + a **tool-round loop** (MAX_TOOL_ROUNDS). A tool request ends
  the round without forwarding `end`/`stats`, the tool runs for real, a `type:'tool'` event is emitted, and the
  model's follow-up streams into the **same bubble**. `messages` became `let` for this.
- Boot: after `initSchedule()`, a deferred 400 ms `ensureSeeded()` + `autoConnect()` (window paints first),
  then `mcp:status` is pushed to the renderer. New IPC `mcp:connectAll` + preload `connectAllMcpServers` and
  `onMcpStatus`.
- `skillRegistry.mcpToolsBlock()` now prints real argument names from `inputSchema` and appends
  `TOOL_PROTOCOL_PROMPT` (so the model knows the exact call format and that inventing output is forbidden).

**FIX 5 — UI (`ui/src/views/Skills.jsx`)**
- **Connect all** button, **Connect on launch** toggle (writes `mcpServers.autoConnect`), live status
  subscription via `onMcpStatus`, and honest security copy (auto-connect is real; a model can neither invent
  output nor start a server).

**PROOF — `node probe-mcp.js` = 32/32 PASS (exit 0)**
- Real spawn + `initialize`/`tools/list` handshake; **10 tools** cached with schemas.
- Real tool output verified: workspace list/read/search against a temp project; `port_status` detected a port
  this probe opened (OPEN) and a dead one (closed/ECONNREFUSED); `http_status` returned HTTP 200 from a local
  server the probe runs (no internet); `json_validate` both branches; workspace escape was refused.
- The **live chat system prompt** advertises the tools (`workspace_search`, `args:`) and the protocol block.
- Safety: unknown tool refused; a model request did **not** start a server with `autoConnect:false`;
  `autoConnect:false` skipped launch connections; `stopAll()` left 0 running.
- Guard/protocol branches: plain text byte-for-byte, a request never leaks, prose-before-request preserved.
- `node --check` 6/6 exit 0 (main, preload, mcpManager, chatToolLoop, skillRegistry, the new server).
  Vite build green: `index-DGxGXEpV.js` 536.78 kB, 2300 modules.

**Active deliverables resting here**
- New: `mcp-servers/autodash-tools-server.js`, `src/modules/chatToolLoop.js`, `probe-mcp.js`.
- Changed: `src/modules/mcpManager.js`, `src/modules/skillRegistry.js`, `src/config/default-config.json`,
  `main.js`, `preload.js`, `ui/src/views/Skills.jsx`.
- Kept: `mcp-servers/example-tools-server.js` (smoke-test fixture + template for user-written servers).
- Needs an **Electron restart** (main-process + preload changes); the UI bundle was rebuilt.

## SESSION (2026-10-01) — "sirf wahi karo jo task me likha hai": unrequested features ab banded

**User's complaint (verbatim ask):** backend prompts folder se delete kar diye, sirf
`prompts/frontend/1st prompt.txt` rakha — usme kahin bhi password/security ka zikr nahi — phir bhi Force Run par
Gemini ek **security lock / login** bana deta hai, aur **style/colors bhi delete** ho jate hain. Desired:
*"jo task diya jaye sirf usi par kaam kare, pichle wale ko mind me rakh ke nahi; agar software/website banana ho
to sirf banaye — ye na soche ke user ko kya chahiye."*

**EVIDENCE (root causes — all four forced extra work; none came from the user's prompt)**
1. `skills/web-security.json` + builtin had `enabledByDefault: true`, targets `[chat, automation]`, prompt =
   "SECURITY CONTRACT (your output is internet-facing by default)" mandating `password_hash()`, sessions, CSRF
   and *"rate limiting / lockout for login"*. Stored config probe showed `aiConfig.skills.enabled = {}` →
   nothing ever toggled → **this skill was injected into EVERY automation call**. That is where the login screen
   came from.
2. `fileManager.validateGeneratedProject()` hard-required `frontend/index.html`, `css/styles.css`, `js/app.js`,
   `backend/config.php|api.php|health.php|README.md`, `db/schema.sql` + PDO/MySQL checks. With backend prompts
   deleted, validation **failed 100% of the time**, firing the repair pass.
3. The repair pass asked for *"every required frontend/backend file … frontend calls the PHP API … valid MySQL
   schema"* → the model **invented a PHP/MySQL backend nobody asked for** and, by re-emitting whole files,
   **overwrote `frontend/css/styles.css` — the reported colour loss**.
4. `projectPromptContext` appended `===== COMPLETE ORDERED PROJECT PLAN =====` + *"Generate/update the complete
   project according to this plan; do not start a different project"* to EVERY prompt (single-prompt run sent
   its own text twice and was told to regenerate the WHOLE project each call). `loadMasterPrompt()`'s folder
   block still ships (file `prompts/master-system-prompt.txt` no longer exists) and said server code belongs in
   `backend/`, nudging a backend into existence. Also: `prompts/styles/` is empty and `designStyle` unset (`auto`).
**FIX 1 — machine-enforced TASK SCOPE (`src/modules/skillRegistry.js`)**
- New non-toggleable `SCOPE_DISCIPLINE_PROMPT` prepended FIRST in `composeSystemPrompt()` (chat + automation):
  one task only; login/password/"security lock"/DB/roles/admin/analytics are UNREQUESTED FEATURES; no assumed
  requirements; **NO CARRY-OVER** from earlier prompts/runs; preserve everything the task does not name (fixes
  colour loss); task outranks stack conventions; plan-only prompts emit no files; fewer correct files > extra features.
- ACTIVE SKILLS header now says skills govern HOW you work and *"never authorise ADDING features … the task wins"*.
- `web-security` builtin: `enabledByDefault: true → false`, description marks it **opt-in**, prompt starts with a
  conditional preamble (apply ONLY if the task really has accounts/auth/database). Identical content written to
  `skills/web-security.json` (CRLF, no BOM, matches `writeSkillFile()`), because a file OVERRIDES the builtin.
  Legacy installs with a stored toggle keep their choice (`resolveState`: state wins).

**FIX 2 — scope-aware validation (`src/modules/fileManager.js`)**
- NEW `validateGeneratedOutput(basePath)`: frontend-only runs get *"did the run write real non-empty files?"* —
  no stack named, so Next.js/Vue/plain HTML all pass. Ignores `node_modules/.git/.next/dist/build` and `*_backup_*`.
- `validateGeneratedProject(basePath, options)`: `options.backendRequested === false` routes to the new check.
  **Default unchanged** → manual `xampp:deploy` keeps the strict PHP/MySQL contract.

**FIX 3 — repair pass + XAMPP gated (`src/modules/scheduler.js`)**
- `const backendRequested = backendPrompts.length > 0` drives everything. Repair pass runs ONLY when a backend was
  requested (text adds *"do not add any feature/screen/field the plan does not name, do not re-emit a file you are
  not changing"*). Validation + terminal message branch on the flag.
- `Xampp.connect` gated with `fileConfig.xamppAutoDeploy !== false && backendRequested` — no Apache/MySQL deploy or
  schema import for a static/Next.js deliverable.
- `projectPromptContext` only built when `totalPrompts > 1`, reworded to `===== OTHER PROMPTS IN THIS PROJECT
  (background context ONLY - do not implement them now) =====` + *"Your one task is the instruction ABOVE this
  block"*; single-prompt runs log *"no project plan is attached"*.

**FIX 4 — folder block softened (`src/modules/apiManager.js loadMasterPrompt`)**
- `OUTPUT FOLDER STRUCTURE (MANDATORY)` / `EXACTLY these top-level folders` → `applies only to files you actually
  generate` / `contains these top-level folders`, plus *"ONLY create files and folders the task actually needs …
  never add an API, database, schema, config or admin file just to make the layout look complete."*

**PROOF — `node probe-scope.js` = 15/15 PASS, exit 0**
- Real composed automation prompt: TASK SCOPE is FIRST; active skills =
  `honesty-guard, seo-advanced, seo-content, code-quality, accessibility, performance, data-integrity`;
  **`web-security` absent**; `password_hash()` present nowhere; persona prompt still delivered.
- With `web-security` toggled on: injected, but carries the conditional preamble and still sits after TASK SCOPE.
- Validation: frontend-only project **passes** with `{backendRequested:false}`; same folder with NO option still
  fails with the identical missing list (`frontend/js/app.js, backend/config.php, … schema.sql`) → manual XAMPP
  contract untouched; zero-byte-only output and a missing folder still rejected.
- `node --check` exit 0 on skillRegistry/fileManager/scheduler/apiManager. One-off scripts
  (`probe-skill-state.js`, `migrate-web-security-skill.js`) removed; `probe-scope.js` kept as a regression probe
  per the `probe-diag.js` convention.

**NOT CHANGED (user-owned / out of scope)**
- `prompts/frontend/1st prompt.txt` — user said read it, do NOT change it. Read only.
- `prompts/master-system-prompt.txt` still absent (now harmless: the folder block is the only injected master
  content and it no longer pushes a backend).
- `prompts/styles/` left empty; `designStyle` left `auto`. No UI files touched → no rebuild; **Electron restart
  required** for main-process changes.

## SESSION (2026-09-29, evening) — Desktop shortcut 16s → 3.5s + 503 "high demand" ab ERROR nahi (hiccup)

**User complaints:** (1) Desktop ki AutoDash copy click karne par bahut waqt leti hai kholne me; (2) Force Run
me neeche logs me kaam chalta rehta hai par phir bhi "503 model high demand" ka ERROR aata hai.

**EVIDENCE (measured, not guessed)**
- Shortcut chain: `AutoDash.lnk -> launch-autodash.vbs -> cmd /c npm start -> node(cli.js) -> electron.exe`.
  Measured: `npm --version` alone = **1387 ms**; `electron --version` via the .bin shim = 710 ms. Window-open
  timings read from `%APPDATA%\autodash-control-panel\logs\main.log`: **OLD path 16027 ms (cold) / 6011 ms
  (warm)** vs **NEW path 3784 / 3792 / 3535 ms**. Second click while running: duplicate process lived only
  **1035 ms** and the running instance restored its window (`restoreLinesAdded=1`).
- 503: `runs/errors.json` was **EMPTY** — so it was never an Error Center entry. The red line is
  `apiManager.generateStructureCode` catch `log.error('API call failed — …503 high demand…')` printed BEFORE
  the existing model-rescue switched model and the run continued (scheduler health gate/runs were fine).

**FIX 1 — startup (main.js + launch-autodash.vbs)**
- `main.js`: single-instance lock + `app.on('second-instance', restoreMainWindow)` now run at the VERY TOP,
  before the heavy module graph (scheduler/apiManager → @google/genai, axios, electron-store, nut-js). A
  duplicate logs nothing, loads nothing, `app.quit(); process.exit(0)`. `pendingRestore` covers a click that
  lands during boot (honoured on ready-to-show). Shared `restoreMainWindow()` = restore if minimized + show if
  hidden + focus (+ one log line for evidence). Old `if (!gotLock) … else {…}` became a plain block (brace
  parity verified, 555/555) so the rest of the file keeps its shape.
- `main.js` WINDOW-FIRST BOOT: `createWindow()/createTray()/initSchedule()` now run immediately after
  `Logger.init()`; prompt-folder setup + Groq model migration (disk/encrypted-store work) moved AFTER them.
- `launch-autodash.vbs` rewritten: wscript → `node_modules\electron\dist\electron.exe "<project folder>"`
  (same app path/package.json/userData as `electron .`, zero npm). Falls back to `cmd /c npm start` if the
  binary is missing. Existing `AutoDash.lnk` needed no change (it targets the VBS).

**FIX 2 — 503 ab self-healing hiccup (apiManager.js)**
- NEW `isRecoverableFailure(kind, ctx)` (exported, pure): a failure is a HICCUP (log.warn) when another
  attempt/provider is left, or a Gemini model rescue / key rotation is both budgeted AND actually possible
  (`pickRestedModel(...)`, `getGeminiKeyPool(...).some(k => k !== entry.apiKey)`); otherwise it stays a RED
  `log.error`. Catch block now classifies ONCE (`kInfo`) and reuses it for rescue + key rotation.
- Terminal line: `API hiccup (temporarily overloaded) — … — router is auto-recovering.` (only when recoverable).
- NEW 503 MODEL MEMORY: `MODEL_OVERLOAD_TTL_MS` 10 min, `markModelOverloaded/isModelOverloaded/
  clearModelOverloaded/pickRestedModel` (session Map). A 503 marks the model; `generateStructureCode` starts
  the NEXT prompt on a rested curated model (log.info explains it); a success clears the memory.
- PROOF: `%TEMP%\ad-503-probe.js` = **SMART503-PROBE PASS (16/16)**; `%TEMP%\ad-503-int.js` (stubbed provider,
  no network, real router) = **SMART503-INTEGRATION PASS (10/10)**: 503 → warn `API hiccup (temporarily
  overloaded)`, **0 red errors**, run continued on `gemini-3.6-flash`, next prompt STARTED on the rested model,
  and a real dead end (groq) still logged exactly **1 red** `API call failed`. `node --check` main+apiManager
  exit 0; probe snapshot-restored `runs/usage.json`.
- NOTE: no UI files changed → no Vite rebuild needed. App left RUNNING with the new bundle/backend.

## SESSION (2026-09-29) — API Keys 401 "Expected OAuth 2 access token" ab SELF-RESOLVING (SMART AUTO-AUDIT)

**Complaint:** Gemini *Test Connection* -> red 401 UNAUTHENTICATED (ACCESS_TOKEN_TYPE_UNSUPPORTED). App
sirf suggestions deta tha ("clear the field and press Test again", "create a fresh key") — sab kuch user ko
khud karna parta tha, aur stored key ka pata chalta hi nahi tha.

**Reality (live probe se):** typed key (input field) aur STORED key alag hain; Google typed/dead key ko
reject karta hai (key-level, app theek hai). Stored primary `AQ.Ab8…n4NQ` = **VALID (61 models)**, extra
`AQ.Ab8…nKCw` = DEAD 401 (wahi jo pehle se registry me tha).

**Fix — `src/modules/apiManager.js` `testConnection()`:**
- Jab probe `invalid-key` (401/403) de, app **khud baaki SARE stored keys** (primary + extras, max 3,
  session dead-key registry wale skip) zero-quota `models.list` se re-check karta hai.
- Verdict me naye fields: `keyAudit:[{mask,role:'primary'|'extra',valid,status,models,message}]`,
  `savedKeyValid` (wo key jo field khali par test hoti — primary ya extras[0] — valid hai?), `savedKeyMask`.
- Suggestions ab AUTO-CHECKED outcome bolti hain: saved key valid -> "Use saved key"; koi extra valid ->
  router rotation note; SAB dead -> fresh-key instruction; network par "could not re-check" (galat "all dead"
  kabhi nahi). Purana "Heads up: TYPED vs STORED" hint hata diya (audit supersede karta hai).
- `markKeyDead` 401 par pehle se + registry-skip ensures re-probe kabhi 401 keys par nahi jalta.

**Fix — `ui/src/views/ApiKeys.jsx`:**
- `test(p, forceKey)`: `''` = input field ko ignore karke stored key test (Use saved key button).
  Fallback ab primary + extras[0] (Check Status ke saath consistent tha, pehle sirf primary).
- Failed box: **"Saved-key auto-check · zero quota"** list (har key ✓/✗ + mask + role + models).
- Colors: `salvage` (`keyValid || savedKeyValid`) -> AMBER not red; header "TYPED KEY REJECTED — your SAVED
  key passed the zero-quota auto-check".
- One-click resolutions: **Use saved key** (clear field + re-test), **Open AI Studio — create a new key**
  (`api.openUrl` -> aistudio.google.com/api-keys; jab `code==='INVALID_KEY' && !savedKeyValid`), **Remove N
  dead extra key(s)** (sirf textarea cleanup — Save ab bhi chahiye, wipe kabhi silent nahi).

**Proof:** `%TEMP%\ad-audit-probe.js` (Electron + real encrypted store, fake `AQ.ZZZ…` key, ZERO generation
quota) => `INVALID_KEY`, keyAudit = primary VALID/61 models + extra 401, `savedKeyValid:true`, 1772ms,
**AUDIT-PROBE PASS**; `node --check` apiManager+main.js exit 0; `cd ui; npm run build` green ->
`src/renderer/react/assets/index--j7Wq9l_.js` (bundle me naye strings confirmed). USER ko app FULLY
restart karna hoga taake purane running bundle ki jagah naya load ho.

## SESSION (2026-09-25, later) — Force Run ab XAMPP se CONNECTED khatam hota hai (user ka #1 complaint)

### Asli evidence (logs se, andaze se nahi)
- `Desktop\Dashboard` me sirf KHAALI `frontend/` + `backend/` folders the: 19:22 ka Force Run frontend prompt 1/4 par fail
  hua (Gemini **503 "high demand"** -> streaming empty -> non-streaming fallback) aur app mid-run band kar di gayi; groq
  key **401** de rahi thi is liye sirf 1/2 providers healthy the. Koi history entry nahi, koi XAMPP deploy nahi,
  `htdocs\autodash-dashboard` kabhi bana hi nahi.
- Windows par `.sql` ka koi handler hi nahi tha (HKCU UserChoice khaali, `HKCR\.sql` default khaali) -> generated
  `schema.sql` par generic icon aur "Open with" me kuch nahi.

### Fixes
1. **`.sql` file association** (system-level, reversible): `HKCU\Software\Classes\.sql` (default) = `VSCode.sql`
   (VS Code ka apna SQL icon + command) + `ie4uinit.exe -Show`. Verified: `HKCR\.sql -> VSCode.sql`, icon `sql.ico` exists.
2. `main.js` `files:open`: `shell.openPath` error dene par ab VS Code `Code.exe` phir `notepad.exe` fallback, aur
   `{openedWith, note}` return karta hai (fail hone ke bajaye).
3. **NAYA `src/modules/xampp.js`**: `detectXampp` (D:\xamp -> D:\XAMP -> C:\xampp; apache/bin/httpd.exe + mysql/bin/mysqld.exe
   + htdocs chahiye), `startApache` (httpd.exe spawn, cwd = XAMPP root — `apache_start.bat` ki exact copy, :80 ka wait),
   `startMysql` (`mysqld --defaults-file=mysql\bin\my.ini --standalone` — `mysql_start.bat` ki copy, :3306 ka wait),
   `parseDbIdentity` (schema.sql ka `CREATE DATABASE` -> config.php `define()` -> default `autodash_dashboard` + DB_USER/PASSWORD),
   `importSchema` (pehle `mysqldump` backup `runs/db-backups/`, phir `CREATE DATABASE IF NOT EXISTS` utf8mb4_general_ci,
   phir schema.sql ko stdin se `mysql <db>` me stream, aakhir me `information_schema.tables` ka count), `deployProject`
   (`htdocs\autodash-dashboard`, purana wala timestamped backup), `verifyHealth` (axios GET health.php, `proxy:false`,
   JSON ok:true), `connect()` = services -> deploy -> import -> health, aur `status()` (Settings card ke liye).
4. `scheduler.js`: scaffold se PEHLE **HEALTH GATE** (0 healthy provider -> fail fast, khaali Desktop folder dobara nahi banega);
   Step-5 ka deploy ab `Xampp.connect()`; connect fail hone par run **failed** mark hota hai failed step ki asli wajah ke sath
   (jhooti "completed" nahi).
5. **IPC** `xampp:status` / `xampp:deploy` (+ preload `getXamppStatus`/`deployToXampp`) aur `system:openUrl`
   (`shell.openExternal`, sirf http(s)). Settings view me naya **"XAMPP & Database"** card: status chips
   (XAMPP path / Apache :80 / MySQL :3306 / deployed), Dashboard + phpMyAdmin "open" buttons, Refresh,
   "Deploy & Connect now", aur per-step result list.
6. `fileConfig` defaults: `xamppRoot` "", `xamppAutoDeploy`/`xamppAutoStart`/`xamppImportSchema` = **true**.
7. `apiManager.loadMasterPrompt()`: ab `prompts/` ko **module-relative pehle**, cwd baad me resolve karta hai (shortcut se
   different working directory par master prompt chup-chaap gayab ho jata tha).

### Prompts poori tarah dobara likhi (research-backed, architecture-first)
- `prompts/master-system-prompt.txt` ab ek **PROJECT BLUEPRINT** hai: stack, exact file list, EK canonical API contract
  (API_BASE `http://localhost/autodash-dashboard/backend/api.php`, 12 actions login/session/logout/changePassword/stats/
  list/create/update/delete/search/getSettings/saveSettings, `{success,data|error:{code,message}}` envelope, 401
  `unauthenticated`, CORS + OPTIONS, health.php contract), mandatory DB schema (9 tables incl. `sale_items`, `password_resets`),
  seed-data volume, `window.API` client spec, aur 8 generation rules.
- `frontend/01-04` (foundation + API client / auth lock / settings gear + 6 psychology themes + rebranding + asli password
  change / asli sections + notifications + live search + header clock + status pill) aur `backend/01-02` (PHP PDO API +
  health + README + seed wala schema / normalization + indexes + cross-file integration repair) ko narrow ordered steps
  bana diya jo blueprint contract reuse karte hain. Woh ghalat-maloom lines ("you are seniour: deeclaw + AI code + code
  interpreter") hata di gayin jo model ko confuse karti thin. Purane prompts ka "alag alag contract" (Node/Postgres) khatam.

### Verification (sab real, probes delete kar diye)
- **Probe 1**: prompts sahi order me load (4 frontend / 2 backend; sizes 3451/3246/3433/3683 + 6324/3865; master 6751 chars);
  `detectXampp` -> `D:\xamp`; `startApache` + `startMysql` **dono start ho kar :80/:3306 open**; `parseDbIdentity` ne
  synthetic schema parse kiya; `importSchema` ne throwaway DB me 1 table import kiya (baad me drop).
- **Probe 2 (end-to-end)**: synthetic contract-valid project -> `validateGeneratedProject` sab green -> `Xampp.connect()`
  ne `ok:true` diya, steps detect/apache/mysql/deploy/database/health sab OK aur `health.php` ->
  `{"ok":true,...,"message":"Database connection OK"}` HTTP 200. Cleanup ne demo htdocs se hataya aur probe DB drop ki.
- `node --check` **13/13** JS OK; Vite build green (2299 modules, `index-B8rtvfxR.js` 499.93 kB) — pehle ek JSX closing-tag
  ghalti fix karni pari (naya Settings card Terminal card ka `</motion.div>` nigal gaya tha); Electron boot clean (koi stderr
  nahi, React UI loaded).
- **Apache + MySQL jaan-boojh kar RUNNING chhore** (:80/:3306 listening, phpMyAdmin HTTP 200 `curl --noproxy '*'` ke sath).
  NOTE: is machine par PowerShell `Invoke-WebRequest` localhost par timeout karta hai (system proxy) — hamesha
  `curl --noproxy` ya axios `proxy:false` use karein.
- `runs/db-backups/` folder naya safety location hai (schema import se pehle purani DB ka dump).

### Baaqi limits / agla step
- Generated project ab tak dobara generate nahi hua: **agla Force Run hi asli test hai** (Gemini 503/model rotation ka masla
  ab bhi apply hota hai). Agar Gemini ka `health.php` ya `schema.sql` kharab bana, run ab loudly fail karega (exact failed
  step ke sath) bajaye jhooti kamyabi ke.

## SESSION (2026-09-25) — coherent XAMPP dashboard generation contract
- User's core requirement: all ordered prompts must be read as one plan; Force Run must generate a polished frontend + PHP/MySQL backend + backend/db/schema.sql, and it must work through XAMPP localhost/phpMyAdmin rather than disconnected placeholders.
- Rewrote master prompt, backend database prompts, and frontend foundation/security prompts to remove contradictory Node/PostgreSQL/MongoDB/SQLite requirements; strict two-folder output, PHP PDO/MySQL, health.php, XAMPP API wiring, complete files only.
- Scheduler now sends every individual prompt with the complete ordered frontend+backend plan (`projectPromptContext`) and runs a bounded final repair pass if integration files/checks are missing.
- `fileManager.js`: parse END FILE markers, normalize legacy root/database/assets paths, reject traversal/root files, validate required frontend/backend/SQL contract, and safely mirror validated output to detected XAMPP htdocs with timestamped backup. SQL import/destructive execution is intentionally not automatic; generated backend README carries deployment/import steps.
- Added safe explicit `files:open` IPC and Prompts UI “Open with default app” action for generated files. `.sql` is never executed by the app.
- Validation: synthetic XAMPP project validator passed all checks; syntax checks passed; Vite build passed (2299 modules, `src/renderer/react/assets/index-C44QZg32.js`, 494.62 KB); Electron boot passed with clean stderr and React window displayed. Master prompt BOM was removed.
- XAMPP discovered at D:\\xamp (also D:\\XAMP case variant); Apache/MySQL were not running during the check, so user must start Apache + MySQL in XAMPP Control Panel before browsing the deployed URL.
- User requested Google AI Studio credit/token balances for both Gemini keys, exact Force Run/chat consumption, and 110% real reporting.
- Implemented honest provider-metadata ledger: `recordKeyUsage()` stores masked key label, input/output/total token counts, calls, failures, model, source, and timestamp; raw keys are never persisted in the ledger.
- Force Run Gemini streaming, Interactions API, and generateContent paths capture SDK usage metadata. AI Chat captures streaming `usageMetadata`; usage entries now retain exact metadata and key label.
- `costs:get` returns configured masked Gemini keys, per-key usage, combined exact Gemini usage, and legacy totals. Dashboard now has a per-key “Gemini token ledger” card with combined exact usage.
- Google Gemini API key endpoints do not expose a reliable account “remaining credits” balance; Google AI Studio billing/quota UI remains authoritative. No 110% multiplier or fabricated credits were added; missing metadata remains 0/awaiting metadata.
- Verification: `node --check` apiManager/main/preload/scheduler passed; Vite build passed (2299 modules, `src/renderer/react/assets/index-CL_O6msp.js`, 494 KB).
- User requested Force Run to execute only the first prompt, then ask Yes/No before every next frontend/backend prompt; No must stop safely without deleting generated files.
- Implemented `src/modules/scheduler.js` `awaiting-approval` state with a single in-flight `pendingApproval` Promise, approval IDs, and safe Stop/Decline waiter resolution. Approval is separate from generic pause/resume so Resume cannot bypass a decision.
- Added IPC: `automation:approve-next`, `automation:decline-next`, `automation:pending-approval` in `main.js` and `preload.js`.
- Dashboard now shows a permission card with next phase/name and `Yes, continue` / `No, stop`; renderer reload/view switch can recover pending approval via IPC. Stale/double-click IDs are rejected.
- Frontend phase asks before every subsequent frontend prompt; explicit frontend→backend boundary asks before backend prompt 1; backend phase asks before every subsequent backend prompt. Existing code interpreter remains user-triggered and sandboxed (`code:run`, 8s/20KB/output caps); automation never executes generated files automatically.
- Verification: `node --check` scheduler/main/preload/apiManager passed; IPC marker check passed; Vite build passed, 2299 modules, `src/renderer/react/assets/index-BVgHtROG.js` (492 KB).
- User Force Run log: Gemini `gemini-3.6-flash` returned 503 high demand; Groq then returned 401; old automation classified 503 correctly but only switched Gemini models for `quota-exhausted`, so it could exhaust the same unavailable model and abort the dashboard.
- Fixed `src/modules/apiManager.js`: provider attempts are clamped to 2–4 (default 3); 503 `overloaded` is non-retry-wasted at `_withRetry` and triggers model fallback; quota/overloaded/bad-model can rotate up to 3 Gemini models; 401/429/rate-limit/overloaded can rotate Gemini keys, but never immediately after a model rescue; key rotations remain bounded at 4. Terminal logs now say temporarily overloaded.
- Verified: 503 classifier returns `overloaded`; 401 invalid-key, 429 quota-exhausted, 503 overloaded, 404 bad-model; `node --check` apiManager/scheduler/main passed; Vite production build passed (2299 modules, `src/renderer/react/assets/index-B32cLudU.js`, 490 KB).
- User should fully restart Electron before Force Run. A 401 Groq key cannot be repaired by retries; replace it in API Keys. Gemini 503 may succeed on the next model, but a genuine all-key/all-model outage still reports failure rather than inventing dashboard files.
- User still saw `Request failed - No messages to send.` because source was fixed but the running Electron/window may have been an older build/process.
- `src/modules/chatPayload.js` normalizer is dependency-free and verified: prompt-only first message becomes a real user turn; history + prompt appends without duplication; blank/garbage messages are dropped; attachments become user context.
- `ui/src/views/AiChat.jsx` now sends the current turn in both `prompt` and the final `messages` entry, preserving prior history.
- `main.js chat:stream-route` uses the normalizer before validating and routes the canonical messages.
- Real Electron live probe with decrypted config: 2 Gemini keys, configured `gemini-3.6-flash`; invalid extra key (401) was skipped and valid automation key returned exactly `CHAT_OK`.
- Production React build completed: Vite transformed 2299 modules, output `src/renderer/react/assets/index-B32cLudU.js` (490 KB).
- Electron clean start smoke passed (no boot stderr), `node --check` passed for main/chatPayload, and `test-chat-payload.js` passed all 10 checks.
- User action: fully close all AutoDash/Electron windows and start again with `npm start`; do not use an old installed shortcut/window while testing.

## SESSION (2026-09-24, latest) — chat-dead fix VERIFIED + code interpreter & web search restored
**Live-probed root cause (real keys, real API):** default model `gemini-3.8-flash`
returns 503 "high demand" (Google load-shedding); `gemini-2.5-flash(-lite)` are
RETIRED upstream (404); `gemini-3-flash` never existed. `gemini-3.6-flash` = 200 OK.
**Fixes shipped:** (1) apiManager `classifyProviderError` gained `overloaded` kind
(503/"high demand|overloaded|unavailable|capacity") so 503 rotates instead of
aborting chat as `unknown`; (2) `GEMINI_QUOTA_FALLBACKS` + `MODEL_ENUMS.gemini`
cleaned of retired ids (now 3.6-flash, 3.5-flash-lite, 3.1-flash-lite, 3.8-flash,
flash-lite-latest, 3.5-flash, flash-latest); (3) main.js chat route `bad-model`
now `break`s the key loop (404 fails for every key — skip to next model);
(4) encryption.js legacy-model migration map → verified ids;
(5) default-config.json gemini model → `gemini-3.6-flash`;
(6) AiChat MODELS dropdown = working ids only.
**Two-key routing (user's setup) CONFIRMED in code, no change needed:**
pool[0] = AUTOMATION key (apiManager.getNextGeminiKey starts there), LAST pool key
= dedicated CHAT key (main.js chat route walks pool reversed); both auto-borrow
across the pool on 429/401; `lastGoodChatKey` resumes next message on the winner.
So: paste automation key first, chat key second in API Keys.
**Code interpreter + web search RESTORED to React AiChat.jsx** (were dropped in
rewrite; backend `code:run`/`web:search` IPC + preload `runCode`/`webSearch` were
already live): `MessageBody` carves ``` fenced blocks into `CodeBlock` widgets —
js/javascript/node blocks get a Run button (node -e, 8s cap, output inline);
renderer-side `DANGEROUS_CODE` regex (require/import/process/eval/Function/
while(true)) marks blocks "sandbox-blocked" before IPC. Web chip in toolbar:
DuckDuckGo top-5 injected as `web-search-results.txt` attachment; user msg gets
🌐 footer flag; search failure never blocks chat.
**Gates:** `vite build` exit0 (bundle index-B4xR_8HQ.js, 2299 modules);
test-react-harness re-run → `{}` = ZERO console errors across all 9 views,
no black screens. Temp files deleted (test-react-harness.js, test-ui-harness.js,
test-live-api.js, verify-all.js, verify-state.js, ui-harness-result.txt).
NOT done: live 3-message end-to-end probe (electron probes kept dying; real-key
200 on gemini-3.6-flash already verified) — user smoke-test pending (`npm start`,
send 2-3 messages, click Run on a code block, toggle Web).
GOTCHA (recurring): editor tool rejects `old_text:null` on existing files —
always pass the real old text.

## SESSION (2026-09-24, later) — 3 user-reported bugs FIXED (offline / chat errors / feed loss)
**Issue 1 — "Dashboard shows Offline while online":** `system:checkOnline` used a
single google HEAD. Now races 3 probes (`Promise.any`: google HEAD, cloudflare
HEAD, gstatic generate_204) + DNS-lookup fallback (3s cap); returns `probe`
field; Topbar tooltip shows which probe answered (`netInfo.probe` in AppContext).
**Issue 2 — "2 errors then the answer" + shared Gemini key pool:**
`chat:stream-route` (main.js ~L555-655): keys deduped via `[...new Set()]`;
emit wrapper suppresses intermediate `error` chunks + empty `end` chunks from
failed tries; per-try `recordError` replaced by ONE `recordError(lastError,
{provider: lastProvider, label:'Live AI Chat (auto-route)'})` at chain
exhaustion (both failure returns). KEY DEDICATION: apiManager
`getGeminiKeyPool()` (deduped pool, pool[0]=AUTOMATION key) +
`getNextGeminiKey(conf, afterKey)` (deterministic next-after, unknown → pool[0]);
chat walks pool REVERSED (last key = dedicated CHAT key tried first); both sides
auto-borrow across the pool on 429/401. Both exported. Old `geminiKeyIndex`
global removed. AiChat.jsx: route-warning toast + switched-toast REMOVED
(in-bubble `↪ auto-switched` marker + routeNote already inform).
**Issue 3 — feed lost on view switch:** preload `on*` helpers now return
per-handler unsubscribe (`ipcRenderer.removeListener`); EVERY component cleanup
converted (AppContext automation:status, Logs log:new/api:stream/errors:new,
AiChat chat:stream) — `removeAllListeners` was killing the shared listeners.
Feed buffer LIFTED to AppContext (`feed`/`setFeed`, FEED_CAP=80, single global
subscription: log:new + api:stream collapsed per provider/model + errors:new);
Dashboard renders context feed (no local state/subscription); Logs seeds its
terminal from the feed once (`seededRef`).
Gates: `node --check` ×3 exit0, `vite build` exit0 (bundle index-DLcANVF8.js),
key-pool logic smoke-tested in node. GOTCHA: editor tool rejects `old_text:null`
on existing files — always pass the real old text or use insert_line.

## SESSION (2026-09-24) — UI polish batch + psychology-based Dashboard shipped
Spam fix (`humanMessage` in apiManager/errorStore + Logs/Dashboard-feed `×N`
collapse), real WiFi state (`system:checkOnline` → adapters/providers →
Topbar chip + `netInfo` in AppContext), run-history IPC
(`runs:history`/`getRunHistory`), and full `Dashboard.jsx` rewrite: 6 CountUp
KPIs (real Success Rate / Total Runs / Files from `runs/history.json`), Recent
Runs list, System Status card (NIC adapters + provider chips + latency),
offline banner, Fitts/Von-Restorff/goal-gradient/stagger psychology. Built by
writing 9 `_dash_pN.jsx` part files then UTF-8 concat (workaround for the
6000-char editor input cap — parts deleted after). Gates all green:
`node --check` ×5, `vite build` exit0, bundle-content grep verified.
Key learning: `ui/src/lib/api.js` exports `window.electronAPI` directly, so
new preload methods are available on `api.*` with no wrapper (browser stub
Proxy covers them too).

## SESSION (2026-09-23, evening) — engine LIVE-PROVEN ×3 + Error Center dedupe + user's XAMPP adopted
**Engine verification (Force Runs, real keys):** run1 failed ONLY on network drop
(`ENOTFOUND api.groq.com`, `curl_exit=6`) → `runFailed` now records
`status:"failed"` in history correctly. Runs 2/3/4 all
`Workflow complete: 5 frontend + 4 backend` (9/9 prompts, 40-42 files each),
history `completed ×3`. Run 5 auto-launched via `AD_FORCE_RUN=1` startup hook
(main.js:261) after relaunching with the dedupe fix → **failed CLEANLY at
17:02:17 after 11.9 min** (hist=6, `status:"failed"`, partial files kept):
lite streaming stalled ~5 min (streaming path had NO abortSignal) → `fetch
failed` → transient network drop (`ENOTFOUND api.groq.com` + Google fetch
failed; DNS/https recovered within minutes — probe: googleapis 403-keyless
alive, groq 401 alive) → `All AI providers failed`; dedupe bumped again live
(`duplicate ERR_ALL_PROVIDERS_FAILED (now x2)`), errors stayed 3 rows. NO run6:
gemini free-tier 20/day spent + stored groq key dead (401).
**apiManager rescue order (live-verified):** quota → **model-switch FIRST**,
key rotation ONLY if all fallback models spent or key dead (401/rate-limit)
(~lines 728-775); 429-spent `gemini-3.8-flash` rescued by lite/flash on same key.
**Error Center dedupe:** `errorStore.save()` now matches identical UNRESOLVED
entries by signature (code+provider+model+context+message head120) → bumps
timestamp + `count` instead of appending, returns `{entry, deduped}`;
`recordError` (main.js:285) skips the `errors:new` push/toast on dedupe (log
line `duplicate <code> (now xN) — bumped existing entry.`). LIVE-VERIFIED at run5
health check: `duplicate 429 (now x2)` + `duplicate 401 (now x2)`, file stayed
at 3 rows. Old duplicates consolidated 8→3 unique (groq-401, gemini-429,
workflow-fail). Probe: backup → save×2 → restore = PROBE_PASS (same id, count=2).
**Streaming timeout guard (new fix from run5):** `_callGemini` streaming path
(apiManager.js ~809) had NO abortSignal → hung socket stalled the workflow
~5 min live (16:55:37 request → `fetch failed` only 17:00:38). Now an
AbortController enforces 60s idle (re-armed on every incoming chunk) + 240s
absolute cap; abort lands in the existing non-streaming fallback. Also fixed:
terminal-error-with-partial branch now actually `return collected` (log said
"returning what arrived" but fell through → burned quota). `node --check` exit0;
takes effect next app start (running process unaffected).
**XAMPP:** user installed it themselves at **D:\xamp** (NOT C:\xampp); Apache
(httpd×2) + MySQL (mysqld) running, port 80/3306 listening, phpMyAdmin HTTP **200**
(`/phpmyadmin/` on 127.0.0.1 and localhost; first `000` probe was curl proxy —
always use `--noproxy '*'`). My failed-download residue deleted (`%TEMP%`:
xampp-setup.exe, xampp-try.bin, ad-chrome-dl, ad-edge-dl); user's Desktop +
Downloads untouched (left a random `450w-7EC7R09b5Tw.mp4` in Downloads — not
XAMPP-named, did not delete). DO NOT retry XAMPP downloads: `download.apachefriends.org`
DNS-fails via every resolver (kills winget/choco), SourceForge serves a
Cloudflare JS challenge to curl, real filename is `xampp-windows-x64-8.2.12-0-VS16-installer.exe`.
**Tool gotchas re-confirmed:** tool calls hard-cap ≈30s (keep `Start-Sleep` ≤25s);
only the `commands` array executes — extra params (`commands2`/`commands3`) are
silently ignored (a run-3 launch was lost to this).

## SESSION (2026-09-23) — "key disappeared" + 429 + voice: ROOT-CAUSED & FIXED
**User complaints:** (1) new Gemini key always fails Test Connection with 429 quota,
(2) saved keys "disappear" after switching sections, (3) mic in AI Chat does nothing,
(4) light/dark theme does not apply, (5) desktop shortcut icon still old.

**Evidence gathered (real probes, not guesses)**
- `%TEMP%\ad-enc-probe.js` (Electron, real store): safeStorage AVAILABLE, `getConfig` OK,
  round-trip PASS -> **no data loss**; live keys found: gemini `AQ.Ab8…n4NQ` (+1 extra key),
  groq `gsk_Ht…auQc`, kimi/openrouter empty.
- `%TEMP%\ad-api-probe.js` (0 generation quota): **Gemini key VALID (HTTP 200, 59 models)**;
  **Groq key INVALID (HTTP 401)** -> that is why the fallback chain never worked.
- Log forensics: the two "Decryption failed for providers" entries came from *Node test
  scripts* (`%TEMP%\groq-key-check.js`, `node -e`), never from the app process.
- `%TEMP%\ad-live-test.js`: Test Connection -> `code=QUOTA_EXHAUSTED keyValid=true`
  (429, retryDelay 45s); chat `gemini-3.8-flash` -> 429, **fallback `gemini-3.5-flash-lite`
  -> "pong" OK**; `transcribeAudio` -> success via `Gemini audio`; classifier: 429+QuotaFailure
  -> quota-exhausted (quotaValue 20), 401 -> invalid-key, 404 -> bad-model, ETIMEDOUT -> network.
- `%TEMP%\ad-theme-test.js`: caught a REAL bug - light mode set `--color-bg:#f3f4fb` but
  `bodyBg` stayed `rgb(10,10,16)` because AppContext wrote an **inline hex background**
  that shadowed the tokens. Fixed -> LIGHT `rgb(243,244,251)`, DARK `rgb(10,10,16)`.
- `%TEMP%\ad-views-smoke.js`: all 9 views render, 0 real console errors (only api-stub
  warnings that do not exist inside Electron).

**Conclusions:** the "new" Gemini key is fine - Google free-tier quota is metered
**per project + per model (20/day)** and a new key in the SAME project shares it. The
"disappearing key" was a UX illusion (the input is cleared after save on purpose) plus the
old Test Connection burning up to 3 requests per click and retrying 429s x4.

**Fixes shipped (files)**
- `src/modules/apiManager.js`: `parseProviderError` / `classifyProviderError` /
  `httpStatusOf` (diagnosis + suggestions); `_withRetry` refuses to retry
  invalid-key/quota/bad-model; `probeKey()` (models.list only = ZERO quota);
  `testConnection()` = probe + exactly ONE request (`_callProviderOne`/`probeOnly`);
  `getGeminiModelFallbacks()` (curated list ∩ live models.list, per-model quota escape);
  `transcribeAudio()` (Groq Whisper multipart -> Gemini inline audio w/ lite-model
  fallback); exports `classifyProviderError` + `parseProviderError`.
- `main.js`: `api:probe-key`, structured `api:test`, `config:health`, `chat:stream-route`
  (walks providers, rotates KEY + MODEL on quota, `{type:'route'}` notices, partial-answer
  guard, 6-attempt cap), `ai:transcribe`, media permission handlers (mic).
- `preload.js`: `chatStreamRoute`, `transcribeAudio`, `probeKey`, `configHealth`.
- `src/modules/encryption.js`: multi-candidate key resolution (`env` -> `os` -> `placeholder`,
  self-healing read), `activeSource` preference for writes, no stale cached key,
  **save guard**: unreadable existing entries are backed up to `__backup.<module>.<ts>`
  and marked write-protected instead of being silently destroyed, `configHealth()`.
- `ui/src/views/ApiKeys.jsx`: masked **Stored key** line + reveal, post-save
  **re-read verification** toast, rich Test result (keyValid vs quota + suggestions),
  **Check Status** button (0 quota), encrypted-store banner.
- `ui/src/views/AiChat.jsx`: send via `chatStreamRoute` (auto failover + toast + bubble
  caption), `route`/repeated-`start` handling, **real mic** (MediaRecorder -> WAV re-encode
  -> `transcribeAudio`), legacy SpeechRecognition kept as documented dead code.
- `ui/src/store/AppContext.jsx` + `ui/src/index.css`: token-only theming, `data-bs-theme`,
  `html{background:var(--color-bg)}`, light `.glass` override.
- `main.js` + shortcut: new icon path `src/renderer/assets/icons/icon-v2.ico` (valid ICO,
  5 sizes) because Windows caches icons per path; `AutoDash.lnk` IconLocation updated +
  `ie4uinit -show`.

**Known limitations (honest)**
- Voice via Groq Whisper needs a VALID Groq key; the stored one is 401 -> voice currently
  runs on Gemini audio. Groq was cloudflare-blocked in earlier sessions too.
- Quota errors still mean the user must switch model / use a new Google project - nothing
  in the app can reset Google's per-project daily bucket.
- `_callProviderOne` (main.js) is `_callProviderOnce` in apiManager; keep the names in sync.

## REACT UI MIGRATION (major work - 2026-09-22)
- Renderer rebuilt in React 19 + Vite + Tailwind v4 + Bootstrap 5 + Framer Motion + lucide-react.
- Source: `ui/` (npm run build -> `src/renderer/react/`). Legacy UI untouched at `src/renderer/index.html`.
- **main.js:59-68 now loads React UI first, legacy as fallback** (`fs` import added at top).
- All 9 views ported: Dashboard/Scheduler/ApiKeys/AiSettings/AiChat/Prompts/VsCode/Logs/Settings (agents ported 5; Prompts+VsCode+Logs hand-written after agent 429 quota failures; files were corrupted by truncated inserts and rebuilt clean).
- Design: dark-first, token CSS vars in `ui/src/index.css` (--color-*), single indigo accent, psychology features (count-up numbers, goal-gradient progress, skeleton loaders, live activity feed, toasts).
- IPC contract unchanged (preload.js) — React calls window.electronAPI via ui/src/lib/api.js wrapper.
- Build verified: `ui/npm run build` exit 0 (458KB js / 137KB gzip); `node --check main.js` OK.
- Backup of pre-React state: `Desktop/autodash-control-panel_BACKUP_pre-react/`.
## SESSION UPDATE (2026-09-22 ~23:00)
- **Root cause of "old dashboard" confusion:** single-instance lock focused the pre-edit running instance. Fix: kill electron procs + restart. Confirmed in log: `Renderer: React UI loaded`.
- **Desktop cleanup (user-requested):** deleted `autodash-BACKUP-logs-*`, `autodash-BACKUP-p12-*`, `autodash-control-panel_BACKUP_pre-react`, `Dashboard_backup_*`. Remaining: only `autodash-control-panel` (original app) + `Dashboard` (generated output). NO project backups remain on Desktop — main.js is the only rollback anchor now.
- **New app icon:** generated programmatically (`%TEMP%\make-icon.js`, pure Node PNG encoder + ICO wrapper, no deps): rounded-square indigo→violet gradient + white bolt + drop shadow, 5 sizes (256/64/48/32/16), 18KB. Written to `src/renderer/assets/icons/icon.ico` + copied to `build/icon.ico`. BrowserWindow got `icon:` at main.js:50.
- **AiChat agentic features — NOW LIVE (see the 2026-09-23 session above):** rotating deep-thinking stages w/ animated icon (Analyzing→Reasoning→Connecting→Generating→Final touch), agentic tool chips (Web Search / Files / Code Interpreter / Voice) wired to real IPC, attachments decoded into the prompt, and mic = MediaRecorder + server-side transcription (Web Speech API is unavailable in Electron).
- **Shipped after approval:** chatStream route channel (attachments + tools), web-search tool loop, code-interpreter sandbox IPC, voice transcription IPC.
## SESSION UPDATE 2 (2026-09-22 ~23:30) — "YES" delivered
- **Agentic chat LIVE:** main.js new IPC `web:search` (DDG scrape, top-5, uddg-decode) + `code:run` (node -e, 8s timeout, 20KB cap, output caps); preload exposes `webSearch`/`runCode`; AiChat send() injects web results + decoded text attachments into history; caption flags (🌐/📎/⚡); fenced-JS code blocks get Run button (blocked if require/fs/process/eval).
- **Light/dark theme FIXED:** root cause was missing `[data-theme='light']` token overrides — added full light palette to ui/src/index.css (token swap only).
- **Icon:** new .ico live in-app (taskbar+titlebar via main.js:50). Desktop shortcut `AutoDash.lnk` re-saved (IconLocation re-applied) + `ie4uinit -show` cache flush — if desktop icon still looks old, it's Windows icon cache (explorer restart or reboot clears it).
- Build verified (467KB js), node --check 0 on main.js + preload.js, app restarted with React UI confirmed in log 23:30.
- Windows SpeechRecognition works in Electron renderer (Chromium), no API key needed.
- **Known good fallbacks:** chat 'end' type tolerated; model enums mirror legacy; DDG scrape degrades gracefully (no-key).

## Current Focus
1. **Fix Groq model** — DONE (2026-09-22): all 4 files now use live-tested
   models — default-config.json + app.js MODEL_OPTIONS @239 / MODEL_ENUMS
   @1721 + apiManager MODEL_ENUMS @177 / `_callGroq` default+fallback
   (@726/@739) / DEPRECATED_GROQ_MODELS @729 (llama-3.1, llama-3.3,
   deepseek-r1-distill) + auto-switch target @732 + main.js one-time
   migration (@211–217) → `openai/gpt-oss-120b`. `node --check` green on
   app.js, apiManager.js, main.js. Restart the app, then retest chat.
2. **Background mode** — `vscodeAutomation.backgroundMode: true` must keep VS
   Code automation reliable (nut-js focus/typing) without stealing focus.
3. **VS Code window reuse** — `vscodeAutomation.reuseWindow: true` must be
   honored so VS Code opens ONCE per workflow, not per prompt
   (`ClineAuto.launchVsCodeOnce` / `resetLaunchState`).

4. **RESTART the app** - the fixed `apiManager.js` (written 10:37:26) postdates the
   instance that produced the 10:37:04 `chatStream is not a function` log line.
   Restart, then retest the Live AI Chat send button.
5. **Gemini live chat** - `chatStream()`'s Gemini branch needs
   `@google/generative-ai` (not installed); port it to `@google/genai`.
6. **CP1252 mojibake** in `app.js` + `index.html` UI strings (cosmetic; list in
6. **CP1252 mojibake** in `app.js` + `index.html` UI strings (cosmetic; list in
   `progress.md` KNOWN ISSUES #5).
7. **Logs upgrade shipped (Phase 11)** — restart the app before retesting the
   new Logs tabs (KNOWN ISSUES #3); xterm paints buffered lines ~300 ms after
   the view becomes visible (expected, not a bug).
   `progress.md` KNOWN ISSUES #5).

## Recent Changes (completed)
- **Active-chain UI indicator (2026-09-22)**: `#activeChain` hint under the
  priority list (index.html @283) + `updateActiveChain(providers, routing)` in
  app.js (@320, called on load @464, after API-keys save @531, after AI-settings
  save @635). Mirrors `_buildRoutingChain` filter (enabled + hasKey) and all 4
  strategy orderings; arrow via `String.fromCharCode(0x2192)` (ASCII-safe,
  mojibake-proof). Gates: node --check + verify-all exit 0, CRLF intact.
  Verified during the work: fallback in `generateStructureCode` catch (@579-601)
  already triggers on ALL error types (no status filter); `_buildRoutingChain`
  filter (@448-453) already correct. Known minor: editor tool mangled a literal
  `\u2192` into a raw 0x19 byte once — fixed via PowerShell line rewrite;
  prefer `String.fromCharCode` for non-ASCII in edits.
- **Kimi/OpenRouter 401 diagnosed (2026-09-22)**: stored kimi/openrouter keys are
  EMPTY (post-decryption-failure re-save wiped them); the stored Groq key is
  rejected by Groq itself (`invalid_api_key`); Kimi hardcodes
  `https://api.moonshot.cn` — international platform.moonshot.ai keys 401 there.
  Full write-up in progress.md KNOWN ISSUES #6. Probe: `%TEMP%\autodash-kimi-openrouter-diag.js`.
- **API Keys scrollbar flicker REAL fix (2026-09-22; supersedes the earlier
  gutter-only attempt)**: empirical probe (%TEMP%\autodash-scrollbar-probe.js +
  analyzer, run via node_modules\electron\dist\electron.exe from repo root)
  sampled live geometry at 50 ms across two Dashboard -> API Keys switches.
  Measured: `.main-content` is the ONLY scroll container (no inner scroller in
  that view); API Keys content = 717px vs 709px available (8px past the overflow
  threshold -> most flicker-sensitive view in the app); `@keyframes fadeIn`'s
  `translateY(10px)` inflated scrollable overflow +10px during every 400 ms
  entry animation (scrollHeight 709->727 spike) and `fill: forwards` left a
  permanent transform on the section; and `.main-content`'s flex children used
  default `flex-shrink: 1`, crushing the topbar 70px -> 36px on overflow.
  Fix (styles.css only): fadeIn is opacity-only (@261) and
  `.main-content > * { flex-shrink: 0 }` (@74) pins natural heights; kept
  `overflow-x: hidden` + `scrollbar-gutter: stable` (verified: clientWidth
  constant 997). Post-fix probe: scrollHeight single step 709->751, topbar
  constant 70px, sectionTransform `none`, zero steady-state scrollbar flips,
  zero renderer errors. Gates: verify-all exit 0, CRLF 722/0. Probe gotcha:
  electron.exe exits 1 instantly when the default userData SingletonLock
  lingers -> probe sets a unique userData per run; kill stale electron.exe
  processes first. App must be restarted to pick up the new CSS.
- **Folder-based prompt system**: `promptManager.js` rewritten
  (`loadPromptsFromFolders`, `savePromptToFile`, `reorderPrompts`,
  `deletePromptFile`, `detectLanguage`, UTF-8→UTF-16→latin1 read fallback);
  `prompts/frontend/` + `prompts/backend/` with `01_`-ordered execution,
  `_`/empty files ignored.
- **Scheduler 3-phase workflow** + `fileConfig.promptDelaySec` (default 3).
- **IPC**: `prompts:readFolders/saveOne/deleteOne/reorder/retryOne/
  detectLanguage/openInExplorer` in `main.js` + `preload.js`.
- **Prompts Manager UI**: frontend/backend tabs, ordered list with language
  badges, inline editor, move up/down, delete, open-in-Explorer; legacy
  `prompts.txt` path + preview kept as fallback.
- **Style system**: `prompts/styles/` (7 presets) + `designStyle` selector in
  AI Settings (`aiConfig.designStyle`, default `auto`).

## Next Steps
See `memory-bank/progress.md` (PENDING + KNOWN ISSUES).

## Recent Changes (Phase 12, 2026-09-21)
- GPU cache errors root-caused (double-launch + whenReady outside the
  single-instance else) and fixed; shader disk cache disabled.
- System-wide error capture: uncaughtException/unhandledRejection,
  render/child-process-gone, Chromium stderr interceptor -> Error Center with
  new Source column + filter; 5 new catalog codes; scheduler health-check
  `entry.fn` bug fixed. All 9 sections audited clean.

## Recent Changes (Phase 11, 2026-09-21)
- Logs view rebuilt as 3 tabs: xterm.js Terminal (vendored, CSP-safe),
  Error Center (`runs/errors.json` via new `errorStore.js` + errors:* IPC),
  Guide (rendered from the shared error catalog). `logger.terminal()` emission
  wired in scheduler + apiManager. All gates green (see progress.md Phase 11).

## Recent Changes (Phase 10, 2026-09-21)
- Verified `app.js` does NOT have a structure bug (brace map: `})();`@1388 closes
  `(() => {`@1209; `addEventListener` 63-1206 closed at 1206 `});`). No edit made;
  deleting the last line breaks the file (SyntaxError, proven).
- `apiManager.js`: removed 6 dead `module.exports.X = ...` assignments and
  exported `chatStream`, `StreamBus`, `_withRetry`, `sanitizeGeminiModel`,
  `estimateCost`, `recordApiUsage` from the single `module.exports = { ... }`
  literal -> fixes `ApiManager.chatStream is not a function`.
- `app.js`: `sendChatMessage()` surfaces `{success:false}` chat failures;
  log-panel listener for the new `api:stream` bridge; 13 `alert()` -> `showToast()`.
- `main.js` + `preload.js`: `StreamBus.on('chunk')` -> `api:stream` ->
  `onApiStream` bridge (FEATURE B finally implemented, not just documented).
- Gates: `node --check` (apiManager/app/main/preload) exit 0;
  `node verify-all.js` exit 0; probes `rendererErrors: []`;
  `chatStream` smoke: `typeof === 'function'`, groq path reaches HTTP (401).

## Conventions to preserve
- Windows/PowerShell only; CRLF line endings; `node --check` after every JS edit.
- One-file-at-a-time changes with the diff shown first.
- Never break: AES-256 encryption, multi-provider router, AI Settings view,
  `prompts.txt` legacy fallback.
- **Never "fix" app.js structure by deleting the final `})();`** (line 1388): it
  closes the top-level IIFE opened at line 1209. Verify structure with
  `node %TEMP%\brace-scan.js src\renderer\js\app.js` before touching brackets, and
  remember `node --check` alone cannot detect balanced-but-wrong nesting.
- Before retesting after edits, close the running app - Electron keeps old modules
  in memory (see progress.md KNOWN ISSUES #3).

## React port (ui/ workspace) - 2026-09-22
- Ported `ui/src/views/ApiKeys.jsx` and `ui/src/views/AiSettings.jsx` from legacy `app.js` (PROVIDER_INPUTS/MODEL_SELECT_IDS logic, same IPC shapes: getConfig/saveConfig/testApiConnection/fetchModels).
- ApiKeys: per-provider Configured/Missing badge (green/amber), show-hide eye toggle, Test with inline spinner + inline result, Fetch Models, gemini extra-keys textarea; SAVE NEVER WIPES - empty field keeps stored key (old UI silently wiped keys).
- AiSettings: model selects, thinking level, routing strategy, priority list (up/down instead of drag), temp/maxTokens sliders, system prompt + design style, Active Chain chips with greyed-out dropped providers.
- GOTCHA: PowerShell `Get-Content -Raw | Set-Content` round-trip double-encodes UTF-8 (mojibake); use the editor tool or explicit `[IO.File]` UTF8 reads/writes only.`

## Force Run crash + dead-key rotation fix - 2026-09-23 (afternoon round)
- USER BUG: clicking **Force Run** on Dashboard produced `[ErrorCenter] UNKNOWN
  Unknown Error: frontendPrompts is not defined` in the terminal, masking the
  real "All AI providers failed" AI error.
- **ROOT CAUSE 1 (scheduler.js scope)**: `let frontendPrompts/backendPrompts/
  extensionPrompts` were declared INSIDE the workflow `try{}` but read by the
  sibling `finally{}` (run history) - `let` is block-scoped => ReferenceError on
  EVERY run. A SECOND landmine in the same `finally`: `fileList` was referenced
  but NEVER declared anywhere. FIX: declarations hoisted to method scope (next
  to `usedProvider`); `writtenFiles[]` accumulates `_writeFilesFromResponse`
  results in `runPromptPhase`; `finally` now records `files: writtenFiles.slice()`.
- **ROOT CAUSE 2 (Gemini 401 in workflow)**: `_buildRoutingChain` rotates
  `apiKey + apiKeys[]` via `getNextGeminiKey()`; rotation had landed on the
  stored EXTRA key which is DEAD (HTTP 401 `UNAUTHENTICATED
  ACCESS_TOKEN_TYPE_UNSUPPORTED`), and the key-rotation rescue in
  `generateStructureCode`'s catch only fired on 429 regex, NOT 401. FIX: catch
  now classifies with `classifyProviderError` and rotates on
  `quota-exhausted | rate-limited | invalid-key` (bounded4 rotations).
- **KEY STATE (live probe `%TEMP%\ad-api-probe.js`, zero quota)**: Gemini
  primary `AQ.Ab8RN...n4NQ` = VALID (HTTP200,59 models); Gemini extra[0]
  `AQ.Ab8RN...nKCw` = DEAD 401; Groq `gsk_HtMz...auQc` = DEAD 401. USER should
  remove the dead extra key (AI Settings -> Additional Keys) and paste a fresh
  Groq key. Gemini free-tier daily quota may still force amber/429 until reset.
- VERIFICATION: `node --check` scheduler+apiManager exit0;
  `%TEMP%\ad-sched-test2.js` (isolated userData/prompts/output/cwd, no keys =>
  prompt phase fails fast, EXACT user path) => **TEST PASS**, finally wrote
  `runs/history.json` `{frontend:1, backend:0, files:[]}`, no ReferenceError;
  `%TEMP%\ad-views-smoke.js` => all10 sidebar views OK/headings correct, only
  expected `[api-stub]` lvl2 notices (0 real errors); app restarted, boot log
  clean (logger/config/prompts/media/React UI/window).
- TEST-TOOL GOTCHAs: bare electron probe MUST `app.setPath('userData',
  %APPDATA%\autodash-control-panel)` before requiring encryption or it reads the
  stale `%APPDATA%\Electron` default store and reports "0 keys" (keys NOT lost;
  real store `%APPDATA%\autodash-control-panel\config.json` last written11:09).
  Bare fetch probes need timeouts or they hang past the30s command cap (stdout
  is pipe-buffered - use appendFileSync breadcrumbs); `chdir` before `mkdirSync`
  throws ENOENT at app load ("App threw an error during load"); views smoke
  needs `localStorage.clear()+reload()` or persisted sidebar-collapse makes
  icon-only buttons report `sidebar buttons found: []`.

## SESSION (2026-09-30) — SEO + Performance skill defaults unified
**Goal:** SEO skills ko "on by default" confirm karna, phir CWV inconsistency fix.
**VERIFY (live, not guessed):** config encrypted hai, is liye real module se padha —
`E.getConfig('aiConfig')` → `promptScope={chat:true,automation:true}`,
`skills.enabled={}` (koi user override NAHI), `systemPrompt` 796 chars.
- `seo-content` + `seo-advanced` already `enabledByDefault:true` in BOTH
  `skills/*.json` AND `BUILTIN_SKILLS` → chat me 6 skills / 8,412 chars,
  automation 7 skills / 9,715 chars, sab SEO markers present. **No change needed.**
- **GOTCHA (important):** `mergeDefinitions()` (skillRegistry.js:325) — "a file with
  the same id OVERRIDES the built-in". To `performance` ON karne ke liye **dono**
  jagah edit zaroori thi: `skills/performance.json:11` + `skillRegistry.js:206`.
  Sirf built-in edit karna bekaar — file usko override kar degi. Doosri jagah is
  liye bhi ki UI se skill delete karne par `deleteSkill()` built-in wapas seed
  kare aur stale `false` na aaye.
- **CHANGE:** `performance.enabledByDefault` false→true (both places).
- **RESULT (probe-verified):** chat 7 skills/9,423 chars, automation 8/10,726;
  `PERFORMANCE CONTRACT (budgets, not vibes)` ab dono me present. SEO+CWV ab
  consistent (seo-advanced me CWV budgets bhi thi, par performance skill off thi).
- `node --check skillRegistry.js` exit0. No UI change → **no vite build needed**.
- LEFT ALONE (deliberate): `data-integrity.chat=false` — schema rules chat me bloat
  karte hain, user ne chhune ka nahi kaha.
- GOTCHA: reading `listSkills()` triggers `ensureSkillFiles()` which SEEDS missing
  files — `skills/honesty-guard.json` was auto-created by a "read-only" probe.
  Benign (content == built-in) but it IS a write.

## SESSION (2026-09-30, later) — Dashboard deep audit: 2 real bugs fixed
Full line-by-line read of `ui/src/views/Dashboard.jsx` (490 lines) + AppContext,
api.js, preload.js, main.js `runs:history`/`config:get`, and scheduler.js status
emissions. Most suspicions DISPROVED by evidence (recorded so they are not
re-audited): `forceRunAutomation`/`getPendingApproval`/`approveNextPrompt`/
`declineNextPrompt` all EXIST in preload.js:65-68; scheduler DOES emit terminal
statuses (`broadcastStatus('completed')` L537, `stopped|failed` L548) so the
button is not dead because of a missing broadcast; `config:get` returns the raw
module object so `sched.enabled`/`sched.time` resolve fine; `CountUp` is
value-guarded; `runs:history` reads `runs/history.json` (11 real runs on disk).

**BUG 1 (P0 UX) — Force Run button stuck forever.** `forceRun()` did
`setRunning(true)` and the ONLY resets were (a) the catch branch and (b) the
`awaiting-approval` branch. Any run that finished WITHOUT an approval gate
(single-prompt workflow, failure on the very first prompt) left `running=true`
forever => the CTA stayed "Running…" and `disabled` until the app was restarted.
FIX (Dashboard.jsx ~L150): an explicit terminal-state block
(`completed|failed|stopped|error|idle`) now calls `setRunning(false)`.
`paused` deliberately excluded — that run is still alive.
NOTE Scheduler.jsx is immune: it resets on a 3s `setTimeout`, not on status.

**BUG 2 (P1 data) — "N files generated" inflated ~4.5x.** `writtenFiles` is
append-only across prompts (`writtenFiles.push(...written)`, scheduler.js:359),
but every prompt REWRITES the shared files (index.html, styles.css, schema.sql).
A live `completed` run recorded **41 file entries = only 9 unique paths**.
`recordRunHistory` now does `const uniqueFiles = [...new Set(writtenFiles)]`
(order preserved) — the Dashboard sums this array for both the per-run "N files"
column and the "files generated" KPI, so both were wrong for all 11 runs.
MIGRATED `runs/history.json` in place (279 -> 77 file entries, 11 runs, JSON
re-verified parseable). Backup at `runs/history.json.bak-seo-audit`.
NOTE: `_writeFilesFromResponse` returns relative paths unchanged, so
normalization of readme/database/assets prefixes happens BEFORE the push — the
set-dedupe on raw paths is therefore safe (no `frontend/` vs `assets/` variant
of the same file sneaking through).

**GATES:** `node --check` scheduler/main/preload exit0; `vite build` exit0
(2300 modules, `index-11tt9wuH.js` 534.93 kB / css `index-BpPm4rRO.css`);
bundle-content grep PASS (terminal-state chain present in the shipped bundle).
Gotcha: `npm run build` under PowerShell exits 1 on harmless stderr
(`[PLUGIN_TIMINGS]`) — run it as `cmd /c "npm run build 2>&1"` and read
`$LASTEXITCODE` instead of trusting the first exit code.
