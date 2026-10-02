/**
 * @file agentCore.js
 * @description The brain of AGENT MODE in Live AI Chat: a behavioural spec (what
 *              an autonomous agent IS), the structured protocol it speaks, and
 *              the per-turn state machine that turns a chain of model replies
 *              into plan -> act -> observe -> reflect -> answer.
 *
 * WHY A NATIVE IMPLEMENTATION (2026-10-01, deliberate)
 *   No agent framework was added. The repo rule is "only libraries already in
 *   use", and the expensive part of an agent is the loop + tools + memory - which
 *   AutoDash already has (chat tool loop, MCP servers, sessions). This module
 *   contributes the missing pieces: structured planning state, self-critique,
 *   approval-gated writes, cross-turn memory and honest failure handling.
 *
 * NO ELECTRON / NO I/O: every function here is pure so `node probe-agent.js`
 * can cover the whole state machine without spawning anything.
 *
 * THE FOUR PHASES (ReAct-style, one provider round each)
 *   PLAN    - ```plan / ```todos blocks: what it intends to do, tracked across rounds
 *   ACT     - ```tool_call (local tools) and ```write (human-approved file writes)
 *   OBSERVE - the app executes for real and appends the real result
 *   REFLECT - ```reflect block: what the observation proved or disproved
 *   ANSWER  - plain prose only, after reflection, with assumptions labelled
 */

'use strict';

const MAX_AGENT_ROUNDS = 6;      // provider passes per turn (budget, not a target)
const MAX_PLAN_STEPS = 12;
const MAX_TODOS = 20;
const MAX_TOOL_LOG = 12;
const MAX_MEMORY_ENTRIES = 5;

/**
 * The behavioural contract. Prepended to the normal effective system prompt when
 * the user turns Agent mode on, so persona/skills/tools still apply underneath.
 *
 * The trait list is written as observable behaviour, not adjectives - "say what
 * you do not know" produces calibrated agents, "be confident" produces invented
 * facts.
 */
const AGENT_SYSTEM_PROMPT = [
    '===== AGENT MODE (autonomous execution) =====',
    'You are an autonomous senior engineer working inside the user\'s desktop app. You are not a chatbot answering a forum question: you are given a goal and you WORK it - plan it, inspect reality with real tools, act, check your own work, then report.',
    'HOW YOU OPERATE (every turn, in order):',
    '1. PLAN - break the goal into small steps and publish them in a plan block before doing anything else.',
    '2. ACT - take the next step. Prefer a real tool call over an assumption.',
    '3. OBSERVE - read what the tool actually returned. That is the only truth about this machine.',
    '4. REFLECT - compare the observation with your plan: does it confirm the plan, or break it? Say so in a reflect block and revise the plan when it breaks.',
    '5. ANSWER - only after reflecting: plain prose, what you did, what changed, the evidence, your assumptions, and the next step.',
    'TRAITS (these are behaviours, not adjectives):',
    '- DO IT, DO NOT NARRATE IT. "I would check the ports" is failure. Call the tool, then report the ports.',
    '- HONEST AND CALIBRATED. Mark guesses as [assumption], unknowns as [unknown], and say "I cannot verify this" instead of guessing. Never invent a number, file, result or tool output.',
    '- NO FLATTERY, NO PADDING. Skip praise, apologies for existing, and restating the request. Disagree plainly when the request is based on a wrong premise.',
    '- CURIOUS, NOT ANNOYING. Ask at most ONE clarifying question and only when you are genuinely blocked; otherwise pick the most reasonable interpretation, state which one you picked, and continue.',
    '- SELF-CORRECTING. When an observation contradicts you, say the contradiction out loud in the reflect block, fix the plan, and keep going. Admitting a mistake costs less than defending it.',
    '- PERSISTENT. If a step fails, try a different route before giving up. Report every route you tried.',
    '- MINIMAL AND EXACT. Build exactly what the task asks. Never add a feature, screen, account, database or file that was not requested.',
    'PROTOCOL - structure your reply with these fenced blocks (a reply may contain several):',
    '```plan\\n- step one\\n- step two\\n```',
    '```todos\\n- [ ] not started\\n- [x] done\\n```',
    '```reflect\\none short paragraph: what the observation proved or disproved\\n```',
    '```tool_call\\n{"tool":"<name>","args":{}}\\n```',
    '```write\\n{"path":"frontend/index.html"}\\n<full file content>\\n```',
    'The write block PROPOSES a file: the app asks the human, and only a human approval writes it. Never claim a write happened before the approval result comes back.',
    'RULES:',
    '- Never claim a tool ran, never invent tool output, never describe what a tool "would" return.',
    '- Reflection is mandatory before the final answer: emit at least one reflect block per turn.',
    '- The final answer must be PROSE ONLY (no blocks): what you did, what changed, the evidence, the assumptions, what remains.',
    '- Do exactly the task given. Do not improve, extend, redesign or complete the user\'s brief.',
    '===== END AGENT MODE =====',
].join('\n');

