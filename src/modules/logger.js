/**
 * @file logger.js
 * @description Centralized logging utilizing electron-log. Streams logs to the UI via IPC.
 */

const log = require('electron-log');
const { BrowserWindow } = require('electron');

module.exports = {
    /**
     * Initializes the logging system and overrides default console methods.
     */
    init() {
        log.transports.file.level = 'info';
        log.transports.console.level = 'debug';
        
        // Format: [2026-09-17 10:53:16] [info] Message
        log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';

        // Stream logs to the UI if the window is ready.
        // BUGFIX (triple logging): log.hooks fires ONCE PER TRANSPORT (file,
        // console, ipc...), so an unguarded hook sent every line 3x. Guard on
        // the console transport so the send happens exactly once per log call.
        log.hooks.push((message, transport) => {
            // Only send to UI for the CONSOLE transport (avoids duplicates)
            if (transport !== log.transports.console) return message;
            try {
                const windows = typeof BrowserWindow?.getAllWindows === 'function'
                    ? BrowserWindow.getAllWindows()
                    : [];
                if (windows.length > 0) {
                    windows[0].webContents.send('log:new', {
                        level: message.level,
                        text: message.data.join(' '),
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (err) {
                // Never let UI streaming break actual logging
            }
            return message;
        });

        log.info('Logger initialized successfully.');
    },

    info: (msg, ...args) => log.info(msg, ...args),
    warn: (msg, ...args) => log.warn(msg, ...args),
    error: (msg, ...args) => log.error(msg, ...args),
    debug: (msg, ...args) => log.debug(msg, ...args),

    /**
     * Terminal line for the Logs > Terminal tab (scheduler / apiManager progress).
     * Timestamped and routed through the SAME `log:new` stream the renderer
     * already subscribes to - the terminal is a view of the log stream, so a
     * second IPC channel would deliver every line twice.
     * @param {string} msg - e.g. 'Prompt 2/5 done in 33s (provider: groq, tokens: 980)'
     * @returns {string} the formatted line (useful for tests)
     */
    terminal(msg) {
        const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
        log.info(line);
        return line;
    }
};