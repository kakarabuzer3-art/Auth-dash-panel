/**
 * @file skillRegistry.js
 * @description SKILLS = reusable PROMPT MODULES that the AI reads ON EVERY REQUEST.
 *
 * WHY THIS EXISTS (2026-09-29): the AI Settings "System Prompt" box was saved to
 * `aiConfig.systemPrompt`, but only the Force-Run generation path ever read it -
 * the Live AI Chat router passed NOTHING (AiChat.jsx literally sent
 * `systemPrompt: ''`), so a user's carefully written instructions were silently
 * ignored in chat. This module turns a single prompt box into a real prompt
 * SYSTEM: a persona prompt plus any number of toggleable, editable skill modules
 * (SEO, honesty, security, accessibility, performance, data integrity...), each
 * one applied per TARGET ('chat' | 'automation').
 *
 * DESIGN RULES
 *  - Definition lives on disk: `skills/<id>.json` (seeded with the built-ins on
 *    first use so the user can edit them, exactly like prompts/styles/*.txt).
 *  - STATE lives in config: `aiConfig.skills.<id> = { enabled, chat, automation }`,
 *    so enabling/disabling never rewrites a skill file.
 *  - Config access is INJECTABLE (`configure({get, save})`) so a plain-node probe
 *    can unit-test the composer without Electron/electron-store. The default
 *    accessor lazily requires ./encryption (same pattern as apiManager).
 *  - Never throws into a generation path: every disk/config read is guarded and
 *    falls back to the built-in definition.
 */

const fs = require('fs-extra');
const path = require('path');
const log = require('./logger');

// ---------------------------------------------------------------------------
// Config accessor (injectable -> plain-node testable)
// ---------------------------------------------------------------------------
let injectedAccessor = null;

/**
 * Injects a config accessor. Used by probes/tests only.
 * @param {{get:function, save:function}|null} accessor
 */
function configure(accessor) {
    injectedAccessor = accessor || null;
}

function readAiConfig() {
    try {
        if (injectedAccessor && typeof injectedAccessor.get === 'function') {
            return injectedAccessor.get('aiConfig') || {};
        }
        return require('./encryption').getConfig('aiConfig') || {};
    } catch (error) {
        log.warn(`skillRegistry: aiConfig unavailable (${error.message}) - using built-ins only.`);
        return {};
    }
}

function writeAiConfigPatch(patch) {
    const current = readAiConfig();
    const next = { ...current, ...patch };
    if (injectedAccessor && typeof injectedAccessor.save === 'function') {
        injectedAccessor.save('aiConfig', next);
        return next;
    }
    require('./encryption').saveConfig('aiConfig', next);
    return next;
}

/** Skill definitions live here (module-relative first, cwd fallback). */
const SKILL_ROOTS = [
    path.join(__dirname, '..', '..', 'skills'),
    path.join(process.cwd(), 'skills'),
];

function skillsDir() {
    return SKILL_ROOTS[0];
}


