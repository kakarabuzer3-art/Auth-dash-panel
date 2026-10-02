/**
 * @file errorStore.js
 * @description Persistent error registry backing the Logs > Error Center tab.
 *              Every captured failure is stored in runs/errors.json with a code,
 *              a plain-language cause and a suggested fix, so a non-expert user
 *              can act on it without reading the raw stack trace.
 *
 *              ERROR_CODES is the single source of truth for the Error Guide tab
 *              as well: the renderer fetches it through the `errors:catalog` IPC
 *              channel instead of duplicating the reference text in HTML.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');

// Same runs/ location main.js reads for usage.json (repo-relative, not cwd-relative).
const RUNS_DIR = path.resolve(__dirname, '..', '..', 'runs');
const ERRORS_FILE = path.join(RUNS_DIR, 'errors.json');
const MAX_ENTRIES = 500;
const DEFAULT_RETENTION_DAYS = 30;

/**
 * HTTP codes from the provider APIs plus this app's own local failure codes.
 * group: 'client' (4xx) | 'server' (5xx) | 'local' (no HTTP round trip).
 */
const ERROR_CODES = {
    400: { group: 'client', name: 'Bad Request', retryable: false, meaning: 'The request was malformed', why: 'Invalid model name, exceeded context window, or a bad request body', fix: 'Check the prompt size and the model chosen in AI Settings' },
    401: { group: 'client', name: 'Unauthorized', retryable: false, meaning: 'The API key is invalid or missing', why: 'Key expired, wrong format, or deleted in the provider dashboard', fix: 'Re-enter the API key in API Keys (generate a new one if needed)' },
    403: { group: 'client', name: 'Forbidden', retryable: false, meaning: 'The key is valid but lacks permission', why: 'Account, billing or region restriction on the provider side', fix: 'Check the provider account access and billing status' },
    404: { group: 'client', name: 'Not Found', retryable: false, meaning: 'The model or endpoint does not exist', why: 'Model id is deprecated or unavailable for this key', fix: 'Pick a current model in AI Settings (use Fetch Models)' },
    408: { group: 'client', name: 'Request Timeout', retryable: true, meaning: 'The provider timed out', why: 'Slow upstream or a very large prompt', fix: 'Auto-retried; split oversized prompts if it keeps happening' },
    429: { group: 'client', name: 'Too Many Requests', retryable: true, meaning: 'Rate limit or quota exceeded', why: 'Free-tier daily quota or per-minute rate limit reached', fix: 'Wait for the quota reset, add extra API keys, or switch provider' },
    500: { group: 'server', name: 'Internal Server Error', retryable: true, meaning: 'Provider-side bug', why: 'Unhandled error inside the provider service', fix: 'Auto-retried; switch provider if it persists' },
    502: { group: 'server', name: 'Bad Gateway', retryable: true, meaning: 'Upstream failure at the provider', why: 'Provider edge/network problem', fix: 'Auto-retried; normally no user action needed' },
    503: { group: 'server', name: 'Service Unavailable', retryable: true, meaning: 'Provider overloaded or under maintenance', why: 'High demand or a temporary outage', fix: 'Wait a few minutes and retry' },
    504: { group: 'server', name: 'Gateway Timeout', retryable: true, meaning: 'Provider took too long to respond', why: 'Complex prompt, large context window or provider load', fix: 'Reduce the prompt size or retry' },
    ERR_NO_INTERNET: { group: 'local', name: 'No Internet Connection', retryable: true, meaning: 'The machine is offline', why: 'WiFi/Ethernet dropped or DNS lookup failed', fix: 'Check the network connection, then retry' },
    ERR_NO_API_KEY: { group: 'local', name: 'API Key Missing', retryable: false, meaning: 'No API key configured for this provider', why: 'The provider was never filled in under API Keys', fix: 'Open API Keys and paste a valid key' },
    ERR_ALL_PROVIDERS_FAILED: { group: 'local', name: 'All AI Providers Failed', retryable: true, meaning: 'Every enabled provider returned an error', why: 'All keys invalid/expired or every quota exhausted', fix: 'Fix the keys in API Keys or enable another provider' },
    ERR_PROMPT_EMPTY: { group: 'local', name: 'Prompt Content Empty', retryable: false, meaning: 'A prompt file has no usable content', why: 'The file is empty or only contains comments', fix: 'Add content to the prompt in the Prompts view' },
    ERR_FILE_WRITE: { group: 'local', name: 'File Write Failed', retryable: true, meaning: 'Generated files could not be written', why: 'Output folder missing, locked by another app, or read-only', fix: 'Check the output directory in Settings and close any app locking it' },
    ERR_JSON_PARSE: { group: 'local', name: 'Invalid JSON Response', retryable: true, meaning: 'The AI returned something unparsable', why: 'Truncated or malformed model output', fix: 'Retry; lower max tokens or simplify the prompt if it repeats' },
    CACHE_LOCKED: { group: 'local', name: 'GPU Cache Locked', retryable: false, meaning: 'Chromium could not move its cache folder', why: 'Another app instance or a crashed leftover holds the cache lock', fix: 'Close other instances, restart the app; the shader cache is skipped automatically now' },
    GPU_CACHE_FAIL: { group: 'local', name: 'GPU Cache Creation Failed', retryable: false, meaning: 'The GPU disk cache could not be created', why: 'Disk permission problem or a locked cache folder', fix: 'Harmless (shader cache disabled); if it repeats, clear %APPDATA%\\autodash-control-panel and restart' },
    RENDERER_GONE: { group: 'local', name: 'Renderer Process Crashed', retryable: true, meaning: 'The UI process died unexpectedly', why: 'Out of memory or a GPU/driver crash', fix: 'The window usually reloads itself; otherwise restart the app' },
    CHILD_PROCESS_GONE: { group: 'local', name: 'Child Process Crashed', retryable: true, meaning: 'An Electron helper process (GPU/utility) died', why: 'GPU driver fault or resource exhaustion', fix: 'Restart the app; if it repeats, update graphics drivers' },
    CHROMIUM_ERROR: { group: 'local', name: 'Chromium Internal Error', retryable: true, meaning: 'A low-level Chromium/Electron subsystem reported an error', why: 'Internal browser condition (network, disk, cache)', fix: 'Usually harmless; check the message and restart if behaviour breaks' }
};

