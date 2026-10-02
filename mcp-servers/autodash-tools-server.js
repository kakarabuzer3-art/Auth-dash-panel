#!/usr/bin/env node
/**
 * @file mcp-servers/autodash-tools-server.js
 * @description AutoDash's first-party Model Context Protocol (MCP) tool server.
 *              Dependency-free: JSON-RPC 2.0 over newline-delimited stdio, the
 *              transport src/modules/mcpManager.js implements.
 *
 * WHY IT IS BUNDLED AND AUTO-CONNECTED
 *  - `example-tools-server.js` proves the wire protocol with toy tools
 *    (echo/system_time). This one is the *useful* server: it answers the
 *    questions an AI helper for THIS app actually gets asked - "what did the
 *    last run generate?", "is Apache up?", "what is on port 3306?", "is this
 *    JSON valid?", "is the deployed page healthy?".
 *  - It reads the workspace folder from the AUTODASH_OUTPUT_DIR environment
 *    variable, which mcpManager injects at spawn time from fileConfig. If the
 *    variable is absent the workspace tools fail with an honest message instead
 *    of guessing a path.
 *
 * SECURITY POSTURE (deliberate, not an oversight)
 *  - Every workspace tool is confined to AUTODASH_OUTPUT_DIR: `..` and absolute
 *    paths are rejected, so a prompt-injected tool argument cannot read your
 *    SSH keys or the AutoDash source tree.
 *  - Reads only - this server never writes, moves or deletes a file.
 *  - `port_status` / `http_status` only make connections the user's own machine
 *    could make anyway (loopback diagnostics), and http_status aborts after the
 *    headers instead of downloading a body.
 *  - Output is capped (files, lines, bytes) so one call can never flood the
 *    model's context window.
 *
 * RULES OF AN MCP STDIO SERVER (all honoured below):
 *  - Exactly one JSON-RPC message per line on stdout. NEVER log to stdout - a
 *    stray console.log corrupts the client's parser. Diagnostics go to stderr.
 *  - Answer `initialize`, then `tools/list`, then `tools/call`.
 *  - `notifications/*` get NO reply.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const https = require('https');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'autodash-tools', version: '1.0.0' };

// Workspace confinement root. Empty string => workspace tools report an honest
// error; they never fall back to the process CWD.
const OUTPUT_DIR = process.env.AUTODASH_OUTPUT_DIR
    ? path.resolve(String(process.env.AUTODASH_OUTPUT_DIR))
    : '';

const MAX_WALK_ENTRIES = 400;   // files visited by one list/search call
const MAX_READ_BYTES = 64000;   // one workspace_read response
const MAX_MATCHES = 60;         // search hits returned
const MAX_LIST_ITEMS = 200;     // entries returned by workspace_list

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------
/** Resolves a workspace-relative path, refusing anything outside OUTPUT_DIR. */
function resolveInWorkspace(rel) {
    if (!OUTPUT_DIR) {
        throw new Error('No workspace configured. Set the output folder in AutoDash (Prompts / Settings), then reconnect this server so AUTODASH_OUTPUT_DIR is passed.');
    }
    const relPath = String(rel === undefined || rel === null ? '.' : rel).trim() || '.';
    const full = path.resolve(OUTPUT_DIR, relPath);
    if (full !== OUTPUT_DIR && !full.startsWith(OUTPUT_DIR + path.sep)) {
        throw new Error(`Path escapes the workspace: ${relPath}`);
    }
    return full;
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'vendor']);

/** Depth-limited, entry-capped walk that skips backups and dependency folders. */
function walk(root, maxDepth = 6, visit = () => true) {
    const out = { files: [], truncated: false };
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
        const { dir, depth } = stack.pop();
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (error) {
            continue; // unreadable subfolder: skip, never fail the whole call
        }
        for (const ent of entries) {
            if (out.files.length >= MAX_WALK_ENTRIES) { out.truncated = true; return out; }
            if (IGNORE_DIRS.has(ent.name) || /_backup_\d/i.test(ent.name)) continue;
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
            } else if (ent.isFile()) {
                if (visit(full) !== false) out.files.push(full);
            }
        }
    }
    return out;
}