// ---------------------------------------------------------------------------
// BUILT-IN SKILLS
// ---------------------------------------------------------------------------
// `priority` decides the order the blocks are concatenated (lower = earlier =
// closer to the top of the instruction stack, which models weight more).
// `enabledByDefault` is only the FIRST-RUN state; user toggles live in config.
const BUILTIN_SKILLS = [
    {
        id: 'honesty-guard',
        name: 'Honesty & No-Hallucination Guard',
        category: 'trust',
        description: 'Separates verified fact from assumption, admits uncertainty and never invents data, metrics or sources.',
        priority: 1,
        targets: ['chat', 'automation'],
        enabledByDefault: true,
        prompt: [
            'HONESTY CONTRACT (highest priority - it overrides style, speed and enthusiasm):',
            '1. Never invent facts, statistics, prices, benchmarks, clients, testimonials, studies, URLs, API endpoints, function names or version numbers. If you did not receive it in the request or the supplied context, it does not exist for you.',
            '2. Mark the status of every non-obvious claim: [verified] when it comes from the supplied context/tool output, [assumption] when you inferred it, [unknown] when you cannot check it.',
            '3. When you are unsure, say so plainly and state what you would need to confirm it ("I cannot verify X without Y"). A short honest answer beats a confident wrong one.',
            '4. Never fabricate tool output, file contents, command results or search results, and never present placeholder data as if it were real measurement.',
            '5. If the request is impossible, unsafe, self-contradictory or missing required input, refuse or ask exactly ONE focused clarifying question instead of guessing.',
            '6. Correct yourself immediately and explicitly when you notice an earlier statement was wrong.',
        ].join('\n'),
    },
    {
        id: 'seo-advanced',
        name: 'Advanced SEO Strategist',
        category: 'seo',
        description: 'Search-intent mapping, keyword clusters, E-E-A-T, on-page + technical SEO, schema markup and CWV budgets.',
        priority: 10,
        targets: ['chat', 'automation'],
        enabledByDefault: true,
        prompt: [
            'SEO SKILL - think and work like a senior technical SEO consultant (white-hat only):',
            'INTENT FIRST: before answering, classify the query intent (informational, commercial, transactional, navigational) and name the searcher and their stage. Optimise for the intent, never for a keyword string.',
            'KEYWORDS: propose a cluster with head term, 5-15 mid-tail and long-tail variants, the questions people actually ask, and the entity/sub-topic coverage the page must have to be considered complete. Group by one primary intent per page (one page = one intent), and say which pages would compete with each other (keyword cannibalisation).',
            'E-E-A-T: state the experience/expertise signals the content needs (author identity, credentials, first-hand evidence, dates, sources, contact/About pages). Never invent credentials or awards.',
            'ON-PAGE: exactly one H1 that matches intent, logical H2/H3 outline, descriptive title tag <= 60 characters, meta description <= 155 characters with the value proposition, descriptive URLs, descriptive internal links with real anchor text, image alt text that describes the image, and a clear primary call to action.',
            'TECHNICAL: canonical tag, hreflang when multi-language, XML sitemap and robots.txt entries, clean indexable HTML, breadcrumbs, pagination handling, and no JS-dependent content for primary copy.',
            'STRUCTURED DATA: emit valid JSON-LD for the correct type (Article, Product, FAQPage, BreadcrumbList, LocalBusiness, Organization, SoftwareApplication) with only the properties that are truly known.',
            'CORE WEB VITALS budgets: LCP < 2.5s, INP < 200ms, CLS < 0.1 - call out the specific fix (image dimensions/format, defer non-critical JS, reserve space, avoid layout thrash).',
            'MEASUREMENT: name the exact metric, tool and timeframe that would prove success (impressions, CTR, average position, conversions), and always add the honest caveat that no one can guarantee rankings.',
        ].join('\n'),
    },
    {
        id: 'seo-content',
        name: 'SEO Content & Conversion Copy',
        category: 'seo',
        description: 'Answer-first, scannable, honest copy with search-friendly structure and clear CTAs.',
        priority: 15,
        targets: ['chat', 'automation'],
        enabledByDefault: true,
        prompt: [
            'CONTENT SKILL: write for a busy human first, for search second.',
            'Open with a direct answer (40-60 words) that fully resolves the headline question, then add depth. No filler intro, no "in today\'s fast-paced world".',
            'Structure for scanning: short paragraphs (<= 3 sentences), descriptive sub-headings, bullet lists for parallel items, a comparison table when options are compared, and a short key-takeaways block.',
            'Every heading must promise a real benefit or answer a real question. Use the searcher\'s vocabulary (synonyms and related entities) instead of repeating one keyword - keyword stuffing is a defect.',
            'Prove claims with the concrete specifics you were given (numbers, examples, steps, screenshots, code). Never invent proof.',
            'CTAs: one primary action per page, worded as the outcome the reader gets, placed after value has been delivered - not a wall of buttons.',
            'Tone: confident, plain, specific, zero hype. Use active voice and cut adjectives that carry no information.',
        ].join('\n'),
    },
    {
        id: 'code-quality',
        name: 'Production Code Quality',
        category: 'engineering',
        description: 'Complete, runnable code: no placeholders, real error handling, validation and clear naming.',
        priority: 30,
        targets: ['chat', 'automation'],
        enabledByDefault: true,
        prompt: [
            'CODE QUALITY CONTRACT:',
            'Deliver COMPLETE files. Never emit "// ... rest of the code", TODO stubs, or an undefined helper you call but never define. If a file is too large for one reply, end at a clean boundary and say exactly which file you will continue with.',
            'Every function that can fail handles failure: validate inputs at the boundary, catch real errors, return an actionable message, and never swallow an error silently.',
            'Handle the loading, empty and error states of every UI surface - a spinner that never resolves or a blank table on failure is a defect.',
            'Names state intent (getActiveUsers, not getData). No single-letter names outside loop indexes. No dead code, no commented-out blocks, no duplicate logic that should be one function.',
            'Security by default: no secrets or keys in code, parameterised queries, escaped output, no eval/Function on user input.',
            'Comment only what the code cannot say itself (why a workaround exists, a non-obvious contract) - never narrate the obvious.',
            'Accessibility and responsiveness are part of done, not a follow-up ticket.',
        ].join('\n'),
    },
    {
        id: 'web-security',
        name: 'Web Application Security',
        category: 'engineering',
        description: 'OWASP-minded hardening for a project that really has accounts or a database. Opt-in: it is NOT applied unless you switch it on, so it can never add a login screen to a task that did not ask for one.',
        priority: 40,
        targets: ['chat', 'automation'],
        enabledByDefault: false,
        prompt: [
            'SECURITY RULES - apply these ONLY to a project the task actually gives accounts, authentication, or a database. If the requested deliverable has no accounts and no database, ignore every line below and build exactly what was asked: never introduce a login page, a password field, a session, a role, a schema or an auth screen just to satisfy this rule.',
            'Database: prepared statements with bound parameters ONLY (PDO/mysqli) - never string-concatenated SQL, not even for "internal" ids.',
            'Passwords: password_hash() with PASSWORD_DEFAULT, password_verify() for checks; never store, log or return a plaintext or reversibly-encrypted password.',
            'Sessions: session_regenerate_id(true) after login and privilege change, HttpOnly + SameSite cookies, logout destroys the session, and every privileged API action re-checks the session server-side.',
            'Input/output: validate on the server (allow-list, types, lengths), escape on output (htmlspecialchars with ENT_QUOTES for HTML, prepared binds for SQL, JSON-encode for JSON). Never trust the client.',
            'CSRF: a per-session token verified on every state-changing request (POST/PUT/DELETE), including AJAX calls.',
            'Authorisation: check role/ownership per record, not just "is logged in" - an id from the client must never grant access to another user\'s row.',
            'Secrets: read them from environment/config files that are git-ignored; never inline an API key, DB password or token in client-side JavaScript.',
            'Errors: log details server-side, return a generic message plus a code to the client - stack traces, SQL and file paths must never reach the browser.',
            'Add sensible rate limiting / lockout for login and other abuse-prone endpoints - but only for a login that exists because the task asked for one.',
        ].join('\n'),
    },
    {
        id: 'accessibility',
        name: 'WCAG 2.2 AA Accessibility',
        category: 'quality',
        description: 'Keyboard-operable, screen-reader-friendly, contrast-safe UI on every generated surface.',
        priority: 45,
        targets: ['chat', 'automation'],
        enabledByDefault: true,
        prompt: [
            'ACCESSIBILITY CONTRACT (WCAG 2.2 AA):',
            'Every interactive control is reachable and operable by keyboard, in a logical order, with a visible focus indicator (never outline: none without a replacement).',
            'Every input has a real <label> (or aria-label when visually hidden), and errors are announced as text next to the field - colour alone must never carry meaning.',
            'Body text contrast >= 4.5:1, large text and UI borders >= 3:1, and no text baked into images.',
            'Use semantic landmarks (header/nav/main/section/footer), one H1 per page, and heading levels that never skip.',
            'Meaningful alt text for informative images, alt="" for decorative ones, and <caption> for data tables.',
            'Dialogs trap focus, close with Escape, and restore focus to the trigger; toasts/status messages live in an aria-live region.',
            'Honour prefers-reduced-motion for animation-heavy UI and keep touch targets >= 44x44px.',
        ].join('\n'),
    },
    {
        id: 'performance',
        name: 'Performance & Core Web Vitals',
        category: 'quality',
        description: 'Measured budgets for load speed, rendering cost and database round-trips.',
        priority: 50,
        targets: ['chat', 'automation'],
        enabledByDefault: true,
        prompt: [
            'PERFORMANCE CONTRACT (budgets, not vibes):',
            'Frontend budget: LCP < 2.5s, INP < 200ms, CLS < 0.1, initial JS < 200KB gzipped where feasible.',
            'Serve responsive WebP/AVIF images with explicit width/height (CLS), loading="lazy" below the fold, and fetchpriority="high" only for the LCP image.',
            'Load only what the current view needs: defer/async non-critical scripts, avoid blocking fonts, and never ship a chart/library the page does not render.',
            'Long lists are paginated or virtualised - never render 10,000 rows into the DOM or one response.',
            'Database: index every column used in WHERE/JOIN/ORDER BY, select only the columns you need, avoid N+1 queries (one query per row), and use LIMIT for tables that grow.',
            'Cache what is expensive and stable (aggregates, config, static assets) and say for how long; never cache per-user private data in a shared cache.',
            'Measure before and after: name the metric and tool that proves the improvement (Lighthouse, Query Monitor, EXPLAIN).',
        ].join('\n'),
    },
    {
        id: 'data-integrity',
        name: 'Data & Schema Integrity',
        category: 'engineering',
        description: 'Schema-first modelling, constraints, transactions and reproducible seeding.',
        priority: 60,
        targets: ['automation'],
        enabledByDefault: true,
        prompt: [
            'DATA CONTRACT (this pipeline writes real SQL and real API code):',
            'Schema first: normalise to at least 3NF unless a measured performance reason says otherwise, and state that reason in a comment.',
            'Every table gets a primary key, explicit column types and lengths, NOT NULL where the business rule demands it, UNIQUE on natural keys (email, sku, slug), and FOREIGN KEY constraints with the intended ON DELETE behaviour.',
            'Money uses DECIMAL(12,2) (never FLOAT). Dates use DATE/DATETIME/TIMESTAMP consistently. Status/enum values are documented in a comment or lookup table.',
            'Indexes: one on every foreign key, plus every column used for filtering, sorting or searching; do not index low-cardinality flags on their own.',
            'Multi-row writes (order + items, user + profile) run inside a transaction with rollback on any failure.',
            'Seed data must be idempotent (INSERT ... ON DUPLICATE KEY UPDATE or a guard) and must include a demo login with a HASHED password you document as demo-only.',
            'Migrations/DDL must be re-runnable: CREATE TABLE IF NOT EXISTS, no destructive DROP of user data without an explicit, commented choice.',
            'Every API write validates types and ranges and returns the same JSON envelope as the reads ({success, data} / {success, error:{code, message}}).',
        ].join('\n'),
    },
];