const UNKNOWN_META = {
    group: 'local', name: 'Unknown Error', retryable: false,
    meaning: 'The failure did not match a known error code',
    why: 'Unexpected condition - see the message and the raw logs',
    fix: 'Review the message, then retry; check Logs for the full context'
};

const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENETDOWN', 'ECONNRESET', 'EHOSTUNREACH', 'ERR_NO_INTERNET'];
const FILE_CODES = ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EBUSY', 'ERR_FILE_WRITE'];

/**
 * Maps a thrown error (axios / node / app-level) onto one of the codes above.
 * @param {Error} err
 * @returns {number|string} HTTP status or an 'ERR_*' code
 */
function extractCode(err) {
    if (!err) return 'UNKNOWN';
    const httpStatus = (err.response && err.response.status)
        || (typeof err.status === 'number' ? err.status : null);
    if (httpStatus) return httpStatus;

    const raw = String(err.code || '');
    if (NETWORK_CODES.includes(raw)) return 'ERR_NO_INTERNET';
    if (raw === 'ETIMEDOUT' || raw === 'ECONNABORTED') return 408;
    if (raw === 'ERR_JSON_PARSE') return 'ERR_JSON_PARSE';
    if (FILE_CODES.includes(raw)) return 'ERR_FILE_WRITE';
    // Explicit catalog codes win (RENDERER_GONE, CHILD_PROCESS_GONE, ...):
    if (ERROR_CODES[raw]) return raw;

    const msg = String(err.message || err);
    // App-level aggregate/config messages first: they carry the actionable fix,
    // even when they embed a provider status code ("... Errors: ... code 429").
    if (/all .*providers? failed/i.test(msg)) return 'ERR_ALL_PROVIDERS_FAILED';
    if (/unsupported (ai )?providers?/i.test(msg)) return 'ERR_ALL_PROVIDERS_FAILED';
    if (/routing\.fallback is disabled/i.test(msg)) return 'ERR_ALL_PROVIDERS_FAILED';
    if (/no api key|api key (is )?(missing|not (set|configured))/i.test(msg)) return 'ERR_NO_API_KEY';
    if (/prompt (content )?(is )?empty|empty prompt/i.test(msg)) return 'ERR_PROMPT_EMPTY';
    if (/unexpected token|json\.parse|invalid json|not valid json/i.test(msg)) return 'ERR_JSON_PARSE';
    if (/eacces|eperm|enospc|read-only|write failed|ebusy/i.test(msg)) return 'ERR_FILE_WRITE';
    const statusInMsg = msg.match(/status code (\d{3})/i);
    if (statusInMsg) return Number(statusInMsg[1]);
    if (/socket hang up|getaddrinfo|offline|enetunreach|network error|timed? ?out/i.test(msg)) return 'ERR_NO_INTERNET';
    return 'UNKNOWN';
}

