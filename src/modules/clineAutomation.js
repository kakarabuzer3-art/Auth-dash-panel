/**
 * @file clineAutomation.js
 * @description UI automation layer to control VS Code and interact with the Cline extension.
 */

const { keyboard, Key, sleep, screen } = require('@nut-tree-fork/nut-js');
const { exec } = require('child_process');
const Encrypt = require('./encryption');
const log = require('./logger');

// Fix 6: top-level CommonJS require. NOTE: clipboardy is pinned to ^2.4.0 in
// package.json because v4+ is ESM-only and cannot be require()'d in Electron 29.
const clipboardy = require('clipboardy');

// Default typing speed; always overridden per-call BEFORE any typing happens.
const DEFAULT_TYPING_SPEED_MS = 50;
const DEFAULT_OPEN_SHORTCUT = 'ctrl+shift+p';

/**
 * Promisified child_process.exec with error capture (the raw callback
 * previously threw inside an async callback, which was silently lost).
 */
function execAsync(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) return reject(new Error(`Failed to execute "${command}": ${error.message}`));
            resolve(stdout);
        });
    });
}

/**
 * Fix 6: runs each automation step inside its own try/catch so a failure is
 * logged with the step name (which step died) before being rethrown.
 */
async function step(name, fn) {
    try {
        return await fn();
    } catch (error) {
        log.error(`Cline automation step failed [${name}]: ${error.message}`);
        throw error;
    }
}

/**
 * Maps a shortcut string like "ctrl+shift+p" / "cmd+shift+p" to nut-js keys.
 * @param {string} shortcut - e.g. "ctrl+shift+p"
 * @returns {{modifiers: Key[], finalKey: Key}} Parsed shortcut
 */
function parseShortcut(shortcut) {
    const MODIFIERS = {
        ctrl: Key.LeftControl,
        control: Key.LeftControl,
        shift: Key.LeftShift,
        alt: Key.LeftAlt,
        option: Key.LeftAlt,
        cmd: Key.LeftCmd,
        command: Key.LeftCmd,
        super: Key.LeftSuper,
        win: Key.LeftSuper
    };

    const tokens = String(shortcut || DEFAULT_OPEN_SHORTCUT).toLowerCase().split('+').map(t => t.trim()).filter(Boolean);
    const modifiers = [];
    let finalKey = null;

    for (const token of tokens) {
        if (MODIFIERS[token]) {
            modifiers.push(MODIFIERS[token]);
        } else if (token.length === 1) {
            const letterKey = Key[token.toUpperCase()];
            finalKey = letterKey || null;
            if (!finalKey) log.warn(`Unsupported key token "${token}" in shortcut; will type it instead.`);
        } else if (Key[token]) {
            finalKey = Key[token];
        } else {
            log.warn(`Unknown key token "${token}" in shortcut "${shortcut}".`);
        }
    }

    // Fallback to the platform default if parsing produced nothing usable
    if (finalKey === null) {
        return parseShortcut(DEFAULT_OPEN_SHORTCUT);
    }
    return { modifiers, finalKey };
}

/**
 * Reads the configured open shortcut for the selected AI extension.
 * Config shape: vscodeAutomation.extensions[<aiExtension>].openShortcut
 * @param {string} [override] - Optional explicit shortcut (wins over config)
 * @returns {string} Resolved shortcut string
 */
function resolveOpenShortcut(override) {
    if (override) return override;
    try {
        const vsConfig = Encrypt.getConfig('vscodeAutomation') || {};
        const ext = vsConfig.aiExtension || 'cline';
        const shortcut = vsConfig.extensions?.[ext]?.openShortcut;
        return shortcut || DEFAULT_OPEN_SHORTCUT;
        } catch {
        return DEFAULT_OPEN_SHORTCUT;
    }
}

// Tracks whether VS Code was already launched this process (never open a 2nd window).
let _vscodeLaunched = false;