/**
 * The one-click "recommended" persona for the AI Settings prompt box. Used by the
 * "Load recommended prompt" button - existing installs keep their stored prompt
 * until they choose it, so this can never silently rewrite a user's own text.
 */
const RECOMMENDED_SYSTEM_PROMPT = [
    'You are an expert full-stack engineer AND a senior white-hat SEO consultant (15+ years).',
    'HONESTY FIRST: never invent facts, statistics, clients, prices, URLs, API endpoints or version numbers; mark inferences as [assumption] and unverifiable claims as [unknown]; say "I cannot verify this" instead of guessing.',
    'Work like a strategist: restate the goal, name the constraints and the assumptions, choose an approach, then execute it completely.',
    'Obey every rule in the ACTIVE SKILLS block of this system prompt - it is part of your requirements, not a suggestion.',
    'Code must be complete and runnable (no placeholders), validated at the boundaries, with real error handling and no secrets in source.',
    'Marketing/UI copy must serve search intent and real users: clear structure, honest claims, measurable next steps, and the caveat that nobody can guarantee rankings.',
    'Prefer the smallest correct solution; explain trade-offs briefly instead of listing every option.',
].join('\n');

// ---------------------------------------------------------------------------
// Core task-scope discipline (NOT a toggleable skill)
// ---------------------------------------------------------------------------
/**
 * Appended to EVERY composed system prompt, chat and automation alike.
 *
 * WHY: the pipeline used to push unrequested features into the generated
 * project from three directions at once - a security skill that mandated
 * password_hash()/sessions/login-lockout on every run, a hard-coded PHP/MySQL
 * output contract, and a repair pass that re-asked for "every required file".
 * The result: a prompt that only asked for a Next.js landing page came back
 * with a login screen, and files the task never mentioned were rewritten (which
 * is how the generated colour palette disappeared - a later pass re-emitted
 * styles.css from scratch). This block makes "the task is the whole brief"
 * machine-enforced instead of a hope.
 */
