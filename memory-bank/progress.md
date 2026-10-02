
- 2026-10-01 (later) **MCP fulfil — real connection + smart tools + model-driven tool calls**: user asked
  ("skills/plugins/MCP option fulfill karke connection de do, smart advanced intelligent tareeqe se workable banao").
  Evidence: stored config me `mcpServers.servers = []` → koi server hi nahi tha; server start sirf manual click se
  (design note) isliye har launch par disconnected; bundled example me sirf 3 toy tools; model tools sirf
  hand-typed `/tool` se use kar sakta tha; `inputSchema` handshake par drop ho jata tha.
  **Fixes**: (1) NEW `mcp-servers/autodash-tools-server.js` — dependency-free stdio MCP server, **10 real tools**
  (`workspace_list/read/search`, `port_status`, `http_status`, `system_info`, `system_time`, `json_validate`,
  `seo_audit_checklist`, `echo`), workspace `AUTODASH_OUTPUT_DIR` me confined + read-only + capped, aur failing
  tool MCP-spec ke mutabiq `isError:true` deta hai. (2) `mcpManager.js`: `ensureSeeded()` (first run seed,
  `seeded:true` marker — user delete kare to wapas nahi aata), `autoConnect()` (launch par enabled servers;
  global/per-server `autoConnect:false` off switch), `callToolRunning()` (sirf RUNNING server — **model process
  spawn nahi kar sakta**), spawn par `AUTODASH_OUTPUT_DIR`+`AUTODASH_APP_ROOT` inject, `inputSchema` retain +
  `toolCatalog()` me expose. (3) NEW `src/modules/chatToolLoop.js` (pure): fenced `` ```tool_call {...} ``` `` +
  inline `TOOLCALL: {...}` parser (brace-balanced), aur `createToolStreamGuard()` — probe/text/block state machine
  jo raw JSON user tak (aur saved chat me) pahunchne hi nahi deta; unterminated block flush ho jata hai.
  (4) `main.js`: chat handler `runChain()` + **tool rounds** (max 3 provider passes; tool execution ke baad
  follow-up usi bubble me, `end`/`stats` hold), boot par deferred 400ms `ensureSeeded()`+`autoConnect()` +
  `mcp:status` broadcast, naya IPC `mcp:connectAll`. (5) `skillRegistry.mcpToolsBlock()` me real arg names
  + `TOOL_PROTOCOL_PROMPT`. (6) `preload.js` `connectAllMcpServers`/`onMcpStatus`; `default-config.json`
  `mcpServers.autoConnect: true`; `Skills.jsx` me **Connect all** button, **Connect on launch** toggle, live status.
  **Proof**: `node probe-mcp.js` = **32/32 PASS** (real spawn+handshake, 10 tools, real tool outputs — temp
  workspace par read/search, probe ke khud ke kholay port par OPEN detect, local http server par HTTP 200,
  json_validate dono branches, workspace escape REFUSED; live chat prompt me tools + protocol; unknown tool
  refused; model spawn nahi kar saka; autoConnect:false switch; guard ke saare branches). `node --check` 6/6
  exit 0; `probe-scope.js` phir se green; Vite build green (`index-DGxGXEpV.js` 536.78 kB, 2300 modules).
  **Electron restart zaroori** (main-process + preload).

