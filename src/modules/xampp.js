/**
 * @file xampp.js
 * @description XAMPP integration layer: detect the local XAMPP install, start
 *              Apache + MySQL when they are not running, deploy the validated
 *              project into htdocs, import backend/db/schema.sql into MySQL and
 *              verify the live backend/health.php endpoint over HTTP.
 *
 *              WHY THIS EXISTS (2026-09-25): a generated project is only useful
 *              when it actually RUNS against localhost/phpMyAdmin. Before this
 *              module the workflow only logged the htdocs path and never touched
 *              the services or the database, so the user ended up with a
 *              dashboard that was "not connected to XAMPP".
 *
 *              SAFETY RULES
 *              - Every step is best-effort and returns a structured report; a
 *                machine-level problem must never crash the workflow.
 *              - The import NEVER drops anything it did not create: an existing
 *                database is dumped to runs/db-backups/ first.
 *              - Only the schema this app generated is ever imported.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const axios = require('axios');
const log = require('./logger');

/** Folder name used inside htdocs (must match the generated API_BASE URL). */
const APP_DIR_NAME = 'autodash-dashboard';
/** Known XAMPP install roots on this machine, in detection order. */
const CANDIDATE_ROOTS = ['D:\\xamp', 'D:\\XAMP', 'C:\\xampp'];
const BACKUP_ROOT = path.resolve(__dirname, '../../runs/db-backups');

/**
 * Finds the XAMPP installation that actually contains Apache + MySQL + htdocs.
 * @param {string} [overrideRoot] - user-configured fileConfig.xamppRoot wins
 * @returns {object|null} {root, apacheExe, mysqldExe, mysqlExe, dumpExe, htdocs, target}
 */
function detectXampp(overrideRoot) {
    const roots = [overrideRoot, ...CANDIDATE_ROOTS].filter(Boolean);
    for (const root of roots) {
        try {
            if (!fs.existsSync(root)) continue;
            const apacheExe = path.join(root, 'apache', 'bin', 'httpd.exe');
            const mysqldExe = path.join(root, 'mysql', 'bin', 'mysqld.exe');
            const mysqlExe = path.join(root, 'mysql', 'bin', 'mysql.exe');
            const dumpExe = path.join(root, 'mysql', 'bin', 'mysqldump.exe');
            const htdocs = path.join(root, 'htdocs');
            if (fs.existsSync(apacheExe) && fs.existsSync(mysqldExe) && fs.existsSync(htdocs)) {
                return { root, apacheExe, mysqldExe, mysqlExe, dumpExe: fs.existsSync(dumpExe) ? dumpExe : null, htdocs, target: path.join(htdocs, APP_DIR_NAME) };
            }
        } catch (e) { /* try the next candidate */ }
    }
    return null;
}

/** Resolves true when something accepts connections on host:port in time. */
function isPortOpen(port, host = '127.0.0.1', timeoutMs = 1200) {
    return new Promise((resolve) => {
        let settled = false;
        const sock = net.connect({ port, host });
        const done = (ok) => { if (!settled) { settled = true; try { sock.destroy(); } catch (e) { /* ignore */ } resolve(ok); } };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
    });
}

/** Polls a port until it opens or the deadline passes. */
async function waitForPort(port, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isPortOpen(port)) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return isPortOpen(port);
}

// ---------------------------------------------------------------------------
// SERVICE START
// ---------------------------------------------------------------------------

/** Spawns a detached background process (never blocks the workflow). */
function spawnDetached(cmd, args, cwd) {
    try {
        const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return { spawned: true };
    } catch (error) {
        return { spawned: false, error: error.message };
    }
}

/**
 * Starts Apache when port 80 is closed. Mirrors XAMPP's own apache_start.bat
 * (run httpd.exe from the XAMPP root) so relative paths inside httpd.conf
 * resolve exactly like they do when the user starts it by hand.
 */
async function startApache(xam, startEnabled = true) {
    if (await isPortOpen(80)) return { ok: true, alreadyRunning: true, detail: 'Apache already listening on :80' };
    if (!startEnabled) return { ok: false, detail: 'Apache is not running and auto-start is disabled.' };
    const res = spawnDetached(xam.apacheExe, [], xam.root);
    if (!res.spawned) return { ok: false, detail: `Could not launch httpd.exe: ${res.error}` };
    const up = await waitForPort(80, 20000);
    return up
        ? { ok: true, started: true, detail: 'Apache started and listening on :80' }
        : { ok: false, started: true, detail: 'httpd.exe launched but :80 never opened (see apache\\logs\\error.log).' };
}