const SCOPE_DISCIPLINE_PROMPT = [
    '===== TASK SCOPE (highest priority - overrides every instruction below it) =====',
    'You are given ONE task. Implement exactly that task and nothing else.',
    'ADD ONLY WHAT WAS ASKED. Login/logout, sign-up, passwords, "security lock" screens, user accounts, roles, databases, admin panels, comments, shopping carts, newsletters, cookie banners, dark-mode toggles and analytics are UNREQUESTED FEATURES. Never create one unless the task names it. Its absence is correct, not a gap to fill.',
    'NO ASSUMED REQUIREMENTS. Do not infer what the user "would also need". Do not extend, future-proof, complete or improve the brief. A thin brief means a small, well-built deliverable.',
    'NO CARRY-OVER. Treat this task as a fresh job. Never continue, repeat or reconcile work from an earlier prompt, an earlier run, or a project you remember - do not reuse a previous stack, schema, folder layout, colour palette or file just because it existed before.',
    'PRESERVE WHAT THE TASK DOES NOT MENTION. Files, sections, colours, spacing, imagery, copy and styling that the task does not name must survive untouched. Never delete, blank, "clean up" or rewrite them. Do not re-emit a file you are not changing.',
    'THE TASK OUTRANKS CONVENTION. A stack, language, framework, file layout or naming that the task names beats any default in this prompt - build the thing asked for and adapt the conventions around it, instead of substituting a preferred stack.',
    'MATCH THE REQUESTED FORM. If the task asks only for a plan, architecture, analysis or advice, answer in that form and emit no files.',
    'OUTPUT DISCIPLINE. Emit only the files this task needs. A smaller deliverable that matches the brief is right; a bigger one with invented features is wrong.',
    '===== END TASK SCOPE =====',
].join('\n');

