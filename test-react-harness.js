// Temporary verification harness: loads the React UI in a hidden BrowserWindow,
// clicks through every sidebar view, and records any console errors/warnings.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const RESULT = path.join(__dirname, 'ui-harness-result.txt');
const VIEWS = ['Dashboard', 'Scheduler', 'API Keys', 'AI Chat', 'AI Settings', 'Prompts', 'VS Code', 'Logs', 'Settings'];
const problems = {};

function record(view, type, text) {
    if (!problems[view]) problems[view] = [];
    problems[view].push(`${type}: ${text}`.slice(0, 300));
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        show: false, width: 1400, height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true, nodeIntegration: false, sandbox: true,
        },
    });

    let currentView = 'boot';
    win.webContents.on('console-message', (e, level, message) => {
        // level: 0 verbose, 1 info, 2 warning, 3 error
        if (level >= 2) record(currentView, level === 3 ? 'error' : 'warning', message);
    });
    win.webContents.on('render-process-gone', (e, details) => record(currentView, 'crash', JSON.stringify(details)));
    win.webContents.on('unresponsive', () => record(currentView, 'hang', 'renderer unresponsive'));

    await win.loadFile(path.join(__dirname, 'src/renderer/react/index.html'));
    await new Promise(r => setTimeout(r, 4000));

    for (const view of VIEWS) {
        currentView = view;
        const clicked = await win.webContents.executeJavaScript(`(() => {
            const btns = [...document.querySelectorAll('button, [role="button"], nav *')];
            const b = btns.find(el => el.textContent && el.textContent.trim() === ${JSON.stringify(view)});
            if (!b) return false;
            b.click();
            return true;
        })()`);
        if (!clicked) record(view, 'nav', `sidebar button "${view}" not found`);
        await new Promise(r => setTimeout(r, 1500));
        // black-screen / error-text check
        const state = await win.webContents.executeJavaScript(`(() => ({
            bodyText: (document.body.innerText || '').length,
            hasErrorText: /something went wrong|cannot read|undefined is not/i.test(document.body.innerText || ''),
        }))()`);
        if (!state.bodyText) record(view, 'render', 'view rendered empty (black screen)');
        if (state.hasErrorText) record(view, 'render', 'error text visible in view');
    }

    fs.writeFileSync(RESULT, JSON.stringify(problems, null, 2));
    app.quit();
}).catch(err => {
    fs.writeFileSync(RESULT, JSON.stringify({ fatal: String(err && err.stack || err) }));
    app.quit();
});
