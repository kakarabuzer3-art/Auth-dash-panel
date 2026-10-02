/**
 * @file chatToolLoop.js
 * @description Pure helpers for MODEL-DRIVEN MCP tool use in Live AI Chat.
 *
 * THE PROBLEM THIS SOLVES
 *   Tools were only reachable through a hand-typed `/tool <name> {json}` command,
 *   so the AI could never decide for itself that it needed a real fact
 *   ("is Apache up?", "what did the last run generate?"). This module turns the
 *   model's intent into a machine-readable request WITHOUT giving it the power
 *   to invent results: the app executes the tool for real and feeds the real
 *   output back (see main.js `chat:stream-route`).
 *
 * WHY THE STREAMING GUARD MATTERS
 *   Chat answers are streamed to the UI word by word, and the renderer appends
 *   every chunk it receives. If a tool request were simply forwarded, the user
 *   would watch raw JSON scroll past and it would stay in the saved message. The
 *   guard holds text back while a tool block is still possible, so a request is
 *   swallowed and only the answer around it is shown.
 *
 * NO ELECTRON / NO I/O - pure string logic so a plain `node probe-*.js` can
 * cover every branch (see probe-mcp.js).
 */

'use strict';

// Fenced form (what frontier models produce reliably):
//   ```tool_call
//   {"tool":"port_status","args":{"ports":[80]}}
//   ```
const OPEN_FENCE = '```tool_call';
const CLOSE_FENCE = '```';
// Inline form, for models that ignore the fence instruction:
//   TOOLCALL: {"tool":"system_time","args":{}}
const INLINE = 'TOOLCALL';

const MAX_TOOL_ROUNDS = 3;        // provider calls per user turn (1 + 2 tool rounds)
const MAX_CALLS_PER_ROUND = 3;    // tool executions requested by one answer
const MAX_ARGS_CHARS = 8000;      // runaway guard while collecting a request

/** Instructions appended to the chat system prompt when tools are connected. */
const TOOL_PROTOCOL_PROMPT = [
    '===== LOCAL TOOL PROTOCOL (real tools, real results) =====',
    'You may call one of the tools listed above when the answer depends on a fact about THIS machine or the generated project (files that exist, whether Apache/MySQL is listening, a URL status, the workspace contents, whether JSON is valid).',
    'To call a tool, your ENTIRE reply must be exactly this block and nothing else - no prose before it, no prose after it:',
    '```tool_call',
    '{"tool":"<tool_name>","args":{<arguments>}}',
    '```',
    `You may emit up to ${MAX_CALLS_PER_ROUND} such blocks in one reply (one per tool call). AutoDash executes them locally and sends you the REAL output, then you answer normally.`,
    'NEVER invent tool output, never claim a tool ran, and never describe what a tool "would" return. If you do not need a tool, just answer normally.',
    'Prefer a tool call over guessing when the question is about the user\'s own machine, files or deployment state.',
    '===== END LOCAL TOOL PROTOCOL =====',
].join('\n');

/**
 * Extracts ONE balanced {...} JSON object starting at `start`, respecting
 * string literals so a brace inside a quoted value cannot end it early.
 * @returns {{text:string, end:number}|null} null when unterminated/invalid start
 */
function extractJsonObject(source, start) {
    if (source[start] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return { text: source.slice(start, i + 1), end: i + 1 };
        }
    }
    return null; // unterminated
}

function safeParse(json) {
    try { return JSON.parse(json); } catch (error) { return null; }
}

/** Normalizes one parsed request; returns null when it is not usable. */
function normalizeRequest(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const tool = String(raw.tool || raw.name || '').trim();
    if (!tool) return null;
    let args = raw.args !== undefined ? raw.args : (raw.arguments !== undefined ? raw.arguments : raw.params);
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    return { tool, args };
}

/**
 * Finds every tool request in a complete answer.
 * @returns {{requests:Array<{tool:string,args:object}>, spans:Array<[number,number]>}}
 */
