/**
 * @file promptManager.js
 * @description Folder-based, sequential, multi-language prompt system.
 *
 * Layout (relative to the project root):
 *   prompts/
 *     frontend/  01_layout.txt, 02_cards.txt, ...  -> Phase 1 (AI API)
 *     backend/   01_api.txt, 02_database.txt, ...  -> Phase 2 (AI API)
 *     styles/    auto.txt, glassmorphism.txt, ...  -> design presets
 *
 * Rules:
 *  - Every file is executed in numeric order: 01, 02, 03 ...
 *  - Files starting with "_" are ignored (handy for notes like this one).
 *  - Empty files are ignored.
 *  - Files are read as UTF-8, then UTF-16, then latin1, so prompts can be
 *    written in any language (English / Urdu / Arabic / ...). No language
 *    filtering is ever applied: content is passed through verbatim.
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const log = require('./logger');

/** Folders scanned for sequentially executed prompts (execution order). */
const PROMPT_FOLDERS = ['frontend', 'backend'];

/** File extensions accepted inside a prompt folder (case-insensitive). */
const PROMPT_EXTENSIONS = ['.txt', '.md', '.prompt'];

/** Delimiter of the deprecated single-file format (prompts.txt). */
const DEFAULT_DELIMITER = '===';

/**
 * Prefix for temporary names while reordering. It starts with "_" so a crash
 * mid-reorder can never make the loader execute a half-renamed prompt.
 */
const TEMP_PREFIX = '_reorder_tmp_';

/** Filename safety limits. */
const MAX_NAME_LENGTH = 60;


// ============================================================================
// ENCODING (UTF-8 -> UTF-16 -> latin1)
// ============================================================================

/**
 * Strict UTF-8 validation. Buffer.isUtf8() exists on Node >= 18.14; older
 * runtimes fall back to a round-trip comparison (invalid byte sequences are
 * decoded to U+FFFD, so re-encoding no longer matches the original bytes).
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function isValidUtf8(buffer) {
    if (typeof Buffer.isUtf8 === 'function') return Buffer.isUtf8(buffer);
    try {
        return Buffer.compare(Buffer.from(buffer.toString('utf8'), 'utf8'), buffer) === 0;
    } catch (error) {
        return false;
    }
}

/**
 * Detects the probable encoding of a prompt file.
 * @param {Buffer} buffer - Raw file bytes
 * @returns {'utf-8'|'utf-16le'|'utf-16be'|'latin1'}
 */
function detectEncoding(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return 'utf-8';

    // Byte-order marks win over every heuristic.
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';

    // UTF-8 BOM (the decode step strips it).
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';

    if (isValidUtf8(buffer)) return 'utf-8';

    // BOM-less UTF-16LE shows up as a NUL byte in every second position.
    const sample = buffer.slice(0, Math.min(buffer.length, 512));
    let nulls = 0;
    for (let i = 1; i < sample.length; i += 2) {
        if (sample[i] === 0x00) nulls++;
    }
    if (sample.length >= 4 && nulls / Math.max(1, Math.floor(sample.length / 2)) > 0.3) {
        return 'utf-16le';
    }

    // Legacy single-byte encodings (Windows-1252 / latin1) never throw.
    return 'latin1';
}

/**
 * Decodes a prompt buffer honoring its detected encoding.
 * @param {Buffer} buffer - Raw file bytes
 * @returns {string} Decoded text (never throws)
 */
function decodeBuffer(buffer) {
    if (!Buffer.isBuffer(buffer)) return String(buffer == null ? '' : buffer);
    if (buffer.length === 0) return '';

    switch (detectEncoding(buffer)) {
        case 'utf-16le':
            return buffer.slice(2).toString('utf16le');
        case 'utf-16be': {
            // Byte-swap the body (BOM excluded) so it can be read as UTF-16LE.
            const usable = buffer.length - 2 - ((buffer.length - 2) % 2);
            const body = Buffer.from(buffer.slice(2, 2 + usable));
            body.swap16();
            return body.toString('utf16le');
        }
        case 'latin1':
            return buffer.toString('latin1');
        case 'utf-8':
        default: {
            const body = (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf)
                ? buffer.slice(3)
                : buffer;
            return body.toString('utf8');
        }
    }
}

