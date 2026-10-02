/**
 * @file encryption.js
 * @description Secures sensitive configurations (API keys) using AES-256 native Node crypto.
 */

const crypto = require('crypto');
const Store = require('electron-store');
const log = require('./logger');

const store = new Store();
const ALGORITHM = 'aes-256-ctr';
const SALT_STORE_KEY = '__security.salt';

// Fix 8: single source of truth for default settings. Every key used by the
// app is declared here; stored (encrypted) user config is merged on top.
const DEFAULT_CONFIG = require('../config/default-config.json');

/**
 * Model names that have been retired upstream, mapped to their replacements.
 *
 * Why this exists: getConfig() merges STORED values OVER the defaults, so an
 * installation that once saved a model which has since been retired would keep
 * using it (and keep getting 404s) even after default-config.json is updated.
 * upgradeDeprecatedModels() rewrites such stored values on read, once.
 */
const DEPRECATED_MODELS = {
    'gemini-pro': 'gemini-3.6-flash',
    'gemini-1.5-flash': 'gemini-3.6-flash',
    'gemini-1.5-pro': 'gemini-3.6-flash',
    'gemini-2.0-flash': 'gemini-3.6-flash',
    'gemini-2.0-flash-001': 'gemini-3.6-flash',
    'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
    'gemini-2.5-flash': 'gemini-3.6-flash',
    'gemini-2.5-pro': 'gemini-3.6-flash',
    // Retired upstream 2026 (404 "no longer available to new users") - Google
    // itself names gemini-3.5-flash-lite as the replacement.
    'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
    'gemini-2.5-flash-preview-09-2025': 'gemini-3.6-flash',
    // Never existed on the API (404 not found) - a hallucinated id.
    'gemini-3-flash': 'gemini-3.6-flash'
};

/**
 * Deep-merges user overrides onto a deep-cloned defaults object.
 * Arrays are replaced wholesale; nested plain objects are merged recursively.
 * Always returns fresh objects so callers can safely mutate the result.
 */
function deepMerge(defaults, overrides) {
    const result = (defaults && typeof defaults === 'object' && !Array.isArray(defaults))
        ? { ...defaults }
        : {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return result;
    }
    for (const key of Object.keys(overrides)) {
        const dVal = result[key];
        const oVal = overrides[key];
        const bothPlainObjects = dVal && oVal
            && typeof dVal === 'object' && !Array.isArray(dVal)
            && typeof oVal === 'object' && !Array.isArray(oVal);
        result[key] = bothPlainObjects ? deepMerge(dVal, oVal) : oVal;
    }
    return result;
}

/**
 * Returns a fresh deep clone of the defaults for a module (or null if the
 * module has no declared defaults), so callers never mutate shared state.
 */
function getDefaultsFor(moduleName) {
    const defaults = DEFAULT_CONFIG[moduleName];
    return defaults ? JSON.parse(JSON.stringify(defaults)) : null;
}

// ----------------------------------------------------------------------------
// MASTER PASSWORD RESOLUTION (Fix: replaces the old hardcoded-key approach)
// ----------------------------------------------------------------------------
// Resolution order:
//   1. AUTODASH_MASTER_PASSWORD environment variable (explicit user control).
//   2. An OS-protected master password: on first use a random password is
//      generated, encrypted with Electron safeStorage (DPAPI on Windows /
//      Keychain on macOS / libsecret on Linux) and persisted in the store.
//      This means API keys are protected by the OS user account, not by a
//      compiled-in secret.
//   3. PLACEHOLDER fallback: only if safeStorage is unavailable (e.g. running
//      under plain Node in tests). A prominent warning is logged.
// Production TODO (optional hardening): replace (2) with an explicit
// user-chosen master password prompt on first run.
// Note: configs encrypted under a different password fail to decrypt — that
// is expected and signals the password changed.
// ----------------------------------------------------------------------------
const PLACEHOLDER_MASTER_PASSWORD = 'AutoDashMasterPasswordFallback';
const MASTER_STORE_KEY = '__security.master';