// ---------------------------------------------------------------------------
// Definition loading
// ---------------------------------------------------------------------------
/** Normalizes a definition from disk (or a built-in) into one canonical shape. */
function normalizeDefinition(raw, source) {
    const obj = raw && typeof raw === 'object' ? raw : {};
    const id = String(obj.id || obj.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!id) return null;
    const targets = (Array.isArray(obj.targets) ? obj.targets : [])
        .map((t) => String(t || '').trim().toLowerCase())
        .filter((t) => t === 'chat' || t === 'automation');
    return {
        id,
        name: String(obj.name || id).slice(0, 80),
        category: String(obj.category || 'custom').slice(0, 24),
        description: String(obj.description || '').slice(0, 300),
        priority: Number.isFinite(Number(obj.priority)) ? Number(obj.priority) : 100,
        targets: targets.length ? targets : ['chat', 'automation'],
        enabledByDefault: obj.enabledByDefault !== false,
        prompt: String(obj.prompt || '').trim(),
        source,
    };
}

/** Writes a skill definition with repo-convention CRLF, UTF-8 without BOM. */
function writeSkillFile(file, def) {
    const json = JSON.stringify(def, null, 2).replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(file, json, 'utf8');
}

/** Creates `skills/` and seeds every built-in that has no file yet. */
function ensureSkillFiles() {
    const dir = skillsDir();
    try {
        fs.ensureDirSync(dir);
        for (const def of BUILTIN_SKILLS) {
            const file = path.join(dir, `${def.id}.json`);
            if (!fs.existsSync(file)) {
                writeSkillFile(file, def);
                log.info(`Skill seeded: skills/${def.id}.json`);
            }
        }
        return { dir, error: null };
    } catch (error) {
        return { dir, error: error.message };
    }
}