/** Metadata for a code, falling back to UNKNOWN_META. */
function metaFor(code) {
    return ERROR_CODES[code] || UNKNOWN_META;
}

/**
 * Single-line failure text (mirrors ApiManager.humanMessage — kept local so
 * errorStore stays dependency-light). Unwraps the nested {error:{message}}
 * JSON envelopes provider SDKs throw, so the Error Center list + its toasts
 * show a readable sentence instead of a multi-KB blob.
 * @param {*} err
 * @param {number} [max=300]
 * @returns {string}
 */
function humanMessage(err, max = 300) {
    let msg = String((err && err.message) || err || 'Unknown error');
    for (let i = 0; i < 4 && /^\s*\{/.test(msg); i++) {
        try {
            const obj = JSON.parse(msg);
            const inner = (obj && obj.error) || obj;
            const next = typeof inner === 'string'
                ? inner
                : (inner && (inner.message || inner.msg || inner.status || inner.error));
            if (typeof next === 'string' && next.trim()) { msg = next; continue; }
            break;
        } catch { break; }
    }
    msg = msg.replace(/\s+/g, ' ').trim();
    if (msg.length > max) msg = msg.slice(0, max - 1) + '…';
    return msg;
}

/**
 * Builds a complete, persistable error entry from a thrown error.
 * @param {Error|string} err
 * @param {Object} [context] { provider, model, label }
 * @returns {Object} entry
 */
function buildEntry(err, context = {}) {
    const code = extractCode(err);
    const meta = metaFor(code);
    const message = humanMessage(err, 300);
    return {
        id: 'err_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        timestamp: new Date().toISOString(),
        code,
        codeName: meta.name,
        codeGroup: meta.group,
        retryable: !!meta.retryable,
        provider: context.provider || '',
        model: context.model || '',
        message: message.slice(0, 500),
        cause: meta.why,
        suggestion: meta.fix,
        context: context.label || '',
        source: context.source || (/^(chromium|system):/.test(String(context.label || '')) ? String(context.label).split(':')[0] : 'app'),
        resolved: false
    };
}

// ---------------------------------------------------------------------------
// Storage (runs/errors.json)
// ---------------------------------------------------------------------------

/** Reads the store, recovering from a missing or corrupt file. */
function readAll() {
    try {
        if (!fs.existsSync(ERRORS_FILE)) return [];
        const parsed = JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
        return Array.isArray(parsed.errors) ? parsed.errors : [];
    } catch (error) {
        log.warn(`Error store unreadable (${error.message}) - starting a fresh list.`);
        return [];
    }
}

/** Atomic write (temp file + rename) so a crash cannot truncate the history. */
function writeAll(entries) {
    try {
        if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });
        const tmp = ERRORS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ errors: entries }, null, 2), 'utf8');
        fs.renameSync(tmp, ERRORS_FILE);
        return true;
    } catch (error) {
        log.error(`Could not persist the error store: ${error.message}`);
        return false;
    }
}

/** Retention window from logsConfig (defaults to 30 days). */
function getRetentionDays() {
    try {
        const cfg = require('./encryption').getConfig('logsConfig') || {};
        const days = Number(cfg.errorRetentionDays);
        return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS;
    } catch {
        return DEFAULT_RETENTION_DAYS;
    }
}