let cachedKey = null;
let activeSource = null;              // 'env' | 'os' | 'placeholder' - the source that really opens the store
const keyCache = new Map();           // password -> derived AES key
const decryptFailures = new Set();    // modules that could not be decrypted with ANY candidate

/**
 * Every password we are allowed to try, most trustworthy first.
 *
 * Why this exists: getMasterPassword() silently falls back to the PLACEHOLDER
 * password whenever safeStorage is momentarily unavailable. Any data written in
 * such a session becomes unreadable afterwards - and because getConfig() used to
 * swallow the error, the UI just showed "no keys" while the next save overwrote
 * them under a different key. Trying every candidate makes reads self-healing.
 */
function candidatePasswords() {
    const out = [];
    const seen = new Set();
    const add = (source, password) => {
        if (!password || seen.has(password)) return;
        seen.add(password);
        out.push({ source, password });
    };
    add('env', process.env.AUTODASH_MASTER_PASSWORD);
    add('os', getOsProtectedPassword());
    add('placeholder', PLACEHOLDER_MASTER_PASSWORD);
    return out;
}

/** Derived-key cache (scrypt is expensive; the same password is reused a lot). */
function keyForPassword(password) {
    if (!keyCache.has(password)) keyCache.set(password, crypto.scryptSync(password, getSalt(), 32));
    return keyCache.get(password);
}

function decryptWith(password, data) {
    const decipher = crypto.createDecipheriv(ALGORITHM, keyForPassword(password), Buffer.from(data.iv, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(data.content, 'hex')), decipher.final()]);
    return JSON.parse(decrypted.toString());
}

/**
 * Decrypts a stored entry with whichever candidate password actually works.
 * Returns { ok:false } instead of throwing so callers can protect the data.
 */
function decryptEntryAuto(data) {
    if (!data || !data.iv || !data.content) return { ok: false };
    const candidates = candidatePasswords();
    if (activeSource) {
        const preferred = candidates.find(c => c.source === activeSource);
        if (preferred) {
            try {
                return { ok: true, value: decryptWith(preferred.password, data), source: preferred.source };
            } catch (e) {
                log.warn(`The "${preferred.source}" key no longer decrypts the store - re-detecting the key source.`);
                activeSource = null;
            }
        }
    }
    for (const cand of candidates) {
        try {
            const value = decryptWith(cand.password, data);
            if (!activeSource) {
                activeSource = cand.source;
                log.info(`Config store unlocked with the "${cand.source}" key source.`);
            }
            return { ok: true, value, source: cand.source };
        } catch (e) { /* try the next candidate */ }
    }
    return { ok: false };
}

/**
 * Resolves (or creates) an OS-protected master password via Electron
 * safeStorage. Returns null when unavailable (plain Node / unsupported OS).
 */
function getOsProtectedPassword() {
    try {
        const { safeStorage } = require('electron');
        if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
            return null;
        }
        const stored = store.get(MASTER_STORE_KEY);
        if (stored) {
            return safeStorage.decryptString(Buffer.from(stored, 'base64'));
        }
        // First run under safeStorage: generate a strong random master password
        const generated = crypto.randomBytes(32).toString('hex');
        store.set(MASTER_STORE_KEY, safeStorage.encryptString(generated).toString('base64'));
        log.info('Generated an OS-protected master password (Electron safeStorage) and persisted it.');
        return generated;
    } catch (err) {
        // require('electron') outside the main process returns a string, not the module
        return null;
    }
}

/**
 * Resolves the master password: env var first, then OS-protected storage,
 * then the documented placeholder fallback.
 */
function getMasterPassword() {
    // Prefer the source that actually opened the store, so writes always use the
    // same key material as the reads (no silent key-material flips -> no data
    // that "disappears" on the next launch).
    const cands = candidatePasswords();
    const chosen = cands.find(c => c.source === activeSource) || cands[0];
    if (chosen && chosen.source !== 'placeholder') return chosen.password;

    const fromEnv = process.env.AUTODASH_MASTER_PASSWORD;
    if (fromEnv) return fromEnv;

    const fromOs = getOsProtectedPassword();
    if (fromOs) return fromOs;

    log.warn('SECURITY: no AUTODASH_MASTER_PASSWORD and safeStorage unavailable — using the built-in PLACEHOLDER master password. Set the environment variable before production use.');
    return PLACEHOLDER_MASTER_PASSWORD;
}