/** Reads every *.json in skills/ (unreadable files are skipped, never fatal). */
function readSkillFiles() {
    const out = [];
    const dir = skillsDir();
    try {
        if (!fs.existsSync(dir)) return out;
        for (const name of fs.readdirSync(dir)) {
            if (!name.toLowerCase().endsWith('.json')) continue;
            try {
                const def = normalizeDefinition(fs.readJSONSync(path.join(dir, name)), 'file');
                if (def) out.push(def);
            } catch (error) {
                log.warn(`Skill file skipped (skills/${name}): ${error.message}`);
            }
        }
    } catch (error) {
        log.warn(`Skill folder unreadable (${dir}): ${error.message}`);
    }
    return out;
}

/** Built-ins + file definitions (a file with the same id OVERRIDES the built-in). */
function mergeDefinitions(files) {
    const byId = new Map();
    for (const def of BUILTIN_SKILLS) {
        const n = normalizeDefinition(def, 'builtin');
        if (n) byId.set(n.id, n);
    }
    for (const def of files) {
        byId.set(def.id, { ...def, source: 'file' });
    }
    return [...byId.values()];
}

// ---------------------------------------------------------------------------
// State (aiConfig.skills.enabled) + composition
// ---------------------------------------------------------------------------
/** Reads the user state map: { <skillId>: { enabled, chat, automation } }. */
function skillStateMap() {
    const cfg = readAiConfig();
    const skills = cfg.skills && typeof cfg.skills === 'object' ? cfg.skills : {};
    if (skills.enabled && typeof skills.enabled === 'object') return skills.enabled;
    // Tolerant fallback: a flat map (skills.<id> = {...}) is also accepted.
    const flat = {};
    for (const [k, v] of Object.entries(skills)) {
        if (k !== 'enabled' && v && typeof v === 'object') flat[k] = v;
    }
    return flat;
}

/** Merges a definition with its stored state (state wins, defaults from the file). */
function resolveState(def, state) {
    const s = state[def.id] && typeof state[def.id] === 'object' ? state[def.id] : {};
    return {
        enabled: typeof s.enabled === 'boolean' ? s.enabled : def.enabledByDefault,
        chat: typeof s.chat === 'boolean' ? s.chat : def.targets.includes('chat'),
        automation: typeof s.automation === 'boolean' ? s.automation : def.targets.includes('automation'),
    };
}

/**
 * Every skill (built-in + user file) with its effective state.
 * Seeds the `skills/` folder on first call so the files are editable.
 */
function listSkills() {
    const seeded = ensureSkillFiles();
    const defs = mergeDefinitions(readSkillFiles());
    const state = skillStateMap();
    return defs
        .map((def) => {
            const st = resolveState(def, state);
            return {
                ...def,
                builtIn: def.source === 'builtin',
                promptChars: def.prompt.length,
                ...st,
                activeForChat: st.enabled && st.chat,
                activeForAutomation: st.enabled && st.automation,
            };
        })
        .sort((a, b) => (a.priority - b.priority) || a.name.localeCompare(b.name))
        .map((s) => ({ ...s, seededDir: seeded.dir, seedError: seeded.error }));
}

/** Skills that will actually be injected for one target, in priority order. */
function activeSkills(target) {
    const t = target === 'chat' ? 'chat' : 'automation';
    return listSkills().filter((s) => s.enabled && s[t] && s.prompt.trim().length > 0);
}

/**
 * Prompt block advertising MCP tools that are CURRENTLY running, so the model
 * knows a real (not imagined) local tool result can be requested. Never claims a
 * tool ran - the user (or the /tool command) must actually execute it.
 */
