/**
 * @file mcpManager.js
 * @description Model Context Protocol (MCP) client for AutoDash - stdio transport.
 *
 * WHAT IS REAL HERE: this is a working JSON-RPC 2.0 client. It spawns a server
 * process, performs the MCP handshake (`initialize` -> `notifications/initialized`
 * -> `tools/list`), and executes tools with `tools/call`, all over
 * newline-delimited JSON on the child process' stdin/stdout - the transport the
 * MCP stdio spec defines. `mcp-servers/example-tools-server.js` ships with the app
 * as a live fixture/template.
 *
 * HOW SERVERS START (changed 2026-10-01, at the user's request)
 *   Servers used to start only on an explicit human click, which in practice
 *   left MCP permanently disconnected. Now: the first-party bundled server is
 *   seeded on first run, and every ENABLED server is auto-connected at launch
 *   (`autoConnect()`; switch off globally with mcpServers.autoConnect=false or
 *   per server with `autoConnect:false`). What did NOT change: only servers the
 *   user added or kept enabled ever start, a MODEL can never spawn a process
 *   (`callToolRunning()`), and the real tool output - never an imagined one - is
 *   what gets fed back to the model.
 *
 * Config module `mcpServers`:
 *   { enabled, maxServers, callTimeoutMs, servers: [{ id, name, command, args[],
 *     cwd, env{}, enabled, shell, description }] }
 * `{appRoot}` inside command/args/cwd is replaced with the project folder, so the
 * bundled fixture works from any install location.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const log = require('./logger');

const APP_ROOT = path.join(__dirname, '..', '..');
const CLIENT_INFO = { name: 'AutoDash Control Panel', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT_MS = 20000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const STDERR_TAIL = 12; // lines kept per server for diagnostics

// ---------------------------------------------------------------------------
// Config access (injectable -> probe-able without Electron)
// ---------------------------------------------------------------------------
let injectedAccessor = null;

function configure(accessor) {
    injectedAccessor = accessor || null;
}

function readConfig() {
    try {
        if (injectedAccessor && typeof injectedAccessor.get === 'function') return injectedAccessor.get('mcpServers') || {};
        return require('./encryption').getConfig('mcpServers') || {};
    } catch (error) {
        log.warn(`mcpManager: mcpServers config unavailable (${error.message}).`);
        return {};
    }
}

function writeConfig(patch) {
    const current = readConfig();
    const next = { ...current, ...patch };
    if (injectedAccessor && typeof injectedAccessor.save === 'function') injectedAccessor.save('mcpServers', next);
    else require('./encryption').saveConfig('mcpServers', next);
    return next;
}

/**
 * fileConfig accessor (same injection rule as readConfig) so the probes can run
 * without Electron. Only the output folder is read from it.
 */
function readFileConfig() {
    try {
        if (injectedAccessor && typeof injectedAccessor.get === 'function') return injectedAccessor.get('fileConfig') || {};
        return require('./encryption').getConfig('fileConfig') || {};
    } catch (error) {
        return {};
    }
}

/**
 * Absolute path of the generated-project folder, or '' when unconfigured.
 * Passed to every spawned server as AUTODASH_OUTPUT_DIR so first-party
 * workspace tools can find the project without hardcoding a path.
 */
function resolveOutputDir() {
    const raw = String(readFileConfig().outputDirectory || '').trim();
    if (!raw) return '';
    try {
        return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
    } catch (error) {
        return '';
    }
}

// ---------------------------------------------------------------------------
// Server registry (config) + live clients (processes)
// ---------------------------------------------------------------------------
/** @type {Map<string, object>} id -> live client state */
const clients = new Map();

function resolveTokens(value) {
    return String(value === undefined || value === null ? '' : value).replace(/\{appRoot\}/g, APP_ROOT);
}

/** Normalizes one server entry from config into a predictable shape. */
function normalizeServer(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const name = String(s.name || s.id || '').trim();
    const id = String(s.id || name).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) return null;
    return {
        id,
        name: name || id,
        description: String(s.description || '').slice(0, 300),
        command: String(s.command || '').trim(),
        args: (Array.isArray(s.args) ? s.args : []).map((a) => String(a)),
        cwd: String(s.cwd || '').trim(),
        env: (s.env && typeof s.env === 'object' && !Array.isArray(s.env)) ? s.env : {},
        shell: s.shell === true,
        enabled: s.enabled !== false,
        // First-party servers shipped with AutoDash. They are the only ones
        // auto-seeded on first run; a user-added server is never written for
        // them, only by them.
        bundled: s.bundled === true,
        // Per-server opt-out of the launch-time connect (global switch lives in
        // mcpServers.autoConnect).
        autoConnect: s.autoConnect !== false,
    };
}

