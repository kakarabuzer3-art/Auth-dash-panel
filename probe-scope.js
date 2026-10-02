/**
 * Probe: verifies the scope-discipline fix end-to-end WITHOUT Electron.
 *
 *   node probe-scope.js
 *
 * Checks (the same code path ApiManager.resolveSystemPrompt() calls):
 *   1. TASK SCOPE block is first in a real automation system prompt.
 *   2. web-security is NOT injected by default (it was the source of the
 *      unrequested login/security-lock screens).
 *   3. Switching web-security on injects it, but with the conditional preamble
 *      (still no login screen unless the task names one).
 *   4. validateGeneratedProject({backendRequested:false}) accepts a frontend-only
 *      deliverable and stays strict when no option is given (manual XAMPP deploy).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillRegistry = require('./src/modules/skillRegistry');
const FileManager = require('./src/modules/fileManager');

// Mirror the real stored config: nothing toggled (probe-skill-state.js proved
// skills.enabled = {} and promptScope undefined).
let aiConfig = {
    systemPrompt: 'You are a senior frontend coder.',
    promptScope: { chat: true, automation: true },
    skills: { enabled: {} },
};
skillRegistry.configure({
    get: (k) => (k === 'aiConfig' ? aiConfig : undefined),
    save: () => {},
});

let pass = 0;
let fail = 0;
const check = (label, ok, extra) => {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? `\n        ${extra}` : ''}`);
    ok ? pass++ : fail++;
};

console.log('\n--- 1. effective automation system prompt ---');
const composed = skillRegistry.composeSystemPrompt('automation');
const text = composed.text;
const activeIds = composed.skills.map((s) => s.id);
console.log('  active skills:', activeIds.length ? activeIds.join(', ') : '(none)');
console.log('  total chars  :', text.length);

check('TASK SCOPE block present', text.includes('===== TASK SCOPE (highest priority'));
check('TASK SCOPE is the FIRST section', text.startsWith('===== TASK SCOPE'));
check('active skills injected before TASK SCOPE? (must be false)',
    text.indexOf('===== ACTIVE SKILLS') === -1 || text.indexOf('===== ACTIVE SKILLS') > text.indexOf('===== TASK SCOPE'));
check('web-security NOT injected by default', !activeIds.includes('web-security'),
    `active ids: ${activeIds.join(', ') || '(none)'}`);
check('no password_hash() mandate reaches the AI', !text.includes('password_hash()'));
check('persona prompt still reaches the AI', text.includes('You are a senior frontend coder.'));
check('scope forbids unrequested login screens', text.includes('security lock'));
check('scope forbids carry-over from earlier runs', text.includes('NO CARRY-OVER'));

console.log('\n--- 2. web-security switched ON (user choice) ---');
aiConfig = { ...aiConfig, skills: { enabled: { 'web-security': { enabled: true, chat: true, automation: true } } } };
const on = skillRegistry.composeSystemPrompt('automation');
const onIds = on.skills.map((s) => s.id);
check('web-security now injected', onIds.includes('web-security'), `active ids: ${onIds.join(', ')}`);
check('conditional preamble still present (only applies if task has accounts/db)',
    on.text.includes('apply these ONLY to a project the task actually gives accounts'));
check('TASK SCOPE still outranks it', on.text.startsWith('===== TASK SCOPE'));

console.log('\n--- 3. scope-aware validation ---');
aiConfig = { ...aiConfig, skills: { enabled: {} } }; // back to defaults
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autodash-probe-'));
fs.mkdirSync(path.join(tmp, 'frontend', 'css'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'frontend', 'index.html'), '<html><body>hi</body></html>');
fs.writeFileSync(path.join(tmp, 'frontend', 'css', 'styles.css'), 'body{color:#7c3aed}');

const frontendOnly = FileManager.validateGeneratedProject(tmp, { backendRequested: false });
check('frontend-only project PASSES when no backend was requested', frontendOnly.valid,
    JSON.stringify(frontendOnly.failed || []) + (frontendOnly.reason || ''));

const strict = FileManager.validateGeneratedProject(tmp); // manual XAMPP deploy: unchanged
check('strict PHP/MySQL contract UNCHANGED when no option given', strict.valid === false,
    'missing: ' + (strict.missing || []).join(', '));

const zeroOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'autodash-probe0-'));
fs.mkdirSync(path.join(zeroOnly, 'frontend'), { recursive: true });
fs.writeFileSync(path.join(zeroOnly, 'frontend', 'index.html'), '');
const empty = FileManager.validateGeneratedProject(zeroOnly, { backendRequested: false });
fs.rmSync(zeroOnly, { recursive: true, force: true });
check('zero-byte-only output is still rejected', empty.valid === false, empty.reason || '');

const missingDir = FileManager.validateGeneratedProject(path.join(tmp, 'nope'), { backendRequested: false });
check('missing output folder is still rejected', missingDir.valid === false);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed.\n`);
process.exit(fail === 0 ? 0 : 1);
