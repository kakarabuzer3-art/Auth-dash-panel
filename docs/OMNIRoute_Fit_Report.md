# OMNIRoute Fit Report — `autodash-control-panel`

**Document type:** technical fit / integration assessment
**Subject app:** `C:\Users\Abuzer Kakar\Desktop\autodash-control-panel` (Electron 29 + React 19 + PHP/XAMPP generator)
**Candidate component:** OmniRoute local AI gateway (`omniroute@3.8.50`, `diegosouzapw/OmniRoute`)
**Prepared:** 2026-09-27
**Status:** DRAFT — no production code changed yet (this report contains the exact diffs to apply)

---

## 1. Executive Summary

**Verdict: a good fit, but only as an *optional fifth provider*, not as a replacement for the existing router — and it is currently NOT a working provider on this machine.**

What OmniRoute gives AutoDash that it does not have today:

| AutoDash pain (evidence in code) | What OmniRoute provides |
| --- | --- |
| 4 hand-wired providers, each with its own endpoint/auth/error shape (`apiManager.js` `PROVIDER_NAMES`, `MODEL_ENDPOINTS`, chat-URL map) | **One** OpenAI-compatible endpoint (`http://localhost:20128/v1`) covering 352 providers |
| Dead-key / 429 / 503 rescue logic re-implemented locally (dead-key registry, model fallback, key rotation, hundreds of lines of comments describing live failures) | Upstream failover, circuit breakers, cooldowns, `auto` combos done by the gateway |
| Token accounting for OpenAI-compatible providers is a guess (`tokens += 1` **per SSE chunk**) | `usage` objects on streamed responses (`stream_options.include_usage`) |
| 401 diagnosis is bespoke per provider (Google-specific wording branches) | Uniform OpenAI-shaped errors `{error:{message,type,code}}` + structured `diagnostics` / `recovery_hint` |
| No cost/telemetry beyond a local `runs/usage.json` | `omniroute cost`, `usage`, `logs`, live dashboard, telemetry API |

What OmniRoute does **not** solve:

* It is a **second process with its own lifecycle** (port `20128`, SQLite at `%USERPROFILE%\.omniroute`, 159 DB migrations on boot). AutoDash must gain a health/readiness gate for it, exactly like it already has for XAMPP.
* **It has no provider credentials on this machine** (see §2.2 / §4.4) — `auto` currently returns **HTTP 502** for every request. A gateway without upstream keys is not a fallback plan; it is a new single point of failure.
* It does **not** remove the need for `providers.*.apiKey` in AutoDash — the keys move *into* OmniRoute (`omniroute keys add …`), and AutoDash must keep its own copy for direct mode.
* It requires **Node >= 22.22.2** while Electron 29 embeds Node 20 → **HTTP-only integration**; never `require('omniroute')`, never in-process.

**Recommendation:** implement it behind a default-off feature flag (`gateway.enabled = false`) in three phases (§11). Until upstream credentials exist, run it at most in `mode: "fallback"`, so a 502 costs one extra attempt and nothing else. Promote it to `primary` only after the acceptance gates in §12.4 pass.

---

## 2. Scope, Method and Evidence Base

### 2.1 What was inspected

**AutoDash source (read-only; no edits made for this report):**

| Artifact | Size | Why it matters |
| --- | --- | --- |
| `src/modules/apiManager.js` | 1 549 lines | the entire AI layer: 4 providers, routing chain, retries, streaming, transcription, cost tracking |
| `main.js` | ~1 400 lines, 46 `ipcMain.handle` channels | Electron main; owns `chat:stream-route`, `api:probe-key`, `api:test`, `api:fetch-models`, `ai:transcribe` |
| `preload.js` | 7.7 KB | the renderer's only bridge (`window.electronAPI`) |
| `src/config/default-config.json` | 82 lines | the config contract, merged under `encryption.js` `getConfig()` |
| `src/modules/encryption.js` | 434 lines | AES-256-CTR store + `deepMerge(defaults, stored)` + `DEPRECATED_MODELS` rewrite |
| `src/modules/chatPayload.js` | 101 lines | renderer payload normalizer for `chat:stream-route` |
| `src/modules/scheduler.js` | 1 000+ lines | Force-Run workflow; has `healthCheckProviders()` pre-run gate |
| `ui/src/views/ApiKeys.jsx`, `ui/src/views/AiSettings.jsx` | — | `const PROVIDERS = ['gemini','groq','kimi','openrouter']`, `PROVIDER_LABELS`, `MODEL_OPTIONS` |
| `ui/src/lib/api.js`, `ui/src/views/Dashboard.jsx` | — | IPC access layer + System Status card (candidate home for a gateway chip) |

**OmniRoute facts — three independent sources:**

1. **Installed package** — `%APPDATA%\npm\node_modules\omniroute\package.json` → `"version": "3.8.50"`, `bin: omniroute`, engines `>=22.22.2 <23 || >=24.0.0 <27`, repo `github.com/diegosouzapw/OmniRoute`; plus its `README.md` quickstart and `.env.example` (network/auth sections).
2. **Live probes** against the running server on this machine (2026-09-27) — raw results reproduced verbatim in §2.2 and §4.
3. **Prior CLI captures in `Desktop\workspace`** — `omniroute_serve.log`, `or_help.txt`, `or_keyslist.txt`, `or_keysadd.txt`, `omniroute_install3.log`.

### 2.2 Environment facts verified during this assessment

