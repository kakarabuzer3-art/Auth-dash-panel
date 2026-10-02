/**
 * @file fileManager.js
 * @description Handles file system operations like scaffolding folders and making backups.
 */

const fs = require('fs-extra');
const path = require('path');
const log = require('./logger');

module.exports = {
    /**
     * Creates the project directory structure. The folder list is
     * user-configurable (fileConfig.outputFolders, edited in the Prompts view);
     * the default is just frontend/ + backend/ and the AI itself decides which
     * generated file belongs to which folder via its FILE: path prefixes.
     * @param {string} basePath - The root path for the dashboard generation.
     * @param {boolean} backupExisting - Whether to backup an existing folder before overwriting.
     * @param {string[]} [folders] - Top-level folders to create (default: frontend + backend).
     */
    async scaffoldProject(basePath, backupExisting = true, folders = ['frontend', 'backend']) {
        try {
            if (await fs.pathExists(basePath) && backupExisting) {
                const backupPath = `${basePath}_backup_${Date.now()}`;
                log.info(`Backing up existing project to: ${backupPath}`);
                await fs.move(basePath, backupPath);
            }

            const clean = (Array.isArray(folders) ? folders : [])
                .map((f) => String(f || '').trim().replace(/^[\\/]+|[\\/]+$/g, ''))
                .filter((f) => f && !f.includes('..'));
            const list = clean.length ? clean : ['frontend', 'backend'];

            log.info(`Scaffolding project structure at: ${basePath} (${list.join(', ')})`);
            for (const folder of list) {
                await fs.ensureDir(path.join(basePath, folder));
            }

            log.info('Project structure scaffolded successfully.');
            return true;
                } catch (error) {
            log.error(`Scaffolding failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Mirror a validated project into the detected XAMPP htdocs directory so
     * Apache can serve the generated PHP API. The Desktop project remains the
     * canonical copy; existing htdocs content is backed up before replacement.
     */
    async deployToXampp(basePath) {
        const candidates = ['D:\\xamp\\htdocs', 'D:\\XAMP\\htdocs', 'C:\\xampp\\htdocs'];
        const htdocs = candidates.find(p => fs.existsSync(p));
        if (!htdocs) return { deployed: false, reason: 'XAMPP htdocs directory not found.' };
        const target = path.join(htdocs, 'autodash-dashboard');
        if (await fs.pathExists(target)) {
            const backup = `${target}_backup_${Date.now()}`;
            await fs.move(target, backup);
            log.warn(`Existing XAMPP project backed up to ${backup}`);
        }
        await fs.copy(basePath, target, { overwrite: true, errorOnExist: false });
        return { deployed: true, htdocs, target, url: 'http://localhost/autodash-dashboard/' };
    },

    /**
     * Scope-aware success check for a run that was only ever asked to build the
     * frontend (no backend prompt exists). It asks one honest question - did the
     * run actually write real files? - and deliberately does NOT name a stack,
     * so a Next.js/Vue/plain-HTML deliverable all pass.
     */
    validateGeneratedOutput(basePath) {
        const fsNative = require('fs');
        if (!fsNative.existsSync(basePath)) {
            return { valid: false, missing: [], failed: ['output folder missing'], reason: 'The output folder does not exist.' };
        }
        const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build']);
        const files = [];
        const walk = (dir, depth) => {
            if (depth > 12 || files.length > 400) return;
            let entries = [];
            try { entries = fsNative.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (const ent of entries) {
                if (IGNORE.has(ent.name) || /_backup_\d/i.test(ent.name)) continue;
                const full = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(full, depth + 1);
                else if (ent.isFile()) files.push(full);
            }
        };
        walk(basePath, 0);
        const real = files.filter((f) => {
            try { return fsNative.statSync(f).size > 0; } catch (e) { return false; }
        });
        if (!real.length) {
            return {
                valid: false, missing: [], failed: ['no files generated'],
                reason: 'The run produced no files - the AI returned no usable file markers.',
            };
        }
        return { valid: true, missing: [], failed: [], checks: { filesGenerated: real.length }, fileCount: real.length };
    },

    /**
     * Validate the generated project contract before reporting success. This
     * catches the common Gemini failure mode: valid-looking code with no PHP
     * API, no SQL schema, or a frontend pointed at an unrelated backend.
     *
     * SCOPE-AWARE (2026-10-01): the PHP/MySQL contract is only a contract when the
     * run was actually asked to build a backend. Enforcing it unconditionally made
     * every backend-less run "fail", which fired the repair pass and made the model
     * invent a PHP/MySQL backend - plus a login screen - that no prompt ever asked
     * for, and re-emit frontend/css/styles.css from scratch (which is how generated
     * colour palettes disappeared). Callers that did not request a backend must pass
     * { backendRequested: false }. The default stays true so the manual XAMPP
     * deploy keeps its strict, unchanged contract.
     */
    validateGeneratedProject(basePath, options = {}) {
        if (options && options.backendRequested === false) return this.validateGeneratedOutput(basePath);
        const fsNative = require('fs');
        const required = [
            'frontend/index.html', 'frontend/css/styles.css', 'frontend/js/app.js',
            'backend/config.php', 'backend/api.php', 'backend/health.php', 'backend/README.md', 'backend/db/schema.sql'
        ];
        const missing = required.filter(rel => !fsNative.existsSync(path.join(basePath, rel)));
        if (missing.length) return { valid: false, missing, reason: 'Required generated project files are missing.' };
        const read = rel => fsNative.readFileSync(path.join(basePath, rel), 'utf8');
        const api = read('backend/api.php');
        const config = read('backend/config.php');
        const health = read('backend/health.php');
        const sql = read('backend/db/schema.sql');
        const frontend = read('frontend/js/app.js');
        const checks = {
            pdoMysql: /PDO|mysql:/i.test(config + api),
            schemaDdl: /CREATE\s+(?:DATABASE|TABLE)/i.test(sql),
            healthEndpoint: /PDO|mysqli|SELECT\s+1/i.test(health),
            frontendApi: /fetch\s*\(|XMLHttpRequest|api\.php/i.test(frontend),
            noRootDatabase: !fsNative.existsSync(path.join(basePath, 'database'))
        };
        const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
        return { valid: failed.length === 0, missing: [], failed, checks };
    },

    /**
     * Parses an AI response that may contain multiple files delimited by
     * '--- FILE: <path> ---' markers (per the system prompt contract).
     * Falls back to a single entry if no markers are present.
     * @param {string} text - The raw AI response
     * @returns {Array<{path: string, content: string}>} parsed file objects
     */
    parseMultiFileResponse(text) {
        const input = typeof text === 'string' ? text : '';
        const markerRegex = /^---\s*FILE:\s*(.+?)\s*---\s*$/gm;
        const matches = [...input.matchAll(markerRegex)];
        if (matches.length === 0) {
            return [{ path: '', content: input.trim() }];
        }
        const files = [];
        for (let i = 0; i < matches.length; i++) {
            const start = matches[i].index + matches[i][0].length;
            const end = i + 1 < matches.length ? matches[i + 1].index : input.length;
            const raw = input.slice(start, end).trim();
            const content = raw.replace(/\n?---\s*END FILE\s*---\s*$/i, '').trim();
            files.push({ path: matches[i][1].trim(), content });
        }
        return files;
    }
};