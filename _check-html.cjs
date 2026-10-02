const fs = require('fs');
const html = fs.readFileSync('src/renderer/index.html', 'utf8');

const checks = [
  ['Sidebar AI Chat nav item', /ai-chat-view/],
  ['Chat provider selector', /id=.chatProvider/],
  ['Chat model selector', /id=.chatModel/],
  ['Chat thinking selector', /id=.chatThinking/],
  ['Chat send button', /id=.chatSendBtn/],
  ['Chat stop button', /id=.chatStopBtn/],
  ['Chat clear button', /id=.chatClearBtn/],
  ['Chat messages container', /id=.chatMessages/],
  ['Chat input textarea', /id=.chatInput/],
  ['Live status card', /id=.liveStatusCard/],
  ['Live tokens today', /id=.liveTokensToday/],
  ['Live cost today', /id=.liveCostToday/],
  ['Live requests today', /id=.liveRequestsToday/],
  ['Live last provider', /id=.liveLastProvider/],
  ['Live avg latency', /id=.liveAvgLatency/],
  ['Top tokens display', /id=.topTokens/],
  ['Top cost display', /id=.topCost/],
  ['Topbar credits container', /live-credits-topbar/],
  ['Ignore sidebar (original feature preserved)', /aiSettings/],
  ['Chat provider option Gemini', /value=.gemini.>Gemini</opt/],
  ['Chat provider option Groq', /value=.groq.>Groq</opt/],
  ['Chat provider option Kimi', /value=.kimi.>Kimi</opt/],
  ['Chat provider option OpenRouter', /value=.openrouter.>OpenRouter</opt/],
];

let passed = 0, failed = 0;
for (const [name, re] of checks) {
  if (re.test(html)) { passed++; console.log('PASS: ' + name); }
  else { failed++; console.log('FAIL: ' + name); }
}
console.log(new Date().toISOString() + ' -> Checks: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