- 2026-10-01 **"sirf wahi karo jo task me likha" — unrequested features ab banded**: backend prompts folder se
  hata kar sirf `prompts/frontend/1st prompt.txt` chhod diya (usme kahin password/security zikr nahi), phir bhi
  Force Run par Gemini **login/security-lock screen** banata tha aur **style/colors mit jate the**. Root causes
  (chaaro code se aa rahe the, user ke prompt se NAHI): (1) `skills/web-security.json` + builtin
  `enabledByDefault:true` targeting automation = "SECURITY CONTRACT … password_hash()/sessions/CSRF/login
  lockout" har call me inject; stored config probe me `aiConfig.skills.enabled = {}` yaani kuch toggle nahi hua
  tha; (2) `validateGeneratedProject` ne `backend/config.php|api.php|health.php|db/schema.sql` lazmi kiye →
  backend prompts khatam hone se validation 100% FAIL hoti thi; (3) is fail se chala **repair pass**
  ("…frontend calls the PHP API… valid MySQL schema") jo PHP/MySQL backend khud invent kar deta tha aur poori
  file dobara emit karke `frontend/css/styles.css` overwrite kar deta tha (yahi rang-badalne ki wajah);
  (4) `projectPromptContext` har prompt ke saath `COMPLETE ORDERED PROJECT PLAN` + "regenerate the complete
  project" lagata tha (single-prompt run me apna hi text do baar, poora project har call par).
  **Fixes**: `skillRegistry.js` me non-toggleable `SCOPE_DISCIPLINE_PROMPT` (TASK SCOPE) har chat+automation
  prompt me SABSE PEHLE — one task only, login/password/DB/roles/admin = UNREQUESTED FEATURES, NO CARRY-OVER,
  task-jo-naame-wahi-preserve (rang safe), task > convention, plan-only prompts emit no files;
  ACTIVE SKILLS header ab kehta hai skills "HOW you work" hain, feature add karne ka haq nahi. `web-security`
  → `enabledByDefault:false` (opt-in) + conditional preamble, dono jagah (builtin + `skills/web-security.json`
  CRLF/no-BOM, kyunki file builtin ko override karti hai). `fileManager.js` me NEW `validateGeneratedOutput()`
  (frontend-only run = "kya real files bani?" — koi stack named nahi) aur
  `validateGeneratedProject(basePath,{backendRequested})` ka default behavior **bilkul waise hi** (manual
  XAMPP deploy strict). `scheduler.js`: `backendRequested = backendPrompts.length > 0` → repair pass aur
  `Xampp.connect` doni gated; `projectPromptContext` sirf `totalPrompts > 1` par banta hai aur wording
  "background context ONLY - do not implement them now". `apiManager.js loadMasterPrompt` folder block:
  MANDATORY/EXACTLY → "applies only to files you actually generate" + "never add an API, database, schema,
  config or admin file just to make the layout look complete".
  **Proof**: `node probe-scope.js` = **15/15 PASS** (TASK SCOPE FIRST, active skills me `web-security` ABSENT,
  `password_hash()` kahin nahi, persona phir bhi pahunchta hai; toggle karne par conditional preamble ke saath
  inject; frontend-only project `{backendRequested:false}` PASS, option na dene par wahi purana missing list
  FAIL → XAMPP contract untouched). `node --check` = 4/4 exit 0. `prompts/frontend/1st prompt.txt` **BADLA NAHI**
  (sirf padha). `prompts/master-system-prompt.txt` absent + `prompts/styles/` khali + `designStyle:auto` —
  unchanged. `scheduler.js _writeFilesFromResponse` ka path check bhi hardcoded `^(frontend|backend)/` regex se
  `fileConfig.outputFolders` se derive hote `allowedRe` me badal diya (warna AI ko `loadMasterPrompt` se ek folder
  contract dikhaya jata aur doosre se reject — run beech me throw). UI untouched → rebuild ki zaroorat nahi;
  **main-process changes ke liye Electron restart zaroori**.

- 2026-09-29 (evening) **Shortcut 16s→3.5s + 503 ab hiccup (not error)**:
  - Startup: `main.js` single-instance lock + `second-instance`→`restoreMainWindow` moved to the TOP (before
    scheduler/apiManager/genai/nut-js requires) with `app.quit(); process.exit(0)` for duplicates;
    `pendingRestore` honoured on ready-to-show; window-first boot (createWindow before prompt-folder/config
    work). `launch-autodash.vbs` now runs `node_modules\electron\dist\electron.exe "<project>"` directly
    (npm fallback kept). Measured window-open: **16027 ms cold / 6011 ms warm → 3535-3792 ms**; second click
    restores in **1035 ms**.
  - 503: `apiManager.generateStructureCode` catch now uses exported `isRecoverableFailure()` → self-healing
    503/429/401 hiccups are `log.warn('API hiccup (temporarily overloaded) — … router is auto-recovering.')`
    while a genuine dead end remains `log.error`. NEW session `MODEL_OVERLOAD_TTL_MS`=10 min memory
    (`markModelOverloaded/isModelOverloaded/clearModelOverloaded/pickRestedModel`) makes the NEXT prompt start
    on a rested Gemini model instead of paying the same 503 again.
  - Proof: `%TEMP%\ad-503-probe.js` 16/16 PASS; `%TEMP%\ad-503-int.js` 10/10 PASS (503→warn, 0 red errors,
    run continued on `gemini-3.6-flash`, next prompt started rested, real dead end still 1 red). `node --check`
    main+apiManager exit 0. No UI change → no rebuild. App left running.
- 2026-09-29 **API Keys 401 ab self-resolving (SMART AUTO-AUDIT)**: `apiManager.testConnection()` ab
  invalid-key (401/403) par baaki SARE stored keys khud zero-quota `models.list` se re-check karke
  `keyAudit`/`savedKeyValid`/`savedKeyMask` + AUTO-CHECKED suggestions deta hai; `ApiKeys.jsx` me
  "Saved-key auto-check" list, amber-when-saved-OK verdict, aur one-click **Use saved key** / **Open AI
  Studio (nayi key)** / **Remove dead extra keys** buttons; `test()` fallback ab primary+extras. Live probe
  `%TEMP%\ad-audit-probe.js` = PASS (primary 61 models VALID, extra 401, savedKeyValid true, 1.8s, zero
  quota); `node --check` x2 OK; Vite build green (`index--j7Wq9l_.js`). User must FULLY restart Electron.