function parseToolRequests(text) {
    const src = typeof text === 'string' ? text : '';
    const found = [];
    const spans = [];
    // 1) fenced blocks
    const fenceRe = /```tool_call[ \t]*\r?\n([\s\S]*?)```/g;
    let m;
    while ((m = fenceRe.exec(src)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
        const body = m[1].trim();
        const obj = extractJsonObject(body, 0);
        const req = normalizeRequest(obj ? safeParse(obj.text) : safeParse(body));
        if (req) found.push({ at: m.index, req });
    }
    // 2) inline form
    const inlineRe = /\bTOOLCALL\b[ \t]*:?[ \t]*/g;
    while ((m = inlineRe.exec(src)) !== null) {
        const braceAt = src.indexOf('{', m.index + m[0].length);
        if (braceAt < 0) continue;
        const obj = extractJsonObject(src, braceAt);
        if (!obj) continue;
        const req = normalizeRequest(safeParse(obj.text));
        if (req) {
            found.push({ at: m.index, req });
            spans.push([m.index, obj.end]);
        }
        inlineRe.lastIndex = obj.end;
    }
    // Position order so execution order matches what the model wrote.
    found.sort((a, b) => a.at - b.at);
    spans.sort((a, b) => a[0] - b[0]);
    return { requests: found.slice(0, MAX_CALLS_PER_ROUND).map((f) => f.req), spans };
}

/** Removes tool-request text from an answer (used when the guard could not). */
function stripToolRequests(text) {
    const src = typeof text === 'string' ? text : '';
    const { spans } = parseToolRequests(src);
    if (!spans.length) return src;
    let out = '';
    let cursor = 0;
    for (const [from, to] of spans) {
        if (from > cursor) out += src.slice(cursor, from);
        cursor = to;
    }
    out += src.slice(cursor);
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}


/**
 * Streaming filter that keeps a tool request out of the visible answer.
 *
 * States:
 *   probe  - the reply may still START with a tool block (nothing forwarded yet)
 *   text   - a normal answer; chunks stream through, minus a fence-length tail
 *            held back in case a block starts later
 *   block  - inside a tool block; nothing is forwarded until the fence closes
 *
 * `push(chunk)` returns the text to forward NOW (often ''), and `finish()`
 * returns whatever is still held plus the parsed requests. Nothing is ever lost:
 * an unterminated or invalid block is flushed back to the user as plain text.
 */
function createToolStreamGuard() {
    let mode = 'probe';
    let buf = '';
    let pending = '';

    return {
        push(chunk) {
            const text = typeof chunk === 'string' ? chunk : '';
            if (!text) return '';
            buf += text;

            if (mode === 'probe') {
                const trimmed = buf.replace(/^\s+/, '');
                const lead = buf.length - trimmed.length;
                if (!trimmed || OPEN_FENCE.startsWith(trimmed)) return ''; // still undecided
                if (trimmed.startsWith(OPEN_FENCE)) {
                    pending += buf.slice(0, lead + OPEN_FENCE.length);
                    buf = buf.slice(lead + OPEN_FENCE.length);
                    mode = 'block';
                } else {
                    mode = 'text'; // proven to be an ordinary answer
                }
            }

            if (mode === 'block') {
                const close = buf.indexOf(CLOSE_FENCE);
                if (close < 0) {
                    if (buf.length <= MAX_ARGS_CHARS) return '';
                    // Runaway block: never swallow an unbounded amount of text.
                    pending += buf;
                    buf = '';
                    mode = 'text';
                } else {
                    pending += buf.slice(0, close + CLOSE_FENCE.length);
                    buf = buf.slice(close + CLOSE_FENCE.length);
                    mode = 'text';
                }
            }

            if (mode !== 'text') return '';
            // Hold back a short tail so a fence beginning at the very end of a
            // chunk is still detected instead of leaking to the user.
            const holdBack = Math.max(OPEN_FENCE.length, INLINE.length) - 1;
            const candidate = buf.indexOf(OPEN_FENCE);
            if (candidate >= 0) {
                const emit = buf.slice(0, candidate);
                pending += buf.slice(candidate, candidate + OPEN_FENCE.length);
                buf = buf.slice(candidate + OPEN_FENCE.length);
                mode = 'block';
                return emit;
            }
            if (buf.length <= holdBack) return '';
            const emit = buf.slice(0, buf.length - holdBack);
            buf = buf.slice(buf.length - holdBack);
            return emit;
        },
        /**
         * @returns {{text:string, requests:Array<{tool:string,args:object}>, buffer:string}}
         *          `text` is everything that must still be shown to the user.
         */
        finish() {
            const raw = pending + buf;
            pending = '';
            buf = '';
            const { requests } = parseToolRequests(raw);
            if (!requests.length) return { text: raw, requests: [], buffer: raw };
            return { text: stripToolRequests(raw), requests, buffer: raw };
        },
        /** True once the reply has been proven to be a normal answer. */
        isPlainText() {
            return mode === 'text';
        },
    };
}

/**
 * Builds the user-role turn that hands REAL tool output back to the model.
 * Mirrors the wording of the existing `/tool` command so both paths read the
 * same way in the saved conversation.
 */
function buildToolResultMessage(results, question) {
    const blocks = results.map((r) => [
        `tool: ${r.tool} | server: ${r.server || 'unknown'} | ${r.ms}ms | status: ${r.ok ? 'OK' : 'ERROR'}`,
        '---8<--- tool output start ---8<---',
        String(r.text || '').slice(0, 12000),
        '---8<--- tool output end ---8<---',
    ].join('\n'));
    return [
        '[MCP TOOL RESULT - executed locally by AutoDash; treat as real data, do not re-invent it]',
        ...blocks,
        '',
        '[USER QUESTION]',
        question || 'Explain this tool output and give the next concrete step.',
    ].join('\n');
}

/** Short, user-visible summary of one tool execution. */
function summarizeToolRun(r) {
    return r.ok
        ? `${r.tool} executed locally in ${r.ms}ms - ${String(r.text || '').slice(0, 140)}`
        : `${r.tool} failed: ${String(r.text || 'unknown error').slice(0, 140)}`;
}

module.exports = {
    OPEN_FENCE,
    CLOSE_FENCE,
    INLINE,
    MAX_TOOL_ROUNDS,
    MAX_CALLS_PER_ROUND,
    TOOL_PROTOCOL_PROMPT,
    extractJsonObject,
    parseToolRequests,
    stripToolRequests,
    createToolStreamGuard,
    buildToolResultMessage,
    summarizeToolRun,
};