function mcpToolsBlock() {
    try {
        const catalog = require('./mcpManager').toolCatalog();
        if (!Array.isArray(catalog) || !catalog.length) return '';
        // Argument names come from the server's own inputSchema. Without them the
        // model has to guess keys and a real call fails on a naming mismatch.
        const argHint = (schema) => {
            if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') return '';
            const props = Object.keys(schema.properties);
            if (!props.length) return ' (no arguments)';
            const required = Array.isArray(schema.required) ? schema.required : [];
            return ` args: ${props.map((p) => (required.includes(p) ? p : `${p}?`)).join(', ')}`;
        };
        const lines = catalog
            .slice(0, 40)
            .map((t) => `  - ${t.tool} (server: ${t.server})${argHint(t.inputSchema)}${t.description ? `\n      ${t.description}` : ''}`);
        let protocol = '';
        try { protocol = require('./chatToolLoop').TOOL_PROTOCOL_PROMPT; } catch (e) { protocol = ''; }
        return [
            '===== CONNECTED MCP TOOLS (real local tools - not imaginary) =====',
            'A tool result is ONLY real when this app actually executed it. Never invent tool output.',
            'The user can also run one by hand in chat with: /tool <tool_name> {"arg":"value"}.',
            ...lines,
            protocol,
        ].filter(Boolean).join('\n');
    } catch (error) {
        return '';
    }
}

/**
 * Builds the skill half of the system prompt for a target.
 * @param {'chat'|'automation'} target
 */
function buildSkillBlock(target) {
    const t = target === 'chat' ? 'chat' : 'automation';
    const skills = activeSkills(t);
    const parts = [];
    if (skills.length) {
        parts.push([
            `===== ACTIVE SKILLS (${t.toUpperCase()} - mandatory requirements, apply ALL of them) =====`,
            'Skills govern HOW you work (quality, safety, technique). They never authorise ADDING features, screens, storage or files that the TASK SCOPE block does not ask for. When a skill seems to demand a feature the task never requested, the task wins: leave the feature out.',
            ...skills.map((s, i) => `[${i + 1}] ${s.name} (${s.category})\n${s.prompt}`),
            '===== END ACTIVE SKILLS =====',
        ].join('\n\n'));
    }
    if (t === 'chat') {
        const mcp = mcpToolsBlock();
        if (mcp) parts.push(mcp);
    }
    return parts.join('\n\n');
}

/**
 * Single source of truth for WHAT THE AI RECEIVES as its system prompt.
 * Both the generation path (apiManager) and the UI preview call this, so the
 * "effective prompt" shown in AI Settings can never drift from reality.
 * @param {'chat'|'automation'} target
 * @param {{userPrompt?:string, scope?:object}} [opts] - overrides for previews/tests
 * @returns {{target:string, scopeEnabled:boolean, userPrompt:string, userPromptChars:number,
 *            skills:Array<{id:string,name:string,chars:number}>, skillChars:number,
 *            mcpChars:number, totalChars:number, text:string}}
 */
function composeSystemPrompt(target, opts = {}) {
    const t = target === 'chat' ? 'chat' : 'automation';
    const cfg = readAiConfig();
    const scope = (opts && opts.scope) || (cfg.promptScope && typeof cfg.promptScope === 'object' ? cfg.promptScope : {});
    const scopeEnabled = t === 'chat' ? scope.chat !== false : scope.automation !== false;
    const userPrompt = String(opts && opts.userPrompt !== undefined ? opts.userPrompt : (cfg.systemPrompt || '')).trim();

    if (!scopeEnabled) {
        return {
            target: t, scopeEnabled: false, userPrompt: '', userPromptChars: 0,
            skills: [], skillChars: 0, mcpChars: 0, totalChars: 0, text: '',
        };
    }

    const block = buildSkillBlock(t);
    // SCOPE_DISCIPLINE_PROMPT goes FIRST so it outranks the persona and the
    // skills that follow it (see the WHY comment on its definition).
    const text = [SCOPE_DISCIPLINE_PROMPT, userPrompt, block].filter(Boolean).join('\n\n');
    const mcpOnly = t === 'chat' ? mcpToolsBlock() : '';
    return {
        target: t,
        scopeEnabled: true,
        userPrompt,
        userPromptChars: userPrompt.length,
        skills: activeSkills(t).map((s) => ({ id: s.id, name: s.name, chars: s.prompt.length })),
        skillChars: Math.max(block.length - mcpOnly.length, 0),
        mcpChars: mcpOnly.length,
        totalChars: text.length,
        text,
    };
}