- 2026-09-25 (later) **Force Run → XAMPP CONNECTED + .sql icon/open-with + prompts rewritten**: 
  - Root cause of "khaali Dashboard folder": 19:22 run died at frontend prompt 1/4 (Gemini 503 → streaming empty →
    non-streaming) while the groq key was 401; no deploy, no history entry. `Desktop\Dashboard` had only empty folders.
  - NEW `src/modules/xampp.js` (detect/start Apache :80 + MySQL :3306, mysqldump backup, CREATE DATABASE +
    schema.sql import, deploy to `htdocs\autodash-dashboard`, live `health.php` verify, `connect()` + `status()`).
  - `scheduler.js`: health gate before scaffold (0 providers → fail fast, no empty folder); Step-5 deploy replaced by
    `Xampp.connect()`; a failed connect now FAILS the run with the exact failed step.
  - IPC `xampp:status` / `xampp:deploy` + `system:openUrl`; preload `getXamppStatus`/`deployToXampp`/`openUrl`;
    Settings view: new "XAMPP & Database" card (chips, Dashboard/phpMyAdmin links, Refresh, Deploy & Connect now,
    per-step results). `fileConfig`: xamppRoot/xamppAutoDeploy/xamppAutoStart/xamppImportSchema (all true).
  - `main.js files:open` fallback chain VS Code → Notepad; `.sql` association set to `VSCode.sql` (icon + double-click).
  - `apiManager.loadMasterPrompt()` cwd-proof (module-relative first).
  - **All 6 ordered prompts + master prompt rewritten** as an architecture-first PROJECT BLUEPRINT (one canonical API
    contract with 12 actions, 9-table schema, seed volume, window.API spec, 8 rules) — removes the model-confusing junk.
  - Proof: probe #1 (prompts order, Apache+MySQL started, importSchema imported 1 table into a throwaway DB, then
    dropped) and probe #2 END-TO-END (`validateGeneratedProject` all green → `connect()` ok:true → health.php
    `{"ok":true}` HTTP 200 → demo removed). `node --check` 13/13, Vite build green (index-B8rtvfxR.js 499 kB),
    Electron boot clean. Apache + MySQL left RUNNING for the user.
- 2026-09-25: Verified chat payload fix end-to-end with real encrypted store: first-message normalizer works, invalid 401 key is skipped, valid key + `gemini-3.6-flash` returns `CHAT_OK`; Vite production bundle rebuilt and Electron boot smoke passed. Residual user symptom is stale running app/build, requiring full Electron restart.

## ✅ DONE
- **3-bug fix batch (2026-09-24, later)**: (1) Offline-detection — multi-probe
  race (google/cloudflare/gstatic-204) + DNS fallback in `system:checkOnline`,
  `probe` field → Topbar tooltip. (2) Chat "2 errors then answer" — route emit
  wrapper suppresses intermediate error/empty-end chunks, single `recordError`
  at chain end, key dedupe; SHARED GEMINI KEY POOL with dedication+borrowing
  (`getGeminiKeyPool`/`getNextGeminiKey(conf, afterKey)`, pool[0]=automation,
  last=chat, reverse-walk, cross-borrow on 429/401); AiChat toasts silenced.
  (3) Feed persistence — preload on* helpers return per-handler unsubscribes,
  all component cleanups converted off `removeAllListeners`, feed buffer lifted
  to AppContext (FEED_CAP=80, log:new+api:stream+errors:new), Dashboard consumes
  it, Logs seeds terminal from it. Gates: node --check ×3, vite build exit0.

- **UI polish batch + psychology-based Dashboard (2026-09-24)**:
  `humanMessage()` in `apiManager.js` (+ local copy in `errorStore.js`) unwraps
  multi-KB JSON error blobs → retry/API-failure/health-check/ErrorCenter lines
  now ≤200 chars; `system:checkOnline` (main.js) returns
  `{internet, online, latencyMs, adapters[], providers}` (`os.networkInterfaces()`
  + google HEAD latency); new `runs:history` IPC + preload `getRunHistory()`
  expose `runs/history.json` (`{timestamp, durationMs, frontend, backend,
  provider, status:'completed'|'failed', files}`). UI: AppContext rewritten
  (real `internet` field, transition-only toasts w/ dedupe-ref, 15s poll +
  navigator.onLine listeners, `netInfo`), Topbar wifi → animated Online/Offline
  chip (click re-check), Logs/App feed collapse duplicate lines to `×N`,
  MotionConfig reducedMotion + a11y CSS. **Dashboard.jsx fully REWRITTEN**
  (psychology: Fitts CTA, Von Restorff accent card, goal-gradient progress,
  CountUp KPIs — real Success Rate/Total Runs/Files from history, Recent Runs
  list, System Status card w/ adapters+provider chips, offline banner).
  Written via 9 part files + UTF-8 PowerShell concat (6000-char editor cap).
  Gates: `node --check` ×5 exit0, `vite build` exit0 (488KB bundle), bundle
  grep finds Success Rate/System Status/getRunHistory. `api.js` passes
  `window.electronAPI` through — new preload methods need NO wrapper.

