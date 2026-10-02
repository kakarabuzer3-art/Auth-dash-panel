/**
 * @file apiManager.js
 * @description Smart multi-provider AI router (Gemini, Groq, Kimi, OpenRouter)
 *              with priority-based routing, retries and per-provider fallback.
 */

const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const Encrypt = require('./encryption');
const log = require('./logger');
const fs = require('fs-extra');
const path = require('path');

// FEATURE A (retry) + FEATURE B (streaming): shared EventEmitter so main.js /
// preload.js can forward live token chunks to the renderer via IPC.
// Exported ONLY from the single `module.exports = { … }` block at the bottom:
// `module.exports.X = X` assignments ABOVE it are discarded.
const { EventEmitter } = require('events');
const StreamBus = new EventEmitter();

// Smart retry back-off schedule (ms). Attempt 1 is immediate (0 ms).
// ---------------------------------------------------------------------------
// ERROR CLASSIFICATION (2026-09-23)
// Raw provider errors -> actionable diagnoses. Gemini reports a quota problem
// as HTTP 429 + status RESOURCE_EXHAUSTED + a QuotaFailure detail. The old code
// surfaced that JSON verbatim ("You exceeded your current quota...") and then
// RETRIED it, burning the remaining daily allowance. classifyProviderError()
// separates "the key is invalid" from "the key is fine, the quota is spent".
// ---------------------------------------------------------------------------

/**
 * Pulls {status, reason, retryDelayMs, quotaValue, message} out of the many
 * shapes the SDKs / axios / JSON-in-message errors use.
 */
function parseProviderError(err) {
    const candidates = [];
    const push = (o) => { if (o && typeof o === 'object') candidates.push(o); };
    if (err && err.response && err.response.data) push(err.response.data);
    if (err && err.error) push(err.error);
    const msg = err && err.message ? String(err.message) : '';
    if (msg) {
        const i = msg.indexOf('{');
        if (i >= 0) {
            try { push(JSON.parse(msg.slice(i))); } catch (e) { /* message is not JSON */ }
        }
    }
    for (const c of candidates) {
        const e = (c && c.error && typeof c.error === 'object') ? c.error : c;
        if (!e || typeof e !== 'object') continue;
        let reason = '';
        let retryDelayMs = 0;
        let quotaValue = '';
        const details = Array.isArray(e.details) ? e.details : [];
        for (const d of details) {
            if (!d || typeof d !== 'object') continue;
            const type = String(d['@type'] || '');
            if (/ErrorInfo/.test(type) && typeof d.reason === 'string' && d.reason) reason = d.reason;
            if (/QuotaFailure/.test(type)) {
                if (!reason) reason = 'QUOTA_FAILURE';
                if (!quotaValue && d.quotaValue) quotaValue = String(d.quotaValue);
                // Google nests the real limit inside violations[]:
                // { '@type': '.../QuotaFailure', violations: [{ quotaValue: '20' }] }
                if (!quotaValue && Array.isArray(d.violations) && d.violations[0] && d.violations[0].quotaValue) {
                    quotaValue = String(d.violations[0].quotaValue);
                }
            }
            if (/RetryInfo/.test(type) && typeof d.retryDelay === 'string') {
                const m = d.retryDelay.match(/([\d.]+)s/);
                if (m) retryDelayMs = Math.ceil(parseFloat(m[1]) * 1000);
            }
        }
        if (!reason && typeof e.status === 'string') reason = e.status;
        return {
            status: typeof e.code === 'number' ? e.code : null,
            reason,
            retryDelayMs,
            quotaValue,
            message: typeof e.message === 'string' ? e.message : '',
        };
    }
    return { status: null, reason: '', retryDelayMs: 0, quotaValue: '', message: '' };
}

/** Best-effort HTTP status from any error shape (axios, SDK, plain). */
function httpStatusOf(err) {
    if (!err) return null;
    if (err.response && typeof err.response.status === 'number') return err.response.status;
    if (typeof err.status === 'number') return err.status;
    if (typeof err.code === 'number') return err.code;
    return null;
}

/**
 * Normalizes any provider failure into a diagnosis the UI can show.
 * @returns {{kind:string, provider:string, status:number|null, retryDelayMs:number,
 *            quotaValue:string, message:string, suggestions:string[]}}
 * kind: 'invalid-key' | 'quota-exhausted' | 'rate-limited' | 'bad-model' | 'network' | 'unknown'
 */
function classifyProviderError(err, provider) {
    const parsed = parseProviderError(err);
    const status = parsed.status || httpStatusOf(err);
    const raw = String((err && err.message) || err || '');
    const haystack = (raw + ' ' + parsed.message + ' ' + parsed.reason).toLowerCase();

    const keyInvalid = status === 401 || status === 403
        || /api_key_invalid|api key not valid|invalid api key|incorrect api key|unauthorized|invalid authentication credential/.test(haystack);
    const quotaGone = status === 429 && /quota|resource_exhausted|exceeded your current/.test(haystack);
    const throttled = status === 429 && !quotaGone;
    const badModel = status === 404 || /is not found|not supported|does not exist|no such model|no longer available/.test(haystack);
    // 503 "high demand" is Google shedding load on ONE model - it must rotate
    // to the next model, not fall through to 'unknown' (2026-09-24: every chat
    // died here while gemini-3.6-flash was healthy).
    const overloaded = status === 503 || /high demand|overloaded|unavailable|capacity/.test(haystack);
    const network = /timeout|etimedout|econnreset|enotfound|eai_again|socket hang up|network error/.test(haystack);

    let kind = 'unknown';
    if (keyInvalid) kind = 'invalid-key';
    else if (quotaGone) kind = 'quota-exhausted';
    else if (throttled) kind = 'rate-limited';
    else if (badModel) kind = 'bad-model';
    else if (overloaded) kind = 'overloaded';
    else if (network) kind = 'network';

    const suggestions = [];
    if (kind === 'invalid-key') {
        // SMART 401 DIAGNOSIS (2026-09-25): Google's wording is misleading, so
        // branch on the machine-readable reason instead of parroting it.
        // Verified live against the user's dead key:
        //   ?key= / x-goog-api-key -> 401 ACCESS_TOKEN_TYPE_UNSUPPORTED
        //   Authorization: Bearer  -> 401 API_KEY_SERVICE_BLOCKED
        // => the key itself is rejected; OAuth headers can NEVER fix it.
        const reason = String(parsed.reason || '');
        const oauthWording = reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED'
            || /expected oauth 2|login cookie|access_token_type_unsupported/.test(haystack);
        const serviceBlocked = reason === 'API_KEY_SERVICE_BLOCKED'
            || /api_key_service_blocked|credentials_missing/.test(haystack);
        if (provider === 'gemini' && oauthWording) {
            suggestions.push('Google answered with its generic "Expected OAuth 2 access token" wording - that is a red herring. This app already sends the key correctly (?key= / x-goog-api-key); switching to Authorization: Bearer does NOT help (live-tested: it fails with API_KEY_SERVICE_BLOCKED).');
            suggestions.push('AQ. keys are the CURRENT Google AI Studio key format and authenticate exactly like AIzaSy keys. Google has a known bug where SOME AQ. keys/projects get this exact 401 (ACCESS_TOKEN_TYPE_UNSUPPORTED) on every request while other keys on the same account keep working.');
            suggestions.push('Verify for free: press "Check Status" (model listing only, ZERO generation quota). If that also fails with this 401, the key itself is revoked or hit the bug - create a fresh key at aistudio.google.com/api-keys (use a NEW Google project to escape a broken project flag) and Save it.');
            suggestions.push('If you pasted the key by hand: re-copy it whole - AQ. keys run about 53 characters, and a truncated paste returns the same 401.');
        } else if (provider === 'gemini' && serviceBlocked) {
            suggestions.push('API_KEY_SERVICE_BLOCKED: the credential is not an AI Studio API key at all - an OAuth/session token or a Vertex/AI-Platform credential was pasted here. Use an AQ. or AIzaSy key from aistudio.google.com/api-keys.');
            suggestions.push('Press "Check Status" (zero quota) to confirm, then paste the fresh key and press "Save API Keys".');
        } else {
            suggestions.push('The provider rejected this key - re-copy it (no trailing spaces) and Save again.');
            suggestions.push('Press "Check Status" first (model listing only, zero quota) to confirm the key itself before spending a generation attempt.');
        }
    } else if (kind === 'quota-exhausted') {
        suggestions.push('The key itself is VALID - the free-tier daily quota for this MODEL is used up (Google free tier: about 20 requests/day per model, per project).');
        suggestions.push('A new key inside the SAME Google project shares that quota. Create the key in a NEW project, or wait for the daily reset.');
        suggestions.push('Switch the Gemini model in AI Settings - every model has its own daily bucket (e.g. gemini-3.5-flash-lite).');
        suggestions.push('Add one key per project under "Additional Gemini Keys" - the router rotates them automatically.');
    } else if (kind === 'rate-limited') {
        suggestions.push('Short-term rate limit - wait a few seconds and retry, or slow the request pace down.');
    } else if (kind === 'bad-model') {
        suggestions.push('The stored model id is not available for this key - press Fetch Models and pick one from the list.');
    } else if (kind === 'overloaded') {
        suggestions.push('Google is shedding load on this model right now (503 high demand) - the router automatically tries the next model; if every model is busy, retry in a minute.');
    } else if (kind === 'network') {
        suggestions.push('Network problem reaching the provider - check the connection and retry.');
    }

    return {
        kind,
        provider: provider || '',
        status,
        retryDelayMs: parsed.retryDelayMs,
        quotaValue: parsed.quotaValue,
        message: (parsed.message || raw).slice(0, 600),
        suggestions,
    };
}

/**
 * SMART ERROR LEVELS (2026-09-29).
 * Decides whether a mid-run provider failure is a self-healing HICCUP (log.warn)
 * or a genuine ERROR (log.error). The user's report: a 503 "high demand" printed
 * as a red error in the Logs while the router was already switching to another
 * model and the run continued normally.
 * @param {string} kind - classifyProviderError().kind
 * @param {{attemptLeft?:boolean, providerLeft?:boolean, modelRescuesLeft?:number, keyRotationsLeft?:number}} ctx
 * @returns {boolean} true when the router still has a way to recover this run
 */
function isRecoverableFailure(kind, ctx) {
    const c = ctx || {};
    if (c.attemptLeft || c.providerLeft) return true;
    if ((kind === 'overloaded' || kind === 'quota-exhausted' || kind === 'bad-model')
        && Number(c.modelRescuesLeft || 0) > 0) return true;
    if ((kind === 'quota-exhausted' || kind === 'rate-limited' || kind === 'invalid-key' || kind === 'overloaded')
        && Number(c.keyRotationsLeft || 0) > 0) return true;
    return false;
}

