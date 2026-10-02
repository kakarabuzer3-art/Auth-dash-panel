/**
 * @file main.js
 * @description Main entry point for Electron. Handles window lifecycle, security, System Tray, and IPC integration.
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const notifier = require('node-notifier');

// ===========================================================================
// FAST SECOND-INSTANCE EXIT + INSTANT WINDOW REUSE (2026-09-29 startup fix)
// ---------------------------------------------------------------------------
// WHY THIS LIVES AT THE TOP OF THE FILE: the desktop shortcut used to start
// `cmd -> npm start -> node(cli.js) -> electron` (npm boot alone measures
// ~1.4 s here), and whenever the app was ALREADY running (tray/minimized - the
// common case) the duplicate process still evaluated this ENTIRE module graph
// (scheduler + apiManager -> @google/genai, axios, electron-store, nut-js...)
// before it reached requestSingleInstanceLock() and quit. So one click felt
// like a slow launch even though nothing needed to be launched at all.
//
// NOW: the lock is taken BEFORE the heavy requires. A duplicate hands the click
// to the running instance and exits in milliseconds; the running instance
// restores/focuses its window immediately (see restoreMainWindow below).
// ===========================================================================
let mainWindow = null;
let tray = null;
// Set when a second click arrives while THIS instance is still booting (no
// window yet): createWindow() honours it on ready-to-show instead of silently
// dropping the user's click.
let pendingRestore = false;

/**
 * Brings the existing window to the front - tray-hidden, minimized or behind
 * another app, all resolve to "show + focus". Safe to call at any time.
 */
function restoreMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        pendingRestore = true; // still booting - createWindow() will finish it
        return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    pendingRestore = false;
    try { log.info('Second launch request - existing window restored and focused.'); } catch (e) { /* never break the click */ }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
    // Nothing to do in a duplicate: do NOT load the module graph, do NOT build
    // a tray, do NOT touch the encrypted store - just exit.
    app.quit();
    process.exit(0);
}
// Registered BEFORE whenReady/heavy requires so a click that lands while this
// instance is still booting is never lost (Electron delivers the event from the
// event loop, i.e. after main.js finished evaluating).
app.on('second-instance', restoreMainWindow);

// Import Backend Modules
const Scheduler = require('./src/modules/scheduler');
const ApiManager = require('./src/modules/apiManager');
const ClineAuto = require('./src/modules/clineAutomation');
const Encrypt = require('./src/modules/encryption');
const Logger = require('./src/modules/logger');
const ErrorStore = require('./src/modules/errorStore');
const ChatStore = require('./src/modules/chatStore');
const FileManager = require('./src/modules/fileManager');
const Xampp = require('./src/modules/xampp');
// Skills = reusable prompt modules (persona + SEO/honesty/security rules) that the
// system prompt is composed from; McpManager = stdio JSON-RPC client for local
// Model Context Protocol tool servers. Both are wired in AI Settings > Skills & MCP.
const SkillRegistry = require('./src/modules/skillRegistry');
const McpManager = require('./src/modules/mcpManager');
// Pure helpers for MODEL-DRIVEN MCP tool use in chat (stream guard + request
// parser). No Electron dependency, so probe-mcp.js can cover every branch.
const ChatToolLoop = require('./src/modules/chatToolLoop');
// Pure payload normalizer for the chat router - unit-testable without Electron
// (see src/modules/chatPayload.js for why the renderer payload needs repair).
const { normalizeChatMessages } = require('./src/modules/chatPayload');

// PART 2: scheduler health-check failures reach the Error Center via this hook.
Scheduler.setErrorRecorder((err, ctx) => recordError(err, ctx));

// FEATURE B bridge: forward live AI token chunks (ApiManager.StreamBus) to the
// renderer's log panel. Same pattern as logger.js's `log:new` stream: the window
// is resolved at emit time, so this keeps working if the window is recreated.
ApiManager.StreamBus.on('chunk', (chunk) => {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0 && !windows[0].isDestroyed()) {
            windows[0].webContents.send('api:stream', chunk);
        }
    } catch (err) {
        // Live streaming must never break a generation run.
    }
});

// Window/tray handles + the pending-restore flag are declared at the very top of
// this file, BEFORE the fast single-instance check (see that block for why).

/**
 * Creates the main application window with strict security constraints.
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1366,
        height: 768,
        minWidth: 1024,
        minHeight: 600,
        show: false, // Don't show until ready-to-show
        icon: path.join(__dirname, 'src/renderer/assets/icons/icon-v2.ico'), // modern gradient bolt icon (taskbar + title bar)
        webPreferences: {
            nodeIntegration: false, // Security: Disable Node in renderer
            contextIsolation: true, // Security: Isolate window context
            sandbox: true,          // Security: Enable sandbox
            preload: path.join(__dirname, 'preload.js')
        },
        autoHideMenuBar: true,
        skipTaskbar: false,
    });

    // Microphone for Live AI Chat voice input. Electron grants permissions by
    // default; this handler makes 'media' explicit so getUserMedia() can never
    // fail silently, while every other permission keeps the previous behaviour.
    try {
        const ses = mainWindow.webContents.session;
        ses.setPermissionRequestHandler((_wc, permission, callback) => {
            if (permission === 'media' || permission === 'audioCapture') return callback(true);
            callback(true); // parity with Electron's default grant policy
        });
        ses.setPermissionCheckHandler((_wc, permission) => {
            if (permission === 'media' || permission === 'audioCapture') return true;
            return true; // parity with Electron's default grant policy
        });
        log.info('Media permission handlers installed (microphone available to the chat view).');
    } catch (err) {
        log.warn(`Could not install the media permission handler: ${err.message}`);
    }

    // React UI (Vite build in ui/ -> src/renderer/react) with automatic
    // fallback to the legacy UI if the React build is missing.
    const reactIndexPath = path.join(__dirname, 'src/renderer/react/index.html');
    if (fs.existsSync(reactIndexPath)) {
        mainWindow.loadFile(reactIndexPath);
        log.info('Renderer: React UI (src/renderer/react) loaded.');
    } else {
        mainWindow.loadFile(path.join(__dirname, 'src/renderer/index.html'));
        log.info('Renderer: React build not found — legacy UI loaded.');
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        // A second click arrived while we were booting - honour it now.
        if (pendingRestore) { mainWindow.focus(); pendingRestore = false; }
        log.info('Application window initialized and displayed.');
    });

    // ISSUE 3 FIX: minimize behaves NORMALLY — no preventDefault, no hide.
    mainWindow.on('minimize', () => {
        log.info('Window minimized.');
    });

    // Close: hide to tray if enabled (with a one-time background balloon)
    mainWindow.on('close', (e) => {
        const cfg = Encrypt.getConfig('appConfig') || {};
        if (cfg.closeToTray && !app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
            if (tray && !mainWindow._trayBalloonFired) {
                mainWindow._trayBalloonFired = true;
                tray.displayBalloon({ title: 'AutoDash Control Panel', content: 'Running in background. Click the tray icon to reopen.' });
            }
        }
    });

    // tray-notify bridge: intercept automation:status payloads carrying
    // state === 'tray-notify' and surface them as a tray balloon, without
    // touching scheduler.js. Must be installed before the scheduler runs.
    const origSend = mainWindow.webContents.send.bind(mainWindow.webContents);
    mainWindow.webContents.send = (channel, payload) => {
        if (channel === 'automation:status' && payload && payload.state === 'tray-notify') {
            if (tray) tray.displayBalloon({ title: payload.title, content: payload.message });
        }
        return origSend(channel, payload);
    };

    mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * Initializes the System Tray
 */
