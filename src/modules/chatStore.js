/**
 * @file chatStore.js
 * @description Persistent storage for Live AI Chat sessions.
 *              Sessions are kept in runs/chats.json (same folder/pattern as
 *              runs/errors.json and runs/usage.json) so a user can close the
 *              app, come back later, reload an old conversation and continue
 *              it exactly where it stopped — or delete it.
 */

const fs = require('fs-extra');
const path = require('path');
const log = require('./logger');

const CHATS_FILE = path.resolve(__dirname, '../../runs/chats.json');
const MAX_SESSIONS = 100;          // hard cap so the file can never grow unbounded
const MAX_MESSAGES_PER_SESSION = 500;
const MAX_CONTENT_CHARS = 20000;   // per-message safety cap (file size guard)

/** Reads the whole chats file. Never throws — a corrupt file starts fresh. */
function readAll() {
    try {
        if (!fs.existsSync(CHATS_FILE)) return { sessions: [] };
        const raw = fs.readFileSync(CHATS_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.sessions)) return { sessions: [] };
        return data;
    } catch (error) {
        log.warn(`chatStore: could not read chats.json (${error.message}) — starting with an empty list.`);
        return { sessions: [] };
    }
}

/** Writes the whole chats file atomically-ish (tmp + rename). Never throws. */
function writeAll(data) {
    try {
        fs.ensureDirSync(path.dirname(CHATS_FILE));
        const tmp = CHATS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        fs.renameSync(tmp, CHATS_FILE);
        return true;
    } catch (error) {
        log.error(`chatStore: could not write chats.json: ${error.message}`);
        return false;
    }
}

/** Sanitizes one message for storage (size caps, plain fields only). */
function cleanMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = String(m.content || '').slice(0, MAX_CONTENT_CHARS);
    if (!content.trim()) return null;
    const clean = { role, content };
    if (m.meta && typeof m.meta === 'object') {
        // Keep only small, serializable meta fields (provider/model/notes).
        const meta = {};
        for (const k of ['provider', 'model', 'switched', 'routeNote']) {
            if (m.meta[k] !== undefined) meta[k] = typeof m.meta[k] === 'string' ? m.meta[k].slice(0, 300) : !!m.meta[k];
        }
        if (Object.keys(meta).length) clean.meta = meta;
    }
    return clean;
}

/** Builds a short human title from the first user message. */
function deriveTitle(messages) {
    const firstUser = (messages || []).find(m => m && m.role === 'user' && m.content);
    if (!firstUser) return 'New chat';
    const t = String(firstUser.content).replace(/\s+/g, ' ').trim();
    return t.length > 48 ? t.slice(0, 48) + '…' : t;
}

module.exports = {
    CHATS_FILE,

    /**
     * Lists sessions newest-first, WITHOUT message bodies (fast sidebar load).
     * @returns {Array<{id,title,createdAt,updatedAt,messageCount,preview}>}
     */
    list() {
        const { sessions } = readAll();
        return sessions
            .slice()
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .map(s => ({
                id: s.id,
                title: s.title || 'New chat',
                createdAt: s.createdAt || null,
                updatedAt: s.updatedAt || null,
                messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
                preview: Array.isArray(s.messages) && s.messages.length
                    ? String(s.messages[s.messages.length - 1].content || '').replace(/\s+/g, ' ').slice(0, 80)
                    : '',
            }));
    },

    /**
     * Returns ONE full session (with messages) or null.
     */
    get(id) {
        const { sessions } = readAll();
        return sessions.find(s => s && s.id === id) || null;
    },

    /**
     * Creates or updates a session. `session` = { id?, title?, messages, provider?, model? }
     * Existing sessions keep their createdAt; title auto-derives from the first
     * user message when not given. Returns the stored session (or null on failure).
     */
    upsert(session) {
        if (!session || typeof session !== 'object') return null;
        const data = readAll();
        const now = Date.now();
        const messages = (Array.isArray(session.messages) ? session.messages : [])
            .map(cleanMessage)
            .filter(Boolean)
            .slice(-MAX_MESSAGES_PER_SESSION);
        const id = session.id || `chat_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        const idx = data.sessions.findIndex(s => s && s.id === id);
        const prev = idx >= 0 ? data.sessions[idx] : null;
        const stored = {
            id,
            title: String(session.title || (prev && prev.title) || deriveTitle(messages)),
            messages,
            provider: session.provider || (prev && prev.provider) || '',
            model: session.model || (prev && prev.model) || '',
            createdAt: (prev && prev.createdAt) || now,
            updatedAt: now,
        };
        if (idx >= 0) data.sessions[idx] = stored;
        else data.sessions.push(stored);
        // Newest-first cap: drop the oldest sessions beyond MAX_SESSIONS.
        data.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        data.sessions = data.sessions.slice(0, MAX_SESSIONS);
        return writeAll(data) ? stored : null;
    },

    /**
     * Deletes one session by id. Returns true when something was removed.
     */
    remove(id) {
        const data = readAll();
        const before = data.sessions.length;
        data.sessions = data.sessions.filter(s => s && s.id !== id);
        if (data.sessions.length === before) return false;
        return writeAll(data);
    },
};