- **Workflow engine live-proven ×3 + Error Center dedupe (2026-09-23 evening)**:
  3 consecutive successful Force Runs (`completed` ×3 in `runs/history.json`;
  run1's network-drop failure now correctly recorded as `failed` via the
  `runFailed` fix). Rescue order = **model switch before key rotation**
  (`apiManager.js` ~728-775, live-verified 429→lite rescue). Error Center
  dedupe: `errorStore.save()` bumps identical unresolved entries
  (code+provider+model+context+message-head → timestamp + `count`) instead of
  appending and returns `{entry, deduped}`; `recordError` (main.js:285) skips
  renderer push/toast on dedupe. Gates: `node --check` ×2 exit0,
  backup/restore probe PROBE_PASS (same id, count=2), existing 8 rows
  consolidated → 3 unique, LIVE run5 health check showed
  `duplicate 429/401 — bumped` with file staying at 3 rows. User's own XAMPP
  at **D:\xamp** adopted (httpd+mysqld up, ports 80/3306, phpMyAdmin HTTP 200
  with `--noproxy '*'`); all my failed-download temp artifacts deleted —
  `download.apachefriends.org` is dead everywhere, never retry that install path.
  Run5 (same session) failed CLEANLY after 11.9 min — streaming hung ~5 min
  (missing abortSignal on `generateContentStream`) then transient network drop
  (`ENOTFOUND api.groq.com`); history recorded `failed` (hist=6, partial files
  kept) + dedupe bumped `ERR_ALL_PROVIDERS_FAILED x2` (errors still 3 rows).
  NEW FIX: `_callGemini` streaming AbortController (60s idle re-arm / 240s
  absolute cap, `abortSignal` as RequestOptions 2nd arg — confirmed in
  `dist/genai.d.ts` L1589) + terminal-partial branch now returns partial text
  instead of falling through; `node --check` exit0 (takes effect next app
  start). No run6: gemini free-tier 20/day spent + groq key 401 — engine
  already proven by runs 2/3/4 + run5's correct failure handling.

- **Scrollbar flicker REAL fix (2026-09-22)**: probe-measured root cause — fadeIn
  `translateY(10px)` overflow spike during every view entry + `flex-shrink: 1`
  crushing the topbar 70px->36px on overflow + API Keys content sitting 8px past
  the overflow threshold (717px vs 709px). Fix in styles.css only: opacity-only
  fadeIn + `.main-content > * { flex-shrink: 0 }`; kept `overflow-x: hidden` +
  `scrollbar-gutter: stable` (proven working). Verified by before/after Electron
  probe runs (zero steady-state scrollbar flips, topbar constant 70px) and
  `verify-all.js` exit 0. Full write-up in activeContext.md Recent Changes.

- **Core app**: Electron shell, security (contextIsolation/sandbox), window,
  System Tray (minimize/close-to-tray, balloon notifications), Logs view.
- **Multi-provider AI router**: Gemini / Groq / Kimi / OpenRouter with
  priority, cost-optimized, latency-optimized, round-robin strategies,
  fallback chain, retries; per-provider model/temperature/maxTokens config.
- **Encryption**: AES-256-CTR + Electron safeStorage via electron-store;
  read-merge-write save pattern in the UI.
- **AI Settings view**: per-provider model dropdowns (+ live "Fetch Models"),
  thinking level (Gemini), routing strategy, drag-reorder priorities,
  generation-limit sliders, system prompt, design style selector.
- **Style files**: `prompts/styles/` (auto, glassmorphism, neumorphism,
  cyberpunk, minimal, material3, neubrutalism) wired via `aiConfig.designStyle`.
- **Folder-based prompts**: `prompts/frontend/` + `prompts/backend/`,
  `01_`-ordered execution, `_`/empty files skipped, any language
  (UTF-8/UTF-16/latin1 read fallback), auto-numbered saves, crash-safe reorder,
  legacy `prompts.txt` fallback preserved.
- **Prompts Manager UI**: frontend/backend tabs, ordered list with language
  badges and sizes, inline editor with live language detection, move/delete,
  open in Explorer.
- **Scheduler**: 3-phase workflow (frontend → backend → VS Code once),
  `promptDelaySec` (default 3), pause/resume/stop, tray-notify bridge,
  progress bar in UI.
- **Verification**: `node --check` on all touched files; Electron UI harness
  run passed with zero renderer errors (AI Settings + Prompts Manager probes).

## DONE (Phase 10 - app.js structure audit + live-chat/stream wiring, 2026-09-21)
- **"app.js structure bug" is a FALSE POSITIVE** - proven with a real bracket
  scanner (`%TEMP%\brace-scan.js`): the last `})();` (line 1388) is matched by the
  top-level IIFE `(() => {` on line 1209, and the `DOMContentLoaded` handler is
  closed by `});` on line 1206. `node --check` exit 0; app boots with
  `rendererErrors: []`.
  **DO NOT delete the last line** - removing it yields
  `SyntaxError: Unexpected end of input` (exit 1, proven on a temp copy).
  Program-level layout is intentional: helpers 10-60 -> `addEventListener`
  63-1206 -> chat IIFE 1209-1388.