function createTray() {
    const iconPath = path.join(__dirname, 'src/renderer/assets/icons/icon-v2.ico');
    if (!require('fs').existsSync(iconPath)) {
        log.warn('Tray icon not found, skipping tray creation.');
        return;
    }
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Dashboard', click: () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } } },
        { label: 'Minimize', click: () => { if (mainWindow) mainWindow.minimize(); } },
        { label: 'Force Run Now', click: () => Scheduler.forceRun() },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
    tray.setToolTip('AutoDash Control Panel');
    tray.setContextMenu(contextMenu);

    function restoreTrayWindow() {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
    tray.on('double-click', restoreTrayWindow);
    tray.on('click', restoreTrayWindow);
}

// App Lifecycle Hooks
// === GPU CACHE FIX === Chromium locks the shader disk cache per userData dir,
// so a second booting instance (or a crashed leftover) hits "Unable to move the
// cache: Access is denied (0x5)" / "Gpu Cache Creation failed: -2". Skipping
// the shader cache costs a few recompiled shaders and removes that failure path
// entirely; hardware acceleration itself stays ON.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

    // The single-instance lock AND the 'second-instance' -> restoreMainWindow
    // listener are already installed at the TOP of this file (fast path, before
    // the heavy module graph loads). This block only preserves the original
    // structure/indentation of the startup work that follows.
    {

        // PART 2: system-wide error capture — every failure, not just the ones
        // passing through the IPC choke points below, lands in the Error Center.
        // a) Node-level: uncaught exceptions and unhandled rejections.
        ['uncaughtException', 'unhandledRejection'].forEach((evt) => {
            process.on(evt, (reason) => {
                const err = reason instanceof Error
                    ? reason
                    : new Error(String((reason && reason.message) || reason || evt));
                try { recordError(err, { label: `system:${evt}` }); } catch (e) { /* reporting must never crash the app */ }
            });
        });

        // b) Electron-level: crashed renderer / child (GPU, utility) processes.
        app.on('render-process-gone', (_event, _webContents, details) => {
            const err = new Error(`Renderer process gone: ${details && details.reason} (exitCode ${details && details.exitCode})`);
            err.code = 'RENDERER_GONE';
            try { recordError(err, { label: 'system:render-process-gone' }); } catch (e) { /* ignore */ }
        });
        app.on('child-process-gone', (_event, details) => {
            const err = new Error(`Child process gone: ${details && details.type} - ${details && details.reason} (exitCode ${details && details.exitCode})`);
            err.code = 'CHILD_PROCESS_GONE';
            try { recordError(err, { label: 'system:child-process-gone' }); } catch (e) { /* ignore */ }
        });

        // c) Chromium/low-level errors written to stderr, e.g.
        //    "[21124:0921/195309.840:ERROR:cache_util_win.cc(20)] Unable to move the cache".
        //    NOTE the leading token is the PID, so the anchor is ":ERROR:" not
        //    "[ERROR:" (verified against the user's actual npm start output).
        //    Loop-guarded (recordError -> log.error -> stderr) and throttled per
        //    source file + level so a spamming subsystem cannot flood errors.json.
        const originalStderrWrite = process.stderr.write.bind(process.stderr);
        let lastChromiumKey = ''; let lastChromiumAt = 0;
        process.stderr.write = function (chunk, encoding, callback) {
            try {
                const match = String(chunk).match(/\[([^\]]*?):(ERROR|WARNING|FATAL):([^\]]+)\]\s*(.+)/);
                if (match) {
                    const level = match[2];
                    const key = match[3] + ':' + level;
                    const now = Date.now();
                    if (!(key === lastChromiumKey && now - lastChromiumAt < 30000)) {
                        lastChromiumKey = key; lastChromiumAt = now;
                        const err = new Error((level !== 'ERROR' ? '[' + level + '] ' : '') + match[4].trim());
                        err.code = /gpu|cache/i.test(match[3]) ? 'GPU_CACHE_FAIL' : 'CHROMIUM_ERROR';
                        recordError(err, { source: 'chromium', label: `chromium:${match[3]}(${level.toLowerCase()})` });
                    }
                }
            } catch (e) { /* never break stderr */ }
            return originalStderrWrite(chunk, encoding, callback);
        };

        app.whenReady().then(() => {
    Logger.init(); // Initialize electron-log
    // WINDOW-FIRST BOOT (2026-09-29 startup fix): createWindow() used to run
    // AFTER the prompt-folder setup and the config migration below. Those touch
    // the encrypted store / disk, so every millisecond of them delayed the first
    // paint. The window now starts loading immediately; the housekeeping work
    // (which only matters for a RUN, never for the UI) happens right after.
    createWindow();
    createTray();
    Scheduler.initSchedule(); // BUGFIX: scheduler was never initialized

    // Folder-based prompt system: create prompts/frontend + prompts/backend so
    // the ordered prompt manager always has its directories (idempotent).
    try {
        PromptManager.ensureFolderStructure(resolvePromptsDirectory());
        log.info('Prompt folder structure verified (frontend/ + backend/).');
    } catch (pmErr) {
        log.warn(`Prompt folder setup skipped: ${pmErr.message}`);
    }
    // One-time migration: move deprecated Groq model id to the supported one.
    // Idempotent — only rewrites config when the stale value is present.
    try {
        const providersCfg = Encrypt.getConfig('providers') || {};
        const DEPRECATED_GROQ_MODEL_IDS = ['llama-3.1-8b-instant', 'llama-3.1-70b-versatile', 'llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b'];
        if (providersCfg.groq && DEPRECATED_GROQ_MODEL_IDS.includes(providersCfg.groq.model)) {
            Encrypt.saveConfig('providers', {
                ...providersCfg,
                groq: { ...providersCfg.groq, model: 'openai/gpt-oss-120b' }
            });
            log.info('Migrated deprecated Groq model to openai/gpt-oss-120b');
        }
    } catch (migErr) {
        log.warn(`Groq model migration skipped: ${migErr.message}`);
    }

    // MCP: seed the first-party tool server on first run, then CONNECT it.
    // Deferred to the next tick so the window keeps painting first (the spawn +
    // handshake is real process work and used to have no owner at all). Failures
    // are logged, never thrown - a broken tool server must not break the app.
    setTimeout(() => {
        try {
            const seed = McpManager.ensureSeeded();
            if (seed.seeded) log.info(`MCP: bundled server seeded (${seed.added.join(', ')}).`);
        } catch (seedErr) {
            log.warn(`MCP seed skipped: ${seedErr.message}`);
        }
        McpManager.autoConnect()
            .then((report) => {
                if (report.skipped) log.info(`MCP auto-connect skipped: ${report.skipped}`);
                else log.info(`MCP auto-connect: ${report.ready}/${report.attempted} server(s) ready.`);
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('mcp:status', McpManager.status());
                    }
                } catch (e) { /* window busy/closed */ }
            })
            .catch((err) => log.warn(`MCP auto-connect failed: ${err.message}`));
    }, 400);

    // Background verification hook: with AD_FORCE_RUN=1 the app presses
    // "Force Run Now" once, 4s after boot — used for headless end-to-end
    // testing without touching the UI. No effect unless the env var is set.
    if (process.env.AD_FORCE_RUN === '1') {
        setTimeout(() => {
            log.info('AD_FORCE_RUN=1 detected — auto-pressing Force Run for background verification.');
            Scheduler.forceRun();
        }, 4000);
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    });
    } // closes the boot block (lock/single-instance guard lives at the top of this file)

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    app.isQuitting = true;
    // MCP tool servers are child processes: never leave them orphaned.
    try {
        const stopped = McpManager.stopAll();
        if (stopped.length) log.info(`MCP servers stopped on quit: ${stopped.join(', ')}`);
    } catch (error) {
        try { log.warn(`MCP shutdown on quit failed: ${error.message}`); } catch (e) { /* ignore */ }
    }
});

// ==========================================
// IPC Main Handlers (The Bridge)
// ==========================================

