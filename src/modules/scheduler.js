/**
 * @file scheduler.js
 * @description Cron scheduler and main workflow orchestrator.
 */

const schedule = require('node-schedule');
const fs = require('fs-extra');
const path = require('path');
const notifier = require('node-notifier');

const ApiManager = require('./apiManager');
const ClineAuto = require('./clineAutomation');
const PromptManager = require('./promptManager');
const FileManager = require('./fileManager');
const Xampp = require('./xampp');
const Encrypt = require('./encryption');
const log = require('./logger');

let activeJob = null;
let isRunning = false;
let stopRequested = false;
let paused = false;
let runningPromise = null; // ISSUE 2 FIX: queue instead of a boolean flag
// Per-prompt approval gate. Unlike generic pause(), this is an explicit
// user decision required after a completed prompt and before the next one.
let pendingApproval = null; // { id, phase, nextIndex, nextPrompt, resolve }
let approvalSeq = 0;

// FEATURE D: run history — persists every workflow run to runs/history.json
const RUNS_DIR = path.join(process.cwd(), 'runs');
const HISTORY_FILE = path.join(RUNS_DIR, 'history.json');
const MAX_HISTORY = 20;

/**
 * FEATURE D: append a run-record to runs/history.json (max 20 entries).
 * @param {Object} run  { timestamp, durationMs, frontend, backend, provider, status, files }
 */
function recordRunHistory(run) {
    try {
        fs.ensureDirSync(RUNS_DIR);
        let history = [];
        if (fs.existsSync(HISTORY_FILE)) {
            history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!Array.isArray(history)) history = [];
        }
        history.unshift(run);            // newest first
        history = history.slice(0, MAX_HISTORY);
        fs.writeStringifySync ? null : null; // placeholder guard
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    } catch (e) { log.warn('Could not write run history:', e.message); }
}

// Injectable Error Center recorder — main.js wires this to its recordError();
// scheduler.js cannot import it directly (circular dependency).
let errorRecorder = null;

/**
 * FEATURE E: lightweight health-check ping to each enabled provider before
 * starting the workflow. Skips disabled / key-less providers. Logs the
 * result so a broken key is caught early instead of mid-generation.
 * Returns a summary object { provider: { ok, latencyMs, error } }.
 */
async function healthCheckProviders() {
    const providers = Encrypt.getConfig('providers') || {};
    const chain = ApiManager._buildRoutingChain ? ApiManager._buildRoutingChain() : [];
    // Chain entries carry NO `fn` property — calling entry.fn(...) threw
    // "entry.fn is not a function" on EVERY run (main.log 19:53:23). Map the
    // provider name to its real call function instead.
    const callFns = {
        gemini:     (p, k, m, o) => ApiManager._callGemini(p, k, m, o, 'gemini'),
        kimi:       (p, k, m, o) => ApiManager._callKimi(p, k, m, o),
        groq:       (p, k, m, o) => ApiManager._callGroq(p, k, m, o),
        openrouter: (p, k, m, o) => ApiManager._callOpenrouter(p, k, m, o)
    };
    const summary = {};
    for (const entry of chain) {
        const name = entry.name;
        const conf = providers[name] || {};
        if (!conf.enabled || !entry.apiKey) {
            summary[name] = { ok: false, latencyMs: 0, error: 'disabled or no key' };
            continue;
        }
        const t0 = Date.now();
        try {
            const callFn = callFns[name];
            if (!callFn) throw new Error(`no health-check handler for provider "${name}"`);
            await callFn('Reply with only: ping', entry.apiKey, entry.model, { temperature: 0, maxTokens: 16 });
            summary[name] = { ok: true, latencyMs: Date.now() - t0 };
            log.info(`Provider ${name}: OK (${summary[name].latencyMs}ms)`);
        } catch (e) {
            summary[name] = { ok: false, latencyMs: Date.now() - t0, error: ApiManager.humanMessage(e, 120) };
            // Short single line — raw e.message was a multi-KB JSON blob that
            // flooded the terminal on every pre-run health check.
            log.warn(`Provider ${name}: FAIL (${ApiManager.humanMessage(e, 120)})`);
            // Health-check failures previously died as a console warn only.
            // Forward them to main.js's Error Center via the injected recorder.
            if (errorRecorder) { try { errorRecorder(e, { provider: name, model: entry.model, label: 'Health check (pre-run)' }); } catch (re) { /* ignore */ } }
        }
    }
    return summary;
}