// ============================================================================
// LANGUAGE DETECTION (script sniffing only - never filters or translates)
// ============================================================================

/** Letters that exist in Urdu but not in plain Arabic. */
const URDU_MARKERS = /[\u0679\u067e\u0686\u0688\u0691\u06ba\u06be\u06c1\u06d2\u06af\u06cc\u0698]/;

/** Arabic block + Arabic Supplement (shared by Arabic and Urdu). */
const ARABIC_SCRIPT = /[\u0600-\u06ff\u0750-\u077f]/;

/**
 * Sniffs the dominant script of a prompt (first 100 characters).
 * Order matters: Kana is checked before CJK ideographs because Japanese text
 * also contains kanji; Urdu is detected inside the Arabic block because both
 * share the same script.
 * @param {string} text - Prompt content
 * @returns {'en'|'ur'|'ar'|'hi'|'zh'|'ja'|'ko'|'ru'|'he'} language code
 */
function detectLanguage(text) {
    const sample = String(text == null ? '' : text).slice(0, 100);
    if (!sample.trim()) return 'en';
    if (/[\u3040-\u30ff]/.test(sample)) return 'ja';   // Hiragana / Katakana
    if (/[\uac00-\ud7af]/.test(sample)) return 'ko';   // Hangul syllables
    if (ARABIC_SCRIPT.test(sample)) return URDU_MARKERS.test(sample) ? 'ur' : 'ar';
    if (/[\u0900-\u097f]/.test(sample)) return 'hi';   // Devanagari
    if (/[\u4e00-\u9fff]/.test(sample)) return 'zh';   // CJK ideographs
    if (/[\u0590-\u05ff]/.test(sample)) return 'he';   // Hebrew
    if (/[\u0400-\u04ff]/.test(sample)) return 'ru';   // Cyrillic
    return 'en';
}
const FALLBACK_NAME = 'prompt';

// ============================================================================
// PATHS + FILENAME HELPERS
// ============================================================================

/**
 * Resolves the prompts/ base directory.
 * Priority: explicit argument -> <cwd>/prompts -> <project root>/prompts.
 * @param {string} [explicitPath] - Optional override (e.g. fileConfig.promptsDirectory)
 * @returns {string} Absolute prompts/ path (not guaranteed to exist)
 */
function getPromptsBasePath(explicitPath) {
    if (explicitPath && String(explicitPath).trim()) {
        return path.resolve(String(explicitPath).replace(/^~(?=$|[\\/])/, os.homedir()));
    }
    const cwdCandidate = path.join(process.cwd(), 'prompts');
    if (fs.existsSync(cwdCandidate)) return cwdCandidate;
    // src/modules/promptManager.js -> <project root>/prompts
    const moduleCandidate = path.join(__dirname, '..', '..', 'prompts');
    if (fs.existsSync(moduleCandidate)) return moduleCandidate;
    return cwdCandidate;
}

/**
 * Resolves one prompt folder, refusing anything that is not a known folder
 * (frontend/backend). This also blocks path traversal via the IPC surface.
 */
function getPromptFolderPath(folder, basePath) {
    const name = String(folder == null ? '' : folder).trim().toLowerCase();
    if (!PROMPT_FOLDERS.includes(name)) {
        throw new Error(`Unknown prompt folder "${folder}". Expected one of: ${PROMPT_FOLDERS.join(', ')}.`);
    }
    return path.join(getPromptsBasePath(basePath), name);
}

/**
 * Creates prompts/frontend and prompts/backend (plus the base folder) if
 * missing. Called at app start so the folder structure always exists.
 * @param {string} [basePath] - Optional prompts/ base directory
 */