// --- Logs > Error Center ---------------------------------------------------
// Central capture point: classify a failure, persist it to runs/errors.json
// (ErrorStore) and push it to the renderer so the Error Center tab updates live.
// Never throws - error reporting must not be able to break a workflow run.
function recordError(err, context = {}) {
    try {
        const cfg = Encrypt.getConfig('logsConfig') || {};
        if (cfg.errorCenterEnabled === false) return null;
        const entry = ErrorStore.buildEntry(err, context);
        const saved = ErrorStore.save(entry) || { entry, deduped: false };
        const stored = saved.entry || entry;
        if (saved.deduped) {
            // Same unresolved failure already listed — save() bumped its
            // timestamp/count. Skip the renderer push/toast so repeated
            // identical failures cannot flood the Error Center badge.
            log.error(`[ErrorCenter] duplicate ${stored.code} (now x${stored.count || 2}) — bumped existing entry.`);
            return stored;
        }
        log.error(`[ErrorCenter] ${stored.code} ${stored.codeName}${stored.provider ? ' [' + stored.provider + ']' : ''}: ${String(stored.message || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('errors:new', stored);
        }
        return stored;
    } catch (captureError) {
        try { log.warn(`Error Center capture skipped: ${captureError.message}`); } catch (e) { /* ignore */ }
        return null;
    }
}

ipcMain.handle('errors:list', async (event, filter) => {
    try {
        return { success: true, errors: ErrorStore.list(filter || {}) };
    } catch (error) {
        log.error(`errors:list failed: ${error.message}`);
        return { success: false, error: error.message, errors: [] };
    }
});

ipcMain.handle('errors:save', async (event, payload) => {
    try {
        const entry = (payload && payload.code !== undefined)
            ? payload
            : ErrorStore.buildEntry(payload || new Error('Unknown error'));
        ErrorStore.save(entry);
        return { success: true, entry };
    } catch (error) {
        log.error(`errors:save failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('errors:clear', async () => {
    try {
        ErrorStore.clear();
        return { success: true };
    } catch (error) {
        log.error(`errors:clear failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('errors:resolve', async (event, id) => {
    try {
        return { success: ErrorStore.resolve(id) };
    } catch (error) {
        log.error(`errors:resolve failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('errors:export', async (event, format) => {
    try {
        return Object.assign({ success: true }, ErrorStore.exportData(format === 'csv' ? 'csv' : 'json'));
    } catch (error) {
        log.error(`errors:export failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('errors:catalog', async () => {
    try {
        return Object.assign({ success: true }, ErrorStore.catalog());
    } catch (error) {
        log.error(`errors:catalog failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// FEATURE: run history read-back for the Dashboard. scheduler.js writes
// runs/history.json, but NO IPC ever exposed it — the React UI had no real
// KPI data path (Success Rate / Total Runs / Recent Runs were impossible).
ipcMain.handle('runs:history', async () => {
    try {
        const fsp = require('fs');
        const pathm = require('path');
        const candidates = [
            pathm.join(__dirname, 'runs', 'history.json'),          // repo root (errorStore's target)
            pathm.join(process.cwd(), 'runs', 'history.json'),      // cwd fallback (scheduler's write path)
        ];
        const file = candidates.find(f => fsp.existsSync(f));
        if (!file) return { success: true, history: [] };
        const history = JSON.parse(fsp.readFileSync(file, 'utf8'));
        return { success: true, history: Array.isArray(history) ? history : [] };
    } catch (error) {
        log.warn(`runs:history failed: ${error.message}`);
        return { success: true, history: [] };
    }
});

ipcMain.handle('config:get', async (event, moduleName) => {
    try {
        return Encrypt.getConfig(moduleName);
    } catch (error) {
        log.error(`Error fetching config for ${moduleName}: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('config:save', async (event, { moduleName, data }) => {
    try {
        Encrypt.saveConfig(moduleName, data);
        return { success: true };
    } catch (error) {
        log.error(`Error saving config for ${moduleName}: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Storage safety report for the UI (which key source unlocked the store, and
// whether any module failed to decrypt and is therefore write-protected).
ipcMain.handle('config:health', () => {
    try {
        return { success: true, health: Encrypt.configHealth() };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('automation:start', async (event, payload) => {
    log.info('Manual automation start triggered via UI.');
    Scheduler.forceRun(payload);
    return { success: true };
});

// BUGFIX: handlers for channels exposed by preload.js were missing
ipcMain.handle('automation:stop', async () => {
    log.info('Manual automation stop triggered via UI.');
    Scheduler.stop();
    return { success: true };
});

// Pause / Resume / Force-Run controls (new scheduler state machine)
ipcMain.handle('automation:pause', () => Scheduler.pause());
ipcMain.handle('automation:resume', () => Scheduler.resume());
ipcMain.handle('automation:approve-next', (_event, approvalId) => Scheduler.approveNextPrompt(approvalId));
ipcMain.handle('automation:decline-next', (_event, approvalId) => Scheduler.declineNextPrompt(approvalId));
ipcMain.handle('automation:pending-approval', () => Scheduler.getPendingApproval());
ipcMain.handle('automation:force-run', () => Scheduler.forceRun());
ipcMain.handle('api:fetch-models', (_e, provider) => ApiManager.fetchModels(provider));
// Key health check (2026-09-23): lists models only, so it consumes NO
// generation quota. Pressing it can never eat into the daily allowance.
ipcMain.handle('api:probe-key', async (event, { provider, key }) => {
    try {
        return { success: true, probe: await ApiManager.probeKey(provider, key) };
    } catch (error) {
        log.warn(`Key probe failed (${provider}): ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Test Connection (2026-09-23): ApiManager.testConnection now returns a
// structured verdict instead of throwing raw provider JSON, so the UI can say
// "key VALID, quota spent" instead of dumping Google's error body. `result`
// stays a plain string for backwards compatibility; `detail` holds the data.
ipcMain.handle('api:test', async (event, { provider, key }) => {
    try {
        const detail = await ApiManager.testConnection(provider, key);
        if (detail && detail.ok) {
            return { success: true, result: detail.message, detail };
        }
        return { success: false, error: (detail && detail.message) || 'Test failed.', detail };
    } catch (error) {
        log.error(`API test failed (${provider}): ${error.message}`);
        const info = ApiManager.classifyProviderError(error, provider);
        recordError(error, { provider, label: `API key test (${provider})` });
        return {
            success: false,
            error: info.message || error.message,
            detail: { ok: false, code: 'EXCEPTION', keyValid: false, suggestions: info.suggestions },
        };
    }
});

ipcMain.handle('chat:stream', async (event, payload) => {
    try {
        await ApiManager.chatStream(payload, (chunk) => {
            event.sender.send('chat:stream', chunk);
        });
        return { success: true };
    } catch (error) {
        log.error(`Chat stream error: ${error.message}`);
        recordError(error, { provider: (payload && payload.provider) || '', model: (payload && payload.model) || '', label: 'Live AI Chat' });
        return { success: false, error: error.message };
    }
});

// === AGENTIC CHAT TOOLS (live as of the React UI upgrade) ===
// 1) Web Search — keyless DuckDuckGo scrape (RAG-style context for the AI).
ipcMain.handle('web:search', async (event, query) => {
    try {
        const q = String(query || '').slice(0, 300);
        if (!q.trim()) return { success: false, error: 'Empty query' };
        const res = await axios.get('https://duckduckgo.com/html/', {
            params: { q },
            timeout: 9000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        const html = String(res.data || '');
        // DDG html endpoint results: <a rel="nofollow" class="result__a" href="...">Title</a>
        const results = [];
        const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let m;
        while ((m = re.exec(html)) && results.length < 5) {
            let url = m[1];
            const uddg = url.match(/uddg=([^&]+)/);
            if (uddg) url = decodeURIComponent(uddg[1]);
            const title = m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
            if (title && url.startsWith('http')) results.push({ title, url });
        }
        log.info(`Web search "${q}": ${results.length} results`);
        return { success: true, results };
    } catch (error) {
        log.warn(`Web search failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// 2) Code Interpreter — sandboxed-ish runner: node -e with timeout + output cap.
//    User-triggered execution of AI-generated JS on their own machine (v1 scope).
ipcMain.handle('code:run', async (event, code) => {
    const { execFile } = require('child_process');
    const src = String(code || '');
    if (!src.trim()) return { success: false, error: 'No code provided' };
    if (src.length > 20000) return { success: false, error: 'Code too long (20KB max)' };
    return new Promise((resolve) => {
        let out = '', err = '', done = false;
        const child = execFile(process.execPath, ['-e', src], { timeout: 8000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
            done = true;
            out = String(stdout || '').slice(0, 8000);
            err = String(stderr || '').slice(0, 4000);
            resolve({
                success: !error,
                output: out,
                error: error ? (err || error.message) : (err || null),
                timedOut: error && error.killed === true,
            });
        });
        child.on('error', () => { if (!done) resolve({ success: false, error: 'Failed to spawn runner' }); });
    });
});

// FEATURE 3: Online/Offline status detection — pings Google + each enabled provider
// so the UI topbar dot can show online / partial / offline state.
// === SMART FAILOVER CHAT (2026-09-23) ===
// The legacy chat:stream pins ONE provider, so a single Gemini quota 429 ended
// the conversation with raw Google JSON. This channel walks the configured
// providers (preferred first) and rotates BOTH the key and the model on quota
// errors - Google meters free-tier quota per key, per model, per project - and
// reports failure only when every candidate is exhausted. The renderer still
// receives the same 'chat:stream' event stream, plus { type: 'route' } notices.
//
// SESSION KEY MEMORY (2026-09-24): keys that answered 401/invalid-key once are
// dead for the rest of the app session and are skipped at candidate build time
// (previously EVERY message re-tried the dead chat key for EVERY model, which
// is why chat felt broken). `lastGoodChatKey` remembers the key that produced
// the last successful answer so the NEXT message starts there - when a key's
// tokens run out mid-conversation, the walk below automatically borrows the
// next pool key and the conversation continues exactly where it stopped (the
// full message history is resent with every attempt).
const deadChatKeys = new Set();   // key -> 401 this app session (never retry)
let lastGoodChatKey = null;       // key that answered the last chat message

/**
 * CHAT-SIDE MCP TOOL COMMAND (2026-09-29).
 *
 * `/tool <tool_name> {"arg":"value"} [optional question]` in the Live AI Chat
 * executes a REAL local MCP tool and hands its REAL output to the model as
 * context for a normal streamed answer. This is deliberately explicit instead of
 * "the model may silently call a tool": the model's answer is then grounded in
 * output this app produced, and a missing/failing tool is reported honestly
 * instead of being hallucinated away.
 *
 * @returns {Promise<null|{tool:string,server:string,ms:number,ok:boolean,text:string}>}
 *          null when the message is not a /tool command. Mutates the last user
 *          turn so the model sees the tool result + the actual question.
 */
async function runChatToolCommand(messages, sender) {
    if (!Array.isArray(messages) || !messages.length) return null;
    let idx = messages.length - 1;
    while (idx >= 0 && messages[idx].role !== 'user') idx -= 1;
    if (idx < 0) return null;
    const raw = String(messages[idx].content || '').trim();
    const match = /^\/tool\s+([A-Za-z0-9_.:-]{1,80})\s*([\s\S]*)$/i.exec(raw);
    if (!match) return null;

    const toolName = match[1];
    let rest = match[2].trim();
    let args = {};
    let question = '';
    if (rest.startsWith('{') || rest.startsWith('[')) {
        const end = rest.lastIndexOf('}');
        if (end > 0) {
            const jsonPart = rest.slice(0, end + 1);
            question = rest.slice(end + 1).trim();
            try { args = JSON.parse(jsonPart); } catch (e) {
                throw new Error(`Invalid JSON arguments for /tool ${toolName}: ${e.message}`);
            }
        }
    } else if (rest) {
        question = rest; // no JSON block -> the rest is the question
    }

    const result = await McpManager.callToolAuto(toolName, args); // throws with an honest reason
    if (sender && !sender.isDestroyed()) {
        sender.send('chat:stream', {
            type: 'tool', tool: result.tool, server: result.server,
            ok: result.ok, ms: result.ms, text: String(result.text || '').slice(0, 4000),
        });
    }
    messages[idx] = {
        role: 'user',
        content: [
            '[MCP TOOL RESULT - executed locally by AutoDash; treat as real data, do not re-invent it]',
            `tool: ${result.tool} | server: ${result.server} | ${result.ms}ms | status: ${result.ok ? 'OK' : 'ERROR'}`,
            '---8<--- tool output start ---8<---',
            String(result.text || '').slice(0, 20000),
            '---8<--- tool output end ---8<---',
            '',
            '[USER QUESTION]',
            question || 'Explain this tool result, point out anything that looks wrong or missing, and give the next concrete step.',
        ].join('\n'),
    };
    log.info(`Chat /tool ${result.server}/${result.tool} -> ${result.ok ? 'OK' : 'ERROR'} in ${result.ms}ms - answer requested from the model.`);
    return { tool: result.tool, server: result.server, ms: result.ms, ok: result.ok, text: result.text };
}

ipcMain.handle('chat:stream-route', async (event, payload) => {
    const p = payload || {};
    // Repair the renderer payload (legacy `text` -> `content`, UI `ai` role ->
    // `assistant`, and a lone first-message `prompt` -> a real user turn).
    // Without this the FIRST message of every new chat failed with
    // "No messages to send." and later turns answered one message behind.
    // `let`, not `const`: the tool loop below appends the tool-result turn and
    // re-runs the provider chain (see the TOOL ROUNDS section at the end).
    let messages = normalizeChatMessages(p);
    const preferred = p.provider || 'gemini';
    const thinking = p.thinking || 'medium';
    if (!messages.length) return { success: false, error: 'No messages to send.' };

    // === MCP TOOL COMMAND (`/tool <name> {json}`) ===========================
    // Runs BEFORE any provider call so the model answers from a real tool result.
    let mcp = null;
    try {
        mcp = await runChatToolCommand(messages, event.sender);
    } catch (error) {
        log.warn(`Chat /tool command failed: ${error.message}`);
        if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('chat:stream', { type: 'tool', tool: '', server: '', ok: false, ms: 0, text: error.message });
        }
        return { success: false, error: error.message, tries: [], mcp: null };
    }
    const mcpSummary = mcp ? { tool: mcp.tool, server: mcp.server, ok: mcp.ok, ms: mcp.ms } : null;

    // === SYSTEM PROMPT (persona + ACTIVE SKILLS + live MCP catalog) ========
    // 2026-09-29 FIX: this router used to read `payload.systemPrompt` (which the
    // UI sent as '') and never touched aiConfig - so the AI Settings prompt box
    // had NO effect on chat. The renderer may still override explicitly; otherwise
    // the effective prompt is resolved from config + skills for the chat target.
    const systemPromptOverride = typeof p.systemPrompt === 'string' ? p.systemPrompt.trim() : '';
    const systemPrompt = systemPromptOverride || ApiManager.resolveSystemPrompt('chat');
    if (systemPrompt) log.info(`Chat route: system prompt ${systemPrompt.length} chars (override: ${systemPromptOverride ? 'yes' : 'no'}).`);

    const providers = Encrypt.getConfig('providers') || {};
    const order = [preferred, 'gemini', 'groq', 'kimi', 'openrouter'].filter((v, i, a) => v && a.indexOf(v) === i);
    const candidates = [];
    let sawStoredKey = false; // true when keys exist but all were dead-filtered
    for (const name of order) {
        const conf = providers[name] || {};
        let keys = [conf.apiKey, ...(Array.isArray(conf.apiKeys) ? conf.apiKeys : [])]
            .map(k => String(k || '').trim()).filter(Boolean);
        keys = [...new Set(keys)]; // the same key pasted twice must not burn attempts
        if (!keys.length) continue;
        sawStoredKey = true;
        // Skip keys that already answered 401 this app session - a dead key
        // can never come back, and re-trying it per model wasted 3 attempts.
        // ApiManager.isKeyDead covers keys the WORKFLOW/probe already rejected,
        // so chat and automation share one session memory.
        keys = keys.filter(k => !deadChatKeys.has(k) && !ApiManager.isKeyDead(name, k));
        if (!keys.length) continue;
        // KEY DEDICATION + BORROW (2026-09-24): pool[0] is the AUTOMATION key
        // (the scheduler always starts there - see apiManager.getNextGeminiKey),
        // the LAST pool key is the dedicated CHAT key. Chat walks the pool in
        // reverse so its own key is tried first; when that quota is spent the
        // loop below automatically "borrows" the automation key(s) - and
        // automation borrows the chat key the same way, in the opposite direction.
        if (name === 'gemini' && keys.length > 1) keys = [...keys.slice(1).reverse(), keys[0]];
        // SMART RESUME: the key that answered the previous message goes first -
        // continuity beats dedication when a borrow already happened.
        if (lastGoodChatKey && keys.includes(lastGoodChatKey)) {
            keys = [lastGoodChatKey, ...keys.filter(k => k !== lastGoodChatKey)];
        }
        candidates.push({ name, keys, model: (name === preferred && p.model) ? p.model : (conf.model || '') });
    }
    if (!candidates.length) {
        return {
            success: false,
            error: sawStoredKey
                ? 'Every stored API key was rejected (401) earlier in this session. Paste a fresh key in API Keys.'
                : 'No AI provider has an API key. Add one in API Keys.',
            tries: [],
        };
    }

    // === MODEL-DRIVEN TOOL LOOP (2026-10-01) ==============================
    // The provider chain below is wrapped in `runChain()` so it can run once per
    // tool round. When the model replies with a tool request instead of an
    // answer, the tool is executed for REAL, its output is appended, and the
    // model's follow-up streams into the SAME bubble (no 'end' is forwarded in
    // between). Bounded by ChatToolLoop.MAX_TOOL_ROUNDS; a model can only reach
    // tools on an ALREADY-RUNNING server (McpManager.callToolRunning).
    const tries = [];
    // Gemini alone can legitimately need 3 models x 2 keys = 6 tries, and other
    // providers add more - the old cap of 6 cut real fallbacks short.
    const MAX_ATTEMPTS = 14;
    let lastError = null; // recorded ONCE at the end - per-try recordError spammed
    let lastProvider = ''; // the Error Center + toast on every rotation step

    /** One provider-chain pass. Returns the answer, or a parsed tool request. */
    const runChain = async () => {
    let attempts = 0; // hard cap so a misconfigured chain can never loop
    for (const cand of candidates) {
        const models = [cand.model || ''].filter(Boolean);
        if (cand.name === 'gemini' && models.length) {
            try {
                const alts = await ApiManager.getGeminiModelFallbacks(models[0], cand.keys[0]);
                alts.forEach(m => { if (!models.includes(m)) models.push(m); });
            } catch (e) { /* offline: keep the configured model */ }
        }
        for (const model of models) {
            for (const apiKey of cand.keys) {
                if (attempts++ >= MAX_ATTEMPTS) {
                    if (lastError) recordError(lastError, { provider: lastProvider, label: 'Live AI Chat (auto-route)' });
                    return { success: false, error: `Stopped after ${MAX_ATTEMPTS} attempts - every candidate hit a limit.`, tries, mcp: mcpSummary };
                }
                let emitted = 0;
                // Guard: swallows a tool request so raw JSON never reaches the
                // user (or the saved conversation); passes normal text through.
                const guard = ChatToolLoop.createToolStreamGuard();
                let forwarded = '';
                let pendingEnd = null;
                let pendingStats = null;
                try {
                    await ApiManager.chatStream({ provider: cand.name, model, thinking, messages, apiKey, systemPrompt, promptTarget: 'chat' }, (chunk) => {
                        if (!chunk) return;
                        if (chunk.type === 'chunk') {
                            const out = guard.push(chunk.text);
                            if (!out) return;
                            emitted += 1;
                            forwarded += out;
                            event.sender.send('chat:stream', { type: 'chunk', text: out });
                            return;
                        }
                        // A repeated 'start' after a switch must not spawn a second
                        // bubble in the renderer - flag it so the UI reuses the
                        // pending answer bubble and shows a switch notice.
                        if (chunk.type === 'start' && tries.length) {
                            event.sender.send('chat:stream', { ...chunk, switched: true });
                            return;
                        }
                        // ROUTE MODE owns the retry UX: every failed try emits its
                        // own 'error' chunk + an EMPTY 'end' chunk internally.
                        // Forwarding those was exactly the "2 error messages, then
                        // the answer" bug - the router retries silently and only a
                        // REAL failure (every candidate exhausted) surfaces via the
                        // return value below.
                        if (chunk.type === 'error') return;
                        // 'end'/'stats' are held: if this answer turns out to be a
                        // tool request, the round must NOT finalise the bubble - it
                        // continues after the tool has really run.
                        if (chunk.type === 'end') { if (chunk.fullText) pendingEnd = chunk; return; }
                        if (chunk.type === 'stats') { pendingStats = chunk; return; }
                        event.sender.send('chat:stream', chunk);
                    });
                    if (tries.length) log.info(`Chat completed via fallback provider ${cand.name}/${model}.`);
                    // Remember the winning key: the next message starts here, so a
                    // mid-conversation quota burn resumes seamlessly on the SAME
                    // (borrowed) key instead of re-burning the spent one.
                    lastGoodChatKey = apiKey;
                    const switched = cand.name !== preferred || (!!p.model && model !== p.model);
                    const fin = guard.finish();
                    if (fin.requests.length) {
                        if (fin.text) event.sender.send('chat:stream', { type: 'chunk', text: fin.text });
                        log.info(`[chat] model requested ${fin.requests.length} MCP tool call(s): ${fin.requests.map((r) => r.tool).join(', ')}`);
                        return {
                            success: true, provider: cand.name, model, switched, tries,
                            mcp: mcpSummary, toolRequests: fin.requests, rawText: fin.buffer,
                        };
                    }
                    const tail = fin.text || '';
                    if (tail) event.sender.send('chat:stream', { type: 'chunk', text: tail });
                    if (pendingStats) event.sender.send('chat:stream', pendingStats);
                    if (pendingEnd) event.sender.send('chat:stream', { ...pendingEnd, fullText: forwarded + tail });
                    return {
                        success: true, provider: cand.name, model,
                        switched, tries, mcp: mcpSummary,
                    };
                } catch (error) {
                    const info = ApiManager.classifyProviderError(error, cand.name);
                    tries.push({ provider: cand.name, model, kind: info.kind, status: info.status, error: info.message });
                    // Silent rotation: intermediate failures are remembered for
                    // the attempt list and recorded ONLY if the whole chain fails
                    // (one Error Center entry per conversation, not per key).
                    lastError = error;
                    lastProvider = `${cand.name}/${model}`;
                    log.warn(`chat-route: ${cand.name}/${model} failed (${info.kind}).`);
                    event.sender.send('chat:stream', {
                        type: 'route', provider: cand.name, model, kind: info.kind,
                        message: `${cand.name}: ${info.kind === 'quota-exhausted' ? 'daily quota reached' : info.kind.replace(/-/g, ' ')} - switching automatically...`,
                    });
                    if (emitted > 0) {
                        return {
                            success: false, partial: true, provider: cand.name, model,
                            error: `Answer interrupted: ${cand.name} reported ${info.kind}.`, tries, mcp: mcpSummary,
                        };
                    }
                    // CRITICAL FIX (2026-09-24): a dead key must skip to the NEXT
                    // KEY, not break out of the key loop entirely. The old `break`
                    // jumped to the next MODEL, so when the dedicated chat key was
                    // dead (401) the valid automation key sitting after it in the
                    // pool was NEVER tried - chat failed on every provider, every
                    // model, every time. `continue` keeps cross-key borrowing alive.
                    if (info.kind === 'invalid-key') {
                        deadChatKeys.add(apiKey); // session memory: never retry this key
                        ApiManager.markKeyDead(cand.name, apiKey); // shared with the automation pool
                        continue; // -> next key in this provider's pool
                    }
                    // A model that does not exist (404 / retired) will fail for
                    // EVERY key - skip the remaining keys and move to the next
                    // model instead of burning attempts (2026-09-24: the retired
                    // gemini-2.5-* ids each wasted a full key sweep).
                    if (info.kind === 'bad-model') break;
                    // quota-exhausted / rate-limited / overloaded / network -> next key or model
                }
            }
        }
    }
        // The whole chain failed -> ONE Error Center entry (not one per key tried).
        if (lastError) recordError(lastError, { provider: lastProvider, label: 'Live AI Chat (auto-route)' });
        return {
            success: false,
            error: 'Every configured provider failed. See the attempt list and the Error Center.',
            tries, mcp: mcpSummary,
        };
    }; // === end of runChain() ===

    // === TOOL ROUNDS ======================================================
    // Up to ChatToolLoop.MAX_TOOL_ROUNDS provider passes per user turn. Every
    // requested tool runs for REAL against an already-connected server; its
    // honest output - or the honest failure reason - is appended and the model
    // gets one more pass. The user sees each execution as a 'tool' notice and
    // the follow-up text lands in the SAME answer bubble.
    let question = '';
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === 'user') { question = String(messages[i].content || ''); break; }
    }
    for (let round = 0; round < ChatToolLoop.MAX_TOOL_ROUNDS; round++) {
        const result = await runChain();
        if (!result.success || !Array.isArray(result.toolRequests) || !result.toolRequests.length) return result;
        if (round === ChatToolLoop.MAX_TOOL_ROUNDS - 1) {
            log.warn(`Tool budget (${ChatToolLoop.MAX_TOOL_ROUNDS} provider rounds) reached - returning the last answer.`);
            // No more passes are coming, so finalise the bubble for renderers
            // that rely on the 'end' event instead of the promise result.
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('chat:stream', { type: 'end', fullText: '' });
            }
            return result;
        }
        const runs = [];
        for (const req of result.toolRequests) {
            const started = Date.now();
            try {
                const r = await McpManager.callToolRunning(req.tool, req.args);
                runs.push({ tool: r.tool, server: r.server, ok: r.ok, ms: r.ms, text: r.text });
            } catch (error) {
                // Honest failure: the model is told WHY, so it stops instead of
                // pretending the tool produced data.
                runs.push({ tool: req.tool, server: '', ok: false, ms: Date.now() - started, text: error.message });
            }
            const last = runs[runs.length - 1];
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('chat:stream', {
                    type: 'tool', tool: last.tool, server: last.server,
                    ok: last.ok, ms: last.ms, text: String(last.text || '').slice(0, 4000),
                });
            }
        }
        log.info(`Tool round ${round + 1}: ${runs.map((r) => `${r.tool}=${r.ok ? 'OK' : 'ERROR'}`).join(', ')}`);
        messages = [
            ...messages,
            { role: 'assistant', content: String(result.rawText || '').trim() },
            { role: 'user', content: ChatToolLoop.buildToolResultMessage(runs, question) },
        ];
    }
    return { success: false, error: 'Tool loop ended without a final answer.', tries, mcp: mcpSummary };
});

// === SKILLS (prompt modules) + MCP TOOL SERVERS (added 2026-09-29) =========
// Skills are the toggleable rule modules the effective system prompt is built
// from; MCP servers are local tool processes the chat can really execute via
// `/tool <name> {json}`. Everything is surfaced in AI Settings > Skills & MCP.
ipcMain.handle('skills:list', async () => {
    try {
        return { success: true, skills: SkillRegistry.listSkills(), dir: SkillRegistry.skillsDir() };
    } catch (error) {
        log.error(`skills:list failed: ${error.message}`);
        return { success: false, error: error.message, skills: [] };
    }
});

ipcMain.handle('skills:save', async (event, payload) => {
    try {
        return { success: true, skill: SkillRegistry.saveSkill(payload || {}) };
    } catch (error) {
        log.warn(`skills:save rejected: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('skills:delete', async (event, id) => {
    try {
        return { success: true, result: SkillRegistry.deleteSkill(id) };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('skills:setState', async (event, { id, patch } = {}) => {
    try {
        return { success: true, state: SkillRegistry.setSkillState(id, patch || {}) };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// The exact prompt the AI will receive - single source of truth shared with
// ApiManager.resolveSystemPrompt(), so the UI preview can never lie.
ipcMain.handle('skills:preview', async (event, payload) => {
    try {
        // Accepts a bare target string ('chat') or { target, userPrompt, scope } so
        // the UI can preview UNEDITED textarea text / unsaved scope toggles.
        const p = (typeof payload === 'string' || !payload) ? { target: payload } : payload;
        const target = p.target === 'automation' ? 'automation' : 'chat';
        const opts = {};
        if (typeof p.userPrompt === 'string') opts.userPrompt = p.userPrompt;
        if (p.scope && typeof p.scope === 'object') opts.scope = p.scope;
        return { success: true, preview: SkillRegistry.composeSystemPrompt(target, opts) };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('skills:recommended', async () => {
    try {
        return { success: true, prompt: SkillRegistry.RECOMMENDED_SYSTEM_PROMPT };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mcp:status', async () => {
    try {
        return { success: true, status: McpManager.status() };
    } catch (error) {
        log.error(`mcp:status failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mcp:saveServer', async (event, payload) => {
    try {
        return { success: true, server: McpManager.saveServer(payload || {}), status: McpManager.status() };
    } catch (error) {
        log.warn(`mcp:saveServer rejected: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mcp:deleteServer', async (event, id) => {
    try {
        return { success: true, result: McpManager.deleteServer(id), status: McpManager.status() };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mcp:start', async (event, id) => {
    try {
        const st = await McpManager.start(id);
        return { success: st.state === 'ready', server: st, error: st.state === 'ready' ? null : st.error };
    } catch (error) {
        log.warn(`mcp:start failed (${id}): ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mcp:stop', async (event, id) => {
    try {
        return { success: true, result: McpManager.stop(id), status: McpManager.status() };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Manual tool execution from the UI ("Run tool" box) - same code path as /tool.
ipcMain.handle('mcp:call', async (event, { server, tool, args } = {}) => {
    try {
        const result = server
            ? await McpManager.callTool(server, tool, args)
            : await McpManager.callToolAuto(tool, args);
        return { success: result.ok, result, error: result.ok ? null : 'The tool reported an error.' };
    } catch (error) {
        log.warn(`mcp:call failed (${server || 'auto'}/${tool}): ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('mcp:example', async () => {
    try {
        return { success: true, server: McpManager.exampleServer() };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// "Connect all": starts every enabled server (the same call the app makes at
// launch). Used by the Skills & MCP view so a user can re-connect after a
// failure without restarting AutoDash.
ipcMain.handle('mcp:connectAll', async () => {
    try {
        const report = await McpManager.autoConnect();
        return { success: true, report, status: McpManager.status() };
    } catch (error) {
        log.warn(`mcp:connectAll failed: ${error.message}`);
        return { success: false, error: error.message, status: McpManager.status() };
    }
});

// === CHAT SESSION PERSISTENCE (2026-09-24) ===
// Save / load / delete conversations so chat survives restarts (runs/chats.json).
ipcMain.handle('chats:list', () => {
    try { return { success: true, sessions: ChatStore.list() }; }
    catch (error) { return { success: false, error: error.message, sessions: [] }; }
});
ipcMain.handle('chats:get', (event, id) => {
    try { return { success: true, session: ChatStore.get(String(id || '')) }; }
    catch (error) { return { success: false, error: error.message }; }
});
ipcMain.handle('chats:upsert', (event, session) => {
    try {
        const saved = ChatStore.upsert(session || {});
        return { success: true, session: saved };
    } catch (error) {
        log.warn(`chats:upsert failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});
ipcMain.handle('chats:delete', (event, id) => {
    try {
        const removed = ChatStore.remove(String(id || ''));
        return { success: true, removed };
    } catch (error) {
        log.warn(`chats:delete failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Voice input (Live AI Chat mic): speech-to-text with per-provider attempts.
ipcMain.handle('ai:transcribe', async (event, payload) => {
    try {
        const res = await ApiManager.transcribeAudio(payload || {});
        if (res && res.success) log.info(`Voice input transcribed via ${res.engine} (${res.provider}).`);
        else log.warn(`Voice input failed: ${(res && res.error) || 'unknown'}`);
        return res || { success: false, error: 'Transcription returned nothing.', attempts: [] };
    } catch (error) {
        log.error(`Voice transcription error: ${error.message}`);
        recordError(error, { label: 'Voice input (mic)' });
        return { success: false, error: error.message, attempts: [] };
    }
});

ipcMain.handle('system:checkOnline', async () => {
    // `internet` is the field the renderer must read (legacy code looked for
    // `online`, which NEVER existed in this payload — that is exactly why the
    // Topbar wifi icon was stuck on its initial value). We now return BOTH
    // names, plus real NIC adapters and measured latency so the chip and the
    // new Dashboard System Status card show real connection state.
    const results = { internet: false, online: false, latencyMs: null, adapters: [], providers: {}, probe: null };

    // 0. Real network interfaces (Wi-Fi / Ethernet) via os.networkInterfaces()
    try {
        const os = require('os');
        const ifs = os.networkInterfaces();
        for (const [name, list] of Object.entries(ifs || {})) {
            for (const i of list || []) {
                if (i.internal) continue;
                results.adapters.push({
                    name,
                    family: typeof i.family === 'string' ? i.family : String(i.family),
                    address: i.address,
                    mac: i.mac,
                    wifi: /wi-?fi|wireless|wlan/i.test(name),
                });
            }
        }
    } catch { /* adapters are informational only */ }

    // 1. Connectivity: race SEVERAL probes instead of a single google HEAD.
    //    One blocked endpoint (ISP filter / proxy / captive portal) used to flip
    //    the whole app to OFFLINE while the connection was perfectly fine -
    //    that was the "dashboard shows Offline even though I am online" bug.
    //    First success wins and supplies the latency; if every HTTP probe fails,
    //    a DNS lookup is the last-resort check (works through most filters).
    const t0 = Date.now();
    const probes = [
        ['google', () => axios.head('https://www.google.com', { timeout: 4000 })],
        ['cloudflare', () => axios.head('https://www.cloudflare.com', { timeout: 4000 })],
        ['gstatic204', () => axios.get('https://www.gstatic.com/generate_204', { timeout: 4000, validateStatus: (s) => s === 204 })],
    ];
    try {
        results.probe = await Promise.any(probes.map(async ([name, fn]) => { await fn(); return name; }));
        results.internet = true;
        results.latencyMs = Date.now() - t0;
    } catch {
        // All HTTP probes failed -> DNS fallback (survives HTTP-level blocking).
        try {
            const dns = require('dns');
            await Promise.race([
                new Promise((res, rej) => dns.lookup('www.google.com', (e) => (e ? rej(e) : res()))),
                new Promise((_, rej) => setTimeout(() => rej(new Error('dns-timeout')), 3000)),
            ]);
            results.probe = 'dns';
            results.internet = true;
            results.latencyMs = Date.now() - t0;
        } catch { results.internet = false; }
    }
    results.online = results.internet; // alias so both field names work

    if (!results.internet) return results;

    // 2. Check each enabled provider that has an API key
    const providers = Encrypt.getConfig('providers') || {};
    for (const [name, conf] of Object.entries(providers)) {
        if (!conf.enabled || !conf.apiKey) {
            results.providers[name] = 'no-key';
            continue;
        }
        try {
            const start = Date.now();
            if (name === 'gemini') {
                await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
                    params: { key: conf.apiKey },
                    timeout: 5000
                });
            } else if (name === 'groq') {
                await axios.get('https://api.groq.com/openai/v1/models', {
                    headers: { Authorization: `Bearer ${conf.apiKey}` },
                    timeout: 5000
                });
            } else {
                // Kimi / OpenRouter — key format heuristic: non-empty = ok
                results.providers[name] = { status: 'ok', latency: 0 };
                continue;
            }
            results.providers[name] = { status: 'ok', latency: Date.now() - start };
        } catch (err) {
            results.providers[name] = { status: 'fail', error: err.message };
        }
    }

    return results;
});

ipcMain.handle('cline:test', async () => {
    try {
        const result = await ClineAuto.testEnvironment();
        return { success: true, result };
    } catch (error) {
        log.error(`Cline environment test failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Reload the cron schedule when the user saves scheduler settings
ipcMain.handle('scheduler:reload', async () => {
    Scheduler.initSchedule();
    return { success: true };
});

// --- Prompts management (read / save the prompts.txt file) ---
const PromptManager = require('./src/modules/promptManager');

function resolvePromptPath(explicitPath) {
    const fileConfig = Encrypt.getConfig('fileConfig') || {};
    const p = explicitPath || fileConfig.promptFilePath;
    if (!p) return path.join(require('os').homedir(), 'Desktop', 'prompts.txt');
    return p.replace('~', require('os').homedir());
}

ipcMain.handle('prompts:read', async (event, filePath) => {
    try {
        const resolved = resolvePromptPath(filePath);
        const parsed = await PromptManager.loadPromptsFromFile(resolved);
        return { success: true, path: resolved, ...parsed };
    } catch (error) {
        log.error(`prompts:read failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('prompts:save', async (event, { filePath, prompts }) => {
    try {
        const resolved = resolvePromptPath(filePath);
        await PromptManager.savePromptsToFile(resolved, prompts);
        return { success: true, path: resolved };
    } catch (error) {
        log.error(`prompts:save failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Alias kept for backwards compatibility with the UI's "Save Path" flow
ipcMain.handle('savePromptFile', async (event, payload) => {
    return ipcMain.invoke('prompts:save', payload);
});

// --- Prompts folder management (frontend/ + backend/, ordered multi-language) ---

/**
 * Resolves the prompts/ base directory. A custom fileConfig.promptsDirectory
 * wins; otherwise PromptManager's default (the project root prompts/ folder).
 */
function resolvePromptsDirectory() {
    const fileConfig = Encrypt.getConfig('fileConfig') || {};
    return PromptManager.getPromptsBasePath(fileConfig.promptsDirectory);
}

// Reads BOTH prompt folders in execution order (frontend -> backend)
ipcMain.handle('prompts:readFolders', async () => {
    try {
        const basePath = resolvePromptsDirectory();
        await PromptManager.ensureFolderStructure(basePath);
        const data = await PromptManager.loadPromptsFromFolders(basePath);
        return { success: true, ...data };
    } catch (error) {
        log.error(`prompts:readFolders failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Saves ONE prompt file (auto-numbers new files, overwrites exact matches)
ipcMain.handle('prompts:saveOne', async (event, { folder, filename, content }) => {
    try {
        return await PromptManager.savePromptToFile(folder, filename, content, resolvePromptsDirectory());
    } catch (error) {
        log.error(`prompts:saveOne failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Deletes ONE prompt file
ipcMain.handle('prompts:deleteOne', async (event, { folder, filename }) => {
    try {
        return await PromptManager.deletePromptFile(folder, filename, resolvePromptsDirectory());
    } catch (error) {
        log.error(`prompts:deleteOne failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Renames the folder's files to match a new order (01_, 02_, 03_ ...)
ipcMain.handle('prompts:reorder', async (event, { folder, newOrder }) => {
    try {
        return await PromptManager.reorderPrompts(folder, newOrder, resolvePromptsDirectory());
    } catch (error) {
        log.error(`prompts:reorder failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Re-reads ONE prompt file from disk. Used by the UI "Retry" button to fetch
// the current content of a prompt that failed mid-workflow.
ipcMain.handle('prompts:retryOne', async (event, { folder, filename }) => {
    try {
        const basePath = resolvePromptsDirectory();
        const dirName = String(folder || '').trim().toLowerCase();
        const prompts = await PromptManager.loadPromptsFromFolder(path.join(basePath, dirName));
        const prompt = prompts.find(p => p.filename === filename);
        if (!prompt) throw new Error(`Prompt not found: ${folder}/${filename}`);
        return { success: true, prompt };
    } catch (error) {
        log.error(`prompts:retryOne failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Sniffs the dominant script of a text (en/ur/ar/hi/zh/ja/ko/ru/he)
ipcMain.handle('prompts:detectLanguage', async (event, text) => {
    try {
        return { success: true, language: PromptManager.detectLanguage(text) };
    } catch (error) {
        log.error(`prompts:detectLanguage failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// Opens prompts/frontend or prompts/backend in the OS file explorer
ipcMain.handle('prompts:openInExplorer', async (event, folder) => {
    try {
        const basePath = resolvePromptsDirectory();
        const dirName = String(folder || '').trim().toLowerCase();
        const dir = path.join(basePath, dirName);
        if (!require('fs').existsSync(dir)) {
            await PromptManager.ensureFolderStructure(basePath);
        }
        shell.openPath(dir);
        return { success: true, path: dir };
    } catch (error) {
        log.error(`prompts:openInExplorer failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// --- Feature IPC: cost tracker, file tree viewer, retry single prompt ---

// Aggregate live cost stats from both the Encrypt store and the usage.json log.
// The usage.json log (written by recordApiUsage during chatStream) is the
// source of truth for tokens / cost / latency per call today.
ipcMain.handle('costs:get', async () => {
    try {
        const costs = Encrypt.getConfig('costs') || {};
        const today = new Date().toISOString().slice(0, 10);

        // Also read from the usage.json log for the most up-to-date numbers.
        let usageEntries = [];
        try {
            const usageFile = path.join(__dirname, 'runs', 'usage.json');
            if (require('fs').existsSync(usageFile)) {
                usageEntries = JSON.parse(require('fs').readFileSync(usageFile, 'utf8'));
            }
        } catch {}

        // Aggregate today's calls from the usage log.
        const todayEntries = usageEntries.filter(e => {
            try { return new Date(e.timestamp).toISOString().slice(0, 10) === today; }
            catch { return false; }
        });
        const tokensToday = todayEntries.reduce((s, e) => s + (e.tokens || 0), 0);
        const costToday = todayEntries.reduce((s, e) => s + (e.cost || 0), 0);
        const requestsToday = todayEntries.length;
        const avgLatency = requestsToday > 0
            ? Math.round(todayEntries.reduce((s, e) => s + (e.latency || 0), 0) / requestsToday)
            : 0;
        const lastProvider = todayEntries.length > 0
            ? todayEntries[todayEntries.length - 1].provider || '—'
            : (costs.lastProvider || '—');

        const configuredGemini = Encrypt.getConfig('providers')?.gemini || {};
        const configuredKeys = [configuredGemini.apiKey, ...(Array.isArray(configuredGemini.apiKeys) ? configuredGemini.apiKeys : [])]
            .map(k => String(k || '').trim()).filter(Boolean).filter((k, i, a) => a.indexOf(k) === i)
            .map(k => `${k.slice(0, 6)}…${k.slice(-4)}`);
        if (costs.date !== today) {
            return {
                success: true, date: today,
                calls: 0, tokens: 0, estimatedCost: 0, history: [],
                tokensToday, costToday, requestsToday, avgLatency, lastProvider,
                perKey: costs.perKey && typeof costs.perKey === 'object' ? costs.perKey : {},
                keyTotals: costs.keyTotals && typeof costs.keyTotals === 'object' ? costs.keyTotals : {},
                configuredKeys,
                exactGeminiTokens: 0, exactGeminiAvailable: false
            };
        }

        // Merge with stored Encrypt data (stored tokens may be more accurate for
        // non-chat usage like bulk generation).
        const mergedTokens = tokensToday || costs.tokens || 0;
        const mergedCost = costToday || costs.cost || costs.estimatedCost || 0;
        const mergedRequests = costs.requests || requestsToday;

        const perKey = costs.perKey && typeof costs.perKey === 'object' ? costs.perKey : {};
        const keyTotals = costs.keyTotals && typeof costs.keyTotals === 'object' ? costs.keyTotals : {};
        // Exact token ledger is provider-reported metadata only; never multiply
        // or invent a "110%" value. Missing metadata remains zero.
        const ledgerEntries = todayEntries.filter(e => e.exactUsage && e.provider === 'gemini');
        const exactTokens = ledgerEntries.reduce((s, e) => s + (Number(e.exactUsage.totalTokenCount ?? e.exactUsage.total_token_count) || (Number(e.exactUsage.promptTokenCount) || 0) + (Number(e.exactUsage.candidatesTokenCount) || 0)), 0);
        return {
            success: true,
            date: costs.date || today,
            calls: mergedRequests,
            tokens: mergedTokens,
            estimatedCost: mergedCost,
            history: costs.history || [],
            tokensToday: mergedTokens,
            costToday: mergedCost,
            requestsToday: mergedRequests,
            avgLatency,
            lastProvider,
            perKey,
            keyTotals,
            configuredKeys,
            exactGeminiTokens: exactTokens,
            exactGeminiAvailable: ledgerEntries.length > 0
        };
    } catch (error) {
        log.error(`costs:get failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

/**
 * FEATURE 4: recursively lists the generated Dashboard folder
 * (fileConfig.outputDirectory) as a flat array of
 * { path, name, isDir, sizeBytes } with relative POSIX-style paths.
 * Skips node_modules/.git/dotfiles; capped at 500 entries / depth 6.
 */
function walkOutputTree(baseDir, relPrefix, depth, out) {
    if (out.length >= 500 || depth > 6) return;
    let entries = [];
    try {
        entries = require('fs').readdirSync(path.join(baseDir, relPrefix), { withFileTypes: true });
    } catch (error) {
        return;
    }
    for (const entry of entries) {
        if (out.length >= 500) return;
        const name = entry.name;
        if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const isDir = entry.isDirectory();
        let sizeBytes = 0;
        if (!isDir) {
            try { sizeBytes = require('fs').statSync(path.join(baseDir, rel)).size; } catch { sizeBytes = 0; }
        }
        out.push({ path: rel, name, isDir, sizeBytes });
        if (isDir) walkOutputTree(baseDir, rel, depth + 1, out);
    }
}

ipcMain.handle('files:listTree', async () => {
    try {
        const fileConfig = Encrypt.getConfig('fileConfig') || {};
        const baseDir = (fileConfig.outputDirectory || '~/Desktop/Dashboard').replace('~', require('os').homedir());
        if (!require('fs').existsSync(baseDir)) {
            return { success: true, basePath: baseDir, files: [] };
        }
        const files = [];
        walkOutputTree(baseDir, '', 0, files);
        return { success: true, basePath: baseDir, files };
    } catch (error) {
        log.error(`files:listTree failed: ${error.message}`);
        recordError(error, { label: 'File tree (output directory)' });
        return { success: false, error: error.message };
    }
});

// FEATURE 4: returns the text content of ONE file inside the output folder.
// The resolved path is containment-checked so ../ traversal can never escape.
ipcMain.handle('files:readFile', async (event, relPath) => {
    try {
        const fileConfig = Encrypt.getConfig('fileConfig') || {};
        const baseDir = path.resolve((fileConfig.outputDirectory || '~/Desktop/Dashboard').replace('~', require('os').homedir()));
        const target = path.resolve(baseDir, String(relPath || ''));
        if (!target.startsWith(baseDir)) throw new Error('Path escapes the output folder.');
        const stat = require('fs').statSync(target);
        if (!stat.isFile()) throw new Error('Not a file.');
        if (stat.size > 200 * 1024) throw new Error('File too large to preview (>200 KB).');
        return { success: true, content: require('fs').readFileSync(target, 'utf8'), sizeBytes: stat.size };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Open one generated file with the operating system's default registered app.
// This is an explicit user click in the UI; the app never executes SQL or
// arbitrary code automatically.
//
// FALLBACK CHAIN (2026-09-25): brand-new file types such as .sql / .php may
// have NO registered handler yet, and shell.openPath() then returns an error
// string like "No application is associated with the specified file". Instead
// of failing, try VS Code (installed on this machine and owning VSCode.sql)
// and finally Notepad, so the user can always inspect a generated file.
function openWithFallback(target) {
    const { spawn } = require('child_process');
    const candidates = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        'C:\\Program Files\\Microsoft VS Code\\Code.exe',
        'C:\\Windows\\System32\\notepad.exe',
    ];
    for (const exe of candidates) {
        if (exe && fs.existsSync(exe)) {
            spawn(exe, [target], { detached: true, stdio: 'ignore' }).unref();
            return { openedWith: exe };
        }
    }
    return null;
}

ipcMain.handle('files:open', async (_event, relPath) => {
    try {
        const fileConfig = Encrypt.getConfig('fileConfig') || {};
        const baseDir = path.resolve((fileConfig.outputDirectory || '~/Desktop/Dashboard').replace('~', require('os').homedir()));
        const target = path.resolve(baseDir, String(relPath || ''));
        if (!target.startsWith(baseDir + path.sep)) throw new Error('Path escapes the output folder.');
        if (!require('fs').existsSync(target)) throw new Error('Generated file no longer exists.');
        const error = await shell.openPath(target);
        if (!error) return { success: true, path: target, openedWith: 'system' };
        // No OS handler for this extension -> try an editor explicitly.
        const fallback = openWithFallback(target);
        if (fallback) {
            log.info(`No system handler for ${path.extname(target) || '(no extension)'} - opened via ${path.basename(fallback.openedWith)}.`);
            return { success: true, path: target, openedWith: fallback.openedWith, note: 'Opened with fallback editor (no default app registered for this file type).' };
        }
        throw new Error(error);
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// FEATURE 5: runs ONE prompt through the AI router and writes the generated
// files into the output folder via the same parser the workflow uses.
// No scheduling, no other prompts, no VS Code automation.
ipcMain.handle('prompts:runOne', async (event, { folder, filename }) => {
    try {
        const basePath = resolvePromptsDirectory();
        const prompts = await PromptManager.loadPromptsFromFolder(path.join(basePath, String(folder || '').trim().toLowerCase()));
        const prompt = prompts.find(p => p.filename === filename);
        if (!prompt) throw new Error(`Prompt not found: ${folder}/${filename}`);
        const result = await ApiManager.generateStructureCode(prompt.content);
        const fileConfig = Encrypt.getConfig('fileConfig') || {};
        const outDir = (fileConfig.outputDirectory || '~/Desktop/Dashboard').replace('~', require('os').homedir());
        const written = await Scheduler._writeFilesFromResponse(outDir, result.text);
        log.info(`prompts:runOne wrote via ${result.provider}: ${written.join(', ') || 'index'}`);
        return { success: true, provider: result.provider, written };
    } catch (error) {
        log.error(`prompts:runOne failed: ${error.message}`);
        recordError(error, { label: `Retry single prompt: ${folder}/${filename}` });
        return { success: false, error: error.message };
    }
});

// --- URL bridge: open a link in the default browser (Dashboard/phpMyAdmin) ---
ipcMain.handle('system:openUrl', async (event, url) => {
    try {
        const u = String(url || '');
        if (!/^https?:\/\//i.test(u)) throw new Error('Only http(s) URLs can be opened.');
        await shell.openExternal(u);
        return { success: true };
    } catch (error) {
        log.warn(`system:openUrl failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// --- OS notification bridge ---
// FEATURE F: notification actions — when node-notifier fires a balloon with
// action buttons, the click is forwarded back to the renderer via IPC so the
// UI can respond (e.g. "Open Dashboard Folder", "View Logs", "Run Again").
ipcMain.handle('system:notify', async (event, { title, message, actions }) => {
    try {
        const appConfig = Encrypt.getConfig('appConfig') || {};
        if (appConfig.silentNotifications) {
            // Silent mode: route to tray balloon only (no OS sound).
            if (tray) tray.displayBalloon({ title: title || 'AutoDash', content: message || '' });
            // Even in silent mode, surface the action so the renderer can log it.
            if (actions && actions.length) {
                mainWindow && mainWindow.webContents.send('system:notify:action', { title, message, actions });
            }
            return { success: true };
        }
        notifier.notify({
            title: title || 'AutoDash Control Panel',
            message: message || '',
            icon: path.join(__dirname, 'src/renderer/assets/icons/icon-v2.ico'),
            ...(actions && actions.length ? { wait: true } : {})
        });
        if (actions && actions.length) {
            mainWindow && mainWindow.webContents.send('system:notify:action', { title, message, actions });
        }
        return { success: true };
    } catch (error) {
        log.error(`system:notify failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// --- XAMPP connect (Apache + MySQL + schema import + live health) ---------
// Read-only status for the Settings card (ports, htdocs, deployed?).
ipcMain.handle('xampp:status', async () => {
    try {
        const fileConfig = Encrypt.getConfig('fileConfig') || {};
        return { success: true, ...(await Xampp.status((fileConfig.xamppRoot || '').trim())) };
    } catch (error) {
        log.warn(`xampp:status failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});

// MANUAL "Deploy to XAMPP": validate whatever currently exists in the output
// folder, then start services + deploy + import + verify. Lets the user
// connect the dashboard without running the whole generation again (and gives
// an honest report when the generated project is still incomplete).
ipcMain.handle('xampp:deploy', async () => {
    try {
        const fileConfig = Encrypt.getConfig('fileConfig') || {};
        const basePath = (fileConfig.outputDirectory || '~/Desktop/Dashboard').replace('~', require('os').homedir());
        const validation = FileManager.validateGeneratedProject(basePath);
        if (!validation.valid) {
            const details = [...(validation.missing || []), ...(validation.failed || [])].join(', ');
            return { success: false, error: `Generated project is incomplete: ${details}`, validation };
        }
        const report = await Xampp.connect(basePath, {
            start: fileConfig.xamppAutoStart !== false,
            import: fileConfig.xamppImportSchema !== false,
            xamppRoot: (fileConfig.xamppRoot || '').trim(),
        });
        for (const step of (report.steps || [])) log.terminal(`  [${step.ok ? 'OK' : 'FAIL'}] ${step.name}: ${step.detail}`);
        return { success: !!report.ok, report, validation };
    } catch (error) {
        log.error(`xampp:deploy failed: ${error.message}`);
        recordError(error, { label: 'XAMPP deploy (manual)' });
        return { success: false, error: error.message };
    }
});

// --- Native file picker (backbone for the 'Browse' buttons) ---
async function performOpenFileDialog(options = {}) {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: options.title || 'Select a file',
            defaultPath: options.defaultPath || undefined,
            properties: ['openFile'],
            filters: options.filters || [{ name: 'Text Files', extensions: ['txt'] }]
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, canceled: true };
        }
        return { success: true, path: result.filePaths[0] };
    } catch (error) {
        log.error(`dialog:openFile failed: ${error.message}`);
        return { success: false, error: error.message };
    }
}

ipcMain.handle('dialog:openFile', (event, options) => performOpenFileDialog(options));

// Alias channel (Fix 12): 'dialog:browse' opens a native open-file dialog for
// .txt files (default filter) — used by the Prompts 'Browse' button via
// preload's browseFile().
ipcMain.handle('dialog:browse', (event, options) => performOpenFileDialog(options));

// Read ANY absolute file path as text (used by Live AI Chat attachments after
// the native picker returns a path). Capped at 1 MB.
ipcMain.handle('files:readText', async (event, absPath) => {
    try {
        const p = String(absPath || '');
        if (!p) throw new Error('No path.');
        const fsl = require('fs');
        const stat = fsl.statSync(p);
        if (!stat.isFile()) throw new Error('Not a file.');
        if (stat.size > 1024 * 1024) throw new Error('File too large (>1 MB).');
        const content = fsl.readFileSync(p, 'utf8');
        return { success: true, content, name: path.basename(p) };
    } catch (error) {
        return { success: false, error: error.message };
    }
});