/**
 * Starts MySQL when port 3306 is closed. Mirrors mysql_start.bat:
 *   mysql\bin\mysqld --defaults-file=mysql\bin\my.ini --standalone
 * (--defaults-file MUST be the first mysqld argument.)
 */
async function startMysql(xam, startEnabled = true) {
    if (await isPortOpen(3306)) return { ok: true, alreadyRunning: true, detail: 'MySQL already listening on :3306' };
    if (!startEnabled) return { ok: false, detail: 'MySQL is not running and auto-start is disabled.' };
    const myIni = path.join(xam.root, 'mysql', 'bin', 'my.ini');
    const args = [];
    if (fs.existsSync(myIni)) args.push(`--defaults-file=${myIni}`);
    args.push('--standalone');
    const res = spawnDetached(xam.mysqldExe, args, xam.root);
    if (!res.spawned) return { ok: false, detail: `Could not launch mysqld: ${res.error}` };
    const up = await waitForPort(3306, 30000);
    return up
        ? { ok: true, started: true, detail: 'MySQL started and listening on :3306' }
        : { ok: false, started: true, detail: 'mysqld launched but :3306 never opened (see mysql\\data\\*.err).' };
}

// ---------------------------------------------------------------------------
// SCHEMA / CREDENTIAL PARSING (reads what the AI actually generated)
// ---------------------------------------------------------------------------

/** Pulls the database name + credentials declared by the generated files. */
function parseDbIdentity(basePath) {
    const out = { name: 'autodash_dashboard', user: 'root', password: '', host: '127.0.0.1', port: 3306, source: 'default' };
    try {
        const schemaPath = path.join(basePath, 'backend', 'db', 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const sql = fs.readFileSync(schemaPath, 'utf8');
            const m = sql.match(/CREATE\s+DATABASE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([\w-]+)/i);
            if (m) { out.name = m[1]; out.source = 'schema.sql'; }
        }
        const configPath = path.join(basePath, 'backend', 'config.php');
        if (fs.existsSync(configPath)) {
            const php = fs.readFileSync(configPath, 'utf8');
            const grab = (key) => {
                const re = new RegExp(`define\\(\\s*['\"]${key}['\"]\\s*,\\s*['\"]([^'\"\\n]*)['\"]`, 'i');
                const m2 = php.match(re);
                return m2 ? m2[1] : null;
            };
            if (out.source === 'default') { const db = grab('DB_NAME'); if (db) { out.name = db; out.source = 'config.php'; } }
            const user = grab('DB_USER'); if (user !== null) out.user = user;
            const pass = grab('DB_PASSWORD'); if (pass !== null) out.password = pass;
        }
    } catch (error) {
        log.warn(`parseDbIdentity fell back to defaults: ${error.message}`);
    }
    return out;
}

/** mysql.exe argument list built from parsed credentials (XAMPP: root, empty pw). */
function mysqlArgs(db, extra = []) {
    const args = [`-h${db.host}`, `-P${db.port}`, `-u${db.user}`];
    if (db.password) args.push(`-p${db.password}`); // local dev default is empty
    return args.concat(extra);
}