- **REAL bug fixed** (was logged as `Chat stream error: ApiManager.chatStream is
  not a function`): in `apiManager.js` the scattered `module.exports.X = X`
  assignments (lines 18/47/62/210/254/344) were silently discarded by the later
  `module.exports = { ... }` literal. Dead assignments removed; everything is now
  exported ONCE from that literal (17 keys incl. `chatStream`, `StreamBus`,
  `_withRetry`, `sanitizeGeminiModel`, `estimateCost`, `recordApiUsage`).
- **Chat failures are no longer silent**: `main.js` resolves
  `{ success:false, error }` instead of rejecting, so `app.js`
  `sendChatMessage()` now checks `res.success === false` and shows the error in
  the chat transcript.
- **FEATURE B is now wired end-to-end (before this, `api:stream` existed ONLY in
  this memory bank, nowhere in code)**: `main.js`
  `ApiManager.StreamBus.on('chunk')` -> `api:stream` IPC -> `preload.js`
  `onApiStream` -> `app.js` log panel (one line per generation, updated in place,
  `textContent` only). Verified by probe: `[stream:gemini]` line rendered,
  `bridgeMatchesMainJs: true`.
- **`alert()` cleanup finished**: all 13 remaining `alert()` calls in `app.js`
  converted to `showToast(msg, type)` (`success`/`error`/`warning`/`info`);
  `node verify-all.js` now exits 0 ("ALL CHECKS PASSED").
- **Verification tooling** (kept in `%TEMP%`, never committed):
  `brace-scan.js` (bracket open/close map), `autodash-probe.js` (renderer init +
  console errors), `autodash-stream-probe.js` (StreamBus -> renderer round trip),
  `autodash-chat-smoke.js` (in-process `chatStream` smoke test),
  `encoding-check.js` (UTF-8 vs mojibake + CRLF stats).
- **CRLF preserved** on every touched file (apiManager.js 798, app.js 1420,
  main.js 641, preload.js 69 - LF == CRLF in all).


## 🔜 PENDING
- **Dashboard quality**: validate generated dashboards against
  `prompts/master-system-prompt.txt` quality bar (multi-file marker output,
  loading/error states, charts, a11y, Lighthouse 95+).

## ✅ DONE (PART 8 features, added)
- **Command palette**: Ctrl+K overlay (index.html `#commandPalette`); commands
  Run Now / Stop / Open Logs / Open Settings / Switch Theme / Export Config;
  Ctrl+K toggles, Escape closes, ↑/↓ + Enter navigate/execute, type-to-filter.
- **Cost tracker**: `recordApiUsage()` in apiManager (tokens ≈ chars/4, priced
  from per-1M rates) → encrypted `costs` config module
  `{date, calls, tokens, estimatedCost, history[]}`; IPC `costs:get`; Dashboard
  card `#costToday`/`#costTokens` (refreshes every 60s).
- **Theme switcher**: topbar `#btnTheme` toggles dark/light via
  `[data-theme="light"]` CSS overrides; persisted as `appConfig.theme`.
- **File tree viewer**: Prompts view lists `fileConfig.outputDirectory`
  (IPC `files:listTree`/`files:readFile`, traversal-safe, ≤200 KB preview);
  click file → preview modal.
- **Retry single prompt**: per-prompt ↻ button + right-click → runs ONLY that
  prompt (IPC `prompts:runOne`: PromptManager → ApiManager →
  `Scheduler._writeFilesFromResponse`), no VS Code automation.

## ⚠️ KNOWN ISSUES
1. **Groq 404** — FIXED (2026-09-22, live-tested with real key, /models → 200):
   `llama-3.3-70b-versatile` is REMOVED from the account (and `deepseek-r1-
   distill-llama-70b` was the stale stored value). Default `providers.groq.model`
   + all 3 `MODEL_ENUMS.groq`-style arrays (app.js @239/@1721, apiManager @177)
   = `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`,
   `groq/compound-mini`. `_callGroq` default + fallback = `openai/gpt-oss-120b`;
   `DEPRECATED_GROQ_MODELS` (apiManager) / `DEPRECATED_GROQ_MODEL_IDS` (main.js
   one-time migration) both include llama-3.1/3.3 + deepseek-r1-distill → stale
   encrypted configs auto-rewrite at startup and at call time. Restart the app
   to load the fixed modules; then retest Live AI Chat with a fresh key.
2. **VS Code reopens per prompt** — FIXED: code already idempotent:
   `launchVsCodeOnce()` (no-op when launched, `code --reuse-window`,
   `vscodeAutomation.reuseWindow: true`) + `sendPromptToCline()` without
   relaunch + per-run `resetLaunchState()`. Retest in a real workflow run.
3. **Restart required after editing**: an app instance left running while source
   files change keeps the old modules in memory. Observed 2026-09-21: instance
   started 10:36:20, `apiManager.js` rewritten 10:37:26 -> the 10:37:04 chat error
   came from the mid-edit module, not from the shipped code.
4. **Gemini live chat still fails (NEW)**: `chatStream()`'s Gemini branch
   (`apiManager.js` ~L277) does `require('@google/generative-ai')`, which is NOT
   installed (only `@google/genai` ^2.23.0) -> `Cannot find module
   '@google/generative-ai'`. Groq/Kimi/OpenRouter chat works (dummy key -> HTTP
   401 as expected). Fix = port that branch to the installed `@google/genai`
   client, exactly like `_callGemini()` (~L591).
