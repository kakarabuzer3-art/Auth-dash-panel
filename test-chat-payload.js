// Temporary unit test for src/modules/chatPayload.js (plain node, no Electron).
// Reproduces the exact payloads the React chat UI sends.
const { normalizeChatMessages } = require('./src/modules/chatPayload');

let pass = 0, fail = 0;
function eq(label, actual, expected) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { console.log('✅ ' + label); pass++; }
    else { console.log('❌ ' + label + '\n   got:      ' + a + '\n   expected: ' + b); fail++; }
}

// 1) THE reported bug: brand-new chat => history empty, prompt only.
eq('first message of a new chat no longer yields an empty array',
    normalizeChatMessages({ prompt: 'Hello there', messages: [] }),
    [{ role: 'user', content: 'Hello there' }]);

// 2) OLD renderer pattern: live question arrives only in `prompt`.
eq('old-UI pattern (history + separate prompt) appends the live question',
    normalizeChatMessages({
        prompt: 'and then?',
        messages: [{ role: 'user', text: 'first q' }, { role: 'ai', text: 'first a' }]
    }),
    [
        { role: 'user', content: 'first q' },
        { role: 'assistant', content: 'first a' },
        { role: 'user', content: 'and then?' }
    ]);

// 2b) NEW renderer pattern: the question is ALREADY the last message -> no dup.
eq('new-UI pattern does not duplicate the live question',
    normalizeChatMessages({
        prompt: 'and then?',
        messages: [{ role: 'user', content: 'first q' }, { role: 'ai', content: 'first a' }, { role: 'user', content: 'and then?' }]
    }),
    [
        { role: 'user', content: 'first q' },
        { role: 'assistant', content: 'first a' },
        { role: 'user', content: 'and then?' }
    ]);

// 3) content wins when both field names exist (current UI build).
eq('content takes precedence over text',
    normalizeChatMessages({ messages: [{ role: 'user', content: 'new', text: 'old' }] }),
    [{ role: 'user', content: 'new' }]);

// 4) Junk entries never reach the provider.
eq('blank / non-object entries are dropped',
    normalizeChatMessages({
        messages: [{ role: 'user', content: '   ' }, null, 'nope', { role: '', content: 'keep me' }]
    }),
    [{ role: 'user', content: 'keep me' }]);

// 5) Nothing to send stays honest (router reports "No messages to send.").
eq('truly empty payload returns []', normalizeChatMessages({}), []);
eq('empty prompt does not fake a turn', normalizeChatMessages({ prompt: '', messages: [] }), []);

// 6) Garbage shapes cannot crash the router.
eq('non-array messages is tolerated', normalizeChatMessages({ prompt: 'x', messages: 'oops' }),
    [{ role: 'user', content: 'x' }]);
eq('undefined payload is tolerated', normalizeChatMessages(undefined), []);

// 7) System role survives (system prompt turns), unknown roles become user.
eq('system preserved, unknown role -> user',
    normalizeChatMessages({ messages: [{ role: 'system', content: 'be terse' }, { role: 'bot', content: 'hi' }] }),
    [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }]);

console.log('\n' + (fail === 0 ? `🎉 ALL ${pass} CHECKS PASSED` : `⚠️  ${fail} FAILED / ${pass} passed`));
process.exit(fail === 0 ? 0 : 1);