/**
 * Drops entries older than the retention window.
 * @returns {number} number of removed entries
 */
function autoCleanup() {
    const cutoff = Date.now() - getRetentionDays() * 24 * 60 * 60 * 1000;
    const entries = readAll();
    const kept = entries.filter(e => {
        const t = Date.parse(e.timestamp || 0);
        return !Number.isFinite(t) || t >= cutoff;
    });
    if (kept.length !== entries.length) writeAll(kept);
    return entries.length - kept.length;
}

/**
 * Appends one entry (buildEntry output) and caps the file at MAX_ENTRIES.
 * Deduplicates: an UNRESOLVED entry with the same failure signature (code +
 * provider + model + context + message head) is BUMPED (timestamp + count)
 * instead of appended — repeated pre-run health checks against the same dead
 * key/quota otherwise flood the Error Center with identical rows (observed
 * live: 3x identical groq-401 health entries after 4 Force Runs, 2026-09-23).
 * @returns {{entry:Object, deduped:boolean}} stored entry + whether it merged
 */
function save(entry) {
    const all = readAll();
    const sig = e => [e.code, e.provider || '', e.model || '', e.context || '',
        String(e.message || '').slice(0, 120)].join('|');
    const wanted = sig(entry);
    const dup = !entry.resolved && all.find(e => !e.resolved && sig(e) === wanted);
    if (dup) {
        dup.timestamp = entry.timestamp || dup.timestamp;
        dup.count = (dup.count || 1) + 1;
        writeAll(all);
        return { entry: dup, deduped: true };
    }
    const next = [entry].concat(all).slice(0, MAX_ENTRIES);
    writeAll(next);
    return { entry, deduped: false };
}

/**
 * Lists entries, newest first.
 * @param {Object} [filter] { status:'all'|'unresolved'|'resolved', provider, code }
 */
function list(filter = {}) {
    autoCleanup();
    let entries = readAll().slice().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const status = filter.status || 'all';
    if (status === 'unresolved') entries = entries.filter(e => !e.resolved);
    if (status === 'resolved') entries = entries.filter(e => e.resolved);
    if (filter.provider && filter.provider !== 'all') entries = entries.filter(e => e.provider === filter.provider);
    if (filter.code && filter.code !== 'all') entries = entries.filter(e => String(e.code) === String(filter.code));
    if (filter.source && filter.source !== 'all') entries = entries.filter(e => (e.source || 'app') === filter.source);
    return entries;
}

/** Marks one entry resolved. */
function resolve(id) {
    const entries = readAll();
    const hit = entries.find(e => e.id === id);
    if (!hit) return false;
    hit.resolved = true;
    hit.resolvedAt = new Date().toISOString();
    writeAll(entries);
    return true;
}

/** Empties the store. */
function clear() {
    writeAll([]);
    return true;
}

/** CSV cell escaping (RFC4180-ish). */
function csvCell(value) {
    const s = String(value == null ? '' : value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * Serialises the store for the Error Center Export button.
 * @param {'json'|'csv'} format
 * @returns {{content:string, filename:string, mime:string}}
 */
function exportData(format = 'json') {
    const entries = list({ status: 'all' });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
        const cols = ['timestamp', 'code', 'codeName', 'provider', 'model', 'message', 'cause', 'suggestion', 'context', 'resolved'];
        const rows = [cols.join(',')].concat(entries.map(e => cols.map(c => csvCell(e[c])).join(',')));
        return { content: rows.join('\r\n'), filename: 'autodash-errors-' + stamp + '.csv', mime: 'text/csv' };
    }
    return { content: JSON.stringify({ errors: entries }, null, 2), filename: 'autodash-errors-' + stamp + '.json', mime: 'application/json' };
}

/** Reference data for the Guide tab (single source of truth). */
function catalog() {
    return { codes: ERROR_CODES, retentionDays: getRetentionDays(), maxEntries: MAX_ENTRIES };
}

module.exports = {
    ERROR_CODES, ERRORS_FILE,
    buildEntry, extractCode,
    save, list, clear, resolve, autoCleanup, exportData, catalog
};