/** Short status line the panel shows while a round is being generated. */
const PHASE_LABELS = {
    plan: 'planning',
    act: 'acting',
    observe: 'observing',
    reflect: 'reflecting',
    answer: 'answering',
    thinking: 'thinking',
    done: 'done',
};

// ---------------------------------------------------------------------------
// Protocol parsing (pure string logic)
// ---------------------------------------------------------------------------
/** Reads one ```<kind> ... ``` fence; returns the inner text or null. */
function readBlock(src, kind) {
    const re = new RegExp('```' + kind + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g');
    const m = re.exec(src);
    return m ? m[1].trim() : null;
}

/** Collects every ```<kind> ... ``` block of one kind. */
function readBlocks(src, kind) {
    const re = new RegExp('```' + kind + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g');
    const out = [];
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1].trim());
    return out;
}

/** `- step one` / `1. step` / plain line -> a compact step list. */
function toStepList(text) {
    if (!text) return [];
    return text.split(/\r?\n/)
        .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
        .filter(Boolean)
        .slice(0, MAX_PLAN_STEPS);
}

/** `- [ ] todo` / `- [x] done` -> {text, done}; plain lines count as pending. */
function toTodoList(text) {
    if (!text) return [];
    return text.split(/\r?\n/)
        .map((raw) => {
            const line = raw.trim();
            if (!line) return null;
            const box = /^\s*(?:[-*]|\d+[.)])\s*\[([ xX])\]\s*(.*)$/.exec(line);
            if (box) return { text: box[2].trim(), done: box[1].toLowerCase() === 'x' };
            return { text: line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim(), done: false };
        })
        .filter((t) => t && t.text)
        .slice(0, MAX_TODOS);
}

/**
 * Reads a ```write``` proposal: first line = JSON with `path`, the rest = the
 * file body. Returns null when the block is malformed (never throws - a model
 * that breaks the format must not kill the turn).
 */
function readWriteProposal(src) {
    const body = readBlock(src, 'write');
    if (body === null) return null;
    const nl = body.indexOf('\n');
    const header = nl < 0 ? body : body.slice(0, nl);
    const content = nl < 0 ? '' : body.slice(nl + 1);
    let path = null;
    try {
        const parsed = JSON.parse(header.trim());
        path = parsed && (parsed.path || parsed.file || parsed.filename);
    } catch (error) {
        // Tolerate a model that put the JSON after a sentence.
        const obj = /{[^}]*"path"\s*:\s*"([^"]+)"/.exec(header);
        if (obj) path = obj[1];
    }
    if (!path || !String(path).trim() || !content.trim()) return null;
    return { path: String(path).trim(), content };
}

/**
 * Parses everything an agent round can say.
 * @returns {{plan:string[], todos:Array<{text,done}>, reflect:string[],
 *            write:{path,content}|null, toolRequests:Array<{tool,args}>,
 *            prose:string}}
 *   `prose` is the reply with all structured blocks removed - what the user
 *   would actually read if this round were the answer.
 */
function parseRound(text) {
    const src = typeof text === 'string' ? text : '';
    let toolRequests = [];
    try {
        // Reuses the tested request parser (fenced + inline forms, brace-safe).
        toolRequests = require('./chatToolLoop').parseToolRequests(src).requests;
    } catch (error) { toolRequests = []; }
    const reflectBlocks = readBlocks(src, 'reflect');
    return {
        plan: toStepList(readBlock(src, 'plan')),
        todos: toTodoList(readBlock(src, 'todos')),
        reflect: reflectBlocks.join('\n\n').trim(),
        write: readWriteProposal(src),
        toolRequests,
        prose: stripBlocks(src),
    };
}

