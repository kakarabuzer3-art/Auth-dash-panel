// Temporary diagnostic: shows WHERE the real keys live (masked - no secrets),
// which config the app actually decrypts, and the effective model per provider.
//
// NOTE: a bare `electron script.js` boots with userData = ...\AppData\Roaming\
// Electron, NOT the app's real store, so the path is pinned explicitly here -
// otherwise every probe silently reads an empty/fresh config.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');
const REAL_USER_DATA = path.join(process.env.APPDATA || '', pkg.name || 'autodash-control-panel');
app.setPath('userData', REAL_USER_DATA);

(async () => {
    const out = { electron: process.versions.electron, node: process.versions.node };
    try {
        out.appName = app.getName();
        out.userData = app.getPath('userData');
        await app.whenReady();
        const Encrypt = require('./src/modules/encryption');
        const mask = (k) => (typeof k === 'string' && k.trim() ? `present(len=${k.trim().length}, tail=...${k.trim().slice(-4)})` : 'EMPTY');

        const providers = Encrypt.getConfig('providers') || {};
        out.providers = {};
        for (const [name, conf] of Object.entries(providers)) {
            const c = conf && typeof conf === 'object' ? conf : {};
            out.providers[name] = {
                apiKey: mask(c.apiKey),
                apiKeys: Array.isArray(c.apiKeys) ? c.apiKeys.map(mask) : [],
                model: c.model || null,
                enabled: !!c.enabled
            };
        }

        // Legacy module the migration path reads ({ gemini:'key', kimi:'key', groq:'key' }).
        let legacy = null;
        try { legacy = Encrypt.getConfig('apiKeys'); } catch (e) { legacy = `ERROR: ${e.message}`; }
        out.legacyApiKeys = legacy && typeof legacy === 'object'
            ? Object.fromEntries(Object.entries(legacy).map(([k, v]) => [k, typeof v === 'string' ? mask(v) : typeof v]))
            : legacy;

        try { out.aiConfigActiveModel = (Encrypt.getConfig('aiConfig') || {}).activeModel || null; } catch (e) { out.aiConfigActiveModel = `ERROR: ${e.message}`; }
        try { out.routing = Encrypt.getConfig('routing') || null; } catch (e) { out.routing = `ERROR: ${e.message}`; }
    } catch (error) {
        out.fatal = String((error && error.stack) || error);
    }
    fs.writeFileSync(path.join(__dirname, 'probe-diag-result.txt'), JSON.stringify(out, null, 2));
    app.quit();
})();