/** Every configured server (config order preserved). */
function listServers() {
    const cfg = readConfig();
    const raw = Array.isArray(cfg.servers) ? cfg.servers : [];
    return raw.map(normalizeServer).filter(Boolean);
}

function findServer(id) {
    const key = String(id || '').trim().toLowerCase();
    return listServers().find((s) => s.id === key) || null;
}

/** Saves (upsert) one server definition by id. */
function saveServer(input) {
    const server = normalizeServer(input);
    if (!server) throw new Error('A server id/name is required.');
    if (!server.command) throw new Error('A server needs a command (e.g. "node").');
    const cfg = readConfig();
    const max = Number(cfg.maxServers) || 5;
    const servers = listServers();
    const idx = servers.findIndex((s) => s.id === server.id);
    if (idx < 0 && servers.length >= max) throw new Error(`Server limit reached (${max}). Remove one first.`);
    const merged = idx < 0 ? [...servers, server] : servers.map((s) => (s.id === server.id ? { ...s, ...server } : s));
    writeConfig({ servers: merged });
    log.info(`MCP server saved: ${server.id} (${server.command} ${server.args.join(' ')}${server.enabled ? '' : ' - disabled'})`);
    return server;
}

/** Removes a server definition (and stops it if it is running). */
function deleteServer(id) {
    const key = String(id || '').trim().toLowerCase();
    stop(key);
    const servers = listServers().filter((s) => s.id !== key);
    writeConfig({ servers });
    log.info(`MCP server removed: ${key}`);
    return { id: key, removed: true, remaining: servers.length };
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------
function pushStderr(client, text) {
    const lines = String(text || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
        client.stderrTail.push(line.slice(0, 400));
        if (client.stderrTail.length > STDERR_TAIL) client.stderrTail.shift();
        log.warn(`MCP[${client.id}] stderr: ${line.slice(0, 300)}`);
    }
}

function sendRaw(client, message) {
    if (!client.proc || !client.proc.stdin || client.proc.stdin.destroyed) {
        throw new Error(`MCP server "${client.id}" is not running.`);
    }
    client.proc.stdin.write(JSON.stringify(message) + '\n');
}

/** Sends a request and resolves with `result` (rejects on error or timeout). */
function request(client, method, params, timeoutMs) {
    const id = client.nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            client.pending.delete(id);
            reject(new Error(`MCP "${client.id}" timed out after ${timeoutMs}ms on ${method}.`));
        }, timeoutMs);
        client.pending.set(id, { resolve, reject, timer, method });
        try {
            sendRaw(client, { jsonrpc: '2.0', id, method, params: params || {} });
        } catch (error) {
            clearTimeout(timer);
            client.pending.delete(id);
            reject(error);
        }
    });
}

/** Fire-and-forget notification (no id => no reply expected). */
function notify(client, method, params) {
    try {
        sendRaw(client, { jsonrpc: '2.0', method, params: params || {} });
    } catch (error) {
        log.warn(`MCP[${client.id}] notification ${method} failed: ${error.message}`);
    }
}

function failAllPending(client, reason) {
    for (const [, p] of client.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
    }
    client.pending.clear();
}

