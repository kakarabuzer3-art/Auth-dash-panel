# Project Brief: AutoDash Control Panel

## Identity
- **Project name:** AutoDash Control Panel
- **Type:** Electron.js desktop application
- **Version:** 1.0.0 (`package.json`)
- **Location:** C:/Users/Abuzer Kakar/Desktop/autodash-control-panel

## Purpose
Automate AI-powered dashboard generation at a scheduled time. The app:
1. Loads ordered, multi-language prompts from `prompts/frontend/` and `prompts/backend/`.
2. Sends each prompt through a multi-provider AI router (Gemini / Groq / Kimi / OpenRouter).
3. Writes the generated multi-file response into the output workspace.
4. Launches VS Code once and dispatches remaining prompts to the Cline extension.

## Platform & Environment
- **OS:** Windows 10
- **Shell:** PowerShell (all commands must be PowerShell-compatible; no Linux paths)
- **Runtime:** Node.js + Electron ^29.1.4
- **Entry point:** `main.js` (`npm start` → `electron .`)

## Scope
- Desktop control panel: Dashboard, Scheduler, API Keys, AI Settings, Prompts Manager,
  VS Code automation, Logs, Settings views.
- Encrypted local config storage (AES-256-CTR + Electron safeStorage).
- Scheduled (cron-style) or manual ("Force Run") execution of the generation pipeline.

## Non-Goals
- No cloud backend of its own; all AI calls go to third-party provider APIs.
- No framework frontend inside the control panel itself (vanilla HTML/CSS/JS).