/**
 * Resolves the per-call typing delay from vscodeAutomation.typingSpeedMs,
 * falling back to DEFAULT_TYPING_SPEED_MS. An explicit override wins.
 * @param {number} [override] - Explicit typing delay (ms)
 * @returns {number} typing delay in ms
 */
function resolveTypingSpeed(override) {
    if (typeof override === 'number' && override >= 0 && override < 10000) return override;
    try {
        const vsConfig = Encrypt.getConfig('vscodeAutomation') || {};
        return Number.isInteger(vsConfig.typingSpeedMs) ? vsConfig.typingSpeedMs : DEFAULT_TYPING_SPEED_MS;
    } catch {
        return DEFAULT_TYPING_SPEED_MS;
    }
}

module.exports = {
        /**
     * Launches VS Code ONCE and opens the Cline panel. Idempotent: if VS Code
     * was already launched in this process it is a no-op (so the prompt loop
     * never opens a second window — fixes the "VS Code reopens per prompt" bug).
     *
     * Honors:
     *  - vscodeAutomation.reuseWindow (default true): --reuse-window flag
     *  - vscodeAutomation.waitAfterLaunchSec (default 5): settle delay
     *
     * @param {string} workspacePath - Path to the directory VS Code should open
     */
    async launchVsCodeOnce(workspacePath) {
        const vsConfig = Encrypt.getConfig('vscodeAutomation') || {};
        const reuseWindow = vsConfig.reuseWindow !== false;
        const waitSec = Number(vsConfig.waitAfterLaunchSec) || 5;

        if (_vscodeLaunched) {
            log.info('VS Code already launched — skipping relaunch (reusing same window across prompts).');
            return;
        }

        const openShortcut = resolveOpenShortcut();
        const { modifiers: openModifiers, finalKey: openKey } = parseShortcut(openShortcut);

        try {
            log.info(`Launching VS Code in workspace: ${workspacePath} (reuseWindow=${reuseWindow})`);

            // 1. Open VS Code via child_process. --reuse-window attaches to the
            //    running instance instead of spawning a second window.
            const codeCmd = reuseWindow
                ? `code --reuse-window "${workspacePath}"`
                : `code "${workspacePath}"`;
            await step('launch-vscode', () => execAsync(codeCmd));
            _vscodeLaunched = true;

            // Give VS Code time to open and load the workspace
            await step('wait-vscode', () => sleep(waitSec * 1000));

            // 2. Open the configured Command Palette / extension shortcut
            log.info(`Opening shortcut: ${openShortcut}...`);
            const openAll = [...openModifiers, openKey];
            await step('open-extension', async () => {
                await keyboard.pressKey(...openAll);
                await keyboard.releaseKey(...openAll);
            });
            await step('wait-palette', () => sleep(1000));

            // 3. Search for Cline and Open it (done ONCE here, never per-prompt)
            log.info('Triggering Cline Extension...');
            await step('type-extension-name', () => keyboard.type('Cline: Open'));
            await step('wait-search', () => sleep(500));
            await step('confirm-extension', async () => {
                await keyboard.pressKey(Key.Enter);
                await keyboard.releaseKey(Key.Enter);
            });
            await step('wait-cline-panel', () => sleep(2000)); // Wait for Cline panel to render
            log.info('VS Code launched and Cline panel opened.');
        } catch (error) {
            _vscodeLaunched = false; // allow a retry on the next call
            log.error(`launchVsCodeOnce failed: ${error.message}`);
            throw error;
        }
    },

    /**
     * Sends a single prompt to the ALREADY-OPEN Cline panel. Does NOT relaunch
     * VS Code (call launchVsCodeOnce once before the prompt loop).
     *
     * Honors:
     *  - vscodeAutomation.typingSpeedMs (per-call typing delay)
     *  - vscodeAutomation.backgroundMode (default true): after sending, minimizes
     *    VS Code (Alt+Space -> N) so it never steals focus between prompts.
     *  - vscodeAutomation.waitBetweenPromptsSec (default 30): settle delay.
     *
     * @param {string} promptText - The backend prompt to send to Cline
     * @param {number} [typingSpeed] - Delay between keystrokes (ms)
     * @param {string} [openShortcut] - Optional explicit open shortcut (kept for API parity)
     */
    async sendPromptToCline(promptText, typingSpeed = DEFAULT_TYPING_SPEED_MS, openShortcut = null) {
        const vsConfig = Encrypt.getConfig('vscodeAutomation') || {};
        const backgroundMode = vsConfig.backgroundMode !== false;
        const waitBetweenSec = Number(vsConfig.waitBetweenPromptsSec) || 30;
        const typingDelay = resolveTypingSpeed(typingSpeed);

        try {
            log.info(`Sending prompt to Cline (typingSpeed=${typingDelay}, backgroundMode=${backgroundMode})...`);

            // Apply typing speed right BEFORE typing begins
            await step('set-typing-speed', async () => { keyboard.config.autoDelayMs = typingDelay; });

            // Best-effort: ensure VS Code is the focused window so Ctrl+V lands there.
            // Done minimally; if detection fails we proceed (paste goes to foreground app).
            try {
                const active = await screen.getActiveWindow();
                const title = (active && active.title) || '';
                if (!/visual studio code/i.test(title)) {
                    log.info('VS Code not focused — Alt+Tabbing once.');
                    await keyboard.pressKey(Key.LeftAlt, Key.Tab);
                    await keyboard.releaseKey(Key.LeftAlt, Key.Tab);
                    await sleep(400);
                }
            } catch (focusError) {
                log.warn(`Could not verify VS Code focus (${focusError.message}); proceeding anyway.`);
            }

            // Save the previous clipboard content so the user's clipboard can be restored after send.
            log.info('Sending prompt to Cline...');
            let previousClipboard = '';
            try { previousClipboard = clipboardy.readSync(); } catch { /* clipboard may be empty/locked */ }
            await step('clipboard-write', () => clipboardy.write(promptText));

            // Paste shortcut (Ctrl+V / Cmd+V)
            const pasteKey = process.platform === 'darwin' ? Key.LeftCmd : Key.LeftControl;
            await step('paste-prompt', async () => {
                await keyboard.pressKey(pasteKey, Key.V);
                await keyboard.releaseKey(pasteKey, Key.V);
            });
            await step('wait-paste', () => sleep(500));

            // 5. Hit Enter to send (pressKey/releaseKey — keyboard.type() only accepts strings)
            await step('send-prompt', async () => {
                await keyboard.pressKey(Key.Enter);
                await keyboard.releaseKey(Key.Enter);
            });

            // Restore the user's clipboard content after the prompt was sent
            if (previousClipboard) {
                await step('clipboard-restore', async () => {
                    await sleep(300);
                    clipboardy.writeSync(previousClipboard);
                });
            }
            log.info('Prompt successfully dispatched to Cline.');

            // Background mode: minimize VS Code immediately so it stops stealing focus.
            if (backgroundMode) {
                await step('minimize-vscode', async () => {
                    await keyboard.pressKey(Key.LeftAlt, Key.Space);
                    await keyboard.releaseKey(Key.LeftAlt, Key.Space);
                    await sleep(400);
                    await keyboard.type('n'); // 'n' = Minimize in the Windows window menu
                });
            }

            await step('wait-between-prompts', () => sleep(waitBetweenSec * 1000));
        } catch (error) {
            log.error(`sendPromptToCline Error: ${error.message}`);
            throw error;
        }
    },

    /**
     * Resets the per-process "VS Code already launched" flag so launchVsCodeOnce
     * can run again (e.g. on a fresh workflow / new workspace).
     */
    resetLaunchState() {
        _vscodeLaunched = false;
    },

    /**
     * Verifies that the 'code' CLI is available on the system PATH.
     * @returns {Promise<Object>} Environment check result
     */
    async testEnvironment() {
        try {
            const version = await execAsync('code --version');
            return { vscodeCli: true, version: version.split('\n')[0].trim() };
        } catch (error) {
            return { vscodeCli: false, error: error.message };
        }
    }
};