/** Extracts readable text from an MCP tools/call result. */
function resultToText(result) {
    if (!result || typeof result !== 'object') return '';
    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts
        .map((c) => {
            if (!c || typeof c !== 'object') return '';
            if ((c.type === 'text' || !c.type) && typeof c.text === 'string') return c.text;
            return `[${c.type || 'unknown'} content omitted]`;
        })
        .filter(Boolean)
        .join('\n');
    if (text) return text;
    if (result.structuredContent) return JSON.stringify(result.structuredContent, null, 2);
    return '';
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function newClient(server) {
    return {
        id: server.id,
        name: server.name,
        server,
        proc: null,
        buffer: '',
        nextId: 1,
        pending: new Map(),
        tools: [],
        serverInfo: null,
        protocolVersion: null,
        state: 'stopped', // stopped | starting | ready | error
        error: null,
        stderrTail: [],
        startedAt: null,
        lastCall: null,
    };
}

/** Handles one decoded JSON-RPC message coming FROM the server. */
function onMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return;
    // Server -> client request (e.g. sampling/roots). We support none: answer
    // with a JSON-RPC error so a well-behaved server knows and moves on.
    if (msg.method && msg.id !== undefined && msg.id !== null) {
        sendRaw(client, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `AutoDash does not implement ${msg.method}` } });
        return;
    }
    if (msg.method && (msg.id === undefined || msg.id === null)) {
        log.info(`MCP[${client.id}] notification: ${msg.method}`);
        return;
    }
    const pending = client.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    client.pending.delete(msg.id);
    if (msg.error) {
        const err = new Error(`MCP ${pending.method} failed: ${msg.error.message || JSON.stringify(msg.error)}`);
        err.code = msg.error.code;
        pending.reject(err);
    } else {
        pending.resolve(msg.result);
    }
}