async function ensureFolderStructure(basePath) {
    const base = getPromptsBasePath(basePath);
    await fs.ensureDir(base);
    for (const folder of PROMPT_FOLDERS) {
        await fs.ensureDir(path.join(base, folder));
    }
    return { success: true, basePath: base, folders: PROMPT_FOLDERS.slice() };
}

/** True for the filenames that take part in a workflow run. */
function isPromptFile(filename) {
    const name = String(filename || '');
    if (!name) return false;
    if (name.startsWith('_') || name.startsWith('.')) return false; // notes / hidden
    return PROMPT_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

/** Leading number of a prompt filename ("03_cards.txt" -> 3), else null. */
function extractOrder(filename) {
    const match = /^(\d+)/.exec(String(filename || ''));
    if (!match) return null;
    const value = parseInt(match[1], 10);
    return Number.isFinite(value) ? value : null;
}

/** Removes the leading number prefix from a base name. */
function stripOrderPrefix(baseName) {
    return String(baseName || '').replace(/^\d+\s*[._\-\s]*/, '').trim();
}

/** Human readable name ("03_hero_section" -> "hero section"). */
function humanizeName(baseName) {
    const cleaned = stripOrderPrefix(baseName).replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (cleaned || FALLBACK_NAME).slice(0, MAX_NAME_LENGTH);
}

/** Numeric sort: numbered files first, then alphabetical (natural) order. */
function comparePromptEntries(a, b) {
    const orderA = extractOrder(a.fileName);
    const orderB = extractOrder(b.fileName);
    if (orderA !== null && orderB !== null && orderA !== orderB) return orderA - orderB;
    if (orderA !== null && orderB === null) return -1;
    if (orderA === null && orderB !== null) return 1;
    return a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' });
}

/** Every filename in a prompt folder, including ignored "_" note files. */
async function listAllFilenames(dir) {
    if (!(await fs.pathExists(dir))) return [];
    const entries = await fs.readdir(dir);
    return entries.map(entry => (typeof entry === 'string' ? entry : entry.name));
}

/**
 * Lists the runnable prompt filenames of a folder in execution order.
 * @param {string} dir - Absolute path of the prompt folder
 * @returns {Promise<string[]>}
 */
async function listPromptFilenames(dir) {
    if (!(await fs.pathExists(dir))) {
        log.warn(`Prompt folder not found: ${dir}`);
        return [];
    }
    return (await listAllFilenames(dir))
        .filter(isPromptFile)
        .map(fileName => ({ fileName }))
        .sort(comparePromptEntries)
        .map(entry => entry.fileName);
}

/**
 * Finds the real on-disk filename matching a user supplied name (handles
 * casing differences and already-sanitized variants).
 * @returns {Promise<string|null>}
 */
async function resolveExistingFilename(dir, filename) {
    const wanted = String(filename == null ? '' : filename).trim();
    if (!wanted) return null;
    const names = await listAllFilenames(dir);
    if (names.includes(wanted)) return wanted;
    const lower = wanted.toLowerCase();
    const ci = names.find(name => name.toLowerCase() === lower);
    if (ci) return ci;
    const sanitized = sanitizeFilename(wanted).toLowerCase();
    return names.find(name => name.toLowerCase() === sanitized) || null;
}

// ============================================================================
// READ (FOLDER BASED, ANY LANGUAGE, ANY ENCODING)
// ============================================================================

/**
 * Reads every runnable prompt of one folder into memory, in execution order.
 * @param {string} dir - Absolute path of the prompt folder
 * @returns {Promise<Array<{order:number,name:string,filename:string,path:string,content:string,encoding:string,sizeBytes:number,language:string}>>}
 */
async function loadPromptsFromFolder(dir) {
    const prompts = [];
    for (const fileName of await listPromptFilenames(dir)) {
        const filePath = path.join(dir, fileName);
        try {
            const buffer = await fs.readFile(filePath);
            const content = decodeBuffer(buffer);
            if (!content.trim()) {
                log.info(`Skipped empty prompt file: ${fileName}`);
                continue;
            }
            prompts.push({
                order: prompts.length + 1, // sequential execution order (01, 02, ...)
                name: humanizeName(path.basename(fileName, path.extname(fileName))),
                filename: fileName,
                path: filePath,
                content,
                encoding: detectEncoding(buffer),
                sizeBytes: Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(content, 'utf8'),
                language: detectLanguage(content)
            });
        } catch (error) {
            log.error(`Failed to read prompt "${fileName}": ${error.message}`);
        }
    }
    return prompts;
}

/**
 * Reads BOTH prompt folders in execution order.
 * @param {string} [basePath] - Path of the prompts/ folder
 * @returns {Promise<{frontend:Array, backend:Array, basePath:string}>}
 */
async function loadPromptsFromFolders(basePath) {
    const base = getPromptsBasePath(basePath);
    const result = { frontend: [], backend: [], basePath: base };
    for (const folder of PROMPT_FOLDERS) {
        result[folder] = await loadPromptsFromFolder(path.join(base, folder));
        log.info(`Loaded ${result[folder].length} prompt(s) from ${folder}/`);
    }
    return result;
}

// ============================================================================
// WRITE (SAVE / DELETE)
// ============================================================================

/**
 * Makes a user supplied string safe as a filename: strips any directory part,
 * replaces Windows-illegal characters, collapses separators and caps the
 * length. Unicode letters of ANY language are preserved.
 * @param {string} filename
 * @returns {string} Safe filename (always has a known prompt extension)
 */
function sanitizeFilename(filename) {
    let name = String(filename == null ? '' : filename).trim();
    name = name.replace(/^.*[\\/]/, '');                    // no directory part
    name = name.replace(/[<>:"|?*\u0000-\u001f]/g, '_');    // illegal on Windows
    name = name.replace(/\s+/g, '_');
    name = name.replace(/_{2,}/g, '_');

    const ext = path.extname(name).toLowerCase();
    const keepExt = PROMPT_EXTENSIONS.includes(ext);
    const base = (keepExt ? name.slice(0, -ext.length) : name)
        .replace(/[^\p{L}\p{N}_\-. ]+/gu, '')
        .slice(0, MAX_NAME_LENGTH)
        .replace(/^[._]+/, '')
        .replace(/[._]+$/, '');

    return `${base || FALLBACK_NAME}${keepExt ? ext : '.txt'}`;
}

/**
 * Saves one prompt into prompts/<folder>.
 *  - If the exact filename already exists it is overwritten (edit flow).
 *  - Otherwise the next free number is prefixed: 01_name.txt, 02_name.txt ...
 * Content is always written as UTF-8, so any language round-trips safely.
 * @param {string} folder - 'frontend' | 'backend'
 * @param {string} filename - Desired name ("header" or "01_header.txt")
 * @param {string} content - Prompt text (any language)
 * @param {string} [basePath] - Optional prompts/ base directory
 * @returns {Promise<{success:boolean,folder:string,filename:string,path:string,order:number|null}>}
 */
async function savePromptToFile(folder, filename, content, basePath) {
    const dir = getPromptFolderPath(folder, basePath);
    await fs.ensureDir(dir);

    const existing = await listAllFilenames(dir);
    const realName = await resolveExistingFilename(dir, filename);
    const text = String(content == null ? '' : content);

    let targetName = realName;
    if (!targetName) {
        const safeName = sanitizeFilename(filename);
        const ext = path.extname(safeName);
        const base = stripOrderPrefix(path.basename(safeName, ext)) || FALLBACK_NAME;
        let next = existing.reduce((max, name) => Math.max(max, extractOrder(name) || 0), 0) + 1;
        targetName = `${String(next).padStart(2, '0')}_${base}${ext}`;
        while (existing.some(name => name.toLowerCase() === targetName.toLowerCase())) {
            next += 1;
            targetName = `${String(next).padStart(2, '0')}_${base}${ext}`;
        }
    }

    const filePath = path.join(dir, targetName);
    await fs.outputFile(filePath, text, 'utf8');
    if (!text.trim()) {
        log.warn(`Saved "${targetName}" without content - it stays skipped until a prompt is added.`);
    }
    log.info(`Prompt saved: ${folder}/${targetName} (${text.length} chars)`);
    return { success: true, folder, filename: targetName, path: filePath, order: extractOrder(targetName) };
}

/**
 * Deletes one prompt file from a folder.
 * @param {string} folder - 'frontend' | 'backend'
 * @param {string} filename - Existing prompt filename
 * @param {string} [basePath] - Optional prompts/ base directory
 * @returns {Promise<{success:boolean,folder:string,filename:string}>}
 */
async function deletePromptFile(folder, filename, basePath) {
    const dir = getPromptFolderPath(folder, basePath);
    const realName = await resolveExistingFilename(dir, filename);
    if (!realName) {
        throw new Error(`Prompt file not found: ${folder}/${filename}`);
    }
    await fs.remove(path.join(dir, realName));
    log.info(`Prompt deleted: ${folder}/${realName}`);
    return { success: true, folder, filename: realName };
}

// ============================================================================
// REORDER (RENAME 01_, 02_, 03_ ... WITHOUT LOSING FILES)
// ============================================================================

/**
 * Renames the prompts of a folder to match a new order (01_, 02_, 03_ ...).
 *
 * Two phases keep a crash from ever leaving a confusing mix of numbers:
 *   Phase 1: every listed file is renamed to "_reorder_tmp_<i>__<name>"
 *            (the "_" prefix makes the loader ignore it).
 *   Phase 2: the temporary files get their final numbered names.
 * If phase 2 fails, everything still parked under a temporary name is rolled
 * back to its original name.
 *
 * @param {string} folder - 'frontend' | 'backend'
 * @param {string[]} newOrder - Filenames in the desired order
 * @param {string} [basePath] - Optional prompts/ base directory
 * @returns {Promise<{success:boolean,folder:string,renamed:Array<{from:string,to:string}>,prompts:string[]}>}
 */
async function reorderPrompts(folder, newOrder, basePath) {
    const dir = getPromptFolderPath(folder, basePath);
    const requested = (Array.isArray(newOrder) ? newOrder : [])
        .filter(name => typeof name === 'string' && name.trim());
    if (requested.length === 0) {
        throw new Error('reorderPrompts requires a non-empty array of filenames.');
    }
    if (!(await fs.pathExists(dir))) {
        throw new Error(`Prompt folder not found: ${dir}`);
    }

    // Resolve real on-disk names; skip (but never crash on) missing entries.
    const resolved = [];
    for (const name of requested) {
        const real = await resolveExistingFilename(dir, name);
        if (!real) {
            log.warn(`Reorder skipped missing prompt: ${folder}/${name}`);
            continue;
        }
        if (!resolved.includes(real)) resolved.push(real);
    }
    if (resolved.length === 0) {
        throw new Error('None of the supplied prompts exist on disk.');
    }

    // Files that are NOT part of this reorder must never be overwritten.
    const untouched = (await listAllFilenames(dir)).filter(name => !resolved.includes(name));

    const temps = [];
    try {
        // Phase 1: park every listed file under a temporary (ignored) name.
        for (let i = 0; i < resolved.length; i++) {
            const temp = path.join(dir, `${TEMP_PREFIX}${i}__${resolved[i]}`);
            await fs.move(path.join(dir, resolved[i]), temp, { overwrite: true });
            temps.push({ temp, original: resolved[i] });
        }

        // Phase 2: write them back with fresh sequential numbers.
        const taken = new Set(untouched.map(name => name.toLowerCase()));
        const renamed = [];
        for (let i = 0; i < temps.length; i++) {
            const { temp, original } = temps[i];
            const ext = path.extname(original) || '.txt';
            const base = (stripOrderPrefix(path.basename(original, ext)) || FALLBACK_NAME)
                .slice(0, MAX_NAME_LENGTH) || FALLBACK_NAME;
            const number = String(i + 1).padStart(2, '0');
            let finalName = `${number}_${base}${ext}`;
            let suffix = 2;
            while (taken.has(finalName.toLowerCase())) {
                finalName = `${number}_${base}_${suffix}${ext}`;
                suffix += 1;
            }
            taken.add(finalName.toLowerCase());
            await fs.move(temp, path.join(dir, finalName), { overwrite: true });
            renamed.push({ from: original, to: finalName });
        }

        log.info(`Reordered ${renamed.length} prompt(s) in ${folder}/.`);
        return { success: true, folder, renamed, prompts: renamed.map(item => item.to) };
    } catch (error) {
        // Roll back whatever is still parked under a temporary name.
        for (const entry of temps) {
            try {
                if (await fs.pathExists(entry.temp)) {
                    await fs.move(entry.temp, path.join(dir, entry.original), { overwrite: true });
                }
            } catch (rollbackError) {
                log.error(`Rollback failed for ${entry.original}: ${rollbackError.message}`);
            }
        }
        log.error(`Reorder failed for ${folder}/: ${error.message}`);
        throw error;
    }
}

// ============================================================================
// LEGACY SINGLE-FILE FORMAT (deprecated fallback: prompts.txt with "===")
// ============================================================================

/**
 * @deprecated Kept for backwards compatibility with the old prompts.txt flow.
 * New code uses the folder based system (loadPromptsFromFolders).
 *
 * Reads a text file and parses prompts based on a delimiter.
 * @param {string} filePath - Absolute path to the text file.
 * @param {string} delimiter - The separator used between prompts (default: '===')
 * @returns {Promise<Object>} An object containing structure and backend prompts.
 */
async function loadPromptsFromFile(filePath, delimiter = DEFAULT_DELIMITER) {
    try {
        log.info(`Loading prompts from: ${filePath}`);

        if (!(await fs.pathExists(filePath))) {
            throw new Error(`Prompt file not found at path: ${filePath}`);
        }

        const rawContent = decodeBuffer(await fs.readFile(filePath));
        const parsed = rawContent.split(delimiter)
            .map(p => p.trim())
            .filter(p => p.length > 0);

        if (parsed.length < 2) {
            throw new Error('Insufficient prompts. Minimum 2 required for structure generation.');
        }

        // The first 2 prompts are for the AI API, the rest for the VS Code extension
        return {
            structurePrompts: parsed.slice(0, 2),
            extensionPrompts: parsed.slice(2)
        };
    } catch (error) {
        log.error(`Failed to load prompts: ${error.message}`);
        throw error;
    }
}

/**
 * @deprecated Writes prompts back using the legacy '===' delimiter.
 * @param {string} filePath - Absolute path to the text file.
 * @param {string[]} prompts - Array of prompt strings to write.
 * @returns {Promise<boolean>} True on success
 */
async function savePromptsToFile(filePath, prompts) {
    try {
        if (!Array.isArray(prompts) || prompts.length === 0) {
            throw new Error('Nothing to save: prompts array is empty.');
        }
        await fs.outputFile(filePath, prompts.join('\n\n===\n\n'));
        log.info(`Saved ${prompts.length} prompt(s) to: ${filePath}`);
        return true;
    } catch (error) {
        log.error(`Failed to save prompts: ${error.message}`);
        throw error;
    }
}

module.exports = {
    // Folder based system (current)
    PROMPT_FOLDERS,
    ensureFolderStructure,
    getPromptsBasePath,
    loadPromptsFromFolders,
    loadPromptsFromFolder,
    savePromptToFile,
    deletePromptFile,
    reorderPrompts,
    sanitizeFilename,
    detectLanguage,

    // Legacy single-file format (deprecated fallback)
    loadPromptsFromFile,
    savePromptsToFile
};