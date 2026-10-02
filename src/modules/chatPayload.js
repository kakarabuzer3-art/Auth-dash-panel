/**
 * @file chatPayload.js
 * @description Payload normalizer for the Live AI Chat router (main.js
 *              `chat:stream-route`). Written as a pure, dependency-free module
 *              so the EXACT message shaping the router hands to apiManager can
 *              be unit-tested in plain node - no Electron window required.
 *
 *              WHY THIS EXISTS: the renderer sends the current user message as
 *              `prompt` plus the prior turns as `messages`. apiManager.chatStream
 *              reads ONLY `messages` (it maps m.content into every provider's
 *              payload), so without this step the first message of a new chat
 *              reached the router with an empty array and died with the
 *              misleading "No messages to send." - and every later turn would
 *              have answered one message BEHIND the user.
 *
 *              It also repairs two legacy field/role mismatches from the
 *              renderer: the old `text` key (apiManager wants `content`) and the
 *              UI's 'ai' role (Gemini only understands user|model, and the
 *              OpenAI-compatible providers reject unknown roles outright).
 */

// The renderer uses 'ai'; Gemini wants 'model'; OpenAI-compatible APIs want
// 'assistant'. Normalizing here covers all three transports.
const ROLE_MAP = {
    assistant: 'assistant',
    ai: 'assistant',
    model: 'assistant',
    system: 'system',
    user: 'user'
};

/**
 * Flatten IPC attachments into one text block. The renderer sends
 * [{ name, content }] (typed file + web-search results); apiManager never sees
 * them otherwise - before this existed, `payload.attachments` was silently
 * ignored by the router, so attached files and web context never reached the
 * model at all.
 * @param {Array<{name?:string, content?:string, text?:string}>} attachments
 * @returns {string} '' when there is nothing usable.
 */
function formatAttachments(attachments) {
    if (!Array.isArray(attachments)) return '';
    return attachments
        .map((a) => {
            const src = a && typeof a === 'object' ? a : {};
            const name = String(src.name || 'attachment.txt');
            const value = src.content !== undefined && src.content !== null ? src.content : src.text;
            const body = String(value === undefined || value === null ? '' : value);
            return body.trim() ? `--- ${name} ---\n${body}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Turn a raw chat:stream-route payload into the canonical message array.
 * @param {object} payload - { prompt?, messages?, attachments? } from IPC.
 * @returns {Array<{role:'user'|'assistant'|'system', content:string}>}
 */
function normalizeChatMessages(payload) {
    const p = payload || {};
    const raw = Array.isArray(p.messages) ? p.messages : [];
    const messages = raw
        .map((m) => {
            const src = m && typeof m === 'object' ? m : {};
            const value = src.content !== undefined && src.content !== null ? src.content : src.text;
            return {
                role: ROLE_MAP[src.role] || 'user',
                content: String(value === undefined || value === null ? '' : value)
            };
        })
        .filter((m) => m.content.trim().length > 0);

    const prompt = p.prompt === undefined || p.prompt === null ? '' : String(p.prompt).trim();
    const last = messages[messages.length - 1];
    // Version-agnostic: the NEW renderer already ships the live question inside
    // `messages`, the OLD one sent it only as `prompt`. Append only when it is
    // not there yet, otherwise the user's message would be duplicated.
    const promptAlreadySent = !!prompt && !!last && last.role === 'user' && last.content.trim() === prompt;
    if (prompt && !promptAlreadySent) messages.push({ role: 'user', content: prompt });

    const attachmentText = formatAttachments(p.attachments);
    if (!messages.length) {
        // Attachments with no typed text still deserve an answer instead of the
        // misleading "No messages to send."
        return attachmentText ? [{ role: 'user', content: attachmentText }] : messages;
    }

    // Attach context to the FINAL user turn and keep the live question last -
    // the model then reads instructions first and the actual ask last.
    if (attachmentText) {
        let idx = messages.length - 1;
        while (idx >= 0 && messages[idx].role !== 'user') idx -= 1;
        if (idx < 0) messages.push({ role: 'user', content: attachmentText });
        else messages[idx] = { ...messages[idx], content: `${attachmentText}\n\n${messages[idx].content}` };
    }
    return messages;
}

module.exports = { normalizeChatMessages, formatAttachments, ROLE_MAP };