function relOf(full) {
    return path.relative(OUTPUT_DIR, full).split(path.sep).join('/');
}

function humanBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Tool catalog (what the model is told it may call)
// ---------------------------------------------------------------------------
const SEO_CHECKLIST = [
    'One H1 per page that matches the search intent',
    'Title tag <= 60 chars, meta description <= 155 chars, both unique',
    'Canonical tag + hreflang when the page exists in more than one language',
    'Descriptive URLs (words, not ids) and real internal links with anchor text',
    'Valid JSON-LD schema markup for the page type (Article / Product / FAQPage / LocalBusiness)',
    'Images: width+height set, WebP/AVIF, lazy-loaded below the fold, alt text',
    'Core Web Vitals budget: LCP < 2.5s, INP < 200ms, CLS < 0.1',
    'robots.txt + sitemap.xml exist and are current',
    'E-E-A-T signals: author, credentials, dates, sources, contact page',
    'Every claim verifiable - no invented statistics or awards',
];

const TOOLS = [
    {
        name: 'workspace_list',
        description: 'Lists the files in the generated-project workspace (path, size, modified time). Use it to see what a run actually produced before claiming a file exists.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Workspace-relative folder (default ".")' },
                depth: { type: 'integer', description: 'Max folder depth, 1-10 (default 6)' },
            },
        },
    },
    {
        name: 'workspace_read',
        description: 'Reads ONE text file from the workspace (path-confined, read-only, size-capped). Use it to quote real generated code instead of inventing it.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Workspace-relative file path' },
                maxBytes: { type: 'integer', description: `Byte cap, default ${MAX_READ_BYTES}` },
            },
            required: ['path'],
        },
    },
    {
        name: 'workspace_search',
        description: 'Case-insensitive text search across the workspace files, returning file:line matches. Use it to find where a value, class or endpoint is actually used.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Text to find (not a regex)' },
                ext: { type: 'string', description: 'Optional extension filter, e.g. "css" or "php"' },
                maxMatches: { type: 'integer', description: `Match cap, default ${MAX_MATCHES}` },
            },
            required: ['query'],
        },
    },
    {
        name: 'port_status',
        description: 'Checks whether TCP ports on this machine accept a connection (default 80 and 3306, i.e. Apache and MySQL). Use it instead of guessing whether XAMPP is running.',
        inputSchema: {
            type: 'object',
            properties: {
                ports: { type: 'array', items: { type: 'integer' }, description: 'Ports to probe (default [80, 3306, 8000])' },
                host: { type: 'string', description: 'Host to probe (default 127.0.0.1)' },
                timeoutMs: { type: 'integer', description: 'Per-port timeout, default 1500' },
            },
        },
    },
    {
        name: 'http_status',
        description: 'Requests a URL and reports the HTTP status, content type and response time. Headers only - the body is never downloaded. Use it to verify a deployed page or a health endpoint.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Absolute http(s) URL' },
                timeoutMs: { type: 'integer', description: 'Timeout, default 5000' },
            },
            required: ['url'],
        },
    },
    {
        name: 'system_info',
        description: 'Reports runtime facts about this machine: OS, CPU, memory, Node version, uptime and workspace path. Use it instead of assuming the user\'s environment.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'system_time',
        description: 'Current local date/time and timezone offset of this machine.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'json_validate',
        description: 'Validates a JSON string and reports the exact parse error and character position when it is invalid.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'JSON text to validate' } },
            required: ['text'],
        },
    },
    {
        name: 'seo_audit_checklist',
        description: 'Returns the white-hat on-page/technical SEO audit checklist (optionally filtered by a keyword).',
        inputSchema: {
            type: 'object',
            properties: { section: { type: 'string', description: 'Optional keyword filter, e.g. "schema"' } },
        },
    },
    {
        name: 'echo',
        description: 'Returns the text you send it. Use it to verify that the MCP connection works.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to echo back' } },
            required: ['text'],
        },
    },
];


// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
function toolWorkspaceList(args) {
    const a = args && typeof args === 'object' ? args : {};
    const root = resolveInWorkspace(a.path || '.');
    if (!fs.existsSync(root)) return { text: `Not found in the workspace: ${a.path || '.'}` };
    if (!fs.statSync(root).isDirectory()) {
        return { text: `${relOf(root)} is a file, not a folder. Use workspace_read for its contents.` };
    }
    const depth = Math.max(1, Math.min(Number(a.depth) || 6, 10));
    const { files, truncated } = walk(root, depth);
    files.sort();
    if (!files.length) return { text: `The folder "${relOf(root)}" contains no files (searched ${depth} level(s) deep).` };
    const lines = files.slice(0, MAX_LIST_ITEMS).map((f) => {
        let size = 0;
        try { size = fs.statSync(f).size; } catch (e) { /* raced away */ }
        return `- ${relOf(f)}  (${humanBytes(size)})`;
    });
    const tail = [];
    if (files.length > MAX_LIST_ITEMS) tail.push(`... ${files.length - MAX_LIST_ITEMS} more not shown.`);
    if (truncated) tail.push(`Walk stopped at the ${MAX_WALK_ENTRIES}-entry safety cap; narrow the path for a complete list.`);
    return { text: [`${files.length} file(s) under "${relOf(root)}":`, ...lines, ...tail].join('\n') };
}

function toolWorkspaceRead(args) {
    const a = args && typeof args === 'object' ? args : {};
    if (!a.path) throw new Error('workspace_read needs a "path".');
    const full = resolveInWorkspace(a.path);
    if (!fs.existsSync(full)) return { text: `No such file in the workspace: ${a.path}` };
    const st = fs.statSync(full);
    if (st.isDirectory()) return { text: `${a.path} is a folder. Use workspace_list to see what is inside.` };
    const cap = Math.max(256, Math.min(Number(a.maxBytes) || MAX_READ_BYTES, MAX_READ_BYTES));
    const buf = fs.readFileSync(full).subarray(0, cap);
    if (buf.includes(0)) return { text: `${a.path} looks binary (contains NUL bytes); refusing to inline it.` };
    const cut = st.size > cap ? `\n... [truncated: showing ${humanBytes(cap)} of ${humanBytes(st.size)}]` : '';
    return { text: `--- ${relOf(full)} (${humanBytes(st.size)}) ---\n${buf.toString('utf8')}${cut}` };
}

function toolWorkspaceSearch(args) {
    const a = args && typeof args === 'object' ? args : {};
    const needle = String(a.query || '');
    if (!needle) throw new Error('workspace_search needs a non-empty "query".');
    const root = resolveInWorkspace(a.path || '.');
    if (!fs.existsSync(root)) return { text: `Not found in the workspace: ${a.path || '.'}` };
    const cap = Math.max(1, Math.min(Number(a.maxMatches) || MAX_MATCHES, MAX_MATCHES));
    const ext = String(a.ext || '').trim().replace(/^\./, '').toLowerCase();
    const lower = needle.toLowerCase();
    const hits = [];
    const { files, truncated } = walk(root, 8, (f) => {
        if (ext && !f.toLowerCase().endsWith('.' + ext)) return false;
        try { return fs.statSync(f).size <= 512 * 1024; } catch (e) { return false; }
    });
    for (const f of files) {
        if (hits.length >= cap) break;
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        if (text.includes('\u0000')) continue;
        const rows = text.split(/\r?\n/);
        for (let i = 0; i < rows.length && hits.length < cap; i++) {
            if (rows[i].toLowerCase().includes(lower)) hits.push(`${relOf(f)}:${i + 1}: ${rows[i].trim().slice(0, 200)}`);
        }
    }
    if (!hits.length) {
        return { text: `No match for "${needle}"${ext ? ` in *.${ext}` : ''} (${files.length} file(s) scanned${truncated ? ', walk capped' : ''}).` };
    }
    const tail = truncated ? ['', '(walk hit the entry cap - narrow the path for full coverage)'] : [];
    return { text: [`${hits.length} match(es) for "${needle}":`, ...hits.map((h) => `- ${h}`), ...tail].join('\n') };
}


function probePort(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (open, detail) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) { /* already closed */ }
            resolve({ port, open, detail });
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true, 'open'));
        sock.once('timeout', () => finish(false, 'timeout'));
        sock.once('error', (err) => finish(false, err.code || err.message));
        try { sock.connect(port, host); } catch (err) { finish(false, err.message); }
    });
}