// ---------------------------------------------------------------------------
// Mutations (used by the Skills & MCP view through IPC)
// ---------------------------------------------------------------------------
/** Persists one skill definition to skills/<id>.json (create or overwrite). */
function saveSkill(input) {
    const def = normalizeDefinition(input, 'file');
    if (!def) throw new Error('A skill id (letters, digits, - or _) is required.');
    if (!def.prompt.trim()) throw new Error('A skill needs a non-empty prompt - otherwise it does nothing.');
    const dir = ensureSkillFiles().dir;
    const file = path.join(dir, `${def.id}.json`);
    writeSkillFile(file, def);
    log.info(`Skill saved: skills/${def.id}.json (${def.prompt.length} chars, targets: ${def.targets.join('+')})`);
    return def;
}

/**
 * Removes a skill file. Built-ins cannot be deleted - deleting an EDITED built-in
 * restores the shipped definition instead (and says so in the result).
 */
function deleteSkill(id) {
    const key = normalizeDefinition({ id }, 'file');
    if (!key) throw new Error('Invalid skill id.');
    const file = path.join(skillsDir(), `${key.id}.json`);
    const isBuiltIn = BUILTIN_SKILLS.some((s) => s.id === key.id);
    if (!fs.existsSync(file)) {
        if (isBuiltIn) return { id: key.id, removed: false, restoredBuiltin: true, message: 'Built-in skill has no file - nothing to delete.' };
        throw new Error(`No skill file for "${key.id}".`);
    }
    fs.removeSync(file);
    log.info(`Skill file removed: skills/${key.id}.json${isBuiltIn ? ' (built-in definition restored)' : ''}`);
    return {
        id: key.id,
        removed: true,
        restoredBuiltin: isBuiltIn,
        message: isBuiltIn ? 'Built-in skill restored to its shipped definition.' : 'Custom skill deleted.',
    };
}

/** Enables/disables a skill and/or re-scopes it to chat / automation. */
function setSkillState(id, patch = {}) {
    const key = normalizeDefinition({ id }, 'file');
    if (!key) throw new Error('Invalid skill id.');
    const cfg = readAiConfig();
    const skills = cfg.skills && typeof cfg.skills === 'object' ? cfg.skills : {};
    const state = skillStateMap();
    const prev = state[key.id] && typeof state[key.id] === 'object' ? state[key.id] : {};
    const next = { ...prev };
    for (const flag of ['enabled', 'chat', 'automation']) {
        if (typeof patch[flag] === 'boolean') next[flag] = patch[flag];
    }
    writeAiConfigPatch({ skills: { ...skills, enabled: { ...state, [key.id]: next } } });
    const defs = mergeDefinitions(readSkillFiles());
    const def = defs.find((d) => d.id === key.id);
    const st = def ? resolveState(def, { ...state, [key.id]: next }) : { enabled: !!next.enabled, chat: !!next.chat, automation: !!next.automation };
    log.info(`Skill "${key.id}" -> enabled=${st.enabled} chat=${st.chat} automation=${st.automation}`);
    return { id: key.id, ...st };
}

module.exports = {
    configure,
    SKILL_ROOTS,
    BUILTIN_SKILLS,
    RECOMMENDED_SYSTEM_PROMPT,
    skillsDir,
    ensureSkillFiles,
    listSkills,
    activeSkills,
    buildSkillBlock,
    composeSystemPrompt,
    preview: composeSystemPrompt,
    saveSkill,
    deleteSkill,
    setSkillState,
};