5. **CP1252 mojibake in UI strings (NEW)**: `app.js` (code points U+00E2 U+20AC
   U+201D where an em dash belongs; U+00E2 U+0153 U+2026 where a check mark
   belongs; U+00F0 U+0178 U+201C U+0081 where a folder icon belongs) at lines
   491, 499, 518, 676, 692, 816, 822, 871, 902, 910, 1086; `index.html` at lines
   111, 271-274, 313, 361. `styles.css` is clean. Cosmetic only, but it is what
   the user sees. Needs a dedicated re-encode pass (both files are UTF-8 + BOM).
6. **Kimi/OpenRouter 401 root-caused (2026-09-22, live probe
   `%TEMP%\autodash-kimi-openrouter-diag.js`)**: NOT a code bug in the request
   path. (a) Stored `providers.kimi.apiKey` and `providers.openrouter.apiKey`
   are EMPTY — the 2026-09-21 21:37 `Decryption failed for providers` event
   (entry encrypted under a different master password) made getConfig fall back
   to defaults, and a 06:37 re-save persisted the empty keys (original entry
   destroyed). Decryption is healthy again (gemini/groq decrypt fine).
   (b) The stored Groq key (`gsk_HtM...`) is rejected by Groq itself
   (`invalid_api_key`) — the user's keys are invalid/revoked; network + crypto
   plumbing proven good (clean HTTPS round-trip). (c) Latent Kimi trap: the app
   hardcodes `https://api.moonshot.cn/v1` (apiManager @709, MODEL_ENDPOINTS
   @186, chatStream @302); keys issued on the INTERNATIONAL platform
   (platform.moonshot.ai) only work against `https://api.moonshot.ai/v1` and
   401 on the .cn host. Fix = re-enter+save valid keys; consider making the
   Kimi base URL configurable. (d) Minor: `migrateProvidersConfig()`
   (encryption.js @180) omits `openrouter` from the legacy apiKeys migration;
   and the decrypt-fail -> defaults -> save flow is a data-loss footgun.


## ✅ DONE (Phase 12 — GPU cache fix + system-wide error capture + full audit)
- **Root cause of the user's GPU cache errors (proven, not guessed)**: a second
  `npm start` at 19:53 while the 19:46 instance was still running. B quit via
  the single-instance lock BUT `app.whenReady()` was OUTSIDE the `else` ->
  B booted through Logger init + Chromium GPU-cache init -> "Access is denied
  (0x5)" x6 in stderr. main.log showed the double boot (two 19:53:09 inits,
  only one "window initialized").
- **main.js**: `app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')`
  (HW accel stays ON); `whenReady` block moved INSIDE the single-instance else;
  `process.on(uncaughtException/unhandledRejection)`,
  `app.on(render-process-gone/child-process-gone)` -> recordError;
  `process.stderr.write` interceptor matching Chromium's REAL format
  `[PID:ts:ERROR|WARNING|FATAL:file(line)] msg` (anchor is ":ERROR:", NOT
  "[ERROR:" — first attempt was wrong, caught by testing the user's exact
  lines; indexOf('[ERROR:') === -1 on them), gpu/cache files -> GPU_CACHE_FAIL,
  30 s per-file+level throttle, loop-guarded; Scheduler.setErrorRecorder wired.
- **scheduler.js**: health-check bug fixed — `entry.fn` never existed on routing
  chain entries ("entry.fn is not a function" on EVERY run, main.log 19:53:23);
  now a name->callFn map (_callGemini/_callGroq/_callKimi/_callOpenrouter);
  failures forwarded to the Error Center via injected recorder.
- **errorStore.js**: +5 catalog codes (CACHE_LOCKED, GPU_CACHE_FAIL,
  RENDERER_GONE, CHILD_PROCESS_GONE, CHROMIUM_ERROR); `source` field on entries
  ('app'/'chromium'/'system', explicit context.source or well-known label
  prefixes only); `list()` filter by source; `extractCode()` now honors
  explicit err.code when it is a catalog code (was returning UNKNOWN for
  RENDERER_GONE — caught by the live render-kill test).
- **UI (index.html/app.js)**: Source column + "All sources/App/Chromium/System"
  filter in the Error Center; live-push + refresh honour it.
- **Evidence**: `node --check` x4 exit 0; verify-all exit 0; errprobe (real
  renderer): Source col renders, 21 guide cards, rendererErrors []; unit test:
  source filter + code mapping (RENDERER_GONE/CHILD_PROCESS_GONE/429);
  stderr-regex test matches ALL of the user's exact error lines; live render-kill
  test -> errors.json entry written; double-launch test -> second instance exits
  with ZERO cache errors and never boots (main.log has no second init);
  section audit (all 9 views): every key control present, consoleErrorsBySection
  = []; final `npm start` clean (stderr len=0).