/**
 * Emits the current workflow status to the renderer via IPC.
 * Accepts either a string (treated as state) or an object; missing fields
 * are filled with safe defaults so the UI always receives an object
 * containing { state, step, total, message }.
 */
function broadcastStatus(status) {
    const { BrowserWindow } = require('electron');
    const windows = BrowserWindow.getAllWindows();
    const base = { state: 'running', step: 0, total: 0, message: '' };
    const payload = Object.assign(base, typeof status === 'string' ? { state: status } : status);
    windows.forEach(w => w.webContents.send('automation:status', payload));
}

function assertNotStopped() {
    if (stopRequested) throw new Error('Workflow stopped by user.');
}

/**
 * Stop the current run at a safe prompt boundary. Resolve a pending approval
 * waiter first so its Promise never leaks when the user presses No/Stop.
 */
function requestStopForApproval() {
    stopRequested = true;
    paused = false;
    if (pendingApproval) {
        const waiter = pendingApproval;
        pendingApproval = null;
        waiter.resolve(false);
    }
}

/**
 * Ask the renderer whether the next prompt may start. The workflow remains
 * alive but cannot issue another API call until approveNextPrompt() is called.
 * This is intentionally separate from pause/resume: it prevents a generic
 * Resume click from accidentally bypassing the user's per-prompt decision.
 */
function waitForNextPromptApproval(phase, nextIndex, nextPrompt) {
    assertNotStopped();
    const id = ++approvalSeq;
    const nextName = nextPrompt.name || nextPrompt.filename || `prompt ${nextIndex + 1}`;
    broadcastStatus({
        state: 'awaiting-approval', step: 0, total: 0,
        phase, current: nextIndex + 1, promptTotal: 0,
        approvalId: id, nextName, nextIndex: nextIndex + 1,
        message: `First prompt completed. Start next ${phase} prompt: ${nextName}?`
    });
    log.terminal(`Permission required: ${phase} prompt ${nextIndex + 1} (${nextName}) is ready. Waiting for Yes/No.`);
    return new Promise(resolve => {
        pendingApproval = { id, phase, nextIndex, nextPrompt, resolve };
    });
}

/**
 * If the workflow is paused, blocks here (cooperatively) until resume() is
 * called or the workflow is stopped. Polls every 300ms so resume/stop are
 * responsive.
 */
function waitForResume() {
    return new Promise(resolve => {
        const iv = setInterval(() => {
            if (stopRequested) { clearInterval(iv); }
            if (!paused) { clearInterval(iv); resolve(); }
        }, 300);
    });
}

/**
 * User-facing notification helper. When appConfig.silentNotifications is true,
 * no OS popup is shown ; instead a tray-only notification is broadcast so the
 * main process can route it through the tray icon (PART 4).
 */
const ICON_PATH = path.join(__dirname, '../renderer/assets/icons/icon.ico');
function notifyUser(title, message, options = {}) {
    const appConfig = Encrypt.getConfig('appConfig') || {};
    if (appConfig.silentNotifications) {
        broadcastStatus({ state: 'tray-notify', title, message });
        return;
    }
    notifier.notify({
        title,
        message,
        icon: ICON_PATH,
        sound: options.sound !== false,
        wait: false,
        ...options
    });
}