async function toolPortStatus(args) {
    const a = args && typeof args === 'object' ? args : {};
    const host = String(a.host || '127.0.0.1').trim();
    const ports = (Array.isArray(a.ports) && a.ports.length ? a.ports : [80, 3306, 8000])
        .map((p) => parseInt(p, 10)).filter((p) => p > 0 && p < 65536).slice(0, 12);
    const timeoutMs = Math.max(200, Math.min(Number(a.timeoutMs) || 1500, 10000));
    const results = await Promise.all(ports.map((p) => probePort(host, p, timeoutMs)));
    const note = (p) => (p === 80 || p === 443 ? '  (HTTP)' : p === 3306 ? '  (MySQL)' : '');
    const lines = results.map((r) => `- ${host}:${r.port}${note(r.port)} -> ${r.open ? 'OPEN' : `closed (${r.detail})`}`);
    const openCount = results.filter((r) => r.open).length;
    return { text: [`Port probe on ${host} (${openCount}/${results.length} open):`, ...lines].join('\n') };
}

function toolHttpStatus(args) {
    const a = args && typeof args === 'object' ? args : {};
    const raw = String(a.url || '').trim();
    if (!/^https?:\/\//i.test(raw)) throw new Error('http_status needs an absolute http(s) URL.');
    const timeoutMs = Math.max(500, Math.min(Number(a.timeoutMs) || 5000, 20000));
    return new Promise((resolve) => {
        let settled = false;
        const started = Date.now();
        const done = (payload) => { if (!settled) { settled = true; resolve(payload); } };
        const client = raw.toLowerCase().startsWith('https') ? https : http;
        let req;
        try {
            req = client.get(raw, (res) => {
                const ms = Date.now() - started;
                const lines = [
                    `HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim() + ` in ${ms}ms`,
                    `content-type: ${res.headers['content-type'] || '(none)'}`,
                    `server: ${res.headers.server || '(none)'}`,
                ];
                if (res.statusCode >= 400) lines.push('This URL answered with an error status - the endpoint exists but is not healthy.');
                res.destroy(); // headers only: never download the body
                done({ text: lines.join('\n') });
            });
        } catch (err) {
            return done({ text: `Request failed before sending: ${err.message}` });
        }
        req.setTimeout(timeoutMs, () => {
            try { req.destroy(); } catch (e) { /* noop */ }
            done({ text: `No response within ${timeoutMs}ms from ${raw}.` });
        });
        req.on('error', (err) => done({ text: `Request failed: ${err.code || err.message}` }));
    });
}

function toolSystemInfo() {
    const cpus = os.cpus() || [];
    const lines = [
        `platform: ${os.platform()} ${os.release()} (${os.arch()})`,
        `hostname: ${os.hostname()}`,
        `cpu: ${cpus.length}x ${(cpus[0] && cpus[0].model) || 'unknown'}`,
        `memory: ${humanBytes(os.totalmem() - os.freemem())} used of ${humanBytes(os.totalmem())}`,
        `node: ${process.version}`,
        `uptime: ${(os.uptime() / 3600).toFixed(1)}h machine, ${(process.uptime() / 60).toFixed(1)}m this tool server`,
        `workspace: ${OUTPUT_DIR || '(not provided by AutoDash)'}`,
    ];
    try {
        if (typeof fs.statfsSync === 'function') {
            const st = fs.statfsSync(OUTPUT_DIR || os.homedir());
            const total = st.blocks * st.bsize;
            const free = st.bavail * st.bsize;
            lines.push(`disk: ${humanBytes(total - free)} used of ${humanBytes(total)}`);
        }
    } catch (e) { /* statfs is optional on older Node */ }
    return { text: lines.join('\n') };
}

function toolJsonValidate(args) {
    const a = args && typeof args === 'object' ? args : {};
    const text = String(a.text === undefined ? '' : a.text);
    if (!text.trim()) return { text: 'Empty input - nothing to validate.' };
    try {
        const parsed = JSON.parse(text);
        const kind = Array.isArray(parsed)
            ? `array of ${parsed.length}`
            : parsed && typeof parsed === 'object'
                ? `object with keys: ${Object.keys(parsed).slice(0, 12).join(', ')}`
                : typeof parsed;
        return { text: `Valid JSON (${kind}).` };
    } catch (err) {
        const m = /position (\d+)/i.exec(err.message);
        let context = '';
        if (m) {
            const pos = Number(m[1]);
            const from = Math.max(0, pos - 40);
            context = `\nnear: ${JSON.stringify(text.slice(from, from + 80))}`;
        }
        return { text: `Invalid JSON: ${err.message}${context}` };
    }
}

function toolSeoChecklist(args) {
    const a = args && typeof args === 'object' ? args : {};
    const filter = String(a.section || '').trim().toLowerCase();
    const items = filter ? SEO_CHECKLIST.filter((i) => i.toLowerCase().includes(filter)) : SEO_CHECKLIST;
    return {
        text: items.length
            ? `SEO audit checklist${filter ? ` (filter: ${filter})` : ''}:\n- ${items.join('\n- ')}`
            : `No checklist item matched "${filter}". Try: heading, title, canonical, url, schema, image, core web vitals, robots, e-e-a-t, claims.`,
    };
}


// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function callTool(name, args) {
    switch (name) {
        case 'workspace_list': return toolWorkspaceList(args);
        case 'workspace_read': return toolWorkspaceRead(args);
        case 'workspace_search': return toolWorkspaceSearch(args);
        case 'port_status': return toolPortStatus(args);
        case 'http_status': return toolHttpStatus(args);
        case 'system_info': return toolSystemInfo();
        case 'system_time': {
            const now = new Date();
            return { text: `${now.toISOString()} (local: ${now.toString()}, timezone offset ${-now.getTimezoneOffset() / 60}h)` };
        }
        case 'json_validate': return toolJsonValidate(args);
        case 'seo_audit_checklist': return toolSeoChecklist(args);
        case 'echo': return { text: String((args && args.text) === undefined ? '' : args.text) };
        default:
            throw Object.assign(new Error(`Unknown tool "${name}"`), { code: -32602 });
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing (one message per line on stdout)
// ---------------------------------------------------------------------------
function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
    const { id, method, params } = msg || {};
    const isNotification = method && String(method).startsWith('notifications/');
    const run = async () => {
        switch (method) {
            case 'initialize':
                return reply(id, {
                    protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                });
            case 'ping':
                return reply(id, {});
            case 'tools/list':
                return reply(id, { tools: TOOLS });
            case 'tools/call': {
                const name = params && params.name;
                // MCP semantics: a tool that FAILS still answers - with isError:true
                // and a readable reason - so the model can correct itself. Only an
                // unknown tool name is a protocol error.
                if (!name || !TOOLS.some((t) => t.name === name)) {
                    return fail(id, -32602, `Unknown tool "${name || ''}"`);
                }
                try {
                    const out = await callTool(name, params && params.arguments);
                    return reply(id, { content: [{ type: 'text', text: String(out && out.text !== undefined ? out.text : '') }], isError: false });
                } catch (error) {
                    process.stderr.write(`autodash-tools-server: tool ${name} failed (${error.message})\n`);
                    return reply(id, { content: [{ type: 'text', text: `${name}: ${error.message}` }], isError: true });
                }
            }
            default:
                if (isNotification) return undefined; // no response for notifications
                return fail(id, -32601, `Method not found: ${method}`);
        }
    };
    // A tool must never crash the server: a thrown error becomes a JSON-RPC
    // error for a request, and is swallowed for a notification.
    Promise.resolve()
        .then(run)
        .catch((error) => {
            process.stderr.write(`autodash-tools-server: ${method} failed (${error.message})\n`);
            if (!isNotification && id !== undefined && id !== null) fail(id, error.code || -32603, error.message || 'Internal error');
        });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
            handle(JSON.parse(line));
        } catch (error) {
            process.stderr.write(`autodash-tools-server: bad JSON (${error.message})\n`);
        }
    }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write(`autodash-tools-server: ready on stdio (workspace: ${OUTPUT_DIR || 'unset'})\n`);