- **Backup**: `Desktop\autodash-BACKUP-p12-20260921-200917` (66 files).
- **Known cosmetic**: killing a renderer mid-run prints electron-internal
  "Error sending from webFrameMain" stacks (dead webContents during
  logger/recordError send) — harmless, app survives; not fixed.

## ✅ DONE (Phase 11 — Logs Section: Terminal + Error Center + Guide)
## ✅ DONE (Phase 11 — Logs Section: Terminal + Error Center + Guide)
- **Backup**: `Desktop\autodash-BACKUP-logs-20260921-*` (pre-change full copy).
- **Deps**: `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`,
  `@xterm/addon-search@0.16.0`, `@xterm/addon-serialize@0.14.0`; built UMD files
  + css vendored to `src/renderer/vendor/xterm/` (CSP-safe + offline; CDN was
  impossible under `script-src 'self'`, proven by CSP line in index.html).
- **default-config.json**: new `logsConfig` (terminalMaxLines 5000,
  errorRetentionDays 30, autoScroll, showTimestamps, errorCenterEnabled).
- **`src/modules/errorStore.js` (NEW)**: `runs/errors.json` store — `buildEntry`
  (HTTP 4xx/5xx + local `ERR_*` codes -> name/cause/fix via catalog),
  `save/list/clear/resolve/export/exportCsv/autoCleanup/catalog`, atomic writes.
- **logger.js**: `terminal(msg)` timestamped wrapper (log.info + reaches UI via
  the existing `log:new` stream; no duplicate channel added).
- **main.js**: `errors:list/save/clear/resolve/export/catalog` handlers +
  `errors:new` push; error capture at `chat:stream`, `prompts:runOne`,
  `system:checkOnline`; `logger.terminal()` emission in scheduler
  (start/finish, per-prompt send/ok/fail, provider retry-switch, file writes)
  and apiManager (provider call attempt/complete).
- **preload.js**: errors* + onErrorNew channels exposed.
- **index.html**: Logs view -> 3 tabs (Terminal / Error Center / Guide), xterm
  container + toolbar (Clear/Copy/Download/Search), errors table + filter +
  badge, guide mount, vendor scripts + xterm css.
- **styles.css**: `.logs-tabs/.logs-panel`, toolbar, error table w/ severity
  dots + resolved strikethrough rows, guide typography, terminal container.
- **app.js**: tab switching, xterm init (fit/search/serialize), `log:new` ->
  ANSI-colored terminal lines (level colors, cap = terminalMaxLines), search,
  copy/download; Error Center (load/filter/resolve/clear/export, live
  `errors:new` inserts, nav badge); Guide rendered from the errorStore catalog
  (16 cards + quick-reference table, single source of truth).
- **Gates**: `node --check` x7 exit 0; config JSON OK; `verify-all.js` exit 0;
  xterm probe in a real renderer: all 4 globals present, 3 tabs switch, log
  line visible in xterm, 2 synthetic errors listed + badge "2", 16 guide
  cards/table rows, `rendererErrors: []`; `npm start` clean (stderr empty).
- **Note**: xterm paints buffered lines ~300 ms AFTER the Logs view becomes
  visible (rAF pipeline post-fit) — cosmetic latency, no data loss (proved with
  a timing harness sampling at 50/150/300/600/1000/1600 ms).
- **Note**: probe harnesses live in `%TEMP%` (`autodash-logs-probe.js`,
  `autodash-xterm-diag.js`, `autodash-xterm-timing.js`); run them with
  `node_modules\electron\dist\electron.exe <script>` from the repo root —
  plain `node` fails (no `electron` module / `app.setPath` undefined).

## ✅ DONE (Phase 9 — Advanced Smart Features)
## ✅ DONE (Phase 9 — Advanced Smart Features)
- **ISSUE 1 Groq 404**: verified URL is correct (`https://api.groq.com/openai/v1/chat/completions` with `/openai`); 404 is a key/config issue, not URL. Logged at INFO via `apiManager.js`.
- **ISSUE 2 Race condition**: `generateStructureCode` wrapped in `_withRetry()` with exponential backoff `[0, 2000, 8000, 30000]`ms (FEATURE A); `scheduler.js` `executeWorkflow()` has dedupe guard (queue pattern, not flag).
- **ISSUE 3 Minimize bug**: `main.js` `minimize` handler is empty (normal minimize); only `close` hides to tray.
- **ISSUE 4 Gemini 429**: `apiKeys[]` array support + `getNextGeminiKey()` rotation (`apiManager.js`); "Additional Keys" textarea added to AI Settings (`index.html` + `app.js`).
- **ISSUE 5 Prompts not loading**: scheduler falls back to legacy `prompts.txt` ONLY when folder has zero `.txt` files (placeholder-aware); `app.js` calls `loadPromptFolders()` on DOMContentLoaded + 5s auto-refresh; folder counters `#frontendCount`/`#backendCount` added.
- **FEATURE A**: Smart retry with exponential backoff (`_withRetry`, RETRY_DELAYS).
- **FEATURE B**: Live streaming responses — `_callGemini` uses `generateContentStream`, emits chunks via `StreamBus` → `api:stream` IPC → renderer log panel.
- **FEATURE C**: Prompt templates library — `prompts/templates/` JSON files + "Load Template" dropdown in Prompts view (to be populated by user).
- **FEATURE D**: Run history — `runs/history.json` (max 20), recorded in scheduler `finally` block with `{timestamp, durationMs, frontend, backend, provider, status, files}`.
- **FEATURE E**: Provider health check — `healthCheckProviders()` pings each enabled provider before workflow, logs `Provider <name>: OK (<ms>)` / `FAIL`.
- **FEATURE F**: Notification actions — `system:notify` supports `actions` param, emits `system:notify:action` IPC; silent mode routes to tray balloon.
- **All files**: `node --check` passed (apiManager, scheduler, main.js, preload.js, app.js); config JSON valid; Electron UI harness: `rendererErrors: []`.