// ---------------------------------------------------------------------------
// HUMAN MESSAGE (2026-09-23, "attempt spam" fix)
// Provider SDKs throw MULTI-KB JSON blobs as err.message ({"error":{...}}).
// Logging those raw made every retry print a giant wall of text 2x (log.error
// + log.terminal) into the terminal, the Dashboard feed AND the Error Center
// toast — the "attempting … again and again" spam. humanMessage() unwraps the
// nested {error:{message}} envelopes and keeps ONE readable sentence, capped.
// ---------------------------------------------------------------------------
/**
 * @param {*} err - caught error (Error, string, or provider JSON blob)
 * @param {number} [max=200] - hard cap so each log line stays one screen line
 * @returns {string} single-line human-readable failure reason
 */
function humanMessage(err, max = 200) {
    let msg = String((err && err.message) || err || 'Unknown error');
    // Unwrap nested JSON envelopes (Gemini wraps message-in-message).
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

// Gemini free-tier quota is metered PER MODEL, so a spent model can be escaped
// by moving to another one. Ordered lite/cheap first; probeKey() intersects this
// with the live models.list so only models the user's key really offers are used.
const GEMINI_QUOTA_FALLBACKS = [
    'gemini-3.6-flash', // live-verified 200 OK (2026-09-24) - first escape hatch
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-flash-lite-latest',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    // REMOVED (retired upstream, 404 "no longer available to new users"):
    // gemini-2.5-flash-lite, gemini-2.5-flash
];

const RETRY_DELAYS = [0, 2000, 8000, 30000];

/**
 * Generic retry wrapper with exponential back-off.
 * - 429s always consume the full delay (rate-limit respect).
 * - Other transient errors back off before retrying.
 * - On 429 for Gemini, the caller is expected to have rotated the key.
 */
async function _withRetry(fn, maxAttempts = 4) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const status = err?.response?.status || err?.status || err?.code;
            // Terminal failures can never succeed on retry - retrying them only
            // burns the daily quota (this is what made "Test Connection" look
            // like a broken key while it was really a spent free-tier bucket).
            const info = classifyProviderError(err);
            if (info.kind === 'invalid-key' || info.kind === 'quota-exhausted' || info.kind === 'bad-model' || info.kind === 'overloaded') {
                log.warn(`[retry] non-retryable failure (${info.kind}, HTTP ${status || 'n/a'}) - not retrying.`);
                throw err;
            }
            const is429 = (status === 429 || err?.code === 429);
            const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
            if ((is429 || attempt < maxAttempts - 1) && delay > 0) {
                log.info(`[retry] attempt ${attempt + 1}/${maxAttempts} failed (${humanMessage(err, 120)}); waiting ${delay}ms…`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}


const MASTER_PROMPT_SEPARATOR = String.fromCharCode(10, 10);

// Deprecated Gemini models that 404 at the API. Auto-rewritten to a valid default.
const DEPRECATED_GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'];

function sanitizeGeminiModel(model) {
    if (DEPRECATED_GEMINI_MODELS.includes(model)) {
        log.warn(`Deprecated model ${model} → switching to gemini-3.8-flash`);
        return 'gemini-3.8-flash';
    }
    return model;
}

// ISSUE 1 FIX: Groq chat endpoint, centralized for easy debugging. The URL was
// verified correct (https://api.groq.com/openai/v1/chat/completions), so a 404
// with a valid model id points at the key/config, never at this constant.
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ---------------------------------------------------------------------------
// SMART 401 HANDLING (2026-09-25): session dead-key memory + key shape info.
//
// WHY: a live probe proved that a rejected AQ. key fails via EVERY auth style
// (?key= and x-goog-api-key -> 401 ACCESS_TOKEN_TYPE_UNSUPPORTED, Bearer ->
// 401 API_KEY_SERVICE_BLOCKED), so no header trick rescues it: the key itself
// is revoked/bug-affected. Re-trying it during rotation only burns attempts.
// A session-level registry lets the key pool, the workflow rotation and the
// chat router SKIP keys that already answered 401 (a 401 never "heals").
// Registry is per-app-session only - a newly saved key is always tried again
// on the next launch, and when EVERY key is dead the original pool is kept so
// callers still get something to attempt/report instead of an empty chain.
// ---------------------------------------------------------------------------
const deadKeyRegistry = new Set(); // `${provider}|${key}` -> rejected 401 this session

/** Remembers a key that the provider rejected with 401/403 this session. */
function markKeyDead(provider, key) {
    const k = String(key || '').trim();
    if (k) deadKeyRegistry.add(`${provider || 'unknown'}|${k}`);
}

/** True when this exact key already failed auth this session. */
function isKeyDead(provider, key) {
    const k = String(key || '').trim();
    return !!k && deadKeyRegistry.has(`${provider || 'unknown'}|${k}`);
}

// ---------------------------------------------------------------------------
// OVERLOADED-MODEL MEMORY (2026-09-29): Google's 503 "high demand" is load
// shedding on ONE model, never on the account (live-verified 2026-09-24: while
// gemini-3.8-flash 503'd, gemini-3.6-flash answered 200 on the same key). The
// run already auto-switches models when it happens — but the NEXT prompt in the
// same run started on the same shedding model again and paid another 503 round
// trip. This TTL registry remembers the shedding model for a few minutes so the
// router STARTS those prompts on a rested model, and a successful answer clears
// the memory immediately. Session-scoped, self-expiring, no config writes.
// ---------------------------------------------------------------------------
const MODEL_OVERLOAD_TTL_MS = 10 * 60 * 1000;
const overloadedModels = new Map(); // model id -> epoch ms of the last 503

/** Remembers a Gemini model that just answered 503 "high demand". */
function markModelOverloaded(model) {
    const m = String(model || '').trim();
    if (m) overloadedModels.set(m, Date.now());
}

/** True when this model shed load recently (TTL-expired entries self-clean). */
function isModelOverloaded(model) {
    const m = String(model || '').trim();
    if (!m) return false;
    const at = overloadedModels.get(m);
    if (!at) return false;
    if (Date.now() - at > MODEL_OVERLOAD_TTL_MS) {
        overloadedModels.delete(m);
        return false;
    }
    return true;
}

/** Clears the memory (called when the model answers successfully). */
function clearModelOverloaded(model) {
    const m = String(model || '').trim();
    if (m) overloadedModels.delete(m);
}

/**
 * Picks a rested Gemini model for the START of a prompt: a curated fallback that
 * is not currently shedding load and was not already tried in this run. Returns
 * '' when every candidate is overloaded — then the configured model stays.
 */
function pickRestedModel(currentModel, triedModels) {
    const tried = Array.isArray(triedModels) ? triedModels : [];
    return GEMINI_QUOTA_FALLBACKS.find(m => m && m !== currentModel && !tried.includes(m) && !isModelOverloaded(m)) || '';
}

/**
 * Shape analysis of a key so the UI can explain WHAT was pasted instead of
 * only showing Google's raw error. Live facts (2026-09-25): the user's two
 * AI Studio keys are 53-char `AQ.` strings; classic AI Studio keys start
 * `AIza`; Groq `gsk_`; Kimi `sk-`; OpenRouter `sk-or-`.
 * @returns {{kind:string, prefix:string, length:number}|null}
 */
function keyShapeInfo(key) {
    const k = String(key || '').trim();
    if (!k) return null;
    let kind = 'unknown';
    if (k.startsWith('AQ.')) kind = 'gemini-aq';           // current AI Studio format
    else if (k.startsWith('AIza')) kind = 'gemini-aiza';    // classic AI Studio format
    else if (k.startsWith('gsk_')) kind = 'groq';
    else if (k.startsWith('sk-or-')) kind = 'openrouter';
    else if (k.startsWith('sk-')) kind = 'kimi';
    return { kind, prefix: k.slice(0, 6), length: k.length };
}

/** Short non-reversible label for showing WHICH key is meant (never the raw key). */
function maskKeyLite(key) {
    const k = String(key || '').trim();
    if (!k) return '';
    if (k.length <= 10) return '*'.repeat(k.length);
    return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// ISSUE 4 FIX: Gemini multi-key pool. Free-tier keys hit 429 quickly, so
// extra keys can be stored in providers.gemini.apiKeys[] (one per line in the
// UI). providers.gemini.apiKey stays the primary key (backward compatible).
//
// KEY DEDICATION (2026-09-24): pool[0] is the AUTOMATION key - the scheduler
// always starts there. The chat router (main.js chat:stream-route) starts at
// the LAST pool key instead. When either side hits a quota/auth wall it
// automatically "borrows" the next pool key, so both keys back each other up.
function getGeminiKeyPool(geminiConf) {
    const conf = geminiConf || {};
    const keys = [conf.apiKey, ...(Array.isArray(conf.apiKeys) ? conf.apiKeys : [])]
        .map(k => (typeof k === 'string' ? k.trim() : ''))
        .filter(Boolean);
    const deduped = [...new Set(keys)]; // a key pasted twice must not burn retries
    // SESSION DEAD-KEY SKIP: keys that already answered 401 this session are
    // dropped so rotation never lands on them again (verified live: a rejected
    // AQ. key fails via every auth style, so retrying is pure waste). If EVERY
    // key is dead, keep the original pool - callers still need something to
    // attempt/report, and the errors themselves explain the situation.
    const live = deduped.filter(k => !isKeyDead('gemini', k));
    return live.length ? live : deduped;
}

/**
 * Returns the pool key AFTER `afterKey` (round-robin across the whole pool).
 * With no/unknown `afterKey` it returns pool[0] - the dedicated automation key.
 */
function getNextGeminiKey(geminiConf, afterKey) {
    const pool = getGeminiKeyPool(geminiConf);
    if (pool.length === 0) return null;
    const idx = pool.indexOf(afterKey);
    return pool[(idx + 1) % pool.length];
}

/**
 * Reads the master system prompt from disk and appends the user-selected
 * design style preset (prompts/styles/<style>.txt). Returns an empty string
 * when neither file is available; failures are swallowed so prompt
 * generation can never break because of a missing optional file.
 */
function loadMasterPrompt() {
    let master = '';
    // CWD-PROOF resolution (2026-09-25): launched from a shortcut with a
    // different working directory, process.cwd() points somewhere else and the
    // master prompt silently disappeared -> weak generations. Prefer the
    // module-relative path (src/modules -> <project root>) and keep cwd as a
    // fallback for test harnesses that copy prompts elsewhere.
    const roots = [
        path.join(__dirname, '..', '..', 'prompts'),
        path.join(process.cwd(), 'prompts'),
    ];
    try {
        const root = roots.find((r) => fs.existsSync(path.join(r, 'master-system-prompt.txt')));
        if (root) master = fs.readFileSync(path.join(root, 'master-system-prompt.txt'), 'utf8').trim();
    } catch (e) { /* silent */ }

    // Append the user-selected design style preset (prompts/styles/<style>.txt).
    // 'auto' (the default) lets the model choose the design direction itself.
    try {
        const aiCfg = Encrypt.getConfig('aiConfig') || {};
        const style = aiCfg.designStyle || 'auto';
        if (style !== 'auto') {
            const root = roots.find((r) => fs.existsSync(path.join(r, 'styles', style + '.txt')));
            if (root) master += MASTER_PROMPT_SEPARATOR + fs.readFileSync(path.join(root, 'styles', style + '.txt'), 'utf8').trim();
        }
    } catch (e) { /* silent */ }

    // Append the user-configured OUTPUT FOLDER STRUCTURE (fileConfig.outputFolders,
    // editable in the Prompts view). Default: frontend/ + backend/ only — the AI
    // itself decides which generated file belongs to which folder.
    try {
        const fileCfg = Encrypt.getConfig('fileConfig') || {};
        const folders = (Array.isArray(fileCfg.outputFolders) && fileCfg.outputFolders.length
            ? fileCfg.outputFolders
            : ['frontend', 'backend'])
            .map((f) => String(f || '').trim().replace(/^[\\/]+|[\\/]+$/g, ''))
            .filter((f) => f && !f.includes('..'));
        if (folders.length) {
            master += MASTER_PROMPT_SEPARATOR + [
                'OUTPUT FOLDER STRUCTURE (applies only to files you actually generate):',
                `The project root contains these top-level folders: ${folders.join(', ')}.`,
                `Every "--- FILE: <path> ---" path MUST start with one of these folder names (e.g. "${folders[0]}/index.html").`,
                'Place each file in the folder that fits its role: user-facing UI (HTML/CSS/client JS, pages, components) in the frontend folder; server code (API, routes, models, DB schema/seed scripts, config) in the backend folder.',
                'Nested subfolders inside these folders are allowed; creating a NEW top-level folder is not.',
                'ONLY create files and folders the task actually needs. If the task is a frontend/site/plan with no server side, generate ONLY frontend files and leave the other folder empty - never add an API, database, schema, config or admin file just to make the layout look complete.',
            ].join('\n');
        }
    } catch (e) { /* silent */ }

    return master.trim();
}

/**
 * THE system prompt used by every AI call - one resolution path for the whole app.
 *
 * WHY (2026-09-29): the AI Settings prompt box was read directly by the four
 * generation functions, so it never reached the Live AI Chat path, and a single
 * text box could not carry a set of switchable rules. Both problems are solved by
 * delegating to skillRegistry.composeSystemPrompt(), which merges:
 *   1. the user persona prompt (aiConfig.systemPrompt),
 *   2. every ACTIVE SKILL for that target (SEO / honesty / security / ... ),
 *   3. the live MCP tool catalog (chat only),
 * and honours aiConfig.promptScope (chat / automation on-off).
 *
 * @param {'chat'|'automation'} target - which pipeline is asking
 * @returns {string} the system prompt ('' when the target is switched off)
 */
function resolveSystemPrompt(target) {
    try {
        return require('./skillRegistry').composeSystemPrompt(target).text;
    } catch (error) {
        // A prompt must never be able to break a generation run.
        log.warn(`System prompt composition failed (${error.message}) - using the raw aiConfig prompt.`);
        const aiCfg = Encrypt.getConfig('aiConfig') || {};
        return String(aiCfg.systemPrompt || '').trim();
    }
}


// ============================================================================
// COST TRACKING (FEATURE 2)
// ============================================================================

// Approximate USD price per 1M tokens (input, output) per provider. Mirrors the
// costPerMillion* values in default-config.json; used only for the rough
// "Today's API Cost" estimate on the Dashboard.
const PROVIDER_PRICING = {
    gemini: { input: 150, output: 600 },
    groq: { input: 5, output: 10 },
    kimi: { input: 250, output: 1250 },
    openrouter: { input: 500, output: 1500 }
};

/** ~4 characters per token for both prompt and completion text. */
function estimateTokens(text) {
    return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

// Safe, non-secret label for a provider key. Never persist or send raw keys.
function keyLabel(apiKey) {
    const k = String(apiKey || '');
    return k ? `${k.slice(0, 6)}…${k.slice(-4)}` : 'no-key';
}

/**
 * Record authoritative provider usage when the SDK supplies usageMetadata.
 * Google may return promptTokenCount/candidatesTokenCount/totalTokenCount;
 * absent metadata is recorded as 0 rather than estimated or inflated.
 */
function recordKeyUsage(provider, model, apiKey, usage, source = 'generation', ok = true) {
    try {
        if (!usage || typeof usage !== 'object') return;
        const u = usage;
        const input = Number(u.promptTokenCount ?? u.inputTokenCount ?? u.input_tokens ?? 0) || 0;
        const output = Number(u.candidatesTokenCount ?? u.outputTokenCount ?? u.output_tokens ?? 0) || 0;
        const total = Number(u.totalTokenCount ?? u.total_token_count ?? 0) || input + output;
        const date = todayKey();
        const label = keyLabel(apiKey);
        const costs = Encrypt.getConfig('costs') || {};
        const perKey = costs.perKey && typeof costs.perKey === 'object' ? { ...costs.perKey } : {};
        const current = perKey[label] || { date, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, failedCalls: 0, lastModel: '' };
        const same = current.date === date;
        perKey[label] = {
            date,
            calls: (same ? Number(current.calls) || 0 : 0) + 1,
            inputTokens: (same ? Number(current.inputTokens) || 0 : 0) + input,
            outputTokens: (same ? Number(current.outputTokens) || 0 : 0) + output,
            totalTokens: (same ? Number(current.totalTokens) || 0 : 0) + total,
            failedCalls: (same ? Number(current.failedCalls) || 0 : 0) + (ok ? 0 : 1),
            lastModel: model || current.lastModel || '', lastSource: source, lastAt: new Date().toISOString()
        };
        const totals = Object.values(perKey).reduce((a, k) => ({
            inputTokens: a.inputTokens + (Number(k.inputTokens) || 0),
            outputTokens: a.outputTokens + (Number(k.outputTokens) || 0),
            totalTokens: a.totalTokens + (Number(k.totalTokens) || 0),
            calls: a.calls + (Number(k.calls) || 0), failedCalls: a.failedCalls + (Number(k.failedCalls) || 0)
        }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, failedCalls: 0 });
        Encrypt.saveConfig('costs', { ...costs, date, perKey, keyTotals: totals, lastProvider: provider, lastModel: model || '' });
        log.info(`Token ledger: ${label} ${provider}/${model} +${total} exact tokens (${input} in + ${output} out, ${source}).`);
    } catch (error) { log.warn(`Token ledger skipped: ${error.message}`); }
}

/**
 * Records one successful API call into the encrypted "costs" config module:
 * { date, calls, tokens, estimatedCost,
 *   history: [{ date, provider, model, tokens, estimatedCost }] }.
 * Read-merge-write keeps other fields intact; failures are logged, never
 * thrown, so cost accounting can never break a generation run.
 */
function recordApiUsage(provider, promptText, completionText, model) {
    try {
        const price = PROVIDER_PRICING[provider] || { input: 500, output: 1500 };
        const inTokens = estimateTokens(promptText);
        const outTokens = estimateTokens(completionText);
        const tokens = inTokens + outTokens;
        const callCost = (inTokens / 1e6) * price.input + (outTokens / 1e6) * price.output;

        const costs = Encrypt.getConfig('costs') || {};
        const date = todayKey();
        const sameDay = costs.date === date;
        const history = Array.isArray(costs.history) ? costs.history : [];
        history.push({ date, provider, model: model || '', tokens, estimatedCost: callCost });
        while (history.length > 200) history.shift(); // keep the log bounded

        const totals = {
            date,
            calls: (sameDay && Number.isInteger(costs.calls) ? costs.calls : 0) + 1,
            tokens: (sameDay && Number.isFinite(costs.tokens) ? costs.tokens : 0) + tokens,
            estimatedCost: (sameDay && Number.isFinite(costs.estimatedCost) ? costs.estimatedCost : 0) + callCost,
            perKey: costs.perKey && typeof costs.perKey === 'object' ? costs.perKey : {},
            keyTotals: costs.keyTotals && typeof costs.keyTotals === 'object' ? costs.keyTotals : {},
            history
        };
        Encrypt.saveConfig('costs', totals);
        log.info(`Cost tracker: +${tokens} tokens (~$${callCost.toFixed(4)}) via ${provider} — today ~$${totals.estimatedCost.toFixed(4)}, ${totals.calls} call(s).`);
    } catch (error) {
        log.warn(`Cost tracking skipped: ${error.message}`);
    }
}

const PROVIDER_NAMES = ['gemini', 'groq', 'kimi', 'openrouter'];

// Rotates the chain start index for the 'round-robin' routing strategy
let roundRobinCounter = 0;

// Static model lists used to populate the model dropdown and as the fallback
// when a live "fetch models" call fails (PART 1 — Groq models updated 2026).
const MODEL_ENUMS = {
    gemini: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
    groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'groq/compound-mini'],
    kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    openrouter: ['auto', 'google/gemini-2.5-pro', 'meta-llama/llama-4-maverick', 'mistralai/magistral-medium-34b', 'google/gemini-2.5-flash']
};

// Live /models endpoints for providers that expose an OpenAI-compatible list API.
// Gemini lists via the SDK (no REST key endpoint).
const MODEL_ENDPOINTS = {
    groq: 'https://api.groq.com/openai/v1/models',
    kimi: 'https://api.moonshot.cn/v1/models',
    openrouter: 'https://openrouter.ai/api/v1/models'
};

/**
 * Estimate cost in USD for a given provider, model, and token count.
 * Uses rate table from config; returns 0 if rate info is missing.
 */
function estimateCost(provider, model, tokens) {
    try {
        const conf = require('../config/default-config.json');
        const p = (conf.providers || {})[provider] || {};
        const inputRate = p.costPerMillionInput || 0;
        const outputRate = p.costPerMillionOutput || 0;
        // Rough split: 40% input / 60% output for estimation purposes.
        const inputTokens = Math.ceil(tokens * 0.4);
        const outputTokens = tokens - inputTokens;
        const cost = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
        return Math.round(cost * 1e6) / 1e6;
    } catch {
        return 0;
    }
}

/**
 * Record a single API call's usage for cost / request counters.
 * Persists to runs/usage.json (keeps last 1000 entries).
 */
function recordApiUsageChat(provider, model, tokens, cost, latency, apiKey, usage) {
    try {
        const fs = require('fs');
        const path = require('path');
        const runsDir = path.resolve(__dirname, '../../runs');
        if (!fs.existsSync(runsDir)) fs.mkdirSync(runsDir, { recursive: true });
        const usageFile = path.join(runsDir, 'usage.json');
        let usageFileData = [];
        if (fs.existsSync(usageFile)) {
            try { usageFileData = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch { usageFileData = []; }
        }
        usageFileData.push({ timestamp: Date.now(), provider, model, tokens, cost, latency, keyTail: keyLabel(apiKey), exactUsage: usage || null });
        if (usageFileData.length > 1000) usageFileData = usageFileData.slice(-1000);
        fs.writeFileSync(usageFile, JSON.stringify(usageFileData, null, 2));

        // Also sync today's totals to Encrypt config (for costs:get via IPC).
        try {
            const today = new Date().toISOString().slice(0, 10);
            const stored = Encrypt.getConfig('costs') || {};
            if (stored.date !== today) {
                Encrypt.saveConfig('costs', { date: today, tokens: 0, cost: 0, requests: 0, perKey: {}, keyTotals: {}, lastProvider: '', lastModel: '' });
            }
            Encrypt.saveConfig('costs', {
                ...stored,
                date: today,
                perKey: stored.perKey && typeof stored.perKey === 'object' ? stored.perKey : {},
                keyTotals: stored.keyTotals && typeof stored.keyTotals === 'object' ? stored.keyTotals : {},
                tokens: (stored.tokens || 0) + tokens,
                cost: (stored.cost || 0) + cost,
                requests: (stored.requests || 0) + 1,
                lastProvider: provider,
                lastModel: model
            });
        } catch {
            // Encrypt shouldn't be required for usage tracking to work.
        }
    } catch {
        // Silent — usage tracking should never break the main flow.
    }
}



/**
 * Live streaming chat session.
 * Emits chunks via the `emit` callback in the format:
 *   { type: 'start' | 'chunk' | 'stats' | 'end' | 'error', ... }
 *
 * @param {object} opts - { provider, model, thinking, messages, apiKey }
 * @param {function} emit - callback(chunk)
 */
async function chatStream(opts, emit) {
    const { provider, model, thinking, messages, apiKey, systemPrompt, promptTarget } = opts;
    const startTime = Date.now();

    // PERSONA + SKILLS (2026-09-29 fix): the chat path previously sent NO system
    // prompt at all - the AI Settings prompt box was silently ignored for chat.
    // An explicit opts.systemPrompt (from the router) wins; otherwise the effective
    // prompt is composed here so a direct chatStream() caller is covered too.
    const activeSystemPrompt = (typeof systemPrompt === 'string' && systemPrompt.trim())
        ? systemPrompt.trim()
        : resolveSystemPrompt(promptTarget || 'chat');
    log.info(activeSystemPrompt
        ? `Chat system prompt active: ${activeSystemPrompt.length} chars (target: ${promptTarget || 'chat'}).`
        : `Chat system prompt is empty (promptScope.chat = false, or no persona/skills configured).`);

    emit({ type: 'start', provider, model });

    try {
        let fullText = '';
        let tokens = 0;
        let geminiUsage = null;

        if (provider === 'gemini') {
            // FIXED: was require('@google/generative-ai') — not installed.
            // Ported to the installed @google/genai SDK, mirroring _callGemini()
            // (~L605): client.models.generateContentStream + `config` + chunk.text
            // as a property. Reuses the GoogleGenAI import at the top of the file.
            const client = new GoogleGenAI({ apiKey });
            const stream = await client.models.generateContentStream({
                model: sanitizeGeminiModel(model),
                contents: messages.map(m => ({
                    // genai expects roles 'user' | 'model' (not 'assistant')
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                })),
                config: {
                    // System instruction = user persona + ACTIVE SKILLS for chat.
                    ...(activeSystemPrompt ? { systemInstruction: activeSystemPrompt } : {}),
                    temperature: thinking === 'high' ? 0.3 : thinking === 'low' ? 0.9 : 0.7,
                    maxOutputTokens: 8192
                }
            });
            for await (const chunk of stream) {
                const text = chunk.text || '';
                fullText += text;
                tokens += Math.ceil(text.length / 4);
                emit({ type: 'chunk', text });
                if (chunk.usageMetadata || chunk.usage_metadata) geminiUsage = chunk.usageMetadata || chunk.usage_metadata;
                emit({ type: 'stats', tokens, latency: Date.now() - startTime });
            }
        } else {
            // OpenAI-compatible providers (Groq, Kimi, OpenRouter)
            const urls = {
                groq: 'https://api.groq.com/openai/v1/chat/completions',
                kimi: 'https://api.moonshot.cn/v1/chat/completions',
                openrouter: 'https://openrouter.ai/api/v1/chat/completions'
            };
            // OpenAI-compatible transports take the system prompt as a leading
            // 'system' message. Before 2026-09-29 this branch forwarded `messages`
            // untouched, so Groq/Kimi/OpenRouter chat got no persona or skills.
            const outbound = activeSystemPrompt
                ? [{ role: 'system', content: activeSystemPrompt }, ...messages]
                : messages;
            const response = await axios.post(urls[provider], {
                model, messages: outbound, stream: true
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                responseType: 'stream'
            });

            await new Promise((resolve, reject) => {
                response.data.on('data', (chunk) => {
                    const lines = chunk.toString().split('\n').filter(l => l.trim());
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const json = line.slice(6);
                            if (json === '[DONE]') continue;
                            try {
                                const parsed = JSON.parse(json);
                                const text = parsed.choices?.[0]?.delta?.content || '';
                                if (text) {
                                    fullText += text;
                                    tokens += 1;
                                    emit({ type: 'chunk', text });
                                    emit({ type: 'stats', tokens, latency: Date.now() - startTime });
                                }
                            } catch {}
                        }
                    }
                });
                response.data.on('end', resolve);
                response.data.on('error', reject);
            });
        }

        const latency = Date.now() - startTime;
        const cost = estimateCost(provider, model, tokens);
        emit({ type: 'stats', tokens, cost, latency });
        emit({ type: 'end', fullText });
        recordApiUsageChat(provider, model, tokens, cost, latency, apiKey, geminiUsage);
        if (provider === 'gemini' && geminiUsage) recordKeyUsage(provider, model, apiKey, geminiUsage, 'ai-chat');
    } catch (error) {
        emit({ type: 'error', message: error.message });
        emit({ type: 'end', fullText: '' });
        throw error;
    }
}
module.exports = {
    // --- Restored exports (FEATURE A/B + cost helpers) ------------------------
    // These were previously assigned with `module.exports.X = X` ABOVE this
    // block, so the object literal below silently discarded them - that is what
    // caused "ApiManager.chatStream is not a function" in the live-chat feature.
    _withRetry,
    sanitizeGeminiModel,
    StreamBus,
    estimateCost,
    recordApiUsage,
    chatStream,
    // System prompt resolution (persona prompt + ACTIVE SKILLS + MCP tool block).
    // Exported so main.js's chat router and the AI Settings preview share it.
    resolveSystemPrompt,
    // Error diagnosis shared with main.js (Test Connection + chat failover)
    classifyProviderError,
    parseProviderError,
    // SMART ERROR LEVELS (2026-09-29): "self-healing hiccup" (warn) vs "nothing
    // left to try" (error) — pure function, unit-testable without the network.
    isRecoverableFailure,
    // 503 "high demand" model memory (session-scoped, TTL-based)
    markModelOverloaded,
    isModelOverloaded,
    clearModelOverloaded,
    pickRestedModel,
    // One-line failure text shared with scheduler.js (health-check spam fix)
    humanMessage,
    // Gemini key pool (dedication/borrowing) shared with main.js chat router
    getGeminiKeyPool,
    getNextGeminiKey,
    // SMART 401 handling (2026-09-25): session dead-key registry + key shape
    markKeyDead,
    isKeyDead,
    keyShapeInfo,

    /**
     * Identifies a provider from the API key prefix.
     * Order matters: "sk-or-" must be checked before "sk-".
     * @param {string} apiKey - The API key to inspect
     * @returns {string|null} 'gemini' | 'groq' | 'kimi' | 'openrouter' | null
     */
         detectProvider(apiKey) {
        const key = String(apiKey || '').trim();
        if (!key) return null;
        if (key.startsWith('AQ.') || key.startsWith('AIza')) return 'gemini';
        if (key.startsWith('gsk_')) return 'groq';
        if (key.startsWith('sk-or-')) return 'openrouter';
        if (key.startsWith('sk-')) return 'kimi';
        return null;
    },

    /**
     * Returns the static model list for a provider. Used to populate the model
     * dropdown and as the fallback when a live fetch fails.
     * @param {string} provider - 'gemini' | 'groq' | 'kimi' | 'openrouter'
     * @returns {string[]} model identifiers
     */
    getProviderModels(provider) {
        return MODEL_ENUMS[provider] || [];
    },

    /**
     * Fetches the live model list from a provider's /models endpoint.
     * Falls back to the static MODEL_ENUMS list on any error.
     * @param {string} provider - 'gemini' | 'groq' | 'kimi' | 'openrouter'
     * @param {string} [apiKey] - API key (required for remote endpoints)
     * @returns {Promise<string[]>} resolved model identifiers
     */
    async fetchModels(provider, apiKey) {
        // When no key is passed (e.g. the api:fetch-models IPC), use the
        // stored encrypted key for that provider.
        if (!apiKey) {
            const stored = (Encrypt.getConfig('providers') || {})[provider];
            apiKey = stored && stored.apiKey;
        }
        // Gemini: list via the official SDK (no REST key endpoint).
        if (provider === 'gemini') {
            try {
                const client = new GoogleGenAI({ apiKey: apiKey || '' });
                let list;
                if (typeof client.listModels === 'function') list = await client.listModels();
                else if (client.models && typeof client.models.list === 'function') list = await client.models.list();
                const arr = Array.isArray(list && list.models) ? list.models : (Array.isArray(list) ? list : []);
                // Normalize to [{id, name}] — Gemini SDK returns "models/<id>" names.
                return arr.map(m => m && m.name).filter(Boolean)
                    .map(name => ({ id: name, name }));
            } catch (error) {
                log.warn(`Gemini live model fetch failed (${error.message}) — using static list.`);
                return MODEL_ENUMS.gemini;
            }
        }

        // Groq / OpenRouter: OpenAI-compatible /models REST endpoint.
        const endpoint = MODEL_ENDPOINTS[provider];
        if (!endpoint) return MODEL_ENUMS[provider] || [];
        try {
            const response = await axios.get(endpoint, {
                headers: { Authorization: `Bearer ${apiKey || ''}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });
            const data = response.data || {};
            const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
            // Normalize to [{id, name}] as required by the renderer dropdowns.
            return arr.map(m => m && m.id ? { id: m.id, name: m.name || m.id } : null).filter(Boolean);
        } catch (error) {
            log.warn(`${provider} live model fetch failed (${error.message}) — using static list.`);
            return MODEL_ENUMS[provider] || [];
        }
    },

    /**
     * Builds the ordered routing chain from the encrypted providers config:
     * only enabled providers with a key, ordered by routing.strategy
     * (priority | cost-optimized | latency-optimized | round-robin),
     * each retried up to routing.maxRetries times.
     * @returns {Array<{name: string, apiKey: string, model: string, priority: number, attempts: number, latencyMs: number, cost: number}>}
     */
    _buildRoutingChain() {
        const providers = Encrypt.getConfig('providers') || {};
        const routing = Encrypt.getConfig('routing') || {};
        // Keep provider attempts bounded but useful. UI/config may request 2-4;
        // 3 is the default so a transient 503 gets a real second model attempt
        // without multiplying retries into an accidental 12-call storm.
        const requestedRetries = Number.isInteger(routing.maxRetries) ? routing.maxRetries : 3;
        const maxRetries = Math.min(4, Math.max(2, requestedRetries));
        const strategy = routing.strategy || 'priority';

        const chain = PROVIDER_NAMES
            .filter(name => {
                const p = providers[name];
                const hasKey = p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys.some(k => typeof k === 'string' && k.trim()));
                return p && p.enabled !== false && hasKey; // enabled + has a key
            })
            .map(name => {
                const p = providers[name];
                return {
                    name,
                    // Gemini: start on the dedicated AUTOMATION key (pool[0]).
                    // The retry loop below borrows the remaining pool keys
                    // (incl. the chat key) on 429/401 - and chat does the
                    // reverse via main.js chat:stream-route.
                    apiKey: name === 'gemini' ? (getNextGeminiKey(p) || p.apiKey) : p.apiKey,
                    model: p.model,
                    priority: typeof p.priority === 'number' ? p.priority : 99,
                    attempts: maxRetries,
                    latencyMs: typeof p.latencyMs === 'number' ? p.latencyMs : 500,
                    cost: (typeof p.costPerMillionInput === 'number' ? p.costPerMillionInput : 0)
                        + (typeof p.costPerMillionOutput === 'number' ? p.costPerMillionOutput : 0)
                };
            });

        // Order the chain according to the configured strategy
        switch (strategy) {
            case 'cost-optimized':
                chain.sort((a, b) => a.cost - b.cost);
                break;
            case 'latency-optimized':
                chain.sort((a, b) => a.latencyMs - b.latencyMs);
                break;
            case 'round-robin': {
                // Start from the priority-ordered list, then rotate the starting
                // index every call so all providers get even usage. The index is
                // persisted in routing.roundRobinIndex so rotation stays even
                // across app restarts too.
                chain.sort((a, b) => a.priority - b.priority);
                const start = this._nextRoundRobinIndex(chain.length);
                const rotated = chain.slice(start).concat(chain.slice(0, start));
                log.info(`Routing strategy "${strategy}" — rotation start index: ${start}.`);
                return rotated;
            }
            case 'priority':
            default:
                chain.sort((a, b) => a.priority - b.priority);
                break;
        }
        log.info(`Routing strategy "${strategy}" — chain: ${chain.map(c => c.name).join(' -> ') || '(empty)'}.`);
        return chain;
    },

    /**
     * Reads the persisted round-robin start index, advances it, and writes the
     * next value back so rotation continues evenly across app restarts. Falls
     * back to an in-memory counter if the config store cannot be written.
     * @param {number} chainLength - Number of providers in the routing chain
     * @returns {number} The rotation start index to use for this call
     */
    _nextRoundRobinIndex(chainLength) {
        const size = Math.max(chainLength, 1);
        const routing = Encrypt.getConfig('routing') || {};
        const persisted = Number.isInteger(routing.roundRobinIndex) ? routing.roundRobinIndex : roundRobinCounter;
        const start = ((persisted % size) + size) % size; // guard against negatives
        const next = (start + 1) % size;
        roundRobinCounter = next;
        try {
            // Read-merge-write keeps strategy/fallback/maxRetries intact.
            Encrypt.saveConfig('routing', { ...routing, roundRobinIndex: next });
        } catch (error) {
            log.warn(`Could not persist round-robin index (using in-memory rotation): ${error.message}`);
        }
        return start;
    },

    /**
     * Smart multi-provider router. Reads providers + routing config, tries each
     * enabled provider in priority order (with per-provider retries). On any
     * error, logs it and moves to the next provider.
     * @param {string} prompt - The structure prompt
     * @returns {Promise<{text: string, provider: string}>} Response + provider actually used
     * @throws {Error} Combined error listing every provider failure
     */
    async generateStructureCode(prompt) {
        const providers = Encrypt.getConfig('providers') || {};
        const aiConfig = Encrypt.getConfig('aiConfig') || {};
        const genOpts = {
            temperature: typeof aiConfig.temperature === 'number' ? aiConfig.temperature : 0.7,
            maxTokens: aiConfig.maxTokens || 8192
        };

        const routing = Encrypt.getConfig('routing') || {};
        // routing.fallback === false means: do not try other providers on failure
        const fallbackEnabled = routing.fallback !== false;

        const chain = this._buildRoutingChain();
        if (chain.length === 0) {
            throw new Error('No enabled AI provider with an API key. Configure keys in the API Keys view.');
        }

        const master = loadMasterPrompt();
        const finalPrompt = master ? (master + "\n\n----- USER REQUEST -----\n" + prompt) : prompt;
        if (master) log.info(`Master prompt applied (${master.length} chars).`);

        const errors = [];
        for (const entry of chain) {
            // Per-provider generation overrides (fall back to global aiConfig values)
            const pConf = providers[entry.name] || {};
            const entryGenOpts = {
                temperature: typeof pConf.temperature === 'number' ? pConf.temperature : genOpts.temperature,
                maxTokens: Number.isInteger(pConf.maxTokens) ? pConf.maxTokens : genOpts.maxTokens,
                thinkingLevel: pConf.thinkingLevel || 'medium'
            };
            // 503 MEMORY (2026-09-29): if the configured model shed load a few
            // minutes ago, START this prompt on a rested model instead of paying
            // the same 503 round trip again (the rescue would switch later anyway).
            if (entry.name === 'gemini' && isModelOverloaded(entry.model)) {
                const rested = pickRestedModel(entry.model, entry._triedModels);
                if (rested) {
                    log.info(`Gemini model "${entry.model}" is shedding load (503 within the last ${Math.round(MODEL_OVERLOAD_TTL_MS / 60000)} min) - starting this prompt on "${rested}" instead.`);
                    entry._triedModels = [...(entry._triedModels || []), entry.model];
                    entry.model = rested;
                }
            }
            for (let attempt = 1; attempt <= entry.attempts; attempt++) {
                try {
                                        let text;
                    if (entry.name === 'gemini') {
                        text = await _withRetry(() => this._callGemini(finalPrompt, entry.apiKey, entry.model, entryGenOpts, entry.name), entry.attempts);
                    } else if (entry.name === 'kimi') {
                        text = await _withRetry(() => this._callKimi(finalPrompt, entry.apiKey, entry.model, entryGenOpts), entry.attempts);
                    } else if (entry.name === 'groq') {
                        text = await _withRetry(() => this._callGroq(finalPrompt, entry.apiKey, entry.model, entryGenOpts), entry.attempts);
                    } else if (entry.name === 'openrouter') {
                        text = await _withRetry(() => this._callOpenrouter(finalPrompt, entry.apiKey, entry.model, entryGenOpts), entry.attempts);
                    } else {
                        throw new Error('Unsupported AI Provider');
                    }
                    if (attempt > 1) log.warn(`Provider "${entry.name}" succeeded on retry #${attempt}.`);
                    if (entry !== chain[0]) {
                        log.warn(`Primary provider(s) failed — succeeded via fallback provider "${entry.name}" (priority ${entry.priority}).`);
                        log.terminal(`Succeeded via fallback provider "${entry.name}" (${entry.model || 'default model'}).`);
                    }
                    // This model just answered successfully: clear its 503 memory.
                    if (entry.name === 'gemini') clearModelOverloaded(entry.model);
                    recordApiUsage(entry.name, finalPrompt, text, entry.model);
                    return { text, provider: entry.name };
                } catch (error) {
                    // ONE short line per failure (humanMessage unwraps the multi-KB
                    // provider JSON). This used to be emitted TWICE — raw log.error +
                    // raw log.terminal — which is the "attempt" spam that repeated on
                    // every retry in the terminal, feed and toasts.
                    const msg = `${entry.name} (attempt ${attempt}/${entry.attempts}): ${humanMessage(error)}`;
                    errors.push(msg);

                    // SMART ERROR LEVELS (2026-09-29): a transient provider hiccup
                    // that the router is ABOUT to heal — 503 "high demand" -> next
                    // model, 429/401 -> next key or model, another attempt left, or a
                    // fallback provider still waiting — is NOT a run failure. It used
                    // to print as log.error, so a self-healed 503 showed a RED error
                    // while the work kept going (exactly the user's report). A red
                    // log.error is now reserved for a failure that really has nothing
                    // left to try; anything self-healing is an amber warning that
                    // says so, and the run continues without an "error" in the logs.
                    const kInfo = classifyProviderError(error, entry.name);
                    const recoverable = isRecoverableFailure(kInfo.kind, {
                        attemptLeft: attempt < entry.attempts,
                        providerLeft: fallbackEnabled && entry !== chain[chain.length - 1],
                        modelRescuesLeft: entry.name === 'gemini' ? 3 - (entry._modelFallbacks || 0) : 0,
                        keyRotationsLeft: entry.name === 'gemini' ? 4 - (entry._keyRotations || 0) : 0,
                    });
                    if (recoverable) {
                        const what = kInfo.kind === 'overloaded' ? ' (temporarily overloaded)'
                            : (kInfo.kind === 'quota-exhausted' ? ' (quota spent)'
                                : (kInfo.kind === 'invalid-key' ? ' (key rejected)' : ''));
                        log.warn(`API hiccup${what} — ${msg} — router is auto-recovering.`);
                    } else {
                        log.error(`API call failed — ${msg}`);
                    }

                    // 429 (quota spent) or 401 (dead/rejected key) on Gemini:
                    // rotate to the next configured key BEFORE falling back to
                    // the next provider. Bounded (max 4 rotations) so a fully
                    // broken key set can never loop forever.
                    if (entry.name === 'gemini') {
                        // kInfo was already classified above (it also drives the log level).
                        // Remember auth-rejected keys so getNextGeminiKey (which
                        // filters the pool) never rotates BACK onto them.
                        if (kInfo.kind === 'invalid-key') markKeyDead(entry.name, entry.apiKey);
                        const rotatable = kInfo.kind === 'quota-exhausted'
                            || kInfo.kind === 'rate-limited'
                            || kInfo.kind === 'invalid-key'
                            || kInfo.kind === 'overloaded';
                        let rescuedByModel = false;
                        // Model-level failures (quota and 503 high demand) must
                        // switch models before burning another API attempt.
                        // switching to a lite fallback model FIRST (the same
                        // rescue transcribeAudio already had). Rotating keys first
                        // used to burn a guaranteed-401 call on the known-dead
                        // second key on EVERY generation. Verified live
                        // 2026-09-23: with "gemini-3.8-flash" 429-spent,
                        // "gemini-3.5-flash-lite" and "gemini-3.6-flash" still
                        // answered HTTP 200 on the same (primary) key.
                        // 503 memory: remember this model as load-shedding so the
                        // NEXT prompt of the run starts on a rested model instead of
                        // paying the same 503 again (see isModelOverloaded).
                        if (kInfo.kind === 'overloaded') markModelOverloaded(entry.model);
                        const modelFailure = kInfo.kind === 'quota-exhausted' || kInfo.kind === 'overloaded' || kInfo.kind === 'bad-model';
                        if (modelFailure && (entry._modelFallbacks || 0) < 3) {
                            const alts = await this.getGeminiModelFallbacks(entry.model, entry.apiKey);
                            const nextModel = alts.find(m => m && m !== entry.model && !(entry._triedModels || []).includes(m));
                            if (nextModel) {
                                entry._triedModels = [...(entry._triedModels || []), entry.model];
                                entry._modelFallbacks = (entry._modelFallbacks || 0) + 1;
                                const prevModel = entry.model;
                                entry.model = nextModel;
                                attempt -= 1; // retry the same attempt slot on the new model
                                rescuedByModel = true;
                                const reason = kInfo.kind === 'overloaded' ? 'temporarily overloaded' : 'daily quota exhausted';
                                log.warn(`Gemini model "${prevModel}" ${reason} — switching to "${nextModel}".`);
                                log.terminal(`Gemini model ${prevModel} ${reason} — switching to ${nextModel} (${entry._modelFallbacks}/3).`);
                            }
                        }
                        // Rotate to the next configured key when the KEY itself is
                        // the problem (401 / per-minute rate limit), or when every
                        // fallback model bucket is also spent. Bounded (max 4
                        // rotations) so a broken key set can never loop forever.
                        if (rotatable && !rescuedByModel) {
                            // Borrow the NEXT pool key (deterministic from the
                            // current one) - incl. the dedicated chat key when
                            // automation's own keys are spent.
                            const nextKey = getNextGeminiKey(providers.gemini || {}, entry.apiKey);
                            if (nextKey && nextKey !== entry.apiKey && (entry._keyRotations || 0) < 4) {
                                entry._keyRotations = (entry._keyRotations || 0) + 1;
                                entry.apiKey = nextKey;
                                attempt -= 1; // retry the same attempt slot with the rotated key
                                const why = kInfo.kind === 'invalid-key' ? 'key rejected (401)' : 'rate/quota limit';
                                log.warn(`Gemini ${why} — rotating to the next configured key (rotation ${entry._keyRotations}/4).`);
                                log.terminal(`Gemini ${why} — switching to another configured key (${entry._keyRotations}/4).`);
                            }
                        }
                    }
                    if (!fallbackEnabled) {
                        // Fail fast: fallback is disabled, so do not try the next provider
                        throw new Error(`Provider "${entry.name}" failed and routing.fallback is disabled: ${error.message}`);
                    }
                }
            }
        }
        throw new Error(`All AI providers failed. Errors: ${errors.join(' | ')}`);
    },

            async _callGemini(prompt, apiKey, model = 'gemini-2.0-flash', genOpts = {}, providerName) {
        model = sanitizeGeminiModel(model);
        const thinkingLevel = genOpts.thinkingLevel || 'medium';
        // probeOnly: single-shot mode for "Test Connection". Skips the streaming
        // probe and the Interactions API fallback so a test costs exactly ONE
        // request instead of up to three (that cascade is what drained the
        // 20-requests/day free-tier bucket after a handful of tests).
        const probeOnly = !!genOpts.probeOnly;
        // Effective prompt = user persona + ACTIVE SKILLS (see resolveSystemPrompt).
        const systemPrompt = resolveSystemPrompt(genOpts.promptTarget || 'automation');
        log.info(`Sending request to Google Gemini API (model: ${model}, thinking: ${thinkingLevel})...`);
        const client = new GoogleGenAI({ apiKey });
        const resolvedModel = model || 'gemini-2.0-flash';

        // FEATURE B: streaming path — emit each chunk via StreamBus so main.js can
        // forward to the renderer's log panel (live token output). Falls back
        // gracefully to non-streaming if the SDK lacks generateContentStream.
        let collected = '';
        let geminiUsage = null;
        try {
            if (!probeOnly && client.models && typeof client.models.generateContentStream === 'function') {
                // TIMEOUT GUARD (2026-09-23): this streaming call had no abortSignal,
                // so a dead/hung socket stalled the whole workflow for ~5 minutes
                // (live: lite request 16:55:37 -> "fetch failed" only at 17:00:38).
                // AbortController now enforces: (a) 60s idle — re-armed on every
                // incoming chunk, so healthy-but-slow streams keep going; (b) 240s
                // absolute cap for the entire stream. On abort the SDK rejects,
                // the catch below logs it and the normal non-streaming path takes over.
                const streamCtl = new AbortController();
                const STREAM_IDLE_MS = 60000;
                const STREAM_MAX_MS = 240000;
                let idleTimer = setTimeout(() => streamCtl.abort(), STREAM_IDLE_MS);
                const maxTimer = setTimeout(() => streamCtl.abort(), STREAM_MAX_MS);
                const rearmIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => streamCtl.abort(), STREAM_IDLE_MS); };
                try {
                    const stream = await client.models.generateContentStream({
                        model: resolvedModel,
                        contents: prompt,
                        config: {
                            systemInstruction: systemPrompt,
                            temperature: genOpts.temperature,
                            maxOutputTokens: genOpts.maxTokens,
                            thinkingConfig: { thinkingLevel: thinkingLevel }
                        }
                    }, { abortSignal: streamCtl.signal });
                    for await (const chunk of stream) {
                        rearmIdle();
                        const text = chunk.text || '';
                        if (text) {
                            collected += text;
                            StreamBus.emit('chunk', { provider: providerName || 'gemini', text, collected });
                        }
                        if (chunk.usageMetadata || chunk.usage_metadata) geminiUsage = chunk.usageMetadata || chunk.usage_metadata;
                    }
                } finally {
                    clearTimeout(idleTimer);
                    clearTimeout(maxTimer);
                }
                if (collected) { recordKeyUsage('gemini', model, apiKey, geminiUsage, 'force-run'); return collected; }
                log.warn('Gemini streaming returned empty — falling back to non-streaming.');
            }
        } catch (streamErr) {
            // A spent quota / rejected key cannot be fixed by trying the next
            // API flavour - rethrow straight away (unless tokens already arrived).
            const sInfo = classifyProviderError(streamErr, providerName || 'gemini');
            const terminal = sInfo.kind === 'quota-exhausted' || sInfo.kind === 'invalid-key' || sInfo.kind === 'bad-model';
            if (terminal && !collected) throw streamErr;
            if (terminal) {
                // Terminal (quota/key/model) with partial output: honour the log
                // message and actually RETURN the partial text instead of falling
                // through to non-streaming (previous code logged "returning what
                // arrived" and then retried anyway — burning quota for nothing).
                log.warn(`Gemini streaming hit ${sInfo.kind} after partial output - returning what arrived.`);
                return collected;
            }
            log.warn(`Gemini streaming error (${streamErr.message}); falling back to non-streaming.`);
        }

        // Primary: Interactions API (Google's primary interface). Guarded with an
        // AbortController timeout because the Interactions endpoint can hang
        // indefinitely on some SDK versions (observed ~infinite block on the
        // 2nd+ call in a process). On timeout/error we fall back to generateContent.
        if (!probeOnly && client.interactions && typeof client.interactions.create === 'function') {
            const controller = new AbortController();
            const tId = setTimeout(() => controller.abort(), 25000);
            try {
                const interaction = await client.interactions.create({
                    model: resolvedModel,
                    input: prompt,
                    // NOTE: Interactions API does NOT accept system_instruction inside
                    // generation_config (400 "Unknown parameter"). System prompt is
                    // injected by the generateContent fallback via top-level
                    // systemInstruction instead.
                    generation_config: { thinking_level: thinkingLevel } // 'low' | 'medium' | 'high'
                }, { abortSignal: controller.signal });
                recordKeyUsage('gemini', model, apiKey, interaction.usage, 'force-run');
                const text = interaction && interaction.output_text;
                if (text) return text;
                // Empty output_text: fall back to parsing the interaction steps.
                // Step is a union type; only ModelOutputStep carries the answer,
                // shaped as { type: 'model_output', content: [{ type: 'text', text: '...' }] }.
                const steps = Array.isArray(interaction && interaction.steps) ? interaction.steps : [];
                const stepsText = steps
                    .filter(s => s && s.type === 'model_output' && Array.isArray(s.content))
                    .flatMap(s => s.content)
                    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
                    .map(c => c.text)
                    .join('');
                if (stepsText) {
                    log.warn('Interactions API returned empty output_text — recovered from interaction.steps.');
                    return stepsText;
                }
                throw new Error('Interactions API returned no output text.');
            } catch (err) {
                // Timeout or Interactions failure -> use the proven generateContent path.
                const reason = err && err.name === 'AbortError' ? 'timed out' : `failed (${err.message})`;
                log.warn(`Gemini Interactions API ${reason} — falling back to generateContent.`);
            } finally { clearTimeout(tId); }
        } else if (!probeOnly) {
            log.warn('client.interactions unavailable in this SDK version — using legacy generateContent API.');
        }

        // Fallback: legacy generateContent API (also guarded against indefinite hangs).
        const controller2 = new AbortController();
        const tId2 = setTimeout(() => controller2.abort(), 25000);
        try {
                        const response = await client.models.generateContent({
                model: resolvedModel,
                contents: prompt,
                config: {
                    systemInstruction: systemPrompt,
                    temperature: genOpts.temperature,
                    maxOutputTokens: genOpts.maxTokens
                }
            }, { abortSignal: controller2.signal });
            recordKeyUsage('gemini', model, apiKey, response.usageMetadata, 'force-run');
            return response.text;
        } finally { clearTimeout(tId2); }
    },

        async _callKimi(prompt, apiKey, model = 'moonshot-v1-128k', genOpts = {}) {
        const systemPrompt = resolveSystemPrompt(genOpts.promptTarget || 'automation');
        log.info(`Sending request to Moonshot Kimi API (model: ${model})...`);
        const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
        const response = await axios.post('https://api.moonshot.cn/v1/chat/completions', {
            model: model || 'moonshot-v1-128k',
            messages,
            temperature: genOpts.temperature,
            max_tokens: genOpts.maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000 
        });
        return response.data.choices[0].message.content;
    },

        /**
     * Groq (OpenAI-compatible endpoint). Default model openai/gpt-oss-120b
     * (replaces the deprecated llama-3.3-70b-versatile). The model is configurable
     * via providers.groq.model; the AI Settings dropdown lists live/static models.
     */
    async _callGroq(prompt, apiKey, model = 'openai/gpt-oss-120b', genOpts = {}) {
        // Defensive guard: deprecated model ids from stale encrypted configs
        // would 404 at the API. Rewrite them before the request.
        const DEPRECATED_GROQ_MODELS = ['llama-3.1-8b-instant', 'llama-3.1-70b-versatile', 'llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b'];
        if (DEPRECATED_GROQ_MODELS.includes(model)) {
            log.warn(`Groq model "${model}" is deprecated — auto-switching to openai/gpt-oss-120b.`);
            model = 'openai/gpt-oss-120b';
        }
        const systemPrompt = resolveSystemPrompt(genOpts.promptTarget || 'automation');
        log.info(`Sending request to Groq API (model: ${model})...`);
        log.info(`Groq endpoint: ${GROQ_API_URL}`);
        const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
        const response = await axios.post(GROQ_API_URL, {
            model: model || 'openai/gpt-oss-120b',
            messages,
            temperature: genOpts.temperature,
            max_tokens: genOpts.maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30000
        });
        return response.data.choices[0].message.content;
    },

    /**
     * OpenRouter (OpenAI-compatible endpoint). The model value "auto" lets
     * OpenRouter pick the best available model.
     */
        async _callOpenrouter(prompt, apiKey, model = 'auto', genOpts = {}) {
        const systemPrompt = resolveSystemPrompt(genOpts.promptTarget || 'automation');
        log.info(`Sending request to OpenRouter API (model: ${model})...`);
        const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: model || 'auto',
            messages,
            temperature: genOpts.temperature,
            max_tokens: genOpts.maxTokens
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/autodash-control-panel',
                'X-Title': 'AutoDash Control Panel'
            },
            timeout: 30000
        });
        return response.data.choices[0].message.content;
    },

    /**
     * Lightweight connectivity/auth test used by the 'api:test' IPC channel.
     * Uses ONLY the given provider (no fallback) so a broken key can never
     * "pass" via another provider. If key is omitted, the stored key for that
     * provider is used.
     * @param {string} provider - 'gemini' | 'groq' | 'kimi' | 'openrouter'
     * @param {string} [key] - API key to validate (optional)
     * @returns {Promise<string>} Human-readable success message
     */
    /**
     * Cheap authenticity check: calls ONLY the provider's model-listing
     * endpoint, which consumes NO generation quota (verified live against both
     * Google and Groq). Used by Test Connection as step 1 and by the API Keys
     * view for the per-provider key-health badge.
     * @returns {Promise<{valid:boolean, models:string[], message:string,
     *                    kind?:string, status?:number|null, latencyMs:number, suggestions?:string[]}>}
     */
    async probeKey(provider, apiKey) {
        const key = String(apiKey || '').trim();
        const started = Date.now();
        if (!key) {
            return {
                valid: false, kind: 'missing-key', status: null, models: [], latencyMs: 0,
                message: 'No API key stored for this provider.',
                suggestions: ['Paste a key and press "Save API Keys".'],
            };
        }
        const shape = keyShapeInfo(key);
        try {
            if (provider === 'gemini') {
                const r = await axios.get('https://generativelanguage.googleapis.com/v1beta/models', {
                    params: { key, pageSize: 200 },
                    timeout: 20000,
                });
                const models = ((r.data && r.data.models) || [])
                    .map(m => String((m && m.name) || '').replace(/^models\//, ''))
                    .filter(Boolean);
                return {
                    valid: true, models, latencyMs: Date.now() - started, keyShape: shape,
                    message: `Key is VALID - ${models.length} models available.`, suggestions: [],
                };
            }
            const endpoint = MODEL_ENDPOINTS[provider];
            if (!endpoint) {
                return {
                    valid: false, kind: 'unsupported', status: null, models: [], latencyMs: 0,
                    message: `Unsupported provider "${provider}".`, suggestions: [],
                };
            }
            const r = await axios.get(endpoint, { headers: { Authorization: `Bearer ${key}` }, timeout: 20000 });
            const models = ((r.data && r.data.data) || []).map(m => m && m.id).filter(Boolean);
            return {
                valid: true, models, latencyMs: Date.now() - started, keyShape: shape,
                message: `Key is VALID - ${models.length} models available.`, suggestions: [],
            };
        } catch (error) {
            const info = classifyProviderError(error, provider);
            log.warn(`probeKey(${provider}) -> ${info.kind} (HTTP ${info.status || 'n/a'})`);
            // Remember auth-rejected keys for this session so the Gemini pool /
            // chat router skip them instead of re-burning attempts on rotation.
            if (info.kind === 'invalid-key') markKeyDead(provider, key);
            return {
                valid: false, kind: info.kind, status: info.status, models: [],
                latencyMs: Date.now() - started, message: info.message, suggestions: info.suggestions,
                keyShape: shape,
            };
        }
    },

    /**
     * Exactly ONE generation request - no retry, no strategy cascade. Test
     * Connection uses this so a single test costs a single request.
     */
    async _callProviderOnce(provider, prompt, apiKey, model, genOpts) {
        const opts = { ...(genOpts || {}), probeOnly: true };
        if (provider === 'gemini') return this._callGemini(prompt, apiKey, model, opts, 'gemini');
        if (provider === 'groq') return this._callGroq(prompt, apiKey, model, opts);
        if (provider === 'kimi') return this._callKimi(prompt, apiKey, model, opts);
        if (provider === 'openrouter') return this._callOpenrouter(prompt, apiKey, model, opts);
        throw new Error(`Unsupported provider "${provider}".`);
    },

    /**
     * Gemini models worth trying after a quota-exhausted error: curated
     * lite/cheap models intersected with the live models.list for this key,
     * excluding the model that just failed. Free-tier quota is metered per
     * model, so switching models usually restores service immediately.
     * @returns {Promise<string[]>} up to 2 candidate model ids
     */
    async getGeminiModelFallbacks(failedModel, apiKey) {
        let live = [];
        try {
            const probe = await this.probeKey('gemini', apiKey);
            live = probe.valid ? probe.models : [];
        } catch (e) { /* offline: fall back to the curated list */ }
        const pool = live.length
            ? GEMINI_QUOTA_FALLBACKS.filter(m => live.includes(m))
            : GEMINI_QUOTA_FALLBACKS.slice();
        return pool.filter(m => m !== failedModel).slice(0, 2);
    },

    async testConnection(provider, key) {
        const providers = Encrypt.getConfig('providers') || {};
        const conf = providers[provider] || {};
        const apiKey = String(key || conf.apiKey || '').trim();
        const keyShape = keyShapeInfo(apiKey);
        if (!apiKey) {
            return {
                ok: false, code: 'NO_KEY', keyValid: false, provider, model: conf.model || '',
                message: `No API key provided or stored for "${provider}".`,
                suggestions: ['Paste a key and press "Save API Keys" first.'],
            };
        }

        // STEP 1 - key authenticity. Model listing only => zero generation quota,
        // so this tells "bad key" apart from "good key, spent quota" for free.
        const probe = await this.probeKey(provider, apiKey);
        if (!probe.valid) {
            const suggestions = [...(probe.suggestions || [])];
            if (probe.kind === 'invalid-key') markKeyDead(provider, apiKey);

            // SMART AUTO-AUDIT (2026-09-29): a red 401 used to end with manual
            // advice ("clear the field and press Test Connection again"). The app
            // now performs that check ITSELF: every OTHER stored key is
            // re-verified immediately via models.list (ZERO generation quota), so
            // the verdict says whether the SAVED configuration still works and the
            // UI can offer one-click resolutions ("Use saved key" / "Open AI
            // Studio" / "Remove dead extras"). Keys already quarantined by the
            // session dead-key registry are reported without spending another
            // request on them (a 401 never heals, so re-probing is pure waste).
            const keyAudit = [];
            let savedKeyValid = false;
            let savedKeyMask = '';
            if (probe.kind === 'invalid-key') {
                const storedPrimary = String(conf.apiKey || '').trim();
                const extras = (Array.isArray(conf.apiKeys) ? conf.apiKeys : [])
                    .map(k => (typeof k === 'string' ? k.trim() : ''))
                    .filter(Boolean);
                // The key the UI would test if the input field were empty.
                const fallbackKey = storedPrimary || extras[0] || '';
                const candidates = [...new Set([storedPrimary, ...extras]
                    .filter(Boolean)
                    .filter(k => k !== apiKey))].slice(0, 3);
                for (const cand of candidates) {
                    const role = cand === storedPrimary ? 'primary' : 'extra';
                    if (isKeyDead(provider, cand)) {
                        keyAudit.push({
                            mask: maskKeyLite(cand), role, valid: false, status: 401, models: 0,
                            message: 'Already rejected (401) earlier this session - skipped.',
                        });
                        continue;
                    }
                    const r = await this.probeKey(provider, cand);
                    keyAudit.push({
                        mask: maskKeyLite(cand), role, valid: !!r.valid,
                        status: r.status || null, models: (r.models || []).length,
                        message: String(r.message || ''),
                    });
                }
                const fallbackAudit = fallbackKey
                    ? keyAudit.find(a => a.mask === maskKeyLite(fallbackKey)) : null;
                savedKeyValid = !!(fallbackAudit && fallbackAudit.valid);
                savedKeyMask = savedKeyValid ? fallbackAudit.mask : '';

                const good = keyAudit.find(a => a.valid);
                if (savedKeyValid) {
                    suggestions.push(`AUTO-CHECKED (zero quota): only the key you just tested was rejected - your SAVED key ${savedKeyMask} passed the model-listing check (${fallbackAudit.models} models).`);
                    suggestions.push('Press "Use saved key" below to clear the input field and test the stored key - no new key is needed.');
                } else if (good) {
                    suggestions.push(`AUTO-CHECKED (zero quota): the tested key is dead, but saved ${good.role === 'primary' ? 'PRIMARY' : 'extra'} key ${good.mask} is VALID (${good.models} models) - the router rotates to it automatically on failure.`);
                    suggestions.push('Replace the rejected key with a fresh one from aistudio.google.com/api-keys (NEW Google project) so every slot in the pool is healthy.');
                } else if (keyAudit.length === 0) {
                    suggestions.push(`No other stored key exists to fall back to - ${maskKeyLite(apiKey)} itself is rejected (401). Create a FRESH key at aistudio.google.com/api-keys (use a NEW Google project) and press "Save API Keys".`);
                } else {
                    const dead = keyAudit.filter(a => a.valid === false && a.status === 401).length;
                    if (dead === keyAudit.length) {
                        suggestions.push(`AUTO-CHECKED (zero quota): all ${keyAudit.length + 1} keys stored for ${provider} were re-checked and EVERY one is rejected (401) - the keys themselves are revoked or hit Google's AQ.-key bug; this app sends them correctly.`);
                        suggestions.push('Create a FRESH key at aistudio.google.com/api-keys (use a NEW Google project to escape a broken project flag) and press "Save API Keys" - or use the "Open AI Studio" button below.');
                    } else {
                        suggestions.push(`AUTO-CHECKED (zero quota): ${dead} stored key(s) rejected (401), ${keyAudit.length - dead} could not be re-checked (network/rate limit) - press Test Connection again to retry.`);
                    }
                }
            }
            return {
                ok: false,
                code: probe.kind === 'invalid-key' ? 'INVALID_KEY' : 'PROBE_FAILED',
                keyValid: false, provider, model: conf.model || '',
                status: probe.status || null, message: probe.message,
                suggestions, latencyMs: probe.latencyMs, keyShape,
                keyAudit, savedKeyValid, savedKeyMask,
            };
        }

        // STEP 2 - exactly ONE minimal generation request (no retry, no cascade).
        // maxTokens 64 (was 16): on thinking-enabled models a 16-token budget can
        // be fully consumed by the thought, returning an empty answer that looked
        // like a broken provider.
        const model = conf.model || (MODEL_ENUMS[provider] || [])[0] || '';
        try {
            let reply = await this._callProviderOnce(
                provider, 'Reply with the single word: pong', apiKey, model,
                { temperature: 0, maxTokens: 64 }
            );
            let testedModel = model;
            // EMPTY-REPLY RESCUE (gemini only): an empty answer from the
            // configured model does not mean the key is broken - try ONE known-
            // good lite model before failing, exactly like the workflow does.
            if (!reply && provider === 'gemini') {
                const alt = GEMINI_QUOTA_FALLBACKS.find(m => m && m !== model);
                if (alt) {
                    log.info(`Test: empty reply from "${model}" - retrying once on "${alt}".`);
                    reply = await this._callProviderOnce(
                        provider, 'Reply with the single word: pong', apiKey, alt,
                        { temperature: 0, maxTokens: 64 }
                    );
                    testedModel = alt;
                }
            }
            if (!reply) throw new Error('Empty response from provider.');
            return {
                ok: true, code: 'OK', keyValid: true, provider, model: testedModel,
                modelsAvailable: probe.models.length, keyShape,
                message: `Connection OK (${provider} / ${testedModel}). Reply: ${String(reply).trim().slice(0, 40)}`
                    + (testedModel !== model ? ` Note: "${model}" answered empty - "${testedModel}" works, consider switching the model in AI Settings.` : ''),
                suggestions: [], latencyMs: probe.latencyMs,
            };
        } catch (error) {
            const info = classifyProviderError(error, provider);
            const quota = info.kind === 'quota-exhausted';
            return {
                ok: false,
                code: quota ? 'QUOTA_EXHAUSTED' : (info.kind === 'bad-model' ? 'BAD_MODEL' : 'GENERATION_FAILED'),
                keyValid: true, provider, model,
                status: info.status || null,
                retryDelayMs: info.retryDelayMs || 0,
                quotaValue: info.quotaValue || '',
                message: quota
                    ? `Key is VALID - but the daily quota for "${model}" is exhausted (free tier allows about ${info.quotaValue || 20} requests/day per model, per project).`
                    : `Key is valid, but the test generation failed: ${info.message}`,
                suggestions: info.suggestions || [],
                latencyMs: probe.latencyMs, keyShape,
            };
        }
    },

    /**
     * Speech-to-text for the Live AI Chat microphone button (real, live).
     * Tries, in order: Groq Whisper (fast) and Gemini native audio
     * understanding. Both are optional - whichever key is configured wins, and
     * each failure is reported per attempt so the UI can explain itself.
     * @param {object} payload - { audioBase64, mimeType, language? }
     * @returns {Promise<{success:boolean, text?:string, provider?:string,
     *                    engine?:string, attempts:Array, error?:string, suggestions?:string[]}>}
     */
    async transcribeAudio(payload) {
        const p = payload || {};
        const audioBase64 = String(p.audioBase64 || '');
        const mimeType = String(p.mimeType || 'audio/webm');
        const attempts = [];
        if (!audioBase64) {
            return { success: false, error: 'No audio data received.', attempts };
        }
        const buffer = Buffer.from(audioBase64, 'base64');
        if (buffer.length > 12 * 1024 * 1024) {
            return { success: false, error: 'Recording too large (12MB max) - keep dictation under about 60 seconds.', attempts };
        }

        const providers = Encrypt.getConfig('providers') || {};
        const groqKey = String((providers.groq || {}).apiKey || '').trim();
        const geminiConf = providers.gemini || {};
        const geminiKey = String(geminiConf.apiKey || '').trim();

        // ---- 1) Groq Whisper (multipart upload) -----------------------------
        if (groqKey) {
            const ext = /wav/.test(mimeType) ? 'wav' : (/mp3|mpeg/.test(mimeType) ? 'mp3' : 'webm');
            for (const model of ['whisper-large-v3-turbo', 'whisper-large-v3']) {
                try {
                    const form = new FormData();
                    form.append('file', new Blob([buffer], { type: mimeType }), `dictation.${ext}`);
                    form.append('model', model);
                    form.append('response_format', 'json');
                    if (p.language) form.append('language', String(p.language));
                    const r = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
                        headers: { Authorization: `Bearer ${groqKey}` },
                        timeout: 60000,
                        maxBodyLength: Infinity,
                    });
                    const text = String((r.data && r.data.text) || '').trim();
                    if (text) {
                        log.info(`Transcribed ${buffer.length} bytes via Groq ${model} (${text.length} chars).`);
                        return { success: true, text, provider: 'groq', model, engine: 'Groq Whisper', attempts };
                    }
                    attempts.push({ provider: 'groq', model, ok: false, error: 'Empty transcript returned.' });
                } catch (error) {
                    const info = classifyProviderError(error, 'groq');
                    attempts.push({ provider: 'groq', model, ok: false, kind: info.kind, error: info.message, suggestions: info.suggestions });
                    if (info.kind === 'invalid-key' || info.kind === 'bad-model') break;
                }
            }
        } else {
            attempts.push({ provider: 'groq', ok: false, kind: 'missing-key', error: 'No Groq API key stored.' });
        }

        // ---- 2) Gemini native audio understanding ---------------------------
        if (geminiKey) {
            const instruction = 'Transcribe the following audio verbatim. Return ONLY the transcript text - no commentary, no quotes, no labels.';
            const primary = geminiConf.model || (MODEL_ENUMS.gemini || [])[0] || 'gemini-3.8-flash';
            const queue = [primary];
            const tried = [];
            let cursor = 0;
            while (cursor < queue.length && tried.length < 4) {
                const model = queue[cursor++];
                if (tried.includes(model)) continue;
                tried.push(model);
                try {
                    const r = await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
                        {
                            contents: [{
                                parts: [
                                    { text: instruction },
                                    { inlineData: { mimeType, data: audioBase64 } },
                                ],
                            }],
                            generationConfig: { temperature: 0, maxOutputTokens: 2048 },
                        },
                        { params: { key: geminiKey }, headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
                    );
                    const cand = ((r.data && r.data.candidates) || [])[0] || {};
                    const parts = (cand.content && cand.content.parts) || [];
                    const text = parts.map(x => x && x.text).filter(Boolean).join(' ').trim();
                    if (text) {
                        log.info(`Transcribed ${buffer.length} bytes via Gemini ${model} (${text.length} chars).`);
                        return { success: true, text, provider: 'gemini', model, engine: 'Gemini audio', attempts };
                    }
                    attempts.push({ provider: 'gemini', model, ok: false, error: 'Empty transcript returned.' });
                } catch (error) {
                    const info = classifyProviderError(error, 'gemini');
                    attempts.push({ provider: 'gemini', model, ok: false, kind: info.kind, error: info.message, suggestions: info.suggestions });
                    if (info.kind === 'invalid-key') break;
                    if (info.kind === 'quota-exhausted') {
                        // Gemini meters quota per model -> pull in lite alternatives.
                        const alts = await this.getGeminiModelFallbacks(model, geminiKey);
                        alts.forEach(a => { if (!tried.includes(a)) queue.push(a); });
                    }
                }
            }
        } else {
            attempts.push({ provider: 'gemini', ok: false, kind: 'missing-key', error: 'No Gemini API key stored.' });
        }

        const withHints = attempts.find(a => a.suggestions && a.suggestions.length);
        return {
            success: false,
            error: 'Transcription failed on every configured provider.',
            attempts,
            suggestions: (withHints && withHints.suggestions) || [],
        };
    }
};