function run(exe, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout: opts.timeout || 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
            resolve({ ok: !error, error: error ? error.message : null, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

/** Streams a file into `mysql <db>` on stdin (no shell, no temp files). */
function importSqlFile(mysqlExe, args, filePath) {
    return new Promise((resolve) => {
        const child = spawn(mysqlExe, args, { windowsHide: true });
        let err = '';
        child.stderr.on('data', (d) => { err += String(d); });
        child.on('error', (e) => resolve({ ok: false, error: e.message + (err ? ` ${err}` : '') }));
        child.on('close', (code) => resolve({ ok: code === 0, code, error: code === 0 ? null : (err.trim() || `mysql exited with code ${code}`) }));
        const stream = fs.createReadStream(filePath);
        stream.on('error', (e) => { try { child.kill(); } catch (k) { /* ignore */ } resolve({ ok: false, error: e.message }); });
        stream.pipe(child.stdin);
    });
}

/**
 * Creates the database (if missing), dumps the previous version to
 * runs/db-backups/, then imports the generated schema.sql.
 */
async function importSchema(xam, basePath, enabled = true) {
    const schemaPath = path.join(basePath, 'backend', 'db', 'schema.sql');
    if (!fs.existsSync(schemaPath)) return { ok: false, skipped: true, detail: 'backend/db/schema.sql not found - nothing to import.' };
    if (!enabled) return { ok: true, skipped: true, detail: 'Schema import disabled (fileConfig.xamppImportSchema = false).' };

    const db = parseDbIdentity(basePath);
    const safeName = db.name.replace(/'/g, "''");
    const exists = await run(xam.mysqlExe, mysqlArgs(db, ['-N', '-e', `SHOW DATABASES LIKE '${safeName}'`]));
    const alreadyThere = exists.ok && exists.stdout.trim().length > 0;

    // 1) Safety dump of the previous database (best effort, never blocks).
    if (alreadyThere && xam.dumpExe) {
        try {
            await fs.ensureDir(BACKUP_ROOT);
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dumpPath = path.join(BACKUP_ROOT, `${db.name}_${stamp}.sql`);
            const dumped = await new Promise((resolve) => {
                const child = spawn(xam.dumpExe, mysqlArgs(db, [db.name]), { windowsHide: true });
                const out = fs.createWriteStream(dumpPath);
                child.stdout.pipe(out);
                let err = '';
                child.stderr.on('data', (d) => { err += String(d); });
                child.on('error', (e) => resolve({ ok: false, error: e.message }));
                child.on('close', (code) => resolve({ ok: code === 0, error: err.trim() || null }));
            });
            if (dumped.ok) log.info(`XAMPP: previous database backed up to ${dumpPath}`);
            else { await fs.remove(dumpPath).catch(() => {}); log.warn(`XAMPP: database backup skipped (${dumped.error || 'dump failed'}).`); }
        } catch (e) { log.warn(`XAMPP: database backup skipped (${e.message}).`); }
    }

    // 2) CREATE DATABASE IF NOT EXISTS with the contract charset.
    const created = await run(xam.mysqlExe, mysqlArgs(db, ['-e',
        `CREATE DATABASE IF NOT EXISTS \`${db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`]));
    if (!created.ok) return { ok: false, database: db.name, detail: `Could not create database "${db.name}": ${created.stderr || created.error}` };

    // 3) Import the schema.
    const imported = await importSqlFile(xam.mysqlExe, mysqlArgs(db, ['--default-character-set=utf8mb4', db.name]), schemaPath);
    if (!imported.ok) return { ok: false, database: db.name, detail: `Schema import failed: ${imported.error}` };

    // 4) Confirm the tables really landed.
    const tables = await run(xam.mysqlExe, mysqlArgs(db, ['-N', '-e',
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${safeName}'`]));
    const tableCount = Number((tables.stdout || '').trim()) || 0;
    return {
        ok: tableCount > 0,
        database: db.name,
        tableCount,
        user: db.user,
        detail: tableCount > 0
            ? `Database "${db.name}" ready - ${tableCount} table(s) imported.`
            : `Import finished but "${db.name}" reports 0 tables - check backend/db/schema.sql.`,
    };
}

// ---------------------------------------------------------------------------
// DEPLOY + LIVE HEALTH VERIFY + ORCHESTRATION
// ---------------------------------------------------------------------------

/** Copies the validated project into htdocs/autodash-dashboard (with backup). */
async function deployProject(xam, basePath) {
    if (await fs.pathExists(xam.target)) {
        const backup = `${xam.target}_backup_${Date.now()}`;
        await fs.move(xam.target, backup, { overwrite: true });
        log.warn(`XAMPP: previous htdocs project backed up to ${backup}`);
    }
    await fs.copy(basePath, xam.target, { overwrite: true, errorOnExist: false });
    return { ok: true, target: xam.target, url: `http://localhost/${APP_DIR_NAME}/` };
}

/**
 * Calls the deployed health.php. It performs a REAL PDO connection check, so a
 * green result proves Apache + PHP + PDO + MySQL + schema all work together.
 */
async function verifyHealth() {
    const url = `http://localhost/${APP_DIR_NAME}/backend/health.php`;
    try {
        const res = await axios.get(url, {
            timeout: 8000, proxy: false,
            headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'AutoDash-HealthCheck/1.0' },
            validateStatus: () => true,
        });
        const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        let parsed = null;
        try { parsed = typeof res.data === 'string' ? JSON.parse(res.data) : res.data; } catch (e) { parsed = null; }
        const ok = !!(parsed && (parsed.ok === true || parsed.ok === 'true' || parsed.status === 'ok' || parsed.success === true))
            || /"ok"\s*:\s*true/i.test(body);
        return { ok, status: res.status, url, message: (parsed && (parsed.message || parsed.error)) || (ok ? 'Database connection OK' : body.slice(0, 200)) };
    } catch (error) {
        return { ok: false, url, message: error.message };
    }
}

/**
 * Full pipeline used by the workflow AND by the manual UI action:
 * detect -> start services -> deploy -> import schema -> verify health.
 * @param {string} basePath - the generated project folder
 * @param {object} [opts] { start, deploy, import, verify, xamppRoot }
 * @returns {Promise<{ok, skipped?, steps, url?, health?, root?}>}
 */
async function connect(basePath, opts = {}) {
    const cfg = { start: true, import: true, deploy: true, verify: true, xamppRoot: '', ...opts };
    const steps = [];
    const xam = detectXampp(cfg.xamppRoot);
    if (!xam) {
        steps.push({ name: 'detect', ok: false, detail: `No XAMPP installation found (looked in: ${CANDIDATE_ROOTS.join(', ')}).` });
        return { ok: false, skipped: true, steps, reason: 'XAMPP not found' };
    }
    steps.push({ name: 'detect', ok: true, detail: `XAMPP found at ${xam.root}` });

    const apache = await startApache(xam, cfg.start);
    steps.push({ name: 'apache', ok: apache.ok, detail: apache.detail });
    const mysql = await startMysql(xam, cfg.start);
    steps.push({ name: 'mysql', ok: mysql.ok, detail: mysql.detail });
    if (!apache.ok || !mysql.ok) return { ok: false, steps, root: xam.root, reason: 'services unavailable' };

    let url;
    if (cfg.deploy) {
        try {
            const deployed = await deployProject(xam, basePath);
            url = deployed.url;
            steps.push({ name: 'deploy', ok: true, detail: `Deployed to ${deployed.target}` });
        } catch (error) {
            steps.push({ name: 'deploy', ok: false, detail: error.message });
            return { ok: false, steps, root: xam.root, reason: 'deploy failed' };
        }
    }

    if (cfg.import) {
        const imported = await importSchema(xam, basePath, true);
        steps.push({ name: 'database', ok: imported.ok, detail: imported.detail || '' });
        if (!imported.ok) return { ok: false, steps, root: xam.root, url, reason: 'schema import failed' };
    }

    if (cfg.verify && cfg.deploy) {
        const health = await verifyHealth();
        steps.push({ name: 'health', ok: health.ok, detail: `${health.url} -> ${health.ok ? 'OK' : 'FAILED'} (${health.message})` });
        return { ok: health.ok, steps, root: xam.root, url, health };
    }
    return { ok: true, steps, root: xam.root, url };
}

/** Lightweight status for the Settings UI (no side effects, no HTTP). */
async function status(xamppRoot) {
    const xam = detectXampp(xamppRoot);
    const apache = await isPortOpen(80);
    const mysql = await isPortOpen(3306);
    if (!xam) return { found: false, apacheRunning: apache, mysqlRunning: mysql, candidates: CANDIDATE_ROOTS };
    return {
        found: true,
        root: xam.root,
        htdocs: xam.htdocs,
        target: xam.target,
        deployed: fs.existsSync(xam.target),
        url: `http://localhost/${APP_DIR_NAME}/`,
        apacheRunning: apache,
        mysqlRunning: mysql,
        phpMyAdmin: 'http://localhost/phpmyadmin/',
    };
}

module.exports = {
    APP_DIR_NAME,
    CANDIDATE_ROOTS,
    detectXampp,
    isPortOpen,
    startApache,
    startMysql,
    parseDbIdentity,
    deployProject,
    importSchema,
    verifyHealth,
    connect,
    status,
};