## 2026-09-24 - Live AI Chat fixed + persistent sessions
- ROOT CAUSE: dead chat key (401) used `break` in chat:stream-route key loop -> valid automation key never tried. Now `continue` + `deadChatKeys` session Set + `lastGoodChatKey` resume; MAX_ATTEMPTS 6->14; keys deduped.
- main.js: chats:list/get/upsert/delete IPC -> ChatStore (list/get/upsert/remove; runs/chats.json); files:readText handler (any abs path, 1 MB cap) for chat attachments.
- preload.js: listChatSessions/getChatSession/saveChatSession/deleteChatSession, readTextFile.
- AiChat.jsx fully rewritten: render JSX (collapsible saved-chats sidebar, model select, routing toggle, TTS, mic lang, voice chat, message list, attach/mic/textarea input) using CSS vars + framer-motion + lucide-react + toast (no Tailwind).
- Verified: vite build green; probe: 401 chat key skipped -> automation key; stored model gemini-3.8-flash 503 -> fallback gemini-3.5-flash-lite answered; ChatStore roundtrip OK. Probe deleted.

## 2026-09-24 (evening) - AiChat black-screen fix + configurable output folder structure
- BLACK SCREEN ROOT CAUSE: AiChat.jsx chat-stream `useEffect` was missing its closing `}, []);` — a stray closer sat after `attachTextFile`, so `refreshSessions/newChat/openSession/deleteSession/toggleMic/attachTextFile` were declared INSIDE the effect closure (out of render scope) -> ReferenceError at render -> whole dashboard black. Vite build still passed (valid syntax, wrong scope). Fixed: closer moved to right after the effect's return.
- Output Folder Structure (user request): folders created inside the generated Dashboard folder are now configurable via `fileConfig.outputFolders` (default `['frontend','backend']` — assets/database removed).
  - `fileManager.scaffoldProject(basePath, backupExisting, folders)` — 3rd param, sanitized (no `..`, no leading slashes), defaults to frontend+backend.
  - `scheduler.js` passes `fileConfig.outputFolders` into scaffold.
  - `apiManager.loadMasterPrompt()` appends a MANDATORY "OUTPUT FOLDER STRUCTURE" block listing the configured folders and instructing the AI to decide per-file placement (UI -> frontend, server/DB -> backend).
  - `prompts/master-system-prompt.txt` rule 4 rewritten: only frontend/ + backend/, DB files inside backend/db/, assets inside frontend/assets/.
  - `ui/src/views/Prompts.jsx`: new "Output Folder Structure" card (textarea, one folder per line, Save via `mergeConfig('fileConfig', {outputFolders})`).
- Verified: `node --check` x4 OK; vite build green (2299 modules, new bundle index-CiQjLHL5.js); live scaffold probe: custom + default both create ONLY backend+frontend.


## 2026-09-30 — Dashboard audit (2 bugs fixed)
- **P0** Force Run button stuck on "Running…" + disabled after any run that
  finished without an approval gate (`running` state never reset). Fixed with an
  explicit terminal-state reset in `Dashboard.jsx` (`paused` excluded).
- **P1** "N files generated" KPI inflated ~4.5x — `writtenFiles` append-only
  across prompts, shared files counted repeatedly (41 entries = 9 unique paths).
  Fixed with `[...new Set(writtenFiles)]` in `scheduler.js` + migrated the 11
  existing runs in `runs/history.json` (279 -> 77). Backup kept.
- Disproved (do not re-audit): missing preload methods, missing terminal status
  broadcast, `config:get` shape, CountUp, `runs:history` path.
- Gates: `node --check` x3 exit0, `vite build` exit0, bundle grep PASS.


## 2026-09-30 — Skills: SEO + Performance default-on
- SEO (`seo-content` p15, `seo-advanced` p10) verified ACTIVE in both chat and
  automation pipelines; `enabledByDefault:true` already correct in file + built-in.
- `performance` (p50) flipped to `enabledByDefault:true` in BOTH
  `skills/performance.json` and `src/modules/skillRegistry.js` (file overrides
  built-in, so one-sided edits silently do nothing).
- Effective prompt: chat 9,423 chars / 7 skills, automation 10,726 / 8 skills.
- Still off: nothing. `data-integrity` stays automation-only by design.