| Check | Command actually run | Result |
| --- | --- | --- |
| System Node | `node -v` | **v24.19.0** (satisfies OmniRoute's engine range) |
| Gateway health | `curl.exe -s http://127.0.0.1:20128/api/monitoring/health` | `{"status":"healthy","setupComplete":true}` → **HTTP 200; running now** |
| Dashboard | `Invoke-WebRequest http://127.0.0.1:20128/dashboard` | **HTTP 200** |
| Models catalog, no key | `curl.exe -s .../v1/models` | **HTTP 401** `{"error":{"message":"Authentication required","type":"invalid_api_key","code":"invalid_api_key"}}` |
| Models catalog, bogus key | `curl.exe -s -H "Authorization: Bearer dummy-test-key" .../v1/models` | **HTTP 401** `{"error":{"message":"Invalid API key", ...}}` |
| Chat completion, no key | `curl.exe -s -X POST .../v1/chat/completions -d @or-body.json` | **HTTP 502** `bad_gateway` + `diagnostics` |
| Management API | `curl.exe -s .../api/keys` | **HTTP 401** `{"error":{"code":"AUTH_001", ...}}` |
| Provider credentials | `or_keyslist.txt` (CLI capture) | `API Keys` → **`No keys configured.`** |
| `~/.omniroute/.env` | key-name scan (values never printed) | only `STORAGE_ENCRYPTION_KEY` set — **no** `REQUIRE_API_KEY`, **no** `OMNIROUTE_SERVER_HOST`, **no** `INITIAL_PASSWORD` override |

**Consequence of the last two rows:** the running instance is on defaults — binds `0.0.0.0`, management password still the shipped `CHANGEME`, zero upstream providers. That combination is covered in §10 and §11 phase P0.

---

## 3. Current AutoDash Architecture (as it actually is)

### 3.1 Process / request topology

```
Electron main (Node 20, main.js)
  |-- ipcMain.handle('chat:stream-route')  -> chatPayload.normalizeChatMessages()
  |                                            -> ApiManager.chatStream()          (streaming, SSE)
  |-- ipcMain.handle('api:probe-key')      -> ApiManager.probeKey()                (GET /models only, zero quota)
  |-- ipcMain.handle('api:test')           -> ApiManager.testConnection()          (1 generation)
  |-- ipcMain.handle('api:fetch-models')   -> ApiManager.fetchModels()             (GET /models)
  |-- ipcMain.handle('ai:transcribe')      -> ApiManager.transcribeAudio()         (Groq Whisper -> Gemini audio)
  |-- scheduler.js  Force-Run workflow     -> ApiManager.generateStructureCode()   (non-streaming, chain walk)
  |-- scheduler.js  healthCheckProviders() -> ApiManager._call<Provider>()         (pre-run gate)
        |
        +--> direct HTTPS to api.groq.com / api.moonshot.cn / openrouter.ai /
        |    generativelanguage.googleapis.com (Gemini via @google/genai SDK)
        +--> encryption.js (AES-256-CTR, electron-store) = keys + providers + routing + aiConfig
        +--> runs/usage.json  (last 1 000 entries) + costs config (today's totals)

React 19 renderer (ui/, built into src/renderer/react)
  |-- ui/src/lib/api.js -> window.electronAPI (preload.js) -> ipcRenderer.invoke(...)
  |-- views: ApiKeys.jsx, AiSettings.jsx, AiChat.jsx, Dashboard.jsx, Scheduler.jsx, Settings.jsx ...

Separate concern (NOT part of the AI path): backend/api/*.php + src/modules/xampp.js
  = the *generated* customer dashboard that Force-Run deploys into XAMPP htdocs.
  OmniRoute has no relationship to this code path.
```

### 3.2 The AI surface that OmniRoute must plug into (exact anchors)

| # | Location | Current behaviour | Gateway-relevant |
| --- | --- | --- | --- |
| 1 | `apiManager.js:526` `PROVIDER_NAMES = ['gemini','groq','kimi','openrouter']` | the router's universe | must add `'omniroute'` |
| 2 | `apiManager.js:542` `MODEL_ENDPOINTS = { groq, kimi, openrouter }` | static live-model endpoints | needs a gateway branch |
| 3 | `apiManager.js:653-700` `chatStream()` OpenAI-compatible branch | hardcoded `urls = { groq, kimi, openrouter }`, `axios.post(url, {model, messages, stream:true}, {responseType:'stream'})`, manual `data:` SSE parse, `tokens += 1` per chunk | **primary integration point** |
| 4 | `apiManager.js:~640-652` Gemini branch of `chatStream()` | `@google/genai` `generateContentStream` | left untouched |
| 5 | `apiManager.js:817` `_buildRoutingChain()` | filters `p.enabled !== false && hasKey`, sorts by `routing.strategy` | needs `omniroute` + mode ordering |
| 6 | `apiManager.js:917` `generateStructureCode()` | walks chain, dispatches `_callGemini/_callKimi/_callGroq/_callOpenrouter`, retries, rotates Gemini keys on 429/401, `throw` on unsupported provider | needs `_callOmniroute` + dispatch line |
| 7 | `apiManager.js:768` `fetchModels()` | Gemini SDK list, else `MODEL_ENDPOINTS` GET | needs gateway branch (401-gated) |
| 8 | `apiManager.js:~1270` `probeKey()` | Gemini/Groq `/models` only (zero quota) | needs gateway branch (401-gated) |
| 9 | `apiManager.js:1314` `_callProviderOnce()` | single-shot test call; `throw new Error('Unsupported provider')` | needs gateway branch |
| 10 | `apiManager.js:1444` `transcribeAudio()` | Groq Whisper multipart -> Gemini `inlineData` fallback | optional gateway `/audio/transcriptions` |
| 11 | `apiManager.js:568` `recordApiUsageChat()` + `estimateCost()` | writes `runs/usage.json`, `costs` config | gateway can supply exact usage |
| 12 | `apiManager.js:711-1549` `module.exports = { ... }` | one single object literal; a comment at line 16-17 warns that `module.exports.X = X` above it is discarded | new methods go **inside** the literal |
| 13 | `main.js:568` `chat:stream-route` | builds `order = [preferred, 'gemini','groq','kimi','openrouter']`, requires a stored key per candidate, `MAX_ATTEMPTS = 14` | needs gateway ordering + keyless handling |
| 14 | `scheduler.js:63` `healthCheckProviders()` | `callFns` map per provider, requires `entry.apiKey` | needs gateway entry |
| 15 | `src/config/default-config.json` | no `gateway` block exists | new block (default off) |
| 16 | `ui/src/views/ApiKeys.jsx:8` / `AiSettings.jsx:8` | `PROVIDERS` array, `PROVIDER_LABELS`, `MODEL_OPTIONS` | UI surface for the new provider |

---

## 4. OmniRoute — Verified Capability Profile

### 4.1 Runtime facts (from the installed 3.8.50 package + live probes)

| Fact | Value | Source |
| --- | --- | --- |
| Version | **3.8.50** | installed `package.json` |
| System Node | **v24.19.0** (engines: `>=22.22.2 <23 \|\| >=24.0.0 <27`) | `node -v`, `package.json` |
| Canonical port | **20128** (dashboard **and** API, single-port mode) | `.env.example` `PORT=20128` |
| Split-port alternative | `API_PORT=20129`, `DASHBOARD_PORT=20128` | `.env.example` §"NETWORK & PORTS" |
| Live monitoring WS | `LIVE_WS_PORT=20132` (bind `LIVE_WS_HOST=127.0.0.1`) | `.env.example` |
| Dashboard | `http://localhost:20128/dashboard` → **HTTP 200** | live probe |
| OpenAI-compatible base | `http://localhost:20128/v1` | `README.md` ("Base URL: http://localhost:20128/v1") |
| Health endpoint | `GET /api/monitoring/health` → `{"status":"healthy","setupComplete":true}` (no auth needed) | live probe |
| Data dir | `%USERPROFILE%\.omniroute` → `storage.sqlite`, `.env`, backups | `omniroute_serve.log` |
| Encryption of stored credentials | `STORAGE_ENCRYPTION_KEY` (auto-generated, 64 chars) in `~/.omniroute/.env` | `.env` key-name scan |
| CLI | `omniroute serve \| stop \| restart \| status \| health \| doctor \| keys \| models \| logs \| cost \| usage \| simulate \| test \| open dashboard` | `or_help.txt` |
| Cold start | 159 migrations; the first observed `serve` **did not answer within 60 s** | `omniroute_serve.log` |
| In-process import | **not possible from Electron 29** (Node 20 vs `engines >=22.22.2`) | `package.json` engines |

### 4.2 Endpoint & auth contract (what AutoDash may rely on)

| Endpoint | Auth | Verified behaviour on this machine |
| --- | --- | --- |
| `GET /api/monitoring/health` | none | **200** `{"status":"healthy","setupComplete":true}` |
| `GET /v1/models` | **`Authorization: Bearer <gateway key>` required** | no header → **401** `Authentication required`; bogus key → **401** `Invalid API key` |
| `POST /v1/chat/completions` | key optional on loopback (README: "no API key … `auto` responds out of the box"); body validated first | valid JSON body → **reaches routing** (this install: **502** because no upstream providers) |
| `GET /v1/responses` | as above | advertised as OpenAI Responses-compatible |
| Header-less clients | — | tokenised aliases exist: `/vscode/<KEY>/models`, `/vscode/<KEY>/chat/completions`, `/vscode/<KEY>/api/chat` (Ollama) |
| `/api/*` management API | session/management auth | **401** `{"error":{"code":"AUTH_001","correlation_id":"…"}}` |

**Practical consequence for AutoDash:** the gateway **key is mandatory** for the two "zero-quota" features AutoDash leans on hardest — `probeKey()` and `fetchModels()` both hit `/models`. So step 0 of any integration is: create a gateway key in the dashboard (or CLI) and store it in AutoDash's encrypted config. Chat itself would work keyless on loopback, but we will always send the key (see §7.2) because `REQUIRE_API_KEY=true` or a non-loopback bind silently changes that.

### 4.3 Error & telemetry shapes (verbatim, copied from live responses)

Malformed/missing key — clean OpenAI envelope, which `parseProviderError()` in `apiManager.js` already understands:

```json
{"error":{"message":"Authentication required","type":"invalid_api_key","code":"invalid_api_key"}}
```

Upstream exhaustion — this is the shape AutoDash must learn to read, because the useful data is **outside** `error.message`:

```json
{
  "error": {
    "message": "oc/muse-spark-1.2: model — [402]: This model requires an opencode API key …; felo/felo-chat: model — [400] …",
    "type": "server_error",
    "code": "bad_gateway"
  },
  "diagnostics": {
    "poolSize": 13,
    "attempted": 4,
    "excluded": [{ "provider": "opencode", "reason": "exhausted_connection:noauth" }],
    "attemptOrder": [
      { "provider": "opencode", "model": "oc/muse-spark-1.2" },
      { "provider": "felo-web", "model": "felo/felo-chat" }
    ],
    "terminalReason": "[429]: Felo thread creation failed with HTTP 429",
    "recovery": { "action": "retry", "next_step": "The combo failed transiently. Retry the same combo, or switch to model: auto if the failure repeats." }
  },
  "recovery_hint": { "action": "retry", "next_step": "The combo failed transiently. …" }
}
```

Two takeaways:

1. `error.message` is a **multi-provider concatenation** — `humanMessage()` would truncate it and the Error Center would show noise. §7.6 adds a small projector that turns `diagnostics` into one actionable line.
2. `diagnostics.excluded/attemptOrder` proves the gateway's own failover ran; AutoDash's local retry/rotation is therefore **redundant for gateway calls** and should be shortened for that provider (see §10 latency risk).

### 4.4 Credential state — the blocking finding

`or_keyslist.txt` (CLI capture from `Desktop\workspace`) shows `API Keys` → `No keys configured.` and the live `POST /v1/chat/completions` answered **502 bad_gateway** naming three failing free backends (`opencode` 402 no key, `felo` 403 country block, `felo` 429). **The gateway is installed, healthy and authenticated, but has zero upstream providers.** Therefore:

* OmniRoute today is **not** a working fallback for AutoDash. Wiring it in without first importing credentials would convert every "provider down" event into "gateway 502".
* The upstream keys AutoDash already holds (Gemini `AQ.…`/`AIza…`, Groq `gsk_…`, Kimi `sk-…`, OpenRouter `sk-or-…` — see `keyShapeInfo()`), plus OmniRoute's own free tiers, are what make the gateway useful. Import them once: `omniroute keys add gemini <key>`, `omniroute keys add groq <key>`, … (help: `omniroute keys add [--stdin] <provider> [apiKey]`).

---

## 5. Capability Fit Matrix (feature by feature)

Effort: **S** = ≤ 30 lines in one file · **M** = one function + config + UI surface · **L** = new module/IPC/UI flow.

| # | AutoDash feature | Today | Through OmniRoute | Fit | Effort |
| --- | --- | --- | --- | --- | --- |
| 1 | Live AI Chat streaming (`chat:stream-route` -> `chatStream`) | direct SSE per provider, `tokens += 1` per chunk | identical SSE (`data: …` + `[DONE]`), plus optional `stream_options.include_usage` for exact counts | **FIT** | S |
| 2 | Force-Run generation (`generateStructureCode`, non-stream) | 4 provider calls + retries | one `POST /v1/chat/completions` with `model:"auto"` | **FIT** | S |
| 3 | Fetch Models (`api:fetch-models`) | `/models` per provider | `GET /v1/models` → whole gateway catalog | **FIT, gated** (Bearer key required — verified 401 without) | S |
| 4 | Probe Key / key-health badge (`api:probe-key`) | provider `/models` (zero quota) | same idea against the gateway; distinguishes "no key sent" vs "key rejected" | **FIT** | S |
| 5 | Test Connection (`api:test`) | one generation, provider-specific verdicts | gateway verdicts are rich but nested in `diagnostics`; needs a projector | **PARTIAL** | M |
| 6 | Dead-key registry, Gemini key rotation, model fallback (hundreds of lines) | bespoke, battle-tested against Google's quirks | redundant for gateway calls — the gateway already fails over and returns `attemptOrder` | **REDUNDANT (simplification win)** | S |
| 7 | Cost/usage tracking (`runs/usage.json`, `costs` config) | per-provider rates from `default-config.json` | exact `usage` per response + `omniroute cost/usage`; but the gateway is **one** line item, so per-upstream-model cost is lost inside it | **PARTIAL** | M |
| 8 | Voice input (`ai:transcribe`) | Groq Whisper → Gemini audio fallback | OpenAI-compatible `/v1/audio/transcriptions` exists in the spec; **not verified on this install** (needs a key to probe) | **CONDITIONAL** | M |
| 9 | Offline / no-Internet UX, `system:checkOnline` | probes Google/Cloudflare/gstatic | gateway is a **local dependency**: add `ECONNREFUSED 127.0.0.1:20128` to the diagnosis map or the UI will report a raw socket error | **RISK** | S |
| 10 | Scheduler pre-run health gate (`healthCheckProviders`) | per provider ping, skips key-less | add an `omniroute` entry; if the gateway is `primary`, a gateway-only gate avoids double probing | **FIT** | S |
| 11 | Master blueprint prompt (`loadMasterPrompt()` -> `prompts/master-system-prompt.txt`) | sent verbatim, very long | OmniRoute applies **compression** (RTK/Caveman) to eligible requests — must be disabled or verified, or the blueprint contract can be mangled | **RISK (verify)** | S |
| 12 | Error Center (`runs/errors.json`, `recordError`) | per-provider classified errors | gateway errors need their own classifier branch, else "Unknown Error" | **PARTIAL** | S |
| 13 | Images / embeddings / batches / memory / MCP | not used by AutoDash (`code:run` / Cline automation is unrelated) | available but out of scope | — | — |

**Net:** 7 clean fits, 4 partials that are all "add a projector/adapter", 2 risks that are pure verification tasks. No blocker requires redesigning the AI layer — which is why the recommendation is *additive*, not *rewrite*.

---

## 6. Integration Options Considered

### Option A — "Fifth provider" behind a flag (recommended)

A `gateway` config block + an `omniroute` entry in `PROVIDER_NAMES`, default `enabled:false`. Chat and automation keep their existing code paths; the gateway is one more branch. `gateway.mode` decides its chain position:

| `gateway.mode` | Chain effect | When to use |
| --- | --- | --- |
| `fallback` (default) | omniroute **last** — a free extra attempt after Gemini/Groq/Kimi/OpenRouter | today, because the gateway has no upstream keys yet |
| `primary` | omniroute **first**, direct providers remain as backup | once `keys add` has imported credentials and the §12.4 gates pass |
| `exclusive` | **only** omniroute — direct providers skipped entirely | when the user wants one cost/telemetry pane and accepts the local-process dependency |

*Pros:* zero risk to existing behaviour (flag off = byte-identical code path); reversible per-mode; no new npm dependencies; matches existing conventions (declared defaults in `default-config.json`, feature-flag comments, IPC + `preload` + a view).
*Cons:* two routing layers until direct providers are retired; keys then live in two places, which must be explained in the UI.

### Option B — full replacement (delete direct providers)

Replace `PROVIDER_NAMES` with `['omniroute']` and delete the Gemini SDK branch, the key pool, the dead-key registry and the per-provider error classifiers.

*Pros:* ~400 lines of provider-specific weirdness removed.
*Cons:* irreversible single point of failure (a stopped or uninstalled OmniRoute = the app has **no** AI at all); Electron cannot manage the gateway process (Node engine mismatch); every stored `providers.*.apiKey` becomes dead weight; and on this machine the gateway currently answers **502**. **Rejected for now** — revisit only after Option A has run clean for weeks.

### Option C — gateway only for the automation pipeline

Leave chat direct, route only Force-Run through the gateway (or the reverse).

*Pros:* smallest blast radius; the automation path is where long batch generation benefits most from upstream failover.
*Cons:* splits the error surface in two, complicates the health gate, and withholds the usage/cost win from chat. **Not recommended as a design — but it is reachable for free** via `mode` + priority order, so no extra code is needed if a user wants it.

### Recommendation

**Option A**, delivered in the three phases of §11. Because the mode is config-driven, Option C and (later) Option B remain config changes rather than refactors.

---

## 7. Integration Plan — Step-by-Step, With Exact Code

Every step is ordered so that the app keeps working after each one, and step 1 alone changes **no** behaviour (flag off).

### 7.0 Prerequisites (do these first — nothing below is useful without them)

| # | Action | Command / place | Why |
| --- | --- | --- | --- |
| P1 | Confirm the gateway is up | `curl.exe -s http://127.0.0.1:20128/api/monitoring/health` | must print `{"status":"healthy",...}` |
| P2 | Give the gateway at least one upstream credential | `omniroute keys add gemini <AQ.…>` / `omniroute keys add groq <gsk_…>` / `omniroute keys add openrouter <sk-or-…>` | **without this, `auto` returns 502** (§4.4). Equivalent UI path: dashboard → Providers |
| P3 | Create a gateway client key | dashboard `http://localhost:20128/dashboard` → **Endpoints** (login uses the management password) | `/v1/models` is 401-gated, so `Fetch Models` / key-health need it |
| P4 | Harden the running instance | in `C:\Users\Abuzer Kakar\.omniroute\.env`: `OMNIROUTE_SERVER_HOST=127.0.0.1`, and change the manager password (currently the shipped `CHANGEME`) | the current bind is `0.0.0.0` with no enforcement — any LAN device can spend the user's quota |
| P5 | Optional but recommended | `REQUIRE_API_KEY=true` once P3 exists | makes loopback behaviour identical to remote behaviour, so the code path is testable |

Verify P2/P3 end-to-end before touching AutoDash:

```powershell
curl.exe -s -H "Authorization: Bearer <GATEWAY_KEY>" http://127.0.0.1:20128/v1/models
# expect HTTP 200 + a "data":[{ "id": ... }] catalog

$body = '{"model":"auto","messages":[{"role":"user","content":"ping"}]}'
Set-Content -Path "$env:TEMP\or-body.json" -Value $body -Encoding ascii -NoNewline
curl.exe -s -w "`nHTTP %{http_code}" -X POST http://127.0.0.1:20128/v1/chat/completions `
  -H "Content-Type: application/json" --data-binary "@$env:TEMP\or-body.json"
# expect HTTP 200 + choices[0].message.content
```

### 7.1 Step 1 — `src/config/default-config.json`: declare the gateway (default OFF)

Add a top-level `gateway` block next to `routing`, and one provider entry:

```json
  "gateway": {
    "enabled": false,
    "baseUrl": "http://127.0.0.1:20128/v1",
    "apiKey": "",
    "model": "auto",
    "mode": "fallback",
    "sendUsage": true,
    "passModelThrough": false,
    "timeoutMs": 180000,
    "healthTimeoutMs": 3000,
    "paths": {
      "chat": "/chat/completions",
      "models": "/models",
      "responses": "/responses",
      "audio": "/audio/transcriptions"
    }
  },
```

and inside the existing `"providers"` object:

```json
    "omniroute":  { "apiKey": "", "model": "auto", "priority": 5, "enabled": true,
                    "temperature": 0.7, "maxTokens": 8192,
                    "latencyMs": 300, "costPerMillionInput": 0, "costPerMillionOutput": 0 }
```

**Three deliberate decisions, so they are not mistaken for oversights:**

1. **`providers.omniroute.priority` is 5** (after OpenRouter's 4) and **`providers.omniroute.enabled` is ignored** — for this provider the on/off switch is `gateway.enabled` alone. Two switches would mean two sources of truth and a class of "why is it not in the chain" bugs. The `providers.omniroute` entry exists only to carry `model`, `priority` and generation overrides into `_buildRoutingChain()` / `generateStructureCode()`.
2. **`enabled: false`** means every existing installation (whose stored config is merged *over* these defaults by `encryption.js: deepMerge(getDefaultsFor('gateway'), stored)`) keeps today's behaviour byte-for-byte. `getConfig()` also returns these defaults when the `gateway` module was never saved, so **no migration script is needed**.
3. **`mode: "fallback"`** is the safe default: the gateway is only tried after the four direct providers, so a 502 on this machine costs one attempt and never blocks a run.

`encryption.js` needs **no change**: `DEPRECATED_MODELS` only rewrites `providers.gemini.model`, and the new block is a plain nested object that `deepMerge` handles.

### 7.2 Step 2 — `src/modules/apiManager.js`: gateway helpers

Insert immediately **after** the `MODEL_ENDPOINTS` const (`apiManager.js:542-546`). Style matches the file: CommonJS, JSDoc, `log`, no new dependencies.

```js
// ---------------------------------------------------------------------------
// OMNINROUTE GATEWAY (2026-09-27)
//
// WHY: the four providers above are reached through four hand-written URL maps,
// four auth styles and four error-envelope shapes, and the rescue logic for
// dead keys / 429 / 503 lives in THIS file. OmniRoute (omniroute@3.8.50, local,
// port 20128) exposes ONE OpenAI-compatible endpoint
// (http://127.0.0.1:20128/v1) that already performs upstream failover and
// returns a `usage` object per response. It is wired in as an OPTIONAL fifth
// provider: gateway.enabled === false (the default) leaves every path below
// untouched.
//
// LIVE-VERIFIED (2026-09-27, this machine):
//   GET  /api/monitoring/health -> 200 {"status":"healthy","setupComplete":true}
//   GET  /v1/models             -> 401 without "Authorization: Bearer <key>"
//   POST /v1/chat/completions   -> reaches routing; 502 while the gateway has
//                                  no upstream providers (keys add ... <key>)
// The gateway is a SEPARATE PROCESS. Electron 29 embeds Node 20 while
// OmniRoute requires >=22.22.2, so it is never require()d - HTTP only - and a
// stopped server must degrade to "provider unavailable", never to a crash.
// ---------------------------------------------------------------------------
const GATEWAY_DEFAULTS = {
    enabled: false,
    baseUrl: 'http://127.0.0.1:20128/v1',
    apiKey: '',
    model: 'auto',
    mode: 'fallback',
    sendUsage: true,
    passModelThrough: false,
    timeoutMs: 180000,
    healthTimeoutMs: 3000,
    paths: {
        chat: '/chat/completions',
        models: '/models',
        responses: '/responses',
        audio: '/audio/transcriptions'
    }
};

/** Reads the merged gateway config (stored values win over the defaults). */
function gatewayConfig() {
    let stored = null;
    try { stored = Encrypt.getConfig('gateway'); } catch (e) { stored = null; }
    const gw = { ...GATEWAY_DEFAULTS, ...(stored || {}) };
    gw.paths = { ...GATEWAY_DEFAULTS.paths, ...((stored && stored.paths) || {}) };
    gw.baseUrl = String(gw.baseUrl || GATEWAY_DEFAULTS.baseUrl).replace(/\/+$/, '');
    gw.mode = ['primary', 'fallback', 'exclusive'].includes(gw.mode) ? gw.mode : 'fallback';
    return gw;
}

/** True when the gateway is switched on (the ONLY on/off switch for it). */
function gatewayActive(gw = gatewayConfig()) { return gw.enabled === true; }

/** Absolute URL for a gateway path kind ('chat' | 'models' | 'responses' | 'audio'). */
function gatewayUrl(gw, kind = 'chat') {
    const p = (gw.paths && gw.paths[kind]) || GATEWAY_DEFAULTS.paths[kind] || '/chat/completions';
    return `${gw.baseUrl}${p}`;
}

/** Auth headers for the gateway. The key is REQUIRED by /v1/models. */
function gatewayHeaders(gw) {
    const h = { 'Content-Type': 'application/json' };
    if (gw.apiKey) h.Authorization = `Bearer ${gw.apiKey}`;
    return h;
}

/** Root server URL (no /v1) - the health endpoint lives outside /v1. */
function gatewayServerUrl(gw) { return gw.baseUrl.replace(/\/v1\/?$/, ''); }
```

### 7.3 Step 3 — `chatStream()`: route the OpenAI-compatible branch through the gateway

Two edits in `chatStream()` (the `else` branch at `apiManager.js:653-700`).

**3a. Add a target resolver next to the helpers (same insertion point as 7.2):**

```js
/** Direct upstream chat endpoints - the pre-OmniRoute hardcoded map, hoisted. */
const DIRECT_CHAT_URLS = {
    groq: GROQ_API_URL,                              // apiManager.js:274
    kimi: 'https://api.moonshot.cn/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/chat/completions'
};

/**
 * Decides WHERE one OpenAI-compatible chat request goes and builds its body.
 * Returns { url, body, headers, timeoutMs, viaGateway } so the caller keeps a
 * single axios call for both transports (no duplicated SSE parsing).
 */
function resolveChatTarget(provider, opts = {}) {
    const gw = gatewayConfig();
    // The gateway is used if and ONLY if this attempt is the omniroute provider
    // entry. `mode` (primary | fallback | exclusive) only decides WHERE that
    // entry sits in the routing chain - it never re-routes the other four, so
    // "route everything through OmniRoute" is expressed as mode:"exclusive"
    // (chain contains omniroute only) instead of a second, hidden switch.
    if (provider === 'omniroute' && gatewayActive(gw)) {
        const body = { model: gw.model || 'auto', messages: opts.messages, stream: !!opts.stream };
        // Optional: honour the provider's configured model instead of "auto"
        // (the gateway accepts upstream model ids such as "gemini-3.6-flash").
        if (gw.passModelThrough && opts.model) body.model = opts.model;
        // Exact token accounting for streamed replies (optional per the OpenAI
        // spec; a gateway that ignores it simply omits `usage`).
        if (gw.sendUsage && opts.stream) body.stream_options = { include_usage: true };
        return { viaGateway: true, url: gatewayUrl(gw, 'chat'), body, headers: gatewayHeaders(gw), timeoutMs: gw.timeoutMs };
    }
    return {
        viaGateway: false,
        url: DIRECT_CHAT_URLS[provider],
        body: { model: opts.model, messages: opts.messages, stream: !!opts.stream },
        headers: { 'Authorization': `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        timeoutMs: 60000
    };
}
```

**3b. Replace the hardcoded `urls` map and the axios call in the `else` branch of `chatStream()`:**

```js
// BEFORE (apiManager.js:653-672)
} else {
    // OpenAI-compatible providers (Groq, Kimi, OpenRouter)
    const urls = {
        groq: 'https://api.groq.com/openai/v1/chat/completions',
        kimi: 'https://api.moonshot.cn/v1/chat/completions',
        openrouter: 'https://openrouter.ai/api/v1/chat/completions'
    };
    const response = await axios.post(urls[provider], {
        model, messages, stream: true
    }, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        responseType: 'stream'
    });
```

```js
// AFTER
} else {
    // OpenAI-compatible providers (Groq, Kimi, OpenRouter) AND the optional
    // OmniRoute gateway - one axios call and one SSE parser for both, so the
    // gateway can never drift away from the provider behaviour.
    const target = resolveChatTarget(provider, { model, messages, stream: true, apiKey });
    const response = await axios.post(target.url, target.body, {
        headers: target.headers,
        responseType: 'stream',
        timeout: target.timeoutMs
    });
```

**3c. Exact token accounting inside that same SSE loop.** Declare one extra local next to `fullText`/`tokens` in `chatStream()`:

```js
let exactTokens = 0; // set from the final SSE chunk's `usage` (gateway/OpenAI)
```

then, inside `for (const line of lines)` -> `try { const parsed = JSON.parse(json); ... }`, insert **before** the `choices` read:

```js
// The gateway (and OpenAI with stream_options.include_usage) ends the stream
// with a chunk that carries `usage` while `choices` is empty. Counting 1 token
// per chunk - the previous behaviour for all OpenAI-compatible providers -
// under-reported long answers by an order of magnitude.
if (parsed.usage && Number.isFinite(parsed.usage.total_tokens)) {
    exactTokens = parsed.usage.total_tokens;
}
```

and immediately after the `await new Promise(...)` SSE block, before the stats emit:

```js
if (exactTokens) tokens = exactTokens; // prefer the provider's own count
```

**3d. Cost note.** `estimateCost(provider, model, tokens)` looks up `providers[provider].costPerMillion*` in `default-config.json`; for `omniroute` those are `0`, so the local cost line stays `$0.0000` and the real spend lives in the gateway (`omniroute cost`, dashboard). If `parsed.usage` turns out to carry a cost field on this build, prefer it here - that is a one-line change, to be decided at runtime by inspecting a live streamed response (see §12.3, test `T5`).

### 7.4 Step 4 — non-streaming gateway call for the Force-Run workflow

**4a. Register the provider** (`apiManager.js:526`, `531`):

```js
// was: const PROVIDER_NAMES = ['gemini', 'groq', 'kimi', 'openrouter'];
const PROVIDER_NAMES = ['gemini', 'groq', 'kimi', 'openrouter', 'omniroute'];

// MODEL_ENUMS gains the gateway's own vocabulary: `auto` is OmniRoute's
// zero-config smart-routing alias, and the rest are documented combo forms.
// The live list is fetched from GET /v1/models (needs the gateway key).
omniroute: ['auto', 'auto:fast', 'auto:cheap']
```

**4b. Add the call function next to the other `_call*` methods (e.g. after `_callOpenrouter`, `apiManager.js:1228`):**

```js
/**
 * OmniRoute gateway (OpenAI-compatible, local). One request covers every
 * upstream provider: the gateway performs the failover, so this function
 * deliberately does NOT duplicate the model/key rotation dance the other
 * providers need.
 * @param {string} prompt - user prompt (master prompt is applied by the caller)
 * @param {string} apiKey - gateway key (optional on loopback, REQUIRED if
 *                          REQUIRE_API_KEY=true or the bind is non-loopback)
 * @param {string} model  - 'auto' (default) or a gateway/upstream model id
 * @param {object} genOpts - { temperature, maxTokens }
 * @returns {Promise<string>} completion text
 */
async _callOmniroute(prompt, apiKey, model = 'auto', genOpts = {}) {
    const gw = gatewayConfig();
    const systemPrompt = (Encrypt.getConfig('aiConfig') || {}).systemPrompt || '';
    const messages = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }];
    log.info(`Sending request to OmniRoute gateway (${gatewayUrl(gw, 'chat')}, model: ${gw.model || 'auto'})...`);
    const response = await axios.post(gatewayUrl(gw, 'chat'), {
        model: gw.passModelThrough && model ? model : (gw.model || 'auto'),
        messages,
        temperature: genOpts.temperature,
        max_tokens: genOpts.maxTokens
    }, {
        headers: gatewayHeaders({ ...gw, apiKey: gw.apiKey || apiKey }),
        timeout: gw.timeoutMs
    });
    const text = String(response.data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('OmniRoute returned an empty completion.');
    return text;
}
```

**4c. Dispatch it in `generateStructureCode()` (`apiManager.js:938-951`)** - one new `else if`, inserted before the final `else { throw new Error('Unsupported AI Provider'); }`:

```js
} else if (entry.name === 'omniroute') {
    text = await _withRetry(() => this._callOmniroute(finalPrompt, entry.apiKey, entry.model, entryGenOpts), entry.attempts);
}
```

**4d. Test-Connection path** (`_callProviderOnce`, `apiManager.js:1314`):

```js
if (provider === 'omniroute') return this._callOmniroute(prompt, apiKey, model || 'auto', opts);
```

**4e. Export the new surface** - inside the single `module.exports = { ... }` literal (`apiManager.js:711`), **not** as `module.exports.X = X` (the comment at line 16-17 explains why those assignments are discarded):

```js
    // --- OmniRoute gateway (2026-09-27) -------------------------------------
    // gatewayConfig() is read by main.js (chat ordering) and the UI status card;
    // resolveChatTarget() is exposed so the node smoke test can assert the
    // direct-vs-gateway decision without starting Electron.
    getGatewayConfig: () => gatewayConfig(),
    resolveChatTarget,
    probeGateway,
    gatewayErrorHint,
```

### 7.5 Step 5 — `_buildRoutingChain()`: chain position and keyless entry

**5a. Replace the filter (`apiManager.js:827-833`)** so the gateway has exactly one switch and no key requirement:

```js
const gw = gatewayConfig();
const gatewayOn = gatewayActive(gw);

const chain = PROVIDER_NAMES
    .filter(name => {
        const p = providers[name] || {};
        // OmniRoute: the ONLY on/off switch is gateway.enabled (§7.1), and a key
        // is OPTIONAL here - verified live that POST /v1/chat/completions works
        // keyless on loopback while only GET /v1/models is 401-gated. Reachability
        // is the health gate's job (scheduler.js / probeGateway), not the filter's.
        if (name === 'omniroute') return gatewayOn;
        const hasKey = p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys.some(k => typeof k === 'string' && k.trim()));
        return p && p.enabled !== false && hasKey;
    })
```

**5b. Add the position helper next to the other module-level helpers:**

```js
/**
 * Places the omniroute entry according to gateway.mode. Applied AFTER the
 * strategy sort, so the mode is authoritative for the gateway's position while
 * every other provider keeps the order the strategy produced.
 */
function orderGateway(chain, gw) {
    const idx = chain.findIndex(c => c.name === 'omniroute');
    if (idx < 0 || !gatewayActive(gw)) return chain;
    if (gw.mode === 'exclusive') return [chain[idx]];          // gateway only
    const others = chain.filter(c => c.name !== 'omniroute');
    return gw.mode === 'primary' ? [chain[idx], ...others] : [...others, chain[idx]];
}
```

**5c. Route the strategy switch through it.** The current switch `return`s directly for `round-robin` (`apiManager.js:865-876`), which would bypass the mode. Change that one branch from `return rotated;` to a `break`, and replace the function's final `return chain;` with `return orderGateway(chain, gw);`:

```js
    case 'round-robin': {
        chain.sort((a, b) => a.priority - b.priority);
        const start = this._nextRoundRobinIndex(chain.length);
        chain = chain.slice(start).concat(chain.slice(0, start));   // was: return rotated;
        log.info(`Routing strategy "${strategy}" — rotation start index: ${start}.`);
        break;
    }
    // ... 'cost-optimized' / 'latency-optimized' / 'priority' unchanged ...
}
log.info(`Routing strategy "${strategy}" — chain: ${chain.map(c => c.name).join(' -> ') || '(empty)'}.`);
return orderGateway(chain, gw);          // was: return chain;
```

**5d. Guard the contradictory combination** `mode:'exclusive'` + `enabled:false`. Do **not** silently enable a network dependency and do not hard-fail a run over a config typo - log it once and continue with the normal chain:

```js
if (gw.mode === 'exclusive' && !gatewayOn) {
    log.warn('gateway.mode is "exclusive" but gateway.enabled is false — falling back to the normal provider chain. Enable the gateway in AI Settings.');
}
```

**Note on `opts` for the chain entry.** `_buildRoutingChain()` returns `apiKey: p.apiKey` per entry; for `omniroute` that is `''` (the gateway key lives in `gateway.apiKey`). `_callOmniroute()` therefore falls back to `gw.apiKey` internally - which is why 4b writes `gatewayHeaders({ ...gw, apiKey: gw.apiKey || apiKey })`.

### 7.6 Step 6 — model listing, key probe and gateway-specific error hints

**6a. `fetchModels()`** - insert one branch right after the stored-key lookup (`apiManager.js:771-774`), before the Gemini SDK branch:

```js
if (provider === 'omniroute') {
    const gw = gatewayConfig();
    if (!gw.apiKey) {
        // GET /v1/models answered 401 "Authentication required" without a key
        // (live-verified), so do not burn a request that is guaranteed to fail.
        log.warn('OmniRoute model list needs the gateway key (GET /v1/models is 401-gated).');
        return MODEL_ENUMS.omniroute;
    }
    try {
        const r = await axios.get(gatewayUrl(gw, 'models'), {
            headers: gatewayHeaders(gw), timeout: 15000, proxy: false
        });
        const arr = Array.isArray(r.data && r.data.data) ? r.data.data : [];
        const models = arr.map(m => (m && m.id ? { id: m.id, name: m.name || m.id } : null)).filter(Boolean);
        return models.length ? models : MODEL_ENUMS.omniroute;
    } catch (error) {
        log.warn(`OmniRoute live model fetch failed (${humanMessage(error, 120)}) — using static list.`);
        return MODEL_ENUMS.omniroute;
    }
}
```

**6b. `probeKey()`** - add the branch at the top of the `try` (`apiManager.js:1270`), and give it a *keyless* early return:

```js
if (provider === 'omniroute') {
    const gw = gatewayConfig();
    const gwKey = String(apiKey || gw.apiKey || '').trim();
    if (!gwKey) {
        return {
            valid: false, kind: 'missing-key', status: null, models: [], latencyMs: 0,
            message: 'No OmniRoute gateway key stored (GET /v1/models requires one).',
            suggestions: ['Copy a key from the OmniRoute dashboard → Endpoints into Gateway API key, then Save.'],
        };
    }
    const r = await axios.get(gatewayUrl(gw, 'models'), {
        headers: { ...gatewayHeaders(gw), Authorization: `Bearer ${gwKey}` },
        timeout: Math.max(5000, gw.healthTimeoutMs * 3), proxy: false
    });
    const models = (Array.isArray(r.data && r.data.data) ? r.data.data : [])
        .map(m => m && m.id).filter(Boolean);
    return {
        valid: true, kind: 'ok', status: 200, models,
        latencyMs: Date.now() - started,
        message: `Gateway key VALID — ${models.length} model(s) reachable in ${Date.now() - started}ms. Zero quota used.`,
    };
}
```

**6c. `gatewayErrorHint(info)`** - the projector that turns gateway failures into actionable text. Add it next to `gatewayServerUrl` (§7.2):

```js
/**
 * Turns a gateway failure into actionable UI text. Kept separate from
 * classifyProviderError() because the gateway's useful data lives in
 * `diagnostics`/`recovery_hint` (see §4.3), not in provider-style status codes.
 * @param {{status?:number|string, message?:string}} info
 * @returns {string[]} suggestions for Test Connection / Error Center / toasts
 */
function gatewayErrorHint(info = {}) {
    const s = [];
    const status = String(info.status || '');
    const msg = String(info.message || '');
    if (status === '401' || /invalid api key|authentication required/i.test(msg)) {
        s.push('The gateway rejected the key — copy the value from the OmniRoute dashboard → Endpoints into "Gateway API key" and Save.');
        s.push('A reinstalled gateway resets its keys: generate a fresh one instead of re-pasting the old value.');
    } else if (/ECONNREFUSED|ENOTFOUND|socket hang up|ECONNRESET/i.test(msg)) {
        s.push('Nothing is listening on 127.0.0.1:20128 — start it with "omniroute serve" (or enable OmniRoute autostart), then Check again.');
        s.push('First start after an install can take over a minute (159 DB migrations) — retry before changing the port.');
    } else if (status === '502' || /bad_gateway|server_error/i.test(msg)) {
        s.push('The gateway is up but every upstream provider failed. Import credentials: "omniroute keys add <provider> <key>", or connect providers in the dashboard.');
        s.push('The gateway lists what it tried in diagnostics.attemptOrder / terminalReason — open the Error Center entry for the full body.');
    } else if (status === '400' && /invalid json/i.test(msg)) {
        s.push('The gateway validated the body before routing it — this is an AutoDash payload bug, not a credentials problem.');
    }
    s.push('Gateway-side detail: dashboard → Requests (http://localhost:20128/dashboard).');
    return s;
}
```

**6d. `probeGateway()`** - the status used by the new UI chip and by the pre-run gate. Note `proxy: false`: the codebase already learned (in `xampp.js verifyHealth`) that a corporate/system proxy can hijack `localhost` calls.

```js
/**
 * One cheap status snapshot of the local OmniRoute server for the Dashboard
 * card / AI Settings. Uses ONLY unauthenticated health + the 401-gated model
 * list, so it can never spend generation quota.
 * @returns {Promise<{enabled:boolean, mode:string, baseUrl:string, serverUrl:string,
 *   reachable:boolean, healthy:boolean, setupComplete:boolean|null,
 *   keyValid:boolean|null, models:number, latencyMs:number, error:string,
 *   suggestions:string[]}>}
 */
async function probeGateway() {
    const gw = gatewayConfig();
    const started = Date.now();
    const out = {
        enabled: !!gw.enabled, mode: gw.mode, baseUrl: gw.baseUrl, serverUrl: gatewayServerUrl(gw),
        model: gw.model, reachable: false, healthy: false, setupComplete: null,
        keyValid: null, models: 0, latencyMs: 0, error: '', suggestions: []
    };
    try {
        const r = await axios.get(`${out.serverUrl}/api/monitoring/health`, {
            timeout: gw.healthTimeoutMs, proxy: false, validateStatus: () => true
        });
        out.reachable = r.status === 200;
        out.healthy = String((r.data && r.data.status) || '') === 'healthy';
        out.setupComplete = (r.data && 'setupComplete' in r.data) ? !!r.data.setupComplete : null;
        out.latencyMs = Date.now() - started;
    } catch (error) {
        out.error = error.message;
        out.suggestions = gatewayErrorHint({ message: error.message });
        return out;
    }
    if (!gw.apiKey) {
        out.suggestions.push('No gateway key stored — GET /v1/models is 401-gated, so Fetch Models and the key badge cannot work until one is saved.');
        return out;
    }
    try {
        const m = await axios.get(gatewayUrl(gw, 'models'), {
            headers: gatewayHeaders(gw), timeout: Math.max(5000, gw.healthTimeoutMs * 3), proxy: false
        });
        out.keyValid = true;
        out.models = Array.isArray(m.data && m.data.data) ? m.data.data.length : 0;
    } catch (error) {
        out.keyValid = false;
        out.suggestions = gatewayErrorHint(classifyProviderError(error, 'omniroute'));
    }
    return out;
}
```

**6e. `classifyProviderError()`** - one early branch so gateway failures reach the Error Center with gateway wording instead of a "401 => Google is confused" style guess (`apiManager.js:35-215`):

```js
// Insert where the other kind-specific suggestion branches begin, right after
// `kind` has been computed from the status/parsed data:
if (provider === 'omniroute') {
    return { ...parsedOut, kind, suggestions: gatewayErrorHint({ status: parsedOut.status, message: parsedOut.message }) };
}
```

### 7.7 Step 7 — `main.js`: chat ordering, keyless candidate, gateway IPC

**7a. Order the chat candidates by mode** (`main.js:573-578`). Today:

```js
const preferred = p.provider || 'gemini';
const providers = Encrypt.getConfig('providers') || {};
const order = [preferred, 'gemini', 'groq', 'kimi', 'openrouter'].filter((v, i, a) => v && a.indexOf(v) === i);
```

```js
// AFTER
const preferred = p.provider || 'gemini';
const providers = Encrypt.getConfig('providers') || {};
const gw = ApiManager.getGatewayConfig();
// gateway.mode mirrors _buildRoutingChain(): 'primary' tries the local gateway
// first, 'fallback' keeps it as the last-resort attempt, 'exclusive' uses it
// alone. Keeping the two ordering rules identical is what makes the UI's
// "Active Chain" chips truthful for both the chat view and Force-Run.
const baseOrder = gw.mode === 'exclusive'
    ? ['omniroute']
    : (gw.mode === 'primary'
        ? ['omniroute', preferred, 'gemini', 'groq', 'kimi', 'openrouter']
        : [preferred, 'gemini', 'groq', 'kimi', 'openrouter', 'omniroute']);
const order = baseOrder.filter((v, i, a) => v && a.indexOf(v) === i);
```

**7b. Exempt the gateway from the "must have a stored key" rule** (`main.js:584-597`). The loop starts with `let keys = [conf.apiKey, ...]` and `if (!keys.length) continue;` - a keyless gateway would be dropped. Insert before that:

```js
for (const name of order) {
    // The gateway is keyless on loopback (live-verified: only /v1/models needs
    // the key), so it must not be dropped for "no stored key". A stopped or
    // 502-ing gateway is reported as a normal provider failure instead.
    if (name === 'omniroute') {
        if (!gw.enabled) continue;
        candidates.push({ name, keys: [String(gw.apiKey || '')], model: gw.model || 'auto' });
        continue;
    }
    const conf = providers[name] || {};
    /* ...existing key pool / dead-key / dedication logic unchanged... */
}
```

**7c. One new IPC channel** - put it next to `api:fetch-models` (`main.js:445`):

```js
// OmniRoute gateway status for the Dashboard chip / AI Settings card.
// Zero quota: an unauthenticated health probe plus GET /v1/models.
// The gateway is a SEPARATE process (Node >= 22.22.2 while Electron 29 embeds
// Node 20), so AutoDash never spawns or require()s it - it only reports on it.
// No "open dashboard" IPC is needed: the XAMPP card already links out through
// the existing system:openUrl handler (preload: api.openUrl), and the gateway
// dashboard URL is just `${serverUrl}/dashboard`.
ipcMain.handle('omniroute:status', async () => {
    try {
        return { success: true, status: await ApiManager.probeGateway() };
    } catch (error) {
        log.warn(`Gateway probe failed: ${error.message}`);
        return { success: false, error: error.message };
    }
});
```

### 7.8 Step 8 — `preload.js` and the React views

**8a. `preload.js`** - extend the bridge next to `getXamppStatus` (`preload.js:38-39`):

```js
    // OmniRoute gateway status (health + key + model count). Mirrors
    // getXamppStatus so the UI stays consistent. No "open dashboard" method is
    // added: api.openUrl (system:openUrl) already exists and is what the XAMPP
    // card uses to open its dashboard.
    getGatewayStatus: () => ipcRenderer.invoke('omniroute:status'),
```

`ui/src/lib/api.js` needs **no change** (it forwards `window.electronAPI` wholesale through the `api` proxy).

**8b. `ui/src/views/ApiKeys.jsx`** - the provider list is at line 8, labels at line ~9, `MODEL_OPTIONS` at line 16:

```js
const PROVIDERS = ['omniroute', 'gemini', 'groq', 'kimi', 'openrouter'];
const PROVIDER_LABELS = { omniroute: 'OmniRoute (local gateway)', gemini: 'Gemini', groq: 'Groq', kimi: 'Kimi', openrouter: 'OpenRouter' };
// MODEL_OPTIONS.omniroute = ['auto', 'auto:fast', 'auto:cheap']   // live list via Fetch Models
```

Every existing control then works per provider unchanged (`Test`, `Check Status`/probe, `Fetch Models`, Configured/Missing badge) because the IPC layer now understands `provider === 'omniroute'`. Only two UI details need care:

* the **"Configured/Missing" badge** must treat the gateway as configured when either the gateway key *or* an enabled gateway exists (loopback chat works keyless) - otherwise a keyless-but-working gateway reads as "Missing";
* the **Save path** must write `gateway.apiKey` / `gateway.enabled`, not `providers.omniroute.apiKey` (that key is intentionally unused - §7.1 note 1).

**8c. A gateway card in the same view.** The codebase has **no** `Card`/`Row`/`Toggle` components - every view uses `ad-card` + inline styles + `motion` (see the XAMPP card at `Settings.jsx:221-262`). The card below copies that markup 1:1, including the chip colours and the `btnBase` button style from `ApiKeys.jsx:34`:

```jsx
{/* OmniRoute gateway — modelled on the XAMPP & Database card (ad-card wrapper,
    labelStyle header, inline chip spans, btnBase buttons, api.openUrl links). */}
<motion.div className="ad-card" style={{ padding: 18 }}
  initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.28 }}>
  <div style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
    <Server size={13} color="var(--color-accent)" /> OmniRoute Gateway
  </div>

  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
    {(gwStatus ? [
      { label: `Server: ${gwStatus.reachable ? `up (${gwStatus.latencyMs}ms)` : 'down'}`, ok: gwStatus.reachable },
      { label: gwStatus.healthy ? 'Health: healthy' : 'Health: degraded', ok: gwStatus.healthy },
      { label: gwStatus.keyValid === null ? 'Key: not checked' : (gwStatus.keyValid ? 'Key: valid' : 'Key: rejected'), ok: gwStatus.keyValid !== false },
      { label: `Models: ${gwStatus.models}`, ok: gwStatus.models > 0 },
      { label: `Mode: ${gwStatus.enabled ? gwStatus.mode : 'off'}`, ok: gwStatus.enabled },
    ] : [{ label: 'Checking OmniRoute…', ok: false }]).map((c) => (
      <span key={c.label} style={gatewayChipStyle(c.ok)}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: 'currentColor' }} />
        {c.label}
      </span>
    ))}
  </div>

  <div style={{ fontSize: 12.5, marginBottom: 12, lineHeight: 2 }}>
    <div style={{ color: 'var(--color-muted)' }}>
      API base: <span className="num" style={{ color: 'var(--color-fg)' }}>{gwCfg.baseUrl}</span>
      <button
        onClick={() => api.openUrl(`${gwCfg.baseUrl.replace(/\/v1\/?$/, '')}/dashboard`)}
        title="Open the OmniRoute dashboard"
        style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: '1px solid var(--color-border)', borderRadius: 7, color: 'var(--color-accent-soft)', fontSize: 11.5, padding: '3px 9px', cursor: 'pointer' }}>
        <ExternalLink size={12} /> dashboard
      </button>
    </div>
  </div>

  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
    <motion.button whileTap={{ scale: 0.96 }} style={btnBase}
      onClick={() => saveGateway({ ...gwCfg, enabled: !gwCfg.enabled })}>
      {gwCfg.enabled ? 'Disable gateway' : 'Enable gateway'}
    </motion.button>
    <motion.button whileTap={{ scale: 0.96 }} style={btnBase} onClick={refreshGateway}>
      <RefreshCw size={14} /> Refresh
    </motion.button>
    <motion.button whileTap={{ scale: 0.96 }} style={btnBase}
      onClick={() => api.probeKey('omniroute', gwCfg.apiKey)}>
      <ShieldCheck size={14} /> Check Status
    </motion.button>
    <motion.button whileTap={{ scale: 0.96 }} style={btnBase} onClick={() => api.fetchModels('omniroute')}>
      <CloudDownload size={14} /> Fetch Models
    </motion.button>
  </div>

  {gwStatus?.suggestions?.length ? (
    <ul style={{ margin: '10px 0 0 16px', padding: 0, fontSize: 12, color: 'var(--color-muted)', lineHeight: 1.7 }}>
      {gwStatus.suggestions.map((s) => <li key={s}>{s}</li>)}
    </ul>
  ) : null}
</motion.div>
```

Supporting pieces, all in the existing style: `gatewayChipStyle(ok)` is the chip object copied from `Settings.jsx:230-238` (border/background tinted `var(--color-ok)` vs `var(--color-warn)`); the **mode** control is a plain `<select>` exactly like the model/routing selects in `AiSettings.jsx`; the **base URL** and **gateway key** fields reuse the provider-row input styling and the `typed` state pattern (`ApiKeys.jsx:45`); `saveGateway(patch)` is `mergeConfig('gateway', patch)` already exported from `ui/src/lib/api.js`; new icons (`Server`, `RefreshCw`, `ExternalLink`) are already imported in `Settings.jsx` and `CloudDownload`/`ShieldCheck` already in `ApiKeys.jsx`.

**8d. `ui/src/views/AiSettings.jsx`** - same `PROVIDERS` / `PROVIDER_LABELS` additions (line 8-9) so the priority up/down list, the "Active Chain" chips and the model dropdown include OmniRoute. Recommended extra: show the mode selector here too (it is a *routing* decision), and grey the gateway chip out when `enabled === false`, exactly like the existing dropped-provider chips.

**8e. `ui/src/views/Dashboard.jsx`** - add one chip to the existing System Status card: `gateway: up/down + mode`, fed by `api.getGatewayStatus()`. Cheap because the health endpoint is unauthenticated and local (≈3-10 ms measured locally vs. the 4 s Internet probes already there).

### 7.9 Step 9 — `scheduler.js` pre-run health gate

**9a. Register the call function** (`scheduler.js:70-75` `callFns` map):

```js
const callFns = {
    gemini:     (p, k, m, o) => ApiManager._callGemini(p, k, m, o, 'gemini'),
    kimi:       (p, k, m, o) => ApiManager._callKimi(p, k, m, o),
    groq:       (p, k, m, o) => ApiManager._callGroq(p, k, m, o),
    openrouter: (p, k, m, o) => ApiManager._callOpenrouter(p, k, m, o),
    omniroute:  (p, k, m, o) => ApiManager._callOmniroute(p, k, m, o)
};
```

**9b. Do not skip the gateway for "no key"** (`scheduler.js:80-84`). The guard `if (!conf.enabled || !entry.apiKey)` would drop it:

```js
for (const entry of chain) {
    const name = entry.name;
    const conf = providers[name] || {};
    // OmniRoute stores its key in the `gateway` block (and loopback chat works
    // keyless), so the per-provider key guard below must not skip it.
    const isGateway = name === 'omniroute';
    if (!isGateway && (!conf.enabled || !entry.apiKey)) {
        summary[name] = { ok: false, latencyMs: 0, error: 'disabled or no key' };
        continue;
    }
    /* ...existing try/catch unchanged... */
}
```

**9c. One extra gate for the local dependency.** The pre-run gate already exists for exactly this class of problem ("0 healthy providers → fail fast instead of writing an empty `~/Desktop/Dashboard`", see `memory-bank/activeContext.md`). When the gateway is `primary`/`exclusive`, probe the *server* before spending a generation on it:

```js
// Cheap precondition for mode primary/exclusive: a stopped gateway must be
// reported as the reason, not as a mystery 502 after 3 retries.
const gwCfg = ApiManager.getGatewayConfig();
if (gatewayModeIsPrimaryOrExclusive) {
    const gwStatus = await ApiManager.probeGateway();
    if (!gwStatus.reachable) {
        summary.omniroute = { ok: false, latencyMs: gwStatus.latencyMs, error: 'gateway not reachable on 127.0.0.1:20128 (run "omniroute serve")' };
    }
}
```

### 7.10 Step 10 — voice input through the gateway (optional, **default off**)

Only worth doing once §12.3 test `T7` proves `/v1/audio/transcriptions` exists on this build. Add a new flag to the `gateway` block from §7.1 - `"transcribe": false` - because this is the one path where the gateway's advantage is marginal (Groq Whisper is already the fastest option available to AutoDash).

```js
// ---- 0) OmniRoute gateway (optional, gateway.transcribe === true) ----------
const gw = gatewayConfig();
if (gw.transcribe === true && gw.apiKey) {
    try {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: mimeType }), `dictation.${ext}`);
        form.append('model', 'whisper-large-v3');   // omit to let the gateway route
        if (p.language) form.append('language', String(p.language));
        const r = await axios.post(gatewayUrl(gw, 'audio'), form, {
            headers: { Authorization: `Bearer ${gw.apiKey}` },   // no Content-Type: FormData sets it
            timeout: 60000, maxBodyLength: Infinity, proxy: false
        });
        const text = String((r.data && r.data.text) || '').trim();
        if (text) return { success: true, text, provider: 'omniroute', model: 'whisper-large-v3', engine: 'OmniRoute gateway', attempts };
        attempts.push({ provider: 'omniroute', ok: false, error: 'Empty transcript returned.' });
    } catch (error) {
        attempts.push({ provider: 'omniroute', ok: false, error: error.message, suggestions: gatewayErrorHint({ status: error.response && error.response.status, message: error.message }) });
    }
}
// ---- 1) Groq Whisper ... (existing, unchanged) ---------------------------
```

---

## 8. Configuration Change Inventory

### 8.1 AutoDash side (all inside the encrypted `electron-store`, via `config:save`)

| Key | Default | Written by | Meaning |
| --- | --- | --- | --- |
| `gateway.enabled` | `false` | ApiKeys / AiSettings toggle | **the only** on/off switch for OmniRoute |
| `gateway.baseUrl` | `http://127.0.0.1:20128/v1` | AI Settings input | OpenAI-compatible base; `/api/monitoring/health` is derived by stripping `/v1` |
| `gateway.apiKey` | `""` | ApiKeys password field | gateway key from dashboard → Endpoints; required by `/v1/models` |
| `gateway.model` | `"auto"` | AI Settings | what is sent when `passModelThrough` is false |
| `gateway.mode` | `"fallback"` | AI Settings select | `primary` \| `fallback` \| `exclusive` |
| `gateway.sendUsage` | `true` | (advanced) | adds `stream_options.include_usage` for exact token counts |
| `gateway.passModelThrough` | `false` | (advanced) | send the provider's configured model instead of `auto` |
| `gateway.timeoutMs` | `180000` | (advanced) | long, because the gateway may walk several upstreams inside one request |
| `gateway.healthTimeoutMs` | `3000` | (advanced) | health/status probe budget |
| `gateway.transcribe` | `false` | (advanced) | opt-in voice routing (§7.10) |
| `gateway.paths` | see §7.1 | — | path map, so an upstream version that moves an endpoint is a config change, not a code change |
| `providers.omniroute.*` | `model: 'auto'`, `priority: 5` | AI Settings | generation overrides only; `enabled` is **ignored** (§7.1 note 1) |

**No new environment variables are required on the AutoDash side** (`AUTODASH_MASTER_PASSWORD` remains the only env input the app reads). The gateway key is encrypted by the existing AES-256-CTR store, i.e. the same protection as every provider key.

### 8.2 OmniRoute side (`C:\Users\Abuzer Kakar\.omniroute\.env`)

Currently this file contains **only** `STORAGE_ENCRYPTION_KEY`. Recommended additions (all are documented in the installed `.env.example`):

| Variable | Recommended | Why |
| --- | --- | --- |
| `OMNIROUTE_SERVER_HOST` | `127.0.0.1` | the running server binds `0.0.0.0` today (its own startup warning says so) — a laptop on a café/hostel network is reachable from any peer |
| `INITIAL_PASSWORD` / dashboard password | non-default | startup log states the management password is the shipped `CHANGEME` |
| `REQUIRE_API_KEY` | `true` (after P3) | makes loopback behave exactly like remote, so the code path AutoDash tests is the code path production uses |
| `PORT` | `20128` (default) | only change it if something else uses the port — then update `gateway.baseUrl` |
| `SWAGGER`/`MODELS_DEV_SYNC_ENABLED` etc. | leave off | irrelevant to AutoDash and adds startup time |

Restart after editing: `omniroute restart` (or `omniroute stop` then `omniroute serve`).

---

## 9. Files Touched (complete list) and Build Impact

| File | Step(s) | Nature of change | Risk of the change alone |
| --- | --- | --- | --- |
| `src/config/default-config.json` | 7.1 | +2 JSON blocks (default off) | none (no behaviour change while `enabled:false`) |
| `src/modules/apiManager.js` | 7.2-7.6, 7.10 | helpers, 1 resolver, 1 call fn, 3 branches, 1 error projector, 1 status probe, exports | low; every branch is guarded by `provider === 'omniroute'` / `gateway.enabled` |
| `main.js` | 7.7 | candidate ordering, keyless exemption, 1 IPC handler (`omniroute:status`) | low |
| `preload.js` | 7.8a | 1 bridge method (`getGatewayStatus`) | none |
| `ui/src/views/ApiKeys.jsx` | 7.8b-c | provider list + labels + gateway card | none |
| `ui/src/views/AiSettings.jsx` | 7.8d | provider list + labels (+ mode select) | none |
| `ui/src/views/Dashboard.jsx` | 7.8e | 1 status chip | none |
| `src/modules/scheduler.js` | 7.9 | callFns entry + guard exemption (+ optional precondition) | low |
| **new** `test-gateway-path.js` (project root) | 7.2/§12.3 | node smoke test following the existing `test-chat-payload.js` pattern | none |

**No new npm dependencies.** `axios` and Node's global `FormData`/`Blob` (already used by `transcribeAudio`) cover everything. **UI must be rebuilt** because the renderer is prebuilt: `cd ui && npm run build` writes to `../src/renderer/react` with `emptyOutDir: true` (`ui/vite.config.js:10`), then `npm start` in the project root.

---

## 10. Risk Assessment

| # | Risk | Evidence / likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | **Gateway has no upstream providers → every request 502s** | observed live (`bad_gateway`, 402/403/429 list) | high — turns a working router into a failing extra hop | P2 (`omniroute keys add …`) is a **hard precondition**; ship with `enabled:false` + `mode:"fallback"`; `probeGateway()` surfaces "upstream providers missing" as an explicit suggestion |
| R2 | **Gateway process not running / uninstalled / port changed** | likely on any other machine | medium — chat and Force-Run lose one provider | `gatewayErrorHint()` maps `ECONNREFUSED` to "run `omniroute serve`"; scheduler precondition (§7.9c) fails fast with the real reason; direct providers stay enabled in `primary`/`fallback` |
| R3 | **Cold start > 60 s** (159 DB migrations, first boot after install/update) | observed in `omniroute_serve.log` ("did not respond within 60s") | medium — first run of a session looks broken | `healthTimeoutMs` 3 s keeps the UI responsive; `timeoutMs` 180 s for generation; documented "retry before renaming the port" hint |
| R4 | **Node engine mismatch** (`>=22.22.2` vs Electron 29's Node 20) | package.json engines | high if violated | integration is **HTTP-only** (never `require`/spawn from Electron); document "the gateway runs on system Node (**v24.19.0** verified here)"; the app reports its absence instead of crashing |
| R5 | **Local dependency becomes a single point of failure** (`exclusive`, or `primary` while direct keys are dead) | design consequence | high for the user's workflow | `exclusive` requires an explicit user choice in the UI, with an inline warning; `fallback` is the default; `healthCheckProviders()` refuses to start a run with 0 healthy providers |
| R6 | **Latency multiplication**: one gateway request may internally try several upstreams (4 attempts observed), and AutoDash then retries that on top | observed `diagnostics.attempted = 4`; `_withRetry` + `routing.maxRetries` up to 4 | medium — slower failures, possible duplicate spend | cap the gateway entry at **one** AutoDash attempt, because the gateway already fails over internally: |
| R7 | **Prompt transformation** (compression/RTK+Caveman, payloadRules, modelAliases, transforms) changing the master blueprint prompt | OmniRoute feature set; not yet verified against AutoDash's 5-10 KB blueprint prompt | high for Force-Run output quality | verify with a sentinel test (`T6`); if it alters the prompt, keep the gateway for chat only, or disable compression for it; `gateway.mode` + `providers.omniroute.priority` make that a one-line change |
| R8 | **Cost visibility moves out of AutoDash** | gateway is one line item; `providers.omniroute.costPerMillion*` is 0 | low/medium — the Cost screen under-reports | link the gateway dashboard from the card; optionally parse `omniroute cost --output json` later (out of scope for the first release) |
| R9 | **Credentials now live in two stores** | AutoDash `config.json` (AES-256-CTR) + `~/.omniroute/storage.sqlite` (its own key in a plaintext `.env`) | medium — two places to rotate/leak | document it in the card ("provider keys are managed by OmniRoute"); treat `%USERPROFILE%\.omniroute` as secret; rotate both on suspicion |
| R10 | **Network exposure of the gateway** (`0.0.0.0` + default `CHANGEME` password, verified today) | live: serve log warning + no auth vars in `.env` | **high** if the machine is on an untrusted LAN | P4: `OMNIROUTE_SERVER_HOST=127.0.0.1`, change the manager password, then optionally `REQUIRE_API_KEY=true` |
| R11 | **Upstream version drift** (`omniroute update`; 3.8.x moves fast) | package version `3.8.50`, self-migrating DB | medium — endpoint or behaviour change breaks the adapter | `gateway.paths` makes path moves config-only; run `T1-T7` after every upgrade; keep `enabled` off while upgrading |
| R12 | **Localhost proxy hijack** | the codebase already hit this class of bug (`xampp.js verifyHealth` uses `proxy:false`) | low | every gateway call in §7 uses `proxy: false` |

**R6 mitigation, as code** - inside `_buildRoutingChain()`'s `.map()`, for the gateway entry only:

```js
// The gateway performs its own upstream failover (diagnostics.attemptOrder), so
// AutoDash retrying it N times multiplies wall-clock time and can double-spend
// on a partially successful upstream. One attempt is enough; the next provider
// in the chain is the better plan B.
attempts: name === 'omniroute' ? 1 : maxRetries,
```

---

## 11. Phased Rollout

| Phase | Scope | Deliverable | Exit criteria (must be true before the next phase) |
| --- | --- | --- | --- |
| **P0 — visibility only** | 7.1, 7.2, 7.6c-d, 7.7c, 7.8a/e | config block (off), gateway status probe, the `omniroute:status` IPC + `getGatewayStatus` bridge, Dashboard chip, error-hint projector | chip reports `up / healthy / key valid / N models` on this machine; node smoke test of `probeGateway()` green; **no** routing change |
| **P1 — chat as last resort** | 7.3, 7.4a-e, 7.5, 7.7a-b, 7.8b-d | `omniroute` is a real provider in the chain; chat + Fetch Models + Check Status work | with `mode:"fallback"` a chat message still goes to Gemini first and only reaches the gateway when everything else fails; `T5` (usage) confirmed or disabled |
| **P2 — gateway first** | config only: `mode:"primary"` (per user) + the `attempts:1` refinement from §10 | gateway first, direct providers as backup | 10 consecutive chat turns + 1 full Force-Run with the gateway first, no regression in `runs/history.json` file counts; `T6` (prompt integrity) passes |
| **P3 — consolidation / extras** | 7.9c, 7.10, optional `omniroute cost` parsing | gateway-only mode available, voice opt-in, cost link | `mode:"exclusive"` survives a gateway restart mid-session without a crash; rollback (§13) verified once |

Nothing in P0-P2 deletes or rewrites existing provider code, so every phase is independently shippable.

---

## 12. Verification Plan

### 12.1 Already executed during this assessment (baseline, no code changes)

| ID | Command | Expected / observed |
| --- | --- | --- |
| B1 | `node -v` | v24.19.0 ✅ |
| B2 | `curl.exe -s http://127.0.0.1:20128/api/monitoring/health` | `{"status":"healthy","setupComplete":true}` ✅ |
| B3 | `Invoke-WebRequest http://127.0.0.1:20128/dashboard` | HTTP 200 ✅ |
| B4 | `curl.exe -s .../v1/models` (no key) | HTTP 401 `Authentication required` ✅ (informs §7.6a) |
| B5 | `curl.exe -s -H "Authorization: Bearer dummy-test-key" .../v1/models` | HTTP 401 `Invalid API key` ✅ (informs the badge wording) |
| B6 | `curl.exe -s -X POST .../v1/chat/completions -d @or-body.json` | HTTP 502 + `diagnostics` ✅ (informs R1 and the hint projector) |
| B7 | `curl.exe -s .../api/keys` | HTTP 401 `AUTH_001` ✅ |

Gotcha worth keeping: `curl.exe -d '{"model":"auto",...}'` from PowerShell **mangles the JSON** and the gateway answers `400 Invalid JSON body`. Always write the body to a file and use `--data-binary "@$env:TEMP\or-body.json"` (as in §7.0) — a "bad request" there is a test-harness artefact, not a gateway fault.

### 12.2 Static checks after each code step

```powershell
cd 'C:\Users\Abuzer Kakar\Desktop\autodash-control-panel'
node --check src/modules/apiManager.js   # must exit 0
node --check main.js                     # must exit 0
node --check src/modules/scheduler.js    # must exit 0
node test-chat-payload.js                # existing pure-node test must stay green
cd ui; npm run build                     # renderer rebuild (outDir ../src/renderer/react)
```

### 12.3 New tests to add

| ID | Test | How | Pass condition |
| --- | --- | --- | --- |
| T1 | Health probe shape | node under Electron: `ApiManager.probeGateway()` with the gateway stopped, then started | stopped → `reachable:false` + a suggestion mentioning `omniroute serve`; started → `reachable:true, healthy:true` |
| T2 | Gateway key gate | `probeKey('omniroute', '')` then with the real key | empty → `kind:'missing-key'`; real → `valid:true` and `models.length > 0` |
| T3 | Model listing | `api:fetch-models` for `omniroute` in the UI | returns the live catalog, or the static `['auto', …]` list **with a warning** |
| T4 | Routing decision (pure) | `ApiManager.resolveChatTarget('omniroute', { messages: [], stream: true })` vs `('groq', …)` | omni → url ends `/v1/chat/completions` with `stream_options.include_usage`; groq → `api.groq.com` with `Bearer <key>` |
| T5 | Streamed usage | one streamed chat turn; inspect the final SSE chunk | `usage.total_tokens` present → `exactTokens` replaces the per-chunk estimate; absent → keep the estimate and set `gateway.sendUsage:false` in the docs |
| T6 | Prompt integrity (R7) | send a sentinel request: a long system prompt containing `SENTINEL-7f3a` plus a numbered 12-item instruction list | the answer respects items 1-12 in order and echoes the sentinel; any reordering or omission means a transform is active → keep the gateway out of Force-Run |
| T7 | Audio endpoint exists | `curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Authorization: Bearer <key>" -F "file=@x.webm" -F "model=whisper-large-v3" http://127.0.0.1:20128/v1/audio/transcriptions` | `200`/`400`/`422` = endpoint exists (keep §7.10 opt-in); `404` = not on this build, drop §7.10 |
| T8 | Offline behaviour | stop OmniRoute, then send a chat message | UI shows the "nothing is listening on 127.0.0.1:20128" hint, falls through to the direct providers, no crash, no hang |

**T1/T4/T8 need Electron** because `apiManager.js` requires `encryption.js` → `electron-store`. Follow the project's existing probe pattern (`probe-diag.js`, `test-react-harness.js`) and set the store path **before** requiring anything, otherwise the probe reads the stale default store and reports "0 keys":

```js
// test-gateway-path.js — run with: npx electron test-gateway-path.js
const path = require('path');
const { app } = require('electron');
app.setPath('userData', path.join(process.env.APPDATA || '', 'autodash-control-panel'));
const ApiManager = require('./src/modules/apiManager');

(async () => {
    const target = ApiManager.resolveChatTarget('omniroute', { messages: [{ role: 'user', content: 'hi' }], stream: true });
    console.log('chat target:', target.url, '| viaGateway:', target.viaGateway, '| body:', JSON.stringify(target.body));
    const status = await ApiManager.probeGateway();
    console.log('gateway status:', JSON.stringify(status, null, 2));
    app.exit(status.reachable ? 0 : 1);
})();
```

### 12.4 Acceptance gates before promoting to `mode:"primary"` / `"exclusive"`

1. `omniroute keys list` shows **at least two** providers with credentials, at least one of them a paid/primary provider (not free tiers only).
2. Twenty consecutive chat turns: zero `502`s, zero raw socket errors in the Error Center, and `runs/usage.json` gains an `omniroute` entry per turn.
3. One full Force-Run completes and writes the same file set as a Gemini-only run (`runs/history.json` → `files[]` non-empty, all prompt phases `completed`, XAMPP deploy still succeeds).
4. `T6` passes with the real `prompts/master-system-prompt.txt` blueprint.
5. Killing the gateway mid-session produces a clean error plus automatic fall-through, never a hang (`T8`).
6. `memory-bank/activeContext.md` records the outcome and the new failure modes actually observed - this project's convention for every feature.

---

## 13. Rollback Plan

| Level | Action | Time to revert | Residual risk |
| --- | --- | --- | --- |
| Config only | set `gateway.enabled:false` in AI Settings (or `config:save` for module `gateway`) | seconds | none — the code path is already skipped |
| Chain position | switch `gateway.mode` back to `fallback` | seconds | none |
| Code | `git checkout` the §9 file list; rebuild the UI (`cd ui; npm run build`) | minutes | none — no data migration was performed, no stored key format changed |
| OmniRoute itself | leave it installed but stopped (`omniroute stop`), or uninstall | minutes | AutoDash unaffected while `enabled:false` |

**Explicitly no destructive operation is required for rollback:** the integration never rewrites `providers.*`, never migrates `runs/usage.json`, and never changes `encryption.js`'s stored shape. The only new stored module is `gateway`, which defaults to off.

---

## 14. Open Questions / Decisions Needed

| # | Question | Why it blocks something | How to resolve |
| --- | --- | --- | --- |
| Q1 | **How is a gateway client key created on this build?** Dashboard → Endpoints is documented; `/api/keys` is 401 and `omniroute keys add` is for *provider* credentials | blocks P1's `Fetch Models` / key badge | `omniroute keys --help` and `omniroute tokens --help` (a `tokens` command exists in `or_help.txt`), or create one in the dashboard and copy it. If a CLI path exists, a "Create key" button becomes possible later |
| Q2 | **Is POST really keyless while GET /v1/models is not?** Observed live (B4 vs B6); the README also says `auto` works with "no API key" | decides whether AutoDash *needs* `gateway.apiKey` or should treat it as optional-but-recommended | deliberately implemented as optional in §7, and re-verify after setting `REQUIRE_API_KEY=true` (§8.2) |
| Q3 | **Which upstream providers should be imported into the gateway?** | P2 acceptance needs ≥ 2 credentialed providers (R1) | user decision; the CLI is `omniroute keys add <provider> <key>` |
| Q4 | **Does `usage` carry a cost field on this build?** | decides §7.3d (local cost vs. linked dashboard) | T5 |
| Q5 | **Are compression / transforms active for a 5-10 KB system prompt?** | R7 / T6 - could change Force-Run output quality silently | T6; if yes, keep `mode` at `fallback` for automation and `primary` for chat |
| Q6 | **Should AutoDash ever start OmniRoute itself?** | lifecycle UX | **Recommendation: no, not in v1.** OmniRoute ships its own `serve`/`tray`/`autostart`, and Electron's Node 20 cannot supervise a Node ≥ 22 process. AutoDash reports status + links to the dashboard (like the XAMPP card, which *does* manage its own services because they are plain executables) |
| Q7 | **Remote gateway (another machine on the LAN)?** | not needed today | `gateway.baseUrl` already allows it; only revisit if the user runs OmniRoute on a server (then `REQUIRE_API_KEY=true` becomes mandatory, not optional) |

---

## 15. Appendix

### 15.1 Endpoint reference (as used by this design)

| Endpoint | Method | Auth | Verified on this machine | Used by |
| --- | --- | --- | --- | --- |
| `/api/monitoring/health` | GET | none | ✅ 200 `{"status":"healthy","setupComplete":true}` | `probeGateway()`, Dashboard chip, scheduler precondition |
| `/v1/models` | GET | `Bearer <gateway key>` | ✅ 401 without key, 401 with bogus key | `fetchModels()`, `probeKey()`, "Fetch Models" button |
| `/v1/chat/completions` | POST | optional on loopback | ✅ reached routing; 502 while no upstream providers | `chatStream()`, `_callOmniroute()` |
| `/v1/responses` | POST | as above | not tested | future (OpenAI Responses clients) |
| `/v1/audio/transcriptions` | POST | `Bearer <gateway key>` | **not verified** (T7) | §7.10 (opt-in) |
| `/dashboard` | GET | management session | ✅ 200 | "Open Dashboard" button |
| `/api/keys` | GET | management session | ✅ 401 `AUTH_001` without a session | not used by AutoDash |

### 15.2 Command reference

**AutoDash side** (project root `C:\Users\Abuzer Kakar\Desktop\autodash-control-panel`):

```powershell
npm start                      # run the app
node --check main.js           # syntax gate for the Electron main process
node test-chat-payload.js      # existing pure-node unit test
npx electron test-gateway-path.js   # new gateway smoke test (§12.3)
cd ui; npm run build           # rebuild the React renderer into src/renderer/react
```

**OmniRoute side:**

```powershell
omniroute serve              # start (dashboard + API on 20128)
omniroute stop / restart
omniroute status / health    # CLI-side status
omniroute keys add gemini <key>     # import a provider credential
omniroute keys list
omniroute models [provider]  # live catalog (requires the server)
omniroute logs / cost / usage       # request log, spend, quotas
omniroute open dashboard
omniroute simulate <prompt>  # dry-run routing, no upstream call
omniroute update             # upgrade (re-run §12.3 tests afterwards: R11)
```

### 15.3 Glossary

| Term | Meaning in this report |
| --- | --- |
| **Gateway** | the local OmniRoute server at `http://127.0.0.1:20128`, exposing `/v1` (inference) and `/dashboard` (management) |
| **Gateway key** | the client credential for `/v1` (dashboard → Endpoints); distinct from a **provider key** (Gemini/Groq/…) which OmniRoute stores for its own upstream calls |
| **`auto`** | OmniRoute's zero-config model alias that lets the gateway choose the upstream model/provider |
| **`mode`** | how the gateway participates in AutoDash's chain: `primary` (first), `fallback` (last), `exclusive` (only) |
| **Chunked usage / `stream_options.include_usage`** | the OpenAI convention that puts a `usage` object in the final streamed chunk, enabling exact token counts |
| **Chain** | `apiManager._buildRoutingChain()`'s ordered list of provider entries an attempt walks |

### 15.4 Recommended next actions (in order)

1. **P4 first** (security, 5 minutes): add `OMNIROUTE_SERVER_HOST=127.0.0.1` to `C:\Users\Abuzer Kakar\.omniroute\.env`, change the dashboard password away from `CHANGEME`, then `omniroute restart`.
2. **P2 first** (make the gateway useful): `omniroute keys add gemini <AQ.…>` (and Groq/OpenRouter as available), then re-run the §7.0 `curl` pair; the chat completion must stop returning 502.
3. **Create a gateway key** in the dashboard → Endpoints; verify `curl -H "Authorization: Bearer <key>" .../v1/models` returns 200 (this is the gate for `Fetch Models`).
4. **Implement P0 only** (§7.1, §7.2, §7.6c-d, §7.7c, §7.8a/e) and stop there until `test-gateway-path.js` passes - it is the phase with zero routing risk and it makes the gateway's real state visible in the UI.
5. **Then P1** (§7.3-7.5, §7.7a-b, §7.8b-d) behind `mode:"fallback"`, and only promote to `primary` when §12.4's six gates are met.
6. **Record the outcome** in `memory-bank/activeContext.md` (project convention), including which hypotheses in this report turned out wrong - especially Q2 (keyless POST) and Q5 (prompt transforms).

---

### Document control

* **Sources:** OmniRoute `3.8.50` installed package (`%APPDATA%\npm\node_modules\omniroute`), its live server on `127.0.0.1:20128`, the CLI captures in `Desktop\workspace`, and the AutoDash source tree listed in §2.1.
* **Not verified by this report** (explicitly out of scope): `/v1/responses`, `/v1/audio/transcriptions`, MCP/A2A surfaces, batch/memory features, remote-gateway mode, and any behaviour of OmniRoute versions other than 3.8.50.
* **Companion artifacts to create when implementing:** `test-gateway-path.js` (§12.3) and, if §7.10 is adopted, an audio-path fixture.
* **Document status:** the exact file/line anchors in §3.2 and §7 refer to the AutoDash working tree as read on 2026-09-27; re-check the anchors with a search if the tree has moved on before the diffs are applied.

















