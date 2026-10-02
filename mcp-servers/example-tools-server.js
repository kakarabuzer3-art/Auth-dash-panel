#!/usr/bin/env node
/**
 * @file mcp-servers/example-tools-server.js
 * @description A dependency-free Model Context Protocol (MCP) server that speaks
 *              JSON-RPC 2.0 over stdio - the exact wire format AutoDash's
 *              src/modules/mcpManager.js implements.
 *
 * WHY IT SHIPS WITH THE APP
 *  1. It is the smoke-test fixture for the MCP client (proves initialize ->
 *     tools/list -> tools/call works end to end, no network needed).
 *  2. It is the template for writing your own server: copy this file, rename the
 *     tools and register it in AI Settings > Skills & MCP.
 *
 * RULES OF AN MCP STDIO SERVER (handled below):
 *  - One JSON-RPC message per line on stdout. NEVER write logs to stdout - use
 *    stderr, otherwise the client's parser sees garbage.
 *  - Answer `initialize` first, then `tools/list`, then `tools/call`.
 *  - Notifications (method starting with "notifications/") get NO reply.
 */

'use strict';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'autodash-example-tools', version: '1.0.0' };

// ---- Tool catalog ---------------------------------------------------------
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
        name: 'echo',
        description: 'Returns the text you send it. Use it to verify that the MCP connection works.',
        inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', description: 'Text to echo back' } },
            required: ['text'],
        },
    },
    {
        name: 'system_time',
        description: 'Current local date/time and timezone of this machine.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'seo_audit_checklist',
        description: 'Returns the white-hat on-page/technical SEO audit checklist (optionally filtered).',
        inputSchema: {
            type: 'object',
            properties: { section: { type: 'string', description: 'Optional keyword filter, e.g. "schema"' } },
        },
    },
];

// ---- Tool implementations -------------------------------------------------
function callTool(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    switch (name) {
        case 'echo':
            return { text: String(a.text === undefined ? '' : a.text) };
        case 'system_time': {
            const now = new Date();
            return { text: `${now.toISOString()} (local: ${now.toString()}, timezone offset ${-now.getTimezoneOffset() / 60}h)` };
        }
        case 'seo_audit_checklist': {
            const filter = String(a.section || '').trim().toLowerCase();
            const items = filter ? SEO_CHECKLIST.filter((i) => i.toLowerCase().includes(filter)) : SEO_CHECKLIST;
            return {
                text: items.length
                    ? `SEO audit checklist${filter ? ` (filter: ${filter})` : ''}:\n- ${items.join('\n- ')}`
                    : `No checklist item matched "${filter}". Try: heading, title, canonical, url, schema, image, core web vitals, robots, e-e-a-t, claims.`,
            };
        }
        default:
            throw Object.assign(new Error(`Unknown tool "${name}"`), { code: -32602 });
    }
}

// ---- JSON-RPC plumbing ----------------------------------------------------
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
    const { id, method, params } = msg;
    const isNotification = method && String(method).startsWith('notifications/');
    try {
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
                const out = callTool(name, params && params.arguments);
                return reply(id, { content: [{ type: 'text', text: out.text }], isError: false });
            }
            default:
                if (isNotification) return; // no response for notifications
                return fail(id, -32601, `Method not found: ${method}`);
        }
    } catch (error) {
        if (isNotification) return;
        fail(id, error.code || -32603, error.message || 'Internal error');
    }
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
            process.stderr.write(`example-tools-server: bad JSON (${error.message})\n`);
        }
    }
});
process.stdin.on('end', () => process.exit(0));
process.stderr.write('example-tools-server: ready on stdio\n');