module.exports = {
    /**
     * Initializes the cron schedule based on user config.
     */
    initSchedule() {
        const config = Encrypt.getConfig('scheduler') || { time: '19:00', enabled: true };
        if (!config.enabled) return;

        const [hour, minute] = config.time.split(':');
        const daysOff = Array.isArray(config.daysOff) ? config.daysOff : [];

        this.cancelSchedule();

        // Run daily at the configured time; skip configured days off
        activeJob = schedule.scheduleJob(`${minute} ${hour} * * *`, async () => {
            const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
            if (daysOff.includes(dayName)) {
                log.info(`Scheduled run skipped: ${dayName} is a configured day off.`);
                return;
            }
            log.info('Scheduled automation triggered.');
            await this.executeWorkflow();
        });
    },

    /**
     * Cancels the active cron job without touching a running workflow.
     */
    cancelSchedule() {
        if (activeJob) {
            activeJob.cancel();
            activeJob = null;
            log.info('Scheduled job cancelled.');
        }
    },

    /**
     * Writes every file declared in an AI response. The response may be a single
     * blob or contain multiple --- FILE: <path> --- markers (one response per
     * prompt can yield several files). Paths are confined to basePath.
     * @param {string} basePath - Workspace root to write under
     * @param {string} aiText - Raw AI response text
     * @returns {Promise<string[]>} list of relative paths written
     */
    async _writeFilesFromResponse(basePath, aiText) {
        const files = FileManager.parseMultiFileResponse(aiText);
        const written = [];
        // TOP-LEVEL FOLDER CONTRACT must match what this run ADVERTISED to the
        // model in apiManager.loadMasterPrompt() (fileConfig.outputFolders,
        // editable in the Prompts view). It used to be a hardcoded frontend|backend
        // regex, so the model could be told "your folders are X" and then have a
        // valid file rejected mid-run. Defaults mirror scaffoldProject's.
        const rawFolders = (Encrypt.getConfig('fileConfig') || {}).outputFolders;
        const allowed = (Array.isArray(rawFolders) && rawFolders.length ? rawFolders : ['frontend', 'backend'])
            .map((f) => String(f || '').trim().replace(/^[\\/]+|[\\/]+$/g, ''))
            .filter((f) => f && !f.includes('..'));
        const allowedList = allowed.length ? allowed : ['frontend', 'backend'];
        const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const allowedRe = new RegExp(`^(${allowedList.map(escapeRe).join('|')})/`, 'i');
        for (const file of files) {
            let relPath = String(file.path || 'index.html').trim().replace(/\\/g, '/');
            // Normalize legacy Gemini paths into the configured folder contract
            // (only when the destination folder is one this run allows).
            if (relPath.toLowerCase() === 'readme.md' && allowedRe.test('backend/')) relPath = 'backend/README.md';
            if (relPath.toLowerCase().startsWith('database/') && allowedRe.test('backend/')) relPath = `backend/${relPath}`;
            if (relPath.toLowerCase().startsWith('assets/') && allowedRe.test('frontend/')) relPath = `frontend/${relPath}`;
            if (!relPath || relPath.includes('..') || path.isAbsolute(relPath) || !allowedRe.test(relPath)) {
                throw new Error(`Invalid generated path (must start with one of: ${allowedList.join(', ')}): ${file.path || '(empty)'}`);
            }
            const fullPath = path.resolve(basePath, relPath);
            // Confine writes to the workspace (no path traversal outside basePath).
            if (!fullPath.startsWith(path.resolve(basePath) + path.sep) && fullPath !== path.resolve(basePath)) {
                throw new Error(`Refusing to write outside workspace: ${file.path}`);
            }
            await fs.outputFile(fullPath, file.content);
            written.push(relPath);
        }
        return written;
    },

    /**
     * Master function that runs the workflow pipeline (Step 1..N).
     * Emits automation:status after every step and honors pause()/resume()
     * checkpoints between steps.
     */
    async executeWorkflow() {
        // ISSUE 2 FIX: concurrent triggers (rapid double-clicks, tray + UI at
        // the same moment) now share ONE running promise instead of racing
        // past a boolean flag. Late callers receive the in-flight promise.
        if (runningPromise) {
            log.warn('Workflow already running — returning the existing run promise.');
            return runningPromise;
        }
        runningPromise = this._executeWorkflowLoaded();
        try {
            return await runningPromise;
        } finally {
            runningPromise = null;
        }
    },

    async _executeWorkflowLoaded() {
        isRunning = true;
        stopRequested = false;
        paused = false;
                ClineAuto.resetLaunchState();
        broadcastStatus('running');
        log.terminal('Workflow started.');

        const runStart = Date.now();
        let usedProvider = null;
        // SCOPE FIX: the finally{} block below reads these for run history.
        // They MUST live at method scope — declared inside the try{} they would
        // be block-scoped to it, and finally would throw "frontendPrompts is
        // not defined" on EVERY run, masking the real workflow error.
        let frontendPrompts = [];
        let backendPrompts = [];
        let extensionPrompts = [];
        // Files written so far (run history "files" field — finally{} reads it;
        // the old `fileList` reference was never declared anywhere).
        const writtenFiles = [];
        // true once the try{} block fails. finally{} runs AFTER isRunning is
        // reset to false, so the old `isRunning ? 'failed'` check always
        // reported failed runs as "completed" in runs/history.json.
        let runFailed = false;
        // Every prompt is sent with the complete ordered project plan, so a later
        // prompt extends the same project instead of hallucinating a new one.
        let projectPromptContext = '';

        // FEATURE E: ping each enabled provider before starting — catches a
        // broken/404 key early instead of failing mid-generation.
        const healthSummary = await healthCheckProviders();
        const healthyCount = Object.values(healthSummary).filter(h => h.ok).length;

        const TOTAL_STEPS = 5; // load prompts, scaffold, frontend phase, backend phase, vscode phase

        broadcastStatus({ step: 0, total: TOTAL_STEPS, message: `Provider health: ${healthyCount}/${Object.keys(healthSummary).length} OK`, state: 'running' });
        log.terminal(`Provider health: ${healthyCount}/${Object.keys(healthSummary).length} provider(s) reachable.`);

        // Checkpoint: broadcasts step status, asserts not-stopped, and waits if paused.
        const checkpoint = (step, message) => {
            broadcastStatus({ step, total: TOTAL_STEPS, message, state: paused ? 'paused' : 'running' });
            assertNotStopped();
            if (paused) { log.info('Workflow paused — waiting for resume.'); return waitForResume(); }
            return Promise.resolve();
        };

        /**
         * Runs one phase (frontend or backend): every prompt of the folder is
         * sent to the AI router IN ORDER, its multi-file response is written to
         * the workspace, and a per-prompt status is broadcast. Between prompts
         * the workflow waits fileConfig.promptDelaySec (default 3) so the
         * provider is not hammered and the UI can follow along.
         */
        const runPromptPhase = async (phase, step, prompts, basePath, requireInitialApproval = false) => {
            let previousCompleted = requireInitialApproval;
            for (let i = 0; i < prompts.length; i++) {
                const prompt = prompts[i];
                assertNotStopped();
                if (previousCompleted) {
                    const approved = await waitForNextPromptApproval(phase, i, prompt);
                    if (!approved) { stopRequested = true; throw new Error('Workflow stopped by user.'); }
                    previousCompleted = false;
                }
                broadcastStatus({
                    step,
                    total: TOTAL_STEPS,
                    phase,
                    current: i + 1,
                    promptTotal: prompts.length,
                    name: prompt.name || prompt.filename || `prompt ${i + 1}`,
                    message: `${phase} prompt ${i + 1}/${prompts.length}: ${prompt.name || prompt.filename || ''}`,
                    state: 'running'
                });
                log.info(`[${phase}] Prompt ${i + 1}/${prompts.length} (${prompt.filename || 'legacy'}): calling AI router...`);
                log.terminal(`Sending ${phase} prompt ${i + 1}/${prompts.length} (${prompt.filename || 'legacy'}) to the AI router...`);
                const promptStartedAt = Date.now();
                const result = await ApiManager.generateStructureCode(`${prompt.content}${projectPromptContext}`);
                const written = await this._writeFilesFromResponse(basePath, result.text);
                if (Array.isArray(written)) writtenFiles.push(...written); // run history (finally{} scope fix)
                usedProvider = result.provider; // FEATURE D: track provider for history
                const elapsedSec = ((Date.now() - promptStartedAt) / 1000).toFixed(1);
                log.info(`[${phase}] Prompt ${i + 1}/${prompts.length} written via ${result.provider}: ${written.join(', ') || 'index'}`);
                log.terminal(`Prompt ${i + 1}/${prompts.length} done in ${elapsedSec}s (provider: ${result.provider}, files: ${written.length})`);
                (written || []).forEach(name => log.terminal(`  created: ${name}`));
                previousCompleted = true;

                if (i < prompts.length - 1) {
                    const configured = Number((Encrypt.getConfig('fileConfig') || {}).promptDelaySec);
                    const waitSec = Number.isFinite(configured) && configured >= 0 ? configured : 3;
                    if (waitSec > 0) {
                        log.info(`[${phase}] Waiting ${waitSec}s before the next prompt...`);
                        await new Promise(res => setTimeout(res, waitSec * 1000));
                    }
                }
            }
        };

        try {
            // HEALTH GATE (2026-09-25): if NO provider answered the pre-run
            // health check, fail fast BEFORE scaffolding. An earlier Force Run
            // created an empty Desktop\Dashboard this way and the user saw a
            // folder with zero files.
            if (healthyCount === 0) {
                const detail = Object.entries(healthSummary)
                    .map(([name, s]) => `${name}: ${s.error || 'unknown'}`).join('; ');
                throw new Error(`No AI provider is reachable (${detail || 'no keys configured'}). Add a working key in API Keys - nothing was generated.`);
            }

            // Step 1: Load prompts — folder system first, legacy prompts.txt fallback
            const fileConfig = Encrypt.getConfig('fileConfig') || {};
            const folders = await PromptManager.loadPromptsFromFolders(fileConfig.promptsDirectory);
            frontendPrompts = Array.isArray(folders.frontend) ? folders.frontend : [];
            backendPrompts = Array.isArray(folders.backend) ? folders.backend : [];
            extensionPrompts = [];

            // ISSUE 5 FIX: fall back to the legacy prompts.txt ONLY when the
            // prompt folders contain NO prompt files at all. Placeholder files
            // (01_.txt) and "_" notes are skipped by the loader, but their
            // PRESENCE means the user chose the folder system — silently
            // executing unrelated legacy prompts would be a surprise.
            const countPromptFiles = (folder) => {
                try {
                    return require('fs').readdirSync(path.join(PromptManager.getPromptsBasePath(fileConfig.promptsDirectory), folder))
                        .filter(f => /\.(txt|md|prompt)$/i.test(f)).length;
                } catch (e) { return 0; }
            };
            const folderHasFiles = countPromptFiles('frontend') + countPromptFiles('backend') > 0;
            if (!folderHasFiles && !fileConfig.promptsDirectory) {
                log.info('Prompt folders contain no files — falling back to legacy prompts.txt.');
                const promptFilePath = fileConfig.promptFilePath
                    ? fileConfig.promptFilePath.replace('~', require('os').homedir())
                    : path.join(require('os').homedir(), 'Desktop', 'prompts.txt');
                const legacy = await PromptManager.loadPromptsFromFile(promptFilePath);
                frontendPrompts = legacy.structurePrompts.slice(0, 1).map(content => ({ name: 'legacy structure', content }));
                backendPrompts = legacy.structurePrompts.slice(1).map(content => ({ name: 'legacy structure', content }));
                extensionPrompts = legacy.extensionPrompts;
            } else if (frontendPrompts.length === 0 && backendPrompts.length === 0) {
                log.info('Folder mode active but no runnable prompts found (only placeholders/notes). Add prompts in the Prompts view.');
            }
            await checkpoint(1, `Prompts loaded (${frontendPrompts.length} frontend, ${backendPrompts.length} backend).`);

            // Multi-prompt coherence context (2026-10-01, reworked).
            //
            // It used to be appended to EVERY prompt as "Generate/update the complete
            // project according to this plan; do not start a different project", which
            // had two costs: a single-prompt run sent its own text twice and was told to
            // regenerate the WHOLE project on every call (so pass 2 silently overwrote
            // pass 1 - the reported loss of styles/colours), and it invited the model to
            // reconcile "the project" instead of doing the task in front of it.
            // Now: only built when more than one prompt exists, and worded so the other
            // prompts are background ONLY - the current prompt is the one task.
            const totalPrompts = frontendPrompts.length + backendPrompts.length;
            if (totalPrompts > 1) {
                const promptPlan = [
                    ...frontendPrompts.map((p, i) => `FRONTEND ${i + 1}: ${p.filename}\n${p.content}`),
                    ...backendPrompts.map((p, i) => `BACKEND ${i + 1}: ${p.filename}\n${p.content}`)
                ].join('\n\n---\n\n');
                projectPromptContext = `\n\n===== OTHER PROMPTS IN THIS PROJECT (background context ONLY - do not implement them now) =====\n${promptPlan}\n===== END BACKGROUND CONTEXT =====\nYour one task is the instruction ABOVE this block. The prompts above only tell you how this deliverable fits a larger project: do not implement, regenerate or "complete" any of them, do not re-emit a file the current instruction does not require, and keep any file you are not asked to change exactly as it is.`;
                log.terminal(`Background context loaded: ${frontendPrompts.length} frontend + ${backendPrompts.length} backend prompt(s), ${promptPlan.length} chars.`);
            } else {
                log.terminal('Single-prompt run: no project plan is attached, so this prompt is the entire brief and nothing is carried over.');
            }

            // Step 2: Scaffold the folder structure (backs up existing output first)
            const routing = Encrypt.getConfig('routing') || {};
            log.info(`Routing strategy '${routing.strategy || 'priority'}' — the AI router will pick the provider.`);
            const basePath = (fileConfig.outputDirectory || '~/Desktop/Dashboard').replace('~', require('os').homedir());
            log.terminal(`Output folder: ${basePath}`);
            // User-configurable output structure (Prompts view -> "Output Folder
            // Structure"). Default: frontend/ + backend/ only; the AI decides
            // which file belongs to which folder via its FILE: path prefixes.
            const outputFolders = Array.isArray(fileConfig.outputFolders) && fileConfig.outputFolders.length
                ? fileConfig.outputFolders
                : ['frontend', 'backend'];
            await FileManager.scaffoldProject(basePath, fileConfig.backupBeforeOverwrite !== false, outputFolders);
            await checkpoint(2, 'Project scaffolded.');

        // XAMPP detection preview (the real connect/deploy runs AFTER validation
        // below — services are started and the database imported there).
        const xamPreview = Xampp.detectXampp((fileConfig.xamppRoot || '').trim());
        log.terminal(xamPreview
            ? `XAMPP detected at ${xamPreview.root} (Apache :80 / MySQL :3306) — deploy + database import run after validation.`
            : 'XAMPP not found - generated files will stay in the output folder (backend/README.md has manual steps).');

            // Step 3 (Phase 1): every frontend prompt, in order
            await runPromptPhase('frontend', 3, frontendPrompts, basePath);
            await checkpoint(3, `Frontend phase complete (${frontendPrompts.length} prompt(s)).`);

            // Ask once at the frontend → backend boundary. Within each phase,
            // runPromptPhase asks before every subsequent prompt.
            if (frontendPrompts.length > 0 && backendPrompts.length > 0) {
                const approved = await waitForNextPromptApproval('backend', 0, backendPrompts[0]);
                if (!approved) { stopRequested = true; throw new Error('Workflow stopped by user.'); }
                await runPromptPhase('backend', 4, backendPrompts, basePath);
            } else {
                await runPromptPhase('backend', 4, backendPrompts, basePath);
            }
            await checkpoint(4, `Backend phase complete (${backendPrompts.length} prompt(s)).`);

            // Final integration gate. If any prompt produced an incomplete or
            // disconnected project, ask the model for a bounded repair pass;
            // never report "completed" while the XAMPP/PHP/MySQL contract is broken.
            //
            // SCOPE-AWARE (2026-10-01): the PHP/MySQL contract is only enforced when a
            // backend prompt actually took part in this run. With no backend prompt the
            // old code failed validation 100% of the time, and the repair pass then
            // invented a PHP/MySQL backend plus a login screen nobody asked for, and
            // re-emitted frontend files (destroying the styles/colours the first pass
            // had produced). A frontend-only run is now judged on its own terms.
            const backendRequested = backendPrompts.length > 0;
            let validation = FileManager.validateGeneratedProject(basePath, { backendRequested });
            if (!validation.valid && backendRequested) {
                const missing = [...(validation.missing || []), ...(validation.failed || [])].join(', ');
                log.warn(`Generated project contract incomplete (${missing}); requesting one repair pass.`);
                broadcastStatus({ step: 4, total: TOTAL_STEPS, state: 'running', message: `Repairing integration: ${missing}` });
                const repair = await ApiManager.generateStructureCode(`${projectPromptContext}\n\nFINAL REPAIR PASS: repair the generated project so every required frontend/backend file exists, the frontend calls the PHP API, and backend/db/schema.sql is a valid MySQL schema for XAMPP. Touch only the files needed to close these gaps - do not add any feature, page, screen or field the plan does not name, and do not re-emit a file you are not changing. Return only complete file markers.`);
                await this._writeFilesFromResponse(basePath, repair.text);
                validation = FileManager.validateGeneratedProject(basePath, { backendRequested });
            }
            if (!validation.valid) {
                const details = [...(validation.missing || []), ...(validation.failed || [])].join(', ') || validation.reason;
                throw new Error(`Generated dashboard failed integration validation: ${details}`);
            }
            if (backendRequested) {
                log.terminal('Project integration validated: XAMPP/PHP/MySQL contract, frontend API wiring, and SQL schema are present.');
            } else {
                log.terminal(`Frontend-only run validated: ${(validation.fileCount || 0)} file(s) written. No backend prompt exists, so no PHP/MySQL/XAMPP contract was enforced and none was generated.`);
            }

            // FULL LOCAL CONNECTION (2026-09-25): a generated project is only
            // useful when it RUNS. Start Apache + MySQL when they are down,
            // copy the project into htdocs/autodash-dashboard, import
            // backend/db/schema.sql into MySQL (old DB is dumped first) and
            // verify the LIVE health.php (real PDO check). Flags live in
            // fileConfig: xamppAutoDeploy / xamppAutoStart / xamppImportSchema.
            // Gated on backendRequested: with no backend prompt there is no PHP,
            // no schema.sql and nothing for Apache to serve, so deploying a static
            // or Next.js site into htdocs would only produce noise and failures.
            if (fileConfig.xamppAutoDeploy !== false && backendRequested) {
                const xamRoot = (fileConfig.xamppRoot || '').trim();
                if (Xampp.detectXampp(xamRoot)) {
                    broadcastStatus({ step: 5, total: TOTAL_STEPS, state: 'running', message: 'Connecting to XAMPP (Apache, MySQL, database import)...' });
                    log.terminal('Connecting to XAMPP: services -> deploy -> schema import -> live health check...');
                    const xampp = await Xampp.connect(basePath, {
                        start: fileConfig.xamppAutoStart !== false,
                        import: fileConfig.xamppImportSchema !== false,
                        xamppRoot: xamRoot,
                    });
                    for (const step of (xampp.steps || [])) {
                        log.terminal(`  [${step.ok ? 'OK' : 'FAIL'}] ${step.name}: ${step.detail}`);
                    }
                    if (xampp.ok) {
                        log.terminal(`Dashboard is LIVE at ${xampp.url} (phpMyAdmin: http://localhost/phpmyadmin/)`);
                    } else {
                        const failed = (xampp.steps || []).find(s => !s.ok);
                        throw new Error(`Generated dashboard is NOT connected to XAMPP (${xampp.reason || 'unknown reason'}): ${failed ? failed.detail : 'see terminal steps'}`);
                    }
                } else {
                    log.warn('XAMPP not found - skipping deploy/database import; files remain in the output folder.');
                }
            } else {
                log.terminal('XAMPP auto-deploy disabled (fileConfig.xamppAutoDeploy = false) - files remain in the output folder.');
            }


            // Step 5 (Phase 3): launch VS Code ONCE, then dispatch any remaining
            // (legacy extension) prompts to the SAME window via Cline.
            if (extensionPrompts.length > 0) {
                const vsConfig = Encrypt.getConfig('vscodeAutomation') || {};
                const waitSec = vsConfig.waitBetweenPromptsSec || 30;
                await ClineAuto.launchVsCodeOnce(basePath);
                log.terminal(`Launching VS Code once and dispatching ${extensionPrompts.length} prompt(s) to ${vsConfig.aiExtension || 'cline'}...`);
                for (const bPrompt of extensionPrompts) {
                    assertNotStopped();
                    await ClineAuto.sendPromptToCline(bPrompt, vsConfig.typingSpeedMs || 50);
                    broadcastStatus({ step: 5, total: TOTAL_STEPS, message: 'Sending Cline prompt...', state: 'running' });
                    log.info(`Waiting ${waitSec}s for Cline to process before next prompt...`);
                    await new Promise(res => setTimeout(res, waitSec * 1000));
                }
            } else {
                log.info('No extension prompts to dispatch — skipping VS Code automation.');
            }
            await checkpoint(5, 'VS Code automation complete.');

            // Success (silent-aware notification)
            log.terminal(`Workflow complete: ${frontendPrompts.length} frontend + ${backendPrompts.length} backend prompt(s) processed.`);
            broadcastStatus('completed');
            notifyUser(
                'AutoDash Complete',
                `Dashboard generated from ${frontendPrompts.length} frontend + ${backendPrompts.length} backend prompt(s).`,
                { sound: false }
            );

        } catch (error) {
            runFailed = true;
            log.error('Workflow Error:', error);
            log.terminal(`Workflow ${stopRequested ? 'stopped' : 'failed'}: ${error.message}`);
            broadcastStatus(stopRequested ? 'stopped' : 'failed');
            notifyUser('AutoDash Failed', error.message, { sound: false });
            // PART 2b: workflow failures used to reach ONLY the terminal, so the
            // Error Center stayed empty while the terminal filled with errors.
            // Mirror every run failure into the Error Center through the same
            // hook health checks use. A user-requested stop is not an error.
            if (!stopRequested && errorRecorder) {
                try { errorRecorder(error, { label: 'Workflow run', source: 'scheduler' }); } catch (re) { /* ignore */ }
            }
        } finally {
            isRunning = false;
            paused = false;
            // FEATURE D: record this run to runs/history.json
            // Dedupe: every prompt rewrites the shared files (index.html,
            // styles.css, schema.sql, ...), so a naive concat reported one run
            // as 41 "files" when only 9 unique paths exist on disk. The
            // Dashboard KPIs ("N files generated") sum this array, so the
            // duplicates were inflating the count ~4.5x.
            // Order preserved (first-write wins), newest prompt last.
            const uniqueFiles = [...new Set(writtenFiles)];
            recordRunHistory({
                timestamp: new Date().toISOString(),
                durationMs: Date.now() - runStart,
                frontend: frontendPrompts.length,
                backend: backendPrompts.length,
                provider: usedProvider || 'none',
                status: stopRequested ? 'stopped' : (runFailed ? 'failed' : 'completed'),
                files: uniqueFiles
            });
        }
    },

    /**
     * Stops the running workflow (cooperative cancellation) WITHOUT touching
     * the cron schedule. Use cancelSchedule() to remove the daily job.
     */
    stop() {
        if (!isRunning) {
            log.info('Stop requested but no workflow is running.');
            return;
        }
        requestStopForApproval();
        log.warn('Stop requested — workflow will halt at the next checkpoint.');
    },

    /**
     * Pauses the running workflow at the next checkpoint. It resumes only when
     * resume() is called (or it is stopped). Idempotent.
     */
    pause() {
        if (!isRunning) {
            log.info('Pause requested but no workflow is running.');
            return;
        }
        paused = true;
        broadcastStatus({ state: 'paused', step: 0, total: 0, message: 'Workflow paused.' });
        log.warn('Workflow paused — call resume() to continue.');
    },

    /**
     * Resumes a paused workflow from its last checkpoint.
     */
    /**
     * Approve the next prompt after a completed prompt. IDs are checked to make
     * double-clicks harmless and prevent stale UI buttons approving a later run.
     */
    approveNextPrompt(approvalId) {
        if (!pendingApproval || (approvalId != null && Number(approvalId) !== pendingApproval.id)) {
            return { success: false, error: 'This approval request is no longer active.' };
        }
        const waiter = pendingApproval;
        pendingApproval = null;
        waiter.resolve(true);
        broadcastStatus({ state: 'running', message: `Starting ${waiter.phase} prompt ${waiter.nextIndex + 1}: ${waiter.nextPrompt.name || waiter.nextPrompt.filename || 'next prompt'}.` });
        return { success: true };
    },

    /**
     * Decline the next prompt. The run ends at this safe boundary and the
     * already-written files remain intact (no rollback/destructive cleanup).
     */
    declineNextPrompt(approvalId) {
        if (!pendingApproval || (approvalId != null && Number(approvalId) !== pendingApproval.id)) {
            return { success: false, error: 'This approval request is no longer active.' };
        }
        const waiter = pendingApproval;
        pendingApproval = null;
        requestStopForApproval(); // clears the waiter safely
        waiter.resolve(false);
        broadcastStatus({ state: 'stopped', message: `Stopped before ${waiter.phase} prompt ${waiter.nextIndex + 1}. Generated files were kept.` });
        log.warn(`User declined ${waiter.phase} prompt ${waiter.nextIndex + 1}; run stopped safely.`);
        return { success: true, stopped: true };
    },

    /** Returns the current approval request, useful after a renderer reload. */
    getPendingApproval() {
        if (!pendingApproval) return { success: true, pending: false };
        return {
            success: true, pending: true, approvalId: pendingApproval.id,
            phase: pendingApproval.phase, nextIndex: pendingApproval.nextIndex + 1,
            nextName: pendingApproval.nextPrompt.name || pendingApproval.nextPrompt.filename || 'next prompt'
        };
    },

    resume() {
        if (!paused) {
            log.info('Resume requested but workflow is not paused.');
            return;
        }
        paused = false;
        broadcastStatus('running');
        log.info('Workflow resumed.');
    },

    forceRun() {
        log.info('Force Run initiated by user.');
        this.executeWorkflow();
    },

    /** PART 2: main.js injects recordError here so health-check failures reach the Error Center. */
    setErrorRecorder(fn) { errorRecorder = typeof fn === 'function' ? fn : null; }
};