/**
 * Returns a per-installation random salt. It is generated once on first use
 * and persisted in the store; previously the salt was the hardcoded 'salt'
 * string, which undermined the KDF.
 */
function getSalt() {
    let salt = store.get(SALT_STORE_KEY);
    if (!salt) {
        salt = crypto.randomBytes(16).toString('hex');
        store.set(SALT_STORE_KEY, salt);
        log.info('Generated and persisted a new per-installation KDF salt.');
    }
    return Buffer.from(salt, 'hex');
}

/**
 * Lazily derives the AES-256 key (scrypt, N=16384 defaults) from the resolved
 * master password and the persisted per-install salt.
 */
function getEncryptionKey() {
    // Deliberately NOT cached across calls: activeSource is re-detected when the
    // store is first read, and a stale cached key would silently write with the
    // wrong password - the original cause of "my API keys disappeared".
    return crypto.scryptSync(getMasterPassword(), getSalt(), 32);
}

/**
 * Decrypts a stored {iv, content} hex entry and returns the parsed object.
 */
function decryptEntry(data) {
    const attempt = decryptEntryAuto(data);
    if (!attempt.ok) throw new Error('Could not decrypt the stored entry with any known key source.');
    return attempt.value;
}

/**
 * Migration (multi-provider upgrade): converts the legacy flat 'apiKeys'
 * module {gemini, kimi, groq} to the new 'providers' module on first read.
 * The legacy encrypted entry is PRESERVED untouched (no data loss), and the
 * migrated 'providers' module is persisted so this runs only once.
 * @returns {Object} Merged providers config (defaults + legacy keys)
 */
function migrateProvidersConfig() {
    try {
        const providers = getDefaultsFor('providers') || {};
        const legacyRaw = store.get('apiKeys');
        if (legacyRaw) {
            const legacy = decryptEntry(legacyRaw);
            let migrated = false;
            for (const name of ['gemini', 'kimi', 'groq']) {
                if (legacy && typeof legacy[name] === 'string' && legacy[name]) {
                    providers[name] = { ...(providers[name] || {}), apiKey: legacy[name] };
                    migrated = true;
                }
            }
            if (migrated) {
                store.set('providers', encryptEntry(providers));
                log.info('Migrated legacy apiKeys config to the new providers format (legacy entry preserved).');
            }
        }
        return providers;
    } catch (error) {
        log.error(`Providers migration failed: ${error.message}`);
        return getDefaultsFor('providers');
    }
}

/**
 * Upgrades provider model names that have been retired upstream (see
 * DEPRECATED_MODELS). The repaired config is persisted so the upgrade runs
 * only once. Never throws: a persistence failure must not break config reads.
 * @param {Object} providers - The merged providers config (mutated in place)
 * @returns {Object} The same providers object, with retired models replaced
 */
function upgradeDeprecatedModels(providers) {
    if (!providers || typeof providers !== 'object') return providers;
    let changed = false;
    for (const name of Object.keys(providers)) {
        const conf = providers[name];
        if (!conf || typeof conf !== 'object' || typeof conf.model !== 'string') continue;
        const replacement = DEPRECATED_MODELS[conf.model];
        if (replacement) {
            log.warn(`Provider "${name}" was pinned to the retired model "${conf.model}" - upgraded to "${replacement}".`);
            conf.model = replacement;
            changed = true;
        }
    }
    if (changed) {
        try {
            store.set('providers', encryptEntry(providers));
            log.info('Persisted upgraded provider models to encrypted config.');
        } catch (error) {
            log.error(`Failed to persist upgraded provider models: ${error.message}`);
        }
    }
    return providers;
}

/**
 * Encrypts data with a fresh random IV and returns the {iv, content} hex
 * entry stored by electron-store.
 */
function encryptEntry(data) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
    const text = JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return { iv: iv.toString('hex'), content: encrypted.toString('hex') };
}

module.exports = {
    /**
     * Encrypts and saves config data.
     * @param {string} moduleName - The settings category (e.g., 'apiKeys')
     * @param {Object} data - Unencrypted JSON data
     */
    saveConfig(moduleName, data) {
        try {
            // SAFETY (2026-09-23): never overwrite data we cannot read. If the
            // stored entry cannot be decrypted with any known key source, keep a
            // recoverable copy first instead of silently destroying keys.
            try {
                const existing = store.get(moduleName);
                if (existing) {
                    const attempt = decryptEntryAuto(existing);
                    if (attempt.ok) {
                        if (!activeSource) activeSource = attempt.source;
                    } else {
                        const backupKey = `__backup.${moduleName}.${Date.now()}`;
                        store.set(backupKey, existing);
                        decryptFailures.add(moduleName);
                        log.error(`Stored "${moduleName}" could not be decrypted with any known key source - a copy was kept at "${backupKey}" before overwriting.`);
                    }
                }
            } catch (guardErr) {
                log.error(`Pre-save safety check failed for ${moduleName}: ${guardErr.message}`);
            }

            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
            
            const text = JSON.stringify(data);
            const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
            
            store.set(moduleName, {
                iv: iv.toString('hex'),
                content: encrypted.toString('hex')
            });
            log.info(`Config saved and encrypted for module: ${moduleName}`);
        } catch (error) {
            log.error(`Encryption failed for ${moduleName}:`, error);
            throw error;
        }
    },

    /**
     * Retrieves and decrypts config data, merged over the declared defaults
     * from src/config/default-config.json (Fix 8). Missing user keys are
     * filled from defaults; user values always win.
     * @param {string} moduleName 
     * @returns {Object|null} Decrypted, defaults-merged JSON data
     */
    getConfig(moduleName) {
        try {
            const data = store.get(moduleName);
            if (!data) {
                // Multi-provider upgrade: migrate the legacy apiKeys module on
                // the first read of the new 'providers' module.
                if (moduleName === 'providers') return migrateProvidersConfig();
                return getDefaultsFor(moduleName);
            }

            const attempt = decryptEntryAuto(data);
            if (!attempt.ok) {
                decryptFailures.add(moduleName);
                log.error(`Config "${moduleName}" could not be decrypted with any known key source - returning defaults and keeping the stored data protected.`);
                return getDefaultsFor(moduleName);
            }
            decryptFailures.delete(moduleName);
            const stored = attempt.value;
            const merged = deepMerge(getDefaultsFor(moduleName) || {}, stored);
            // Retired model names must not survive in a stored 'providers'
            // config, otherwise the stored (deprecated) value would win over
            // the new default and every API call would keep returning 404.
            if (moduleName === 'providers') return upgradeDeprecatedModels(merged);
            return merged;
        } catch (error) {
            log.error(`Decryption failed for ${moduleName}:`, error);
            return getDefaultsFor(moduleName);
        }
    },

    /**
     * Returns the raw defaults declared in default-config.json for a module.
     * @param {string} moduleName
     * @returns {Object|null} Deep-cloned defaults
     */
    getDefaults(moduleName) {
        return getDefaultsFor(moduleName);
    },

    /**
     * Storage safety diagnostics for the UI (ApiKeys banner): which key source
     * opened the store, whether safeStorage is usable, and which modules could
     * not be decrypted (their data is protected from being overwritten).
     */
    configHealth() {
        const info = {
            activeSource: activeSource || 'not-read-yet',
            envPasswordSet: !!process.env.AUTODASH_MASTER_PASSWORD,
            safeStorageAvailable: false,
            decryptFailures: Array.from(decryptFailures),
        };
        try {
            const { safeStorage } = require('electron');
            info.safeStorageAvailable = !!(safeStorage
                && typeof safeStorage.isEncryptionAvailable === 'function'
                && safeStorage.isEncryptionAvailable());
        } catch (e) { info.safeStorageAvailable = false; }
        return info;
    }
};