/** Removes every protocol block, leaving only the readable prose. */
function stripBlocks(text) {
    const src = typeof text === 'string' ? text : '';
    const kinds = ['plan', 'todos', 'reflect', 'write', 'tool_call', 'toolcall'];
    let out = src;
    for (const kind of kinds) {
        out = out.replace(new RegExp('```' + kind + '[ \\t]*\\r?\\n[\\s\\S]*?```', 'g'), '\n');
    }
    // Inline fallback form used by the shared tool parser.
    out = out.replace(/\bTOOLCALL\b[ \t]*:?[ \t]*\{[\s\S]*?\}(?=\s|$)/g, '\n');
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Compact cross-turn memory so a later turn knows what the agent already did.
 * @param {Array<{goal?:string, summary?:string, done?:boolean}>} memory
 */
function buildMemoryBlock(memory) {
    if (!Array.isArray(memory) || !memory.length) return '';
    const lines = memory.slice(-MAX_MEMORY_ENTRIES).map((m, i) => {
        const goal = String((m && m.goal) || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(untitled)';
        const summary = String((m && m.summary) || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const state = m && m.done ? 'DONE' : m && m.failed ? 'FAILED' : 'unfinished';
        return `${i + 1}. [${state}] ${goal}${summary ? ` -> ${summary}` : ''}`;
    });
    return [
        '===== AGENT MEMORY (earlier tasks in this session) =====',
        'Use this only for continuity (do not re-do finished work, do not repeat a failed approach). The CURRENT task is the only one you must complete now.',
        ...lines,
        '===== END AGENT MEMORY =====',
    ].join('\n');
}


// ---------------------------------------------------------------------------
// Per-turn state machine
// ---------------------------------------------------------------------------
/** Fresh state for ONE user turn. */
function createTurn(opts = {}) {
    return {
        goal: String(opts.goal || '').slice(0, 400),
        round: 0,
        phase: 'plan',           // plan | act | observe | reflect | answer | done
        status: 'planning',      // one-line human label for the panel
        plan: [],
        todos: [],
        reflects: [],
        toolLog: [],
        notes: [],
        memoryBlock: buildMemoryBlock(opts.memory),
        done: false,
    };
}

/** Records one REAL tool execution (never an intention). */
function recordTool(state, run) {
    const log = state.toolLog.slice();
    log.push({
        tool: String(run.tool || ''),
        server: String(run.server || ''),
        ok: !!run.ok,
        ms: Number(run.ms) || 0,
        note: String(run.text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    });
    state.toolLog = log.slice(-MAX_TOOL_LOG);
    state.phase = 'observe';
    state.status = `observed ${run.tool}: ${run.ok ? 'ok' : 'failed'}`;
    return state;
}

/** Records an approval-gated write (approved or denied - both are observations). */
function recordWrite(state, proposal, result) {
    state.notes = state.notes.concat(
        `${result.approved ? 'wrote' : 'DENIED write of'} ${proposal.path}${result.error ? ` (${result.error})` : ''}`
    ).slice(-6);
    state.phase = 'observe';
    state.status = result.approved ? `wrote ${proposal.path}` : `write denied: ${proposal.path}`;
    return state;
}

/**
 * Merges what the model just said into the turn state. Plan/todos REPLACE when
 * the model resends them (they are state, not a log); reflect blocks APPEND
 * (each one is an observation).
 */
function applyRound(state, parsed) {
    const p = parsed && typeof parsed === 'object' ? parsed : {};
    if (Array.isArray(p.plan) && p.plan.length) { state.plan = p.plan; state.phase = 'plan'; }
    if (Array.isArray(p.todos) && p.todos.length) { state.todos = p.todos; state.phase = 'act'; }
    if (p.reflect) { state.reflects = state.reflects.concat(p.reflect).slice(-6); state.phase = 'reflect'; }
    if (p.toolRequests && p.toolRequests.length) state.phase = 'act';
    if (p.write) state.phase = 'act';
    state.round = (state.round || 0) + 1;
    return state;
}

/**
 * What happens next after one round. This is the loop's brain:
 *   'tools'    - run the requested real tools and come back
 *   'write'    - ask the human to approve a file write, then come back
 *   'continue' - the round was structured-only (or skipped reflection): nudge
 *   'finish'   - the model produced prose (and reflected): hand the answer over
 * @param {{prose:string, reflect:string, toolRequests:Array, write:object|null}} parsed
 * @param {number} roundsLeft provider rounds remaining AFTER this one
 */
function decide(parsed, roundsLeft) {
    const p = parsed && typeof parsed === 'object' ? parsed : {};
    if (Array.isArray(p.toolRequests) && p.toolRequests.length) return 'tools';
    if (p.write) return 'write';
    const hasProse = !!(p.prose && String(p.prose).trim());
    if (!hasProse) return roundsLeft > 1 ? 'continue' : 'finish';
    // Prose without reflection means it skipped OBSERVE/REFLECT - one nudge is
    // cheaper than an answer built on an unchecked assumption.
    if (!p.reflect && roundsLeft > 1) return 'continue';
    return 'finish';
}


/**
 * The instruction appended to the conversation so the next round continues the
 * loop instead of starting over. Observations are stated as facts, never as
 * suggestions, so the model cannot treat them as optional.
 */
function directive(state, kind, payload) {
    const roundsLeft = Math.max(0, MAX_AGENT_ROUNDS - (state.round || 0));
    const head = `[AGENT DIRECTIVE - round ${state.round || 0}, ${roundsLeft} round budget left]`;
    if (kind === 'tools') {
        const obs = (payload && payload.observations) || [];
        return [
            head,
            'The tool result(s) below were executed by this app on this machine - they are the only truth available.',
            ...obs,
            'Now: (1) emit an updated todos block reflecting what you learned, (2) emit a reflect block stating whether the observation CONFIRMS or BREAKS your plan, then (3) either request the next tool with a tool_call block or, if and only if the goal is met, reply with the final PROSE answer.',
            'If the observation breaks your plan, say so explicitly and change the plan first.',
        ].join('\n');
    }
    if (kind === 'write') {
        return [
            head,
            `The human ${payload && payload.approved ? 'APPROVED' : 'DENIED'} the write of "${payload && payload.path}"${payload && payload.error ? ` (${payload.error})` : ''}.`,
            'Reflect on that in a reflect block, update todos, then continue: next tool, or the final PROSE answer.',
        ].join('\n');
    }
    return [
        head,
        'Your previous reply contained structured blocks but no final answer yet, and reflection is mandatory before answering.',
        'Continue the loop: either request the next tool (tool_call), or emit the reflect block (what the observation proved) plus an updated todos block, then give the final PROSE answer.',
        `Rounds left: ${roundsLeft}. If you cannot go further, say what is blocked and why instead of guessing.`,
    ].join('\n');
}

/** The system prompt for this turn (agent contract + cross-turn memory). */
function composePrompt(state) {
    const memory = state && state.memoryBlock ? state.memoryBlock : '';
    return [AGENT_SYSTEM_PROMPT, memory].filter(Boolean).join('\n\n');
}

/** Compact payload for the renderer's `agent` stream event + persistence. */
function publicState(state, extra = {}) {
    const todos = Array.isArray(state.todos) ? state.todos : [];
    const doneTodos = todos.filter((t) => t.done).length;
    return {
        round: state.round || 0,
        maxRounds: MAX_AGENT_ROUNDS,
        phase: state.phase || 'plan',
        status: state.status || '',
        plan: (state.plan || []).slice(),
        todos: todos.slice(),
        todoProgress: { done: doneTodos, total: todos.length },
        reflects: (state.reflects || []).slice(-3),
        toolLog: (state.toolLog || []).slice(),
        notes: (state.notes || []).slice(),
        goal: state.goal || '',
        ...extra,
    };
}

/** One-line outcome for cross-turn memory (survives via the saved session). */
function summarize(state, outcome) {
    const reflects = (state.reflects || []).filter(Boolean);
    const todos = (state.todos || []);
    const doneTodos = todos.filter((t) => t.done).length;
    return {
        goal: state.goal || '',
        summary: (outcome && String(outcome).replace(/\s+/g, ' ').trim().slice(0, 240))
            || (reflects[reflects.length - 1] || '').replace(/\s+/g, ' ').trim().slice(0, 240)
            || (todos.length ? `${doneTodos}/${todos.length} todo(s) done` : ''),
        done: !!(outcome && outcome.done),
        failed: !!(outcome && outcome.failed),
    };
}

module.exports = {
    MAX_AGENT_ROUNDS,
    MAX_PLAN_STEPS,
    MAX_TODOS,
    PHASE_LABELS,
    AGENT_SYSTEM_PROMPT,
    readBlock,
    readBlocks,
    readWriteProposal,
    toStepList,
    toTodoList,
    parseRound,
    stripBlocks,
    buildMemoryBlock,
    createTurn,
    recordTool,
    recordWrite,
    applyRound,
    decide,
    directive,
    composePrompt,
    publicState,
    summarize,
};

