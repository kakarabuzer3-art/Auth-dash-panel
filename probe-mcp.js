/**
 * Probe: proves the MCP integration end-to-end, without Electron.
 *
 *   node probe-mcp.js
 *
 * What it actually does (no mocks on the MCP path):
 *   - seeds the bundled server through the same ensureSeeded() the app calls;
 *   - SPAWNS mcp-servers/autodash-tools-server.js and completes the real
 *     initialize -> tools/list handshake;
 *   - calls real tools and checks their real output (workspace reads against a
 *     temporary folder, a port this probe itself opens, JSON validation, ...);
 *   - checks the model-side safety rule (callToolRunning never starts a server);
 *   - covers every branch of the chat tool-loop guard (pure string logic).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const McpManager = require('./src/modules/mcpManager');
const ChatToolLoop = require('./src/modules/chatToolLoop');
const SkillRegistry = require('./src/modules/skillRegistry');

let pass = 0;
let fail = 0;
const check = (label, ok, extra) => {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? `\n        ${extra}` : ''}`);
    ok ? pass++ : fail++;
};

// --- a throwaway workspace the bundled server may read -----------------------
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'autodash-mcp-ws-'));
fs.mkdirSync(path.join(WS, 'frontend', 'css'), { recursive: true });
fs.mkdirSync(path.join(WS, 'backend'), { recursive: true });
fs.writeFileSync(path.join(WS, 'frontend', 'index.html'), '<h1>Hello</h1>\n<img src="a.png">\n');
fs.writeFileSync(path.join(WS, 'frontend', 'css', 'styles.css'), 'body{color:#7c3aed}\n.card{color:#b06cff}\n');
fs.writeFileSync(path.join(WS, 'backend', 'api.php'), '<?php\n// api entry\n');

let stored = {
    mcpServers: { enabled: true, autoConnect: true, maxServers: 5, callTimeoutMs: 8000, servers: [] },
    fileConfig: { outputDirectory: WS },
};
McpManager.configure({
    get: (k) => stored[k],
    save: (k, v) => { stored[k] = v; },
});

async function main() {
    console.log('\n--- 1. seeding (a fresh install is no longer an empty list) ---');
    const seed = McpManager.ensureSeeded();
    check('ensureSeeded added the bundled server', seed.seeded === true && seed.added.includes('autodash-tools'),
        JSON.stringify(seed));
    const servers = McpManager.listServers();
    check('bundled server is marked bundled + enabled',
        servers.length === 1 && servers[0].bundled === true && servers[0].enabled === true,
        JSON.stringify(servers.map((s) => s.id)));
    const second = McpManager.ensureSeeded();
    check('ensureSeeded is idempotent (never re-adds)', second.seeded === false, second.reason);
    stored.mcpServers = { ...stored.mcpServers, servers: [] };
    McpManager.ensureSeeded();
    check('a user who deleted the server keeps it deleted', McpManager.listServers().length === 0);
    stored.mcpServers = { ...stored.mcpServers, servers: [McpManager.autodashToolsServer()] };

    console.log('\n--- 2. real connection (spawn + JSON-RPC handshake) ---');
    const report = await McpManager.autoConnect();
    check('autoConnect connected the bundled server', report.ready === 1 && report.attempted === 1,
        JSON.stringify(report.results));
    const st = McpManager.status();
    check('status reports ready + tools', st.running === 1 && st.servers[0].tools.length >= 10,
        `tools: ${st.servers[0].tools.join(', ')}`);
    check('server handshake info captured',
        !!(st.servers[0].serverInfo && st.servers[0].serverInfo.name === 'autodash-tools'),
        JSON.stringify(st.servers[0].serverInfo));
    const catalog = McpManager.toolCatalog();
    check('toolCatalog exposes inputSchema for the model',
        catalog.length >= 10 && catalog.some((t) => t.inputSchema && t.inputSchema.properties),
        `${catalog.length} tools`);

    // The AI must actually RECEIVE the tools: the chat system prompt is composed
    // by skillRegistry.composeSystemPrompt(), the same call every provider gets.
    stored.aiConfig = { systemPrompt: 'You are a senior frontend coder.', promptScope: { chat: true, automation: true }, skills: { enabled: {} } };
    SkillRegistry.configure({ get: (k) => stored[k], save: (k, v) => { stored[k] = v; } });
    const chatPrompt = SkillRegistry.composeSystemPrompt('chat').text;
    check('the live chat system prompt advertises the connected tools',
        chatPrompt.includes('CONNECTED MCP TOOLS') && chatPrompt.includes('workspace_search') && chatPrompt.includes('args:'),
        `prompt ${chatPrompt.length} chars`);
    check('the prompt teaches the tool-call protocol',
        chatPrompt.includes('LOCAL TOOL PROTOCOL') && chatPrompt.includes('```tool_call'),
        'protocol block present');

    console.log('\n--- 3. real tool calls ---');
    const run = (tool, args) => McpManager.callTool('autodash-tools', tool, args);

    const info = await run('system_info', {});
    check('system_info returns machine facts + the workspace path',
        info.ok && info.text.includes(WS) && /platform:/.test(info.text), info.text.split('\n')[0]);

    const list = await run('workspace_list', {});
    check('workspace_list sees the real generated files',
        list.ok && list.text.includes('frontend/index.html') && list.text.includes('backend/api.php'),
        list.text.split('\n').slice(0, 3).join(' | '));

    const read = await run('workspace_read', { path: 'frontend/css/styles.css' });
    check('workspace_read returns the real file contents', read.ok && read.text.includes('#7c3aed'));

    const search = await run('workspace_search', { query: '#b06cff' });
    check('workspace_search finds file:line matches',
        search.ok && /styles\.css:2/.test(search.text), search.text.split('\n')[1] || '');

    const escape = await run('workspace_read', { path: '../../../etc/passwd' });
    check('workspace_read refuses to escape the workspace',
        !escape.ok || /escapes the workspace/.test(escape.text),
        escape.text.replace(/\n/g, ' ').slice(0, 120));

    const badJson = await run('json_validate', { text: '{"a":1,}' });
    check('json_validate reports the real parse error', badJson.ok && /Invalid JSON/.test(badJson.text));
    const goodJson = await run('json_validate', { text: '{"a":1}' });
    check('json_validate accepts valid JSON and describes it', goodJson.ok && /Valid JSON/.test(goodJson.text));

    const seo = await run('seo_audit_checklist', { section: 'schema' });
    check('seo_audit_checklist filters', seo.ok && /schema/i.test(seo.text));

    const srv = net.createServer();
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const openPort = srv.address().port;
    const ports = await run('port_status', { ports: [openPort, 1], host: '127.0.0.1', timeoutMs: 800 });
    check('port_status detects an open port and a closed one',
        ports.ok && ports.text.includes(`:${openPort} -> OPEN`) && /:1 -> closed/.test(ports.text),
        ports.text.split('\n').slice(1).join(' | '));
    srv.close();

    // http_status against a server THIS probe runs: deterministic, no internet.
    const httpSrv = require('http').createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1>ok</h1>');
    });
    await new Promise((res) => httpSrv.listen(0, '127.0.0.1', res));
    const httpPort = httpSrv.address().port;
    const httpOk = await run('http_status', { url: `http://127.0.0.1:${httpPort}/health.php`, timeoutMs: 3000 });
    check('http_status reports the real status code (headers only)',
        httpOk.ok && /HTTP 200/.test(httpOk.text), httpOk.text.replace(/\n/g, ' | '));
    httpSrv.close();

    console.log('\n--- 4. model-side safety ---');
    const refused = await McpManager.callToolRunning('does_not_exist', {}).then(() => null).catch((e) => e);
    check('callToolRunning refuses an unknown tool honestly',
        !!refused && /No RUNNING MCP server provides/.test(refused.message),
        refused && refused.message.slice(0, 140));

    // A disabled-from-autoconnect server must NOT be spawned by a model request.
    stored.mcpServers = {
        ...stored.mcpServers,
        servers: [McpManager.autodashToolsServer(), { ...McpManager.autodashToolsServer(), id: 'ghost-tools', name: 'Ghost', autoConnect: false }],
    };
    McpManager.stopAll();
    await McpManager.callToolRunning('echo', { text: 'x' }).then(() => null).catch(() => null);
    check('a MODEL cannot spawn a server (ghost-tools stays unstarted)',
        !McpManager.status().servers.some((s) => s.id === 'ghost-tools' && s.running),
        `running: ${McpManager.status().servers.filter((s) => s.running).map((s) => s.id).join(', ') || 'none'}`);
    stored.mcpServers = { ...stored.mcpServers, servers: [McpManager.autodashToolsServer()] };
    await McpManager.autoConnect();

    console.log('\n--- 5. auto-connect switch ---');
    stored.mcpServers = { ...stored.mcpServers, autoConnect: false };
    const off = await McpManager.autoConnect();
    check('autoConnect:false disables launch connections', off.attempted === 0 && !!off.skipped, off.skipped);
    stored.mcpServers = { ...stored.mcpServers, autoConnect: true };

    console.log('\n--- 6. chat tool-loop (pure logic) ---');
    const fenced = '```tool_call\n{"tool":"port_status","args":{"ports":[80]}}\n```';
    const parsed = ChatToolLoop.parseToolRequests(fenced);
    check('parses the fenced request',
        parsed.requests.length === 1 && parsed.requests[0].tool === 'port_status',
        JSON.stringify(parsed.requests));
    const inline = ChatToolLoop.parseToolRequests('TOOLCALL: {"tool":"system_time","args":{}}');
    check('parses the inline fallback form',
        inline.requests.length === 1 && inline.requests[0].tool === 'system_time',
        JSON.stringify(inline.requests));
    const nested = ChatToolLoop.parseToolRequests('TOOLCALL: {"tool":"workspace_search","args":{"query":"a}b{c","ext":"css"}}');
    check('survives braces inside string args',
        nested.requests.length === 1 && nested.requests[0].args.query === 'a}b{c',
        JSON.stringify(nested.requests[0] && nested.requests[0].args));
    const stripped = ChatToolLoop.stripToolRequests(`Here you go.\n${fenced}\nDone.`);
    check('strips the request out of the visible answer', stripped === 'Here you go.\n\nDone.', JSON.stringify(stripped));

    const g1 = ChatToolLoop.createToolStreamGuard();
    let out1 = '';
    for (const piece of ['Hel', 'lo ', 'there', ' friend']) out1 += g1.push(piece);
    out1 += g1.finish().text;
    check('plain answer reaches the user byte-for-byte', out1 === 'Hello there friend', JSON.stringify(out1));

    const g2 = ChatToolLoop.createToolStreamGuard();
    let out2 = '';
    for (const piece of ['```too', 'l_call\n{"tool":"echo",', '"args":{"text":"hi"}}\n`', '``']) out2 += g2.push(piece);
    const fin2 = g2.finish();
    const visible2 = out2 + fin2.text;
    check('a tool request never reaches the user',
        !visible2.includes('tool_call') && !visible2.includes('"tool"') && fin2.requests.length === 1 && fin2.requests[0].tool === 'echo',
        `visible=${JSON.stringify(visible2)} requests=${fin2.requests.length}`);

    const g3 = ChatToolLoop.createToolStreamGuard();
    let out3 = g3.push('Let me check the ports.\n');
    out3 += g3.push('```tool_call\n{"tool":"port_status","args":{}}\n```');
    const fin3 = g3.finish();
    check('prose before a request is kept, the block is dropped',
        out3.startsWith('Let me check the ports.') && !(out3 + fin3.text).includes('port_status') && fin3.requests.length === 1,
        JSON.stringify(out3 + fin3.text));

    const msg = ChatToolLoop.buildToolResultMessage(
        [{ tool: 'echo', server: 'AutoDash Tools', ok: true, ms: 4, text: 'hi' }], 'why?');
    check('tool result message carries the real output + the question',
        msg.includes('hi') && msg.includes('why?') && msg.includes('MCP TOOL RESULT'));

    console.log('\n--- 7. teardown ---');
    const stopped = McpManager.stopAll();
    check('stopAll kills the child processes',
        stopped.includes('autodash-tools') && McpManager.status().running === 0, stopped.join(', '));

    console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed.\n`);
}

main()
    .catch((error) => { console.error('\nPROBE ERROR:', error); fail++; })
    .finally(() => {
        try { McpManager.stopAll(); } catch (e) { /* already gone */ }
        try { fs.rmSync(WS, { recursive: true, force: true }); } catch (e) { /* windows file lock */ }
        process.exit(fail === 0 ? 0 : 1);
    });
