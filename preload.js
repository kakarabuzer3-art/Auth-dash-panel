/**
 * @file preload.js
 * @description Context Bridge to safely expose Main process APIs to the Renderer (UI).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Config Management
    getConfig: (moduleName) => ipcRenderer.invoke('config:get', moduleName),
    saveConfig: (moduleName, data) => ipcRenderer.invoke('config:save', { moduleName, data }),
    // Storage safety: reveals the key source in use + write-protected modules
    configHealth: () => ipcRenderer.invoke('config:health'),

    // Prompts file management
    readPrompts: (filePath) => ipcRenderer.invoke('prompts:read', filePath),
    savePrompts: (filePath, prompts) => ipcRenderer.invoke('prompts:save', { filePath, prompts }),
    savePromptFile: (payload) => ipcRenderer.invoke('savePromptFile', payload),

    // Prompts folder management (ordered multi-language prompt system)
    readPromptFolders: () => ipcRenderer.invoke('prompts:readFolders'),
    saveOnePrompt: (folder, filename, content) => ipcRenderer.invoke('prompts:saveOne', { folder, filename, content }),
    deleteOnePrompt: (folder, filename) => ipcRenderer.invoke('prompts:deleteOne', { folder, filename }),
    reorderPrompts: (folder, newOrder) => ipcRenderer.invoke('prompts:reorder', { folder, newOrder }),
    retryOnePrompt: (folder, filename) => ipcRenderer.invoke('prompts:retryOne', { folder, filename }),
    detectPromptLanguage: (text) => ipcRenderer.invoke('prompts:detectLanguage', text),
    openPromptFolderInExplorer: (folder) => ipcRenderer.invoke('prompts:openInExplorer', folder),

    // Feature bridges: cost tracker, file tree viewer, retry single prompt
    getCosts: () => ipcRenderer.invoke('costs:get'),
    // FEATURE: run history read-back for Dashboard KPIs (scheduler writes runs/history.json)
    getRunHistory: () => ipcRenderer.invoke('runs:history'),
    listOutputFiles: () => ipcRenderer.invoke('files:listTree'),
    readOutputFile: (relPath) => ipcRenderer.invoke('files:readFile', relPath),
    openOutputFile: (relPath) => ipcRenderer.invoke('files:open', relPath),
    // XAMPP: status (ports/htdocs) + manual "deploy & connect" (validate ->
    // start Apache/MySQL -> deploy -> import schema.sql -> live health check)
    getXamppStatus: () => ipcRenderer.invoke('xampp:status'),
    deployToXampp: () => ipcRenderer.invoke('xampp:deploy'),
    runSinglePrompt: (folder, filename) => ipcRenderer.invoke('prompts:runOne', { folder, filename }),

        // OS notifications
    notify: (title, message, actions) => ipcRenderer.invoke('system:notify', { title, message, actions }),
    // Every on* helper registers its OWN wrapper and returns an unsubscribe
    // for JUST that handler. NEVER call removeAllListeners(channel) from a
    // component cleanup - it silently kills the shared subscriptions owned by
    // AppContext (that was the "dashboard logs vanish after switching views"
    // bug: Logs.jsx nuked the global log:new / api:stream / errors:new listeners).
    onNotifyAction: (callback) => { const h = (e, payload) => callback(payload); ipcRenderer.on('system:notify:action', h); return () => ipcRenderer.removeListener('system:notify:action', h); },

    // Native dialogs
    openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
    // Alias (Fix 11): same native picker under the generic name
    browseFile: (options) => ipcRenderer.invoke('dialog:browse', options),
    // Open a URL in the user's default browser (Dashboard / phpMyAdmin links).
    openUrl: (url) => ipcRenderer.invoke('system:openUrl', url),
    // Read an absolute path as text (chat attachments; capped at 1 MB)
    readTextFile: (absPath) => ipcRenderer.invoke('files:readText', absPath),
    
    // Automation Controls
    startAutomation: (payload) => ipcRenderer.invoke('automation:start', payload),
    stopAutomation: () => ipcRenderer.invoke('automation:stop'),
    pauseAutomation: () => ipcRenderer.invoke('automation:pause'),
    resumeAutomation: () => ipcRenderer.invoke('automation:resume'),
    approveNextPrompt: (approvalId) => ipcRenderer.invoke('automation:approve-next', approvalId),
    declineNextPrompt: (approvalId) => ipcRenderer.invoke('automation:decline-next', approvalId),
    getPendingApproval: () => ipcRenderer.invoke('automation:pending-approval'),
    forceRunAutomation: () => ipcRenderer.invoke('automation:force-run'),
    reloadSchedule: () => ipcRenderer.invoke('scheduler:reload'),
    
        // Test Connections
    testApiConnection: (provider, key) => ipcRenderer.invoke('api:test', { provider, key }),
    fetchModels: (provider) => ipcRenderer.invoke('api:fetch-models', provider),
    testClineConnection: () => ipcRenderer.invoke('cline:test'),

    // Live streaming chat
    chatStream: (payload) => ipcRenderer.invoke('chat:stream', payload),
    onChatStream: (callback) => { const h = (e, data) => callback(data); ipcRenderer.on('chat:stream', h); return () => ipcRenderer.removeListener('chat:stream', h); },
    // Agentic chat tools (live): web search + code interpreter
    webSearch: (query) => ipcRenderer.invoke('web:search', query),
    runCode: (code) => ipcRenderer.invoke('code:run', code),
    // Smart failover chat: auto-switches provider/key/model on quota errors
    chatStreamRoute: (payload) => ipcRenderer.invoke('chat:stream-route', payload),
    // --- Skills (prompt modules) + MCP tool servers (2026-09-29) -------------
    // Skills compose the effective system prompt (persona + SEO/honesty/... rules);
    // MCP servers are local tool processes the chat can really execute with
    // `/tool <name> {json}`.
    listSkills: () => ipcRenderer.invoke('skills:list'),
    saveSkill: (skill) => ipcRenderer.invoke('skills:save', skill),
    deleteSkill: (id) => ipcRenderer.invoke('skills:delete', id),
    setSkillState: (id, patch) => ipcRenderer.invoke('skills:setState', { id, patch }),
    previewSystemPrompt: (target) => ipcRenderer.invoke('skills:preview', target),
    getRecommendedPrompt: () => ipcRenderer.invoke('skills:recommended'),
    getMcpStatus: () => ipcRenderer.invoke('mcp:status'),
    saveMcpServer: (server) => ipcRenderer.invoke('mcp:saveServer', server),
    deleteMcpServer: (id) => ipcRenderer.invoke('mcp:deleteServer', id),
    startMcpServer: (id) => ipcRenderer.invoke('mcp:start', id),
    stopMcpServer: (id) => ipcRenderer.invoke('mcp:stop', id),
    callMcpTool: (server, tool, args) => ipcRenderer.invoke('mcp:call', { server, tool, args }),
    getExampleMcpServer: () => ipcRenderer.invoke('mcp:example'),
    connectAllMcpServers: () => ipcRenderer.invoke('mcp:connectAll'),
    // Main-process broadcast of live MCP status (after seeding/auto-connect).
    onMcpStatus: (cb) => {
        const handler = (_e, data) => cb(data);
        ipcRenderer.on('mcp:status', handler);
        return () => ipcRenderer.removeListener('mcp:status', handler);
    },
    // Persistent chat sessions (save / load / delete conversations)
    listChatSessions: () => ipcRenderer.invoke('chats:list'),
    getChatSession: (id) => ipcRenderer.invoke('chats:get', id),
    saveChatSession: (session) => ipcRenderer.invoke('chats:upsert', session),
    deleteChatSession: (id) => ipcRenderer.invoke('chats:delete', id),
    // Voice input: speech-to-text via Groq Whisper / Gemini native audio
    transcribeAudio: (payload) => ipcRenderer.invoke('ai:transcribe', payload),
    // Key health: model listing only (consumes no generation quota)
    probeKey: (provider, key) => ipcRenderer.invoke('api:probe-key', { provider, key }),
    // FEATURE B: live AI token chunks from the router (ApiManager.StreamBus -> api:stream)
    onApiStream: (callback) => { const h = (e, chunk) => callback(chunk); ipcRenderer.on('api:stream', h); return () => ipcRenderer.removeListener('api:stream', h); },
    // FEATURE 3: Online/Offline status detection
    checkOnline: () => ipcRenderer.invoke('system:checkOnline'),

    
    // Logs > Error Center (persisted in runs/errors.json by the main process)
    listErrors: (filter) => ipcRenderer.invoke('errors:list', filter),
    saveError: (entry) => ipcRenderer.invoke('errors:save', entry),
    clearErrors: () => ipcRenderer.invoke('errors:clear'),
    resolveError: (id) => ipcRenderer.invoke('errors:resolve', id),
    exportErrors: (format) => ipcRenderer.invoke('errors:export', format),
    getErrorCatalog: () => ipcRenderer.invoke('errors:catalog'),
    onErrorNew: (callback) => { const h = (e, entry) => callback(entry); ipcRenderer.on('errors:new', h); return () => ipcRenderer.removeListener('errors:new', h); },

    // Logging stream (UI listens to these)
    onLogUpdate: (callback) => { const h = (e, logData) => callback(logData); ipcRenderer.on('log:new', h); return () => ipcRenderer.removeListener('log:new', h); },
    onStatusUpdate: (callback) => { const h = (e, status) => callback(status); ipcRenderer.on('automation:status', h); return () => ipcRenderer.removeListener('automation:status', h); },
    
    // Cleanup listeners to prevent memory leaks
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});