/** Spawns the process, performs the handshake and caches tools/list. */
async function start(id) {
    const key = String(id || '').trim().toLowerCase();
    const existing = clients.get(key);
    if (existing && (existing.state === 'ready' || existing.state === 'starting')) return statusFor(existing);

    const server = findServer(key);
    if (!server) throw new Error(`Unknown MCP server "${key}".`);
    if (!server.command) throw new Error(`MCP server "${key}" has no command.`);
    const cfg = readConfig();
    if (cfg.enabled === false) throw new Error('MCP is disabled (see AI Settings > Skills & MCP).');

    const client = newClient(server);
    client.state = 'starting';
    clients.set(key, client);
    log.info(`MCP[${key}] starting: ${resolveTokens(server.command)} ${server.args.map(resolveTokens).join(' ')}`);

    try {
        client.proc = spawn(resolveTokens(server.command), server.args.map(resolveTokens), {
            cwd: resolveTokens(server.cwd) || APP_ROOT,
            env: {
                ...process.env,
                ...server.env,
                // Context every first-party server needs (mcp-servers/*). User
                // entries can still override both via their own env block.
                AUTODASH_APP_ROOT: APP_ROOT,
                AUTODASH_OUTPUT_DIR: resolveOutputDir(),
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: server.shell,
            windowsHide: true,
        });
    } catch (error) {
        client.state = 'error';
        client.error = error.message;
        throw error;
    }
    client.startedAt = Date.now();

    client.proc.stdout.setEncoding('utf8');
    client.proc.stdout.on('data', (chunk) => {
        client.buffer += chunk;
        let nl;
        while ((nl = client.buffer.indexOf('\n')) >= 0) {
            const line = client.buffer.slice(0, nl).trim();
            client.buffer = client.buffer.slice(nl + 1);
            if (!line) continue;
            try {
                onMessage(client, JSON.parse(line));
            } catch (error) {
                log.warn(`MCP[${key}] non-JSON stdout line ignored: ${line.slice(0, 160)}`);
            }
        }
    });
    client.proc.stderr.setEncoding('utf8');
    client.proc.stderr.on('data', (chunk) => pushStderr(client, chunk));
    client.proc.on('error', (error) => {
        client.state = 'error';
        client.error = error.message;
        failAllPending(client, `MCP server "${key}" process error: ${error.message}`);
    });
    client.proc.on('exit', (code, signal) => {
        const wasReady = client.state === 'ready';
        client.state = code === 0 ? 'stopped' : 'error';
        if (code !== 0) client.error = `exited with code ${code}${signal ? ` (${signal})` : ''}`;
        failAllPending(client, `MCP server "${key}" exited (code ${code}).`);
        log.info(`MCP[${key}] ${wasReady ? 'stopped' : 'exit'}: code=${code} signal=${signal || 'none'}`);
    });

    try {
        const init = await request(client, 'initialize', {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        }, INIT_TIMEOUT_MS);
        client.protocolVersion = (init && init.protocolVersion) || PROTOCOL_VERSION;
        client.serverInfo = (init && init.serverInfo) || null;
        notify(client, 'notifications/initialized', {});
        const list = await request(client, 'tools/list', {}, INIT_TIMEOUT_MS);
        client.tools = ((list && list.tools) || []).map((t) => ({
            name: String((t && t.name) || ''),
            description: String((t && t.description) || '').slice(0, 300),
            // Kept so the system prompt can tell the model the real required
            // arguments (a model that has to guess arg names calls tools wrong).
            inputSchema: (t && t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : null,
        })).filter((t) => t.name);
        client.state = 'ready';
        client.error = null;
        const info = client.serverInfo ? `${client.serverInfo.name} v${client.serverInfo.version}, ` : '';
        log.info(`MCP[${key}] ready - ${info}${client.tools.length} tool(s): ${client.tools.map((t) => t.name).join(', ') || 'none'}`);
        return statusFor(client);
    } catch (error) {
        client.state = 'error';
        client.error = error.message;
        log.warn(`MCP[${key}] handshake failed: ${error.message}`);
        try { if (client.proc && !client.proc.killed) client.proc.kill(); } catch (e) { /* already gone */ }
        return statusFor(client);
    }
}

/** Kills a server (idempotent) and forgets its live state. */
function stop(id) {
    const key = String(id || '').trim().toLowerCase();
    const client = clients.get(key);
    if (!client) return { id: key, state: 'stopped' };
    try {
        if (client.proc && !client.proc.killed) client.proc.kill();
    } catch (error) {
        log.warn(`MCP[${key}] kill failed: ${error.message}`);
    }
    failAllPending(client, 'MCP server stopped.');
    client.state = 'stopped';
    client.tools = [];
    client.startedAt = null;
    clients.delete(key);
    log.info(`MCP[${key}] stopped.`);
    return { id: key, state: 'stopped' };
}

/** Stops every running server (called on app quit). */
function stopAll() {
    const ids = [...clients.keys()];
    for (const id of ids) stop(id);
    return ids;
}

// ---------------------------------------------------------------------------
// Calls + status
// ---------------------------------------------------------------------------
/** Live status for ONE server (used by start() results and the UI). */
function statusFor(client) {
    const cfg = readConfig();
    return {
        id: client.id,
        name: client.name,
        description: client.server.description,
        command: client.server.command,
        args: client.server.args,
        enabled: client.server.enabled,
        state: client.state,
        running: client.state === 'ready',
        error: client.error,
        tools: client.tools.map((t) => t.name),
        toolDetails: client.tools,
        serverInfo: client.serverInfo,
        protocolVersion: client.protocolVersion,
        callTimeoutMs: Number(cfg.callTimeoutMs) || DEFAULT_CALL_TIMEOUT_MS,
        stderrTail: client.stderrTail.slice(-STDERR_TAIL),
        pid: client.proc ? client.proc.pid : null,
        uptimeMs: client.startedAt ? Date.now() - client.startedAt : 0,
        lastCall: client.lastCall,
    };
}

/** Full MCP state: global switches + every configured server with live fields. */
function status() {
    const cfg = readConfig();
    const servers = listServers().map((s) => {
        const client = clients.get(s.id);
        if (client) return statusFor(client);
        return {
            id: s.id, name: s.name, description: s.description, command: s.command, args: s.args,
            enabled: s.enabled, state: 'stopped', running: false, error: null,
            tools: [], toolDetails: [], serverInfo: null, protocolVersion: null,
            callTimeoutMs: Number(cfg.callTimeoutMs) || DEFAULT_CALL_TIMEOUT_MS,
            stderrTail: [], pid: null, uptimeMs: 0, lastCall: null,
        };
    });
    return {
        enabled: cfg.enabled !== false,
        maxServers: Number(cfg.maxServers) || 5,
        callTimeoutMs: Number(cfg.callTimeoutMs) || DEFAULT_CALL_TIMEOUT_MS,
        running: servers.filter((s) => s.running).length,
        servers,
    };
}

/** Tools of every RUNNING server (feeds the system-prompt tool block). */
function toolCatalog() {
    const out = [];
    for (const [serverId, client] of clients) {
        if (client.state !== 'ready') continue;
        for (const t of client.tools) {
            out.push({
                serverId,
                server: client.name,
                tool: t.name,
                description: t.description,
                inputSchema: t.inputSchema || null,
            });
        }
    }
    return out;
}

/** Starts a server if needed and returns its live status (never throws). */
async function ensureStarted(id) {
    const key = String(id || '').trim().toLowerCase();
    const client = clients.get(key);
    if (client && client.state === 'ready') return statusFor(client);
    return start(key);
}

/**
 * Executes one tool on one server (starting that server if necessary).
 * @returns {Promise<{ok:boolean, server:string, serverId:string, tool:string,
 *                    text:string, raw:object, ms:number, isError:boolean}>}
 */
async function callTool(id, toolName, args, timeoutMs) {
    const key = String(id || '').trim().toLowerCase();
    const name = String(toolName || '').trim();
    if (!name) throw new Error('A tool name is required.');
    let client = clients.get(key);
    if (!client || client.state !== 'ready') {
        await start(key);
        client = clients.get(key);
    }
    if (!client || client.state !== 'ready') {
        throw new Error(`MCP server "${key}" is not ready${client && client.error ? `: ${client.error}` : ''}.`);
    }
    if (!client.tools.some((t) => t.name === name)) {
        throw new Error(`Tool "${name}" is not provided by "${key}" (available: ${client.tools.map((t) => t.name).join(', ') || 'none'}).`);
    }
    const cfg = readConfig();
    const ms = Number(timeoutMs) || Number(cfg.callTimeoutMs) || DEFAULT_CALL_TIMEOUT_MS;
    const started = Date.now();
    const result = await request(client, 'tools/call', {
        name,
        arguments: args && typeof args === 'object' ? args : {},
    }, ms);
    const isError = !!(result && result.isError);
    const text = resultToText(result) || (isError ? 'Tool reported an error with no message.' : 'Tool returned no text content.');
    client.lastCall = { tool: name, ms: Date.now() - started, ok: !isError, at: Date.now() };
    log.info(`MCP[${key}] ${name} -> ${isError ? 'ERROR' : 'OK'} in ${client.lastCall.ms}ms (${text.length} chars)`);
    return {
        ok: !isError, isError, server: client.name, serverId: key, tool: name,
        text, raw: result, ms: client.lastCall.ms,
    };
}

/**
 * Executes a tool found on ANY enabled server (the `/tool <name>` chat command):
 * starts configured servers lazily and reports, honestly, when no server provides
 * the tool instead of pretending it ran.
 */
async function callToolAuto(toolName, args) {
    const name = String(toolName || '').trim();
    if (!name) throw new Error('Usage: /tool <tool_name> {"arg":"value"}');
    const attempts = [];
    for (const server of listServers()) {
        if (!server.enabled) continue;
        try {
            const st = await ensureStarted(server.id);
            if (!st.running) { attempts.push(`${server.id}: not ready (${st.error || 'unknown'})`); continue; }
            if (!st.tools.includes(name)) { attempts.push(`${server.id}: no such tool`); continue; }
            return await callTool(server.id, name, args);
        } catch (error) {
            attempts.push(`${server.id}: ${error.message}`);
        }
    }
    throw new Error(`No MCP server provides "${name}". Tried -> ${attempts.join(' | ') || 'no servers configured'}`);
}

/** Descriptor for the bundled fixture (one-click "Add example server"). */
function exampleServer() {
    return {
        id: 'example-tools',
        name: 'Example Tools (bundled)',
        description: 'Ships with AutoDash: echo, system_time and seo_audit_checklist. Delete it any time - it only proves the MCP connection works.',
        command: 'node',
        args: ['{appRoot}/mcp-servers/example-tools-server.js'],
        cwd: '',
        env: {},
        shell: false,
        enabled: true,
    };
}

/**
 * Descriptor for the first-party AutoDash tool server (seeded + auto-connected).
 * 10 real tools (workspace list/read/search, port + http probes, system info,
 * JSON validation, SEO checklist) instead of the toy echo fixture.
 */
function autodashToolsServer() {
    return {
        id: 'autodash-tools',
        name: 'AutoDash Tools (bundled)',
        description: 'Ships with AutoDash: inspect the generated workspace, probe ports (Apache/MySQL) and URLs, read system info, validate JSON, get the SEO checklist.',
        command: 'node',
        args: ['{appRoot}/mcp-servers/autodash-tools-server.js'],
        cwd: '',
        env: {},
        shell: false,
        enabled: true,
        bundled: true,
    };
}

/** Every first-party server this build ships (used for seeding + the UI). */
function bundledServers() {
    return [autodashToolsServer()];
}

/**
 * Seeds the bundled server on FIRST RUN so MCP is connected out of the box
 * instead of showing an empty list the user has to fill in by hand.
 *
 * `seeded: true` is written even when nothing is added, so deleting the bundled
 * server stays deleted - we never resurrect a server the user removed.
 */
function ensureSeeded() {
    const cfg = readConfig();
    const servers = listServers();
    if (cfg.seeded === true) return { seeded: false, reason: 'already checked on an earlier run', servers: servers.length };
    if (servers.length) {
        writeConfig({ seeded: true });
        return { seeded: false, reason: 'user already configured servers', servers: servers.length };
    }
    const seeded = bundledServers();
    writeConfig({ seeded: true, servers: seeded });
    log.info(`MCP: seeded ${seeded.length} bundled server(s): ${seeded.map((s) => s.id).join(', ')}`);
    return { seeded: true, added: seeded.map((s) => s.id), servers: seeded.length };
}

/**
 * Starts every server that is enabled and has not opted out of auto-connect.
 *
 * WHY THIS EXISTS (changed 2026-10-01): servers used to start only on an
 * explicit human click, which left MCP permanently disconnected in practice.
 * The user asked for a working connection, so enabled servers now connect at
 * launch. The safety property that still holds: only servers the user has
 * ADDED or deliberately kept enabled ever start, `mcpServers.autoConnect:false`
 * switches the whole behaviour off, and a per-server `autoConnect:false` opts
 * one out. Start failures are logged and reported, never thrown.
 *
 * @returns {Promise<{attempted:number, ready:number, results:Array<{id:string,ok:boolean,error:string|null,tools:string[]}>}>}
 */
async function autoConnect() {
    const cfg = readConfig();
    if (cfg.enabled === false) return { attempted: 0, ready: 0, results: [], skipped: 'MCP is disabled' };
    if (cfg.autoConnect === false) return { attempted: 0, ready: 0, results: [], skipped: 'autoConnect is off' };
    const targets = listServers().filter((s) => s.enabled && s.autoConnect !== false);
    const results = await Promise.all(targets.map(async (s) => {
        try {
            const st = await start(s.id);
            return { id: s.id, ok: st.state === 'ready', error: st.state === 'ready' ? null : (st.error || st.state), tools: st.tools || [] };
        } catch (error) {
            return { id: s.id, ok: false, error: error.message, tools: [] };
        }
    }));
    const ready = results.filter((r) => r.ok).length;
    for (const r of results) {
        if (r.ok) log.info(`MCP[${r.id}] auto-connected (${r.tools.length} tool(s)).`);
        else log.warn(`MCP[${r.id}] auto-connect failed: ${r.error}`);
    }
    return { attempted: results.length, ready, results };
}

/**
 * Executes a tool on an ALREADY-RUNNING server - the path used when the MODEL
 * asks for a tool mid-answer.
 *
 * Deliberately does NOT call ensureStarted(): a model must never be able to
 * spawn a local process. If nothing running provides the tool it says so, and
 * the reason is fed back to the model instead of a fabricated result.
 */
async function callToolRunning(toolName, args) {
    const name = String(toolName || '').trim();
    if (!name) throw new Error('A tool name is required.');
    const attempts = [];
    for (const [serverId, client] of clients) {
        if (client.state !== 'ready') continue;
        if (!client.tools.some((t) => t.name === name)) { attempts.push(`${serverId}: has no such tool`); continue; }
        return callTool(serverId, name, args);
    }
    const running = [...clients.values()].filter((c) => c.state === 'ready').length;
    throw new Error(
        `No RUNNING MCP server provides "${name}"${attempts.length ? ` (${attempts.join('; ')})` : ''}. ` +
        `${running ? `${running} server(s) are connected` : 'Nothing is connected'} - the user must connect a server that offers this tool (AutoDash never starts one on a model's request).`
    );
}

module.exports = {
    configure,
    APP_ROOT,
    PROTOCOL_VERSION,
    DEFAULT_CALL_TIMEOUT_MS,
    listServers,
    findServer,
    saveServer,
    deleteServer,
    exampleServer,
    autodashToolsServer,
    bundledServers,
    ensureSeeded,
    autoConnect,
    resolveOutputDir,
    start,
    stop,
    stopAll,
    ensureStarted,
    status,
    toolCatalog,
    callTool,
    callToolAuto,
    callToolRunning,
    resultToText,
};


