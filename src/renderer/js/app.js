/**
 * @file app.js
 * @description Renderer process logic. Handles DOM updates, form submissions, and IPC communication.
 */


    // === Toast notification system (replaces native alert dialogs) ===
    // Non-blocking toasts shown in top-right corner.
    // Types: 'success' | 'error' | 'warning' | 'info'
    function showToast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast toast-' + type;
        toast.innerHTML =
            '<span class="toast-icon"></span>' +
            '<span class="toast-body">' + String(message).replace(/</g, '&lt;') + '</span>' +
            '<button class="toast-close" title="Dismiss">×</button>';
        container.appendChild(toast);
        const closeBtn = toast.querySelector('.toast-close');
        closeBtn.addEventListener('click', function () { toast.remove(); });
        setTimeout(function () {
            if (toast.parentNode) {
                toast.style.opacity = '0';
                toast.style.transition = 'opacity 0.3s ease';
                setTimeout(function () { toast.remove(); }, 300);
            }
        }, 4000);
    }

    // === Panel loading state helper ===
    // Toggles the 'is-loading' class on a panel to show spinner overlay.
    // Pair with .panel-loading CSS classes.
    function setPanelLoading(panelId, loading) {
        var panel = document.getElementById(panelId);
        if (!panel) return;
        panel.classList.toggle('is-loading', loading);
    }

    // === Save button state helper ===
    // Toggles 'btn_saving' class on a button to show inline spinner overlay.
    // Call with true at start of save, false after save completes.
    function setButtonSaving(btnId, saving) {
        var btn = document.getElementById(btnId);
        if (!btn) return;
        btn.classList.toggle('btn_saving', saving);
    }

    // === Panel states manager — wires all save buttons to loading state ===
    // Called once at startup; re-call if buttons are dynamically added.
    function updatePanelStates() {
        const saveBtnIds = ['saveApiKeys', 'saveAiSettings', 'saveVsCodeConfig', 'saveScheduler', 'saveFileConfig'];
        saveBtnIds.forEach(function (btnId) {
            const btn = document.getElementById(btnId);
            if (!btn) return;
            btn.addEventListener('click', function () {
                setButtonSaving(btnId, true);
            });
        });
    }


document.addEventListener('DOMContentLoaded', async () => {
    
    // --- 1. UI Navigation Logic ---
    const navItems = document.querySelectorAll('.nav-links li');
    const viewSections = document.querySelectorAll('.view-section');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // Remove active classes
            navItems.forEach(nav => nav.classList.remove('active'));
            viewSections.forEach(section => {
                section.classList.remove('active');
                section.classList.add('hidden');
            });

            // Set clicked as active
            item.classList.add('active');
            const targetId = item.getAttribute('data-target');
            const targetView = document.getElementById(targetId);
            
            targetView.classList.remove('hidden');
            targetView.classList.add('active');
            if (targetId === 'prompts-view') loadFileTree();
        });
    });

    // --- 2. Password Toggle Visibility ---
    document.querySelectorAll('.toggle-pwd').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetId = e.currentTarget.getAttribute('data-target');
            const input = document.getElementById(targetId);
            const icon = e.currentTarget.querySelector('i');
            
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        });
    });

    // --- 3. Clock, Next Run Time & Live Log Ready ---
    const nextRunTimeEl = document.getElementById('nextRunTime');
    const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    /**
     * Computes the next scheduled run from the saved scheduler config
     * (daily at config.time, skipping config.daysOff) and renders it.
     */
    async function updateNextRunTime() {
        try {
            const sched = await window.electronAPI.getConfig('scheduler');
            if (!sched || !sched.enabled || !sched.time) {
                nextRunTimeEl.textContent = 'Not Scheduled';
                return;
            }
            const [h, m] = String(sched.time).split(':').map(Number);
            if (Number.isNaN(h) || Number.isNaN(m)) {
                nextRunTimeEl.textContent = 'Invalid Time';
                return;
            }
            const daysOff = Array.isArray(sched.daysOff) ? sched.daysOff : [];
            const now = new Date();
            for (let i = 0; i < 8; i++) { // look ahead at most 7 days
                const candidate = new Date(now);
                candidate.setDate(now.getDate() + i);
                candidate.setHours(h, m, 0, 0);
                if (candidate <= now) continue; // must be in the future
                const dayName = DAY_NAMES[candidate.getDay()];
                if (daysOff.includes(dayName)) continue; // skip configured rest days
                nextRunTimeEl.textContent = `${dayName.slice(0, 3)} ${candidate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
                return;
            }
            nextRunTimeEl.textContent = 'No Valid Day Found';
        } catch (error) {
            nextRunTimeEl.textContent = 'Unknown';
        }
    }

    setInterval(() => {
        const now = new Date();
        document.getElementById('currentTime').innerText = now.toLocaleTimeString();
    }, 1000);

    await updateNextRunTime();
    // Refresh next-run every 5 minutes so it rolls over correctly past midnight
    setInterval(updateNextRunTime, 5 * 60 * 1000);

    // --- Theme switcher (FEATURE 3) ---
    function applyTheme(theme) {
        const t = theme === 'light' ? 'light' : 'dark';
        document.documentElement.dataset.theme = t;
        const icon = document.querySelector('#btnTheme i');
        if (icon) icon.className = t === 'light' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    }
    async function toggleTheme() {
        const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
        applyTheme(next);
        // Read-merge-write keeps the other appConfig keys intact
        await window.electronAPI.saveConfig('appConfig', {
            ...(await window.electronAPI.getConfig('appConfig') || {}),
            theme: next
        });
    }
    document.getElementById('btnTheme').addEventListener('click', toggleTheme);
    (async () => {
        const appCfg = await window.electronAPI.getConfig('appConfig');
        applyTheme((appCfg || {}).theme || 'dark');
    })();

    // --- Cost tracker display (FEATURE 2) ---
    const costTodayEl = document.getElementById('costToday');
    const costTokensEl = document.getElementById('costTokens');
    async function loadCosts() {
        try {
            const costs = await window.electronAPI.getCosts();
            if (!costs || typeof costs.estimatedCost !== 'number') return;
            costTodayEl.textContent = `$${costs.estimatedCost.toFixed(2)}`;
            costTokensEl.textContent = `${costs.tokens} tokens Â· ${costs.calls} call(s)`;
        } catch (error) { /* keep last values */ }
    }
    await loadCosts();
    setInterval(loadCosts, 60 * 1000); // refresh every minute

    // --- Provider auto-detection hints (client-side mirror of apiManager.detectProvider) ---
    // NOTE: declared before loadConfigs() runs, since loadConfigs calls updateProviderHint.
    const PROVIDER_INPUTS = { gemini: 'geminiKey', groq: 'groqKey', kimi: 'kimiKey', openrouter: 'openrouterKey' };

    // Display names AND the suffix used in provider-specific DOM ids. The explicit
    // "OpenRouter" entry matters: naive capitalization would yield "Openrouter",
    // which silently misses #hintOpenRouter / #modelHintOpenRouter.
    const PROVIDER_LABELS = { gemini: 'Gemini', groq: 'Groq', kimi: 'Kimi', openrouter: 'OpenRouter' };

    function detectProviderLocal(apiKey) {
        const key = String(apiKey || '').trim();
        if (!key) return null;
        if (key.startsWith('AQ.') || key.startsWith('AIza')) return 'gemini';
        if (key.startsWith('gsk_')) return 'groq';
        if (key.startsWith('sk-or-')) return 'openrouter';
        if (key.startsWith('sk-')) return 'kimi';
        return null;
    }

    function updateProviderHint(provider) {
        const input = document.getElementById(PROVIDER_INPUTS[provider]);
        const hint = document.getElementById('hint' + PROVIDER_LABELS[provider]);
        if (!input || !hint) return;
        const detected = detectProviderLocal(input.value);
        if (!input.value.trim()) {
            hint.textContent = '';
        } else if (detected === provider) {
            hint.textContent = `âœ“ Detected provider: ${detected}`;
            hint.style.color = '#3fb950';
        } else if (detected) {
            hint.textContent = `âš  Prefix looks like "${detected}", but this field is for "${provider}".`;
            hint.style.color = '#e3b341';
        } else {
            hint.textContent = 'âš  Unrecognized key prefix â€” the router may not use this provider.';
            hint.style.color = '#f85149';
        }
    }

    for (const inputId of Object.values(PROVIDER_INPUTS)) {
        document.getElementById(inputId).addEventListener('input', (e) => {
            const provider = Object.keys(PROVIDER_INPUTS).find(p => PROVIDER_INPUTS[p] === e.target.id);
            updateProviderHint(provider);
        });
    }

    // --- AI Settings: advanced multi-provider configuration ---
    // NOTE: declared before loadConfigs() runs, because loadConfigs() calls
    // loadAiSettings() (same TDZ-safety pattern as PROVIDER_INPUTS above).
    const MODEL_OPTIONS = {
        gemini: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
        groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'groq/compound-mini'],
        kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
        openrouter: ['auto', 'google/gemini-3.8-flash', 'anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b']
    };
    const MODEL_SELECT_IDS = { gemini: 'modelGemini', groq: 'modelGroq', kimi: 'modelKimi', openrouter: 'modelOpenRouter' };

    /** DOM id suffix for a provider (uses the canonical PROVIDER_LABELS map). */
    function providerSuffix(provider) {
        return PROVIDER_LABELS[provider] || provider;
    }

    /** Fills a provider's model dropdown from MODEL_OPTIONS, keeping any custom stored model. */
    function populateModelDropdown(provider, currentModel) {
        const select = document.getElementById(MODEL_SELECT_IDS[provider]);
        if (!select) return;
        const options = MODEL_OPTIONS[provider].slice();
        if (currentModel && !options.includes(currentModel)) options.unshift(currentModel);
        select.replaceChildren();
        options.forEach(model => {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            select.appendChild(opt);
        });
        select.value = currentModel || options[0];
    }

    /** Shows the currently selected model under each API key field. */
    function updateModelHints(providers) {
        Object.keys(MODEL_SELECT_IDS).forEach(provider => {
            const hint = document.getElementById('modelHint' + providerSuffix(provider));
            if (!hint) return;
            const conf = (providers && providers[provider]) || {};
            hint.textContent = `Current model: ${conf.model || MODEL_OPTIONS[provider][0]}`;
            hint.style.color = '';
        });
    }

    /** Builds the draggable provider priority list (drag a row to reorder). */
    function renderPriorityList(providers) {
        const list = document.getElementById('priorityList');
        if (!list) return;
        list.replaceChildren();
        const ordered = Object.keys(MODEL_SELECT_IDS).sort((a, b) => {
            const pa = (providers[a] && providers[a].priority) || 99;
            const pb = (providers[b] && providers[b].priority) || 99;
            return pa - pb;
        });
        ordered.forEach(provider => {
            const conf = providers[provider] || {};
            const row = document.createElement('div');
            row.className = 'priority-item';
            row.draggable = true;
            row.dataset.provider = provider;

            const handle = document.createElement('i');
            handle.className = 'fa-solid fa-grip-vertical';
            const name = document.createElement('span');
            name.className = 'priority-name';
            name.textContent = PROVIDER_LABELS[provider];
            const model = document.createElement('span');
            model.className = 'priority-model';
            model.textContent = conf.model || MODEL_OPTIONS[provider][0];
            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.className = 'priority-enabled';
            toggle.checked = conf.enabled !== false;
            toggle.title = 'Enable / disable this provider';
            toggle.addEventListener('change', updateThinkingVisibility);
            const rank = document.createElement('span');
            rank.className = 'priority-rank';

            row.append(handle, name, model, toggle, rank);
            list.appendChild(row);
        });
        renumberPriorityList();
        attachDragHandlers();
        updateThinkingVisibility();
    }

    /** Shows the live routing chain (enabled providers that have a key), mirroring _buildRoutingChain's filter + strategy ordering. */
    function updateActiveChain(providers, routing) {
        const el = document.getElementById('activeChain');
        if (!el) return;
        const strategy = (routing && routing.strategy) || 'priority';
        const names = Object.keys(MODEL_SELECT_IDS).filter(name => {
            const p = providers[name] || {};
            const hasKey = p.apiKey || (Array.isArray(p.apiKeys) && p.apiKeys.some(k => typeof k === 'string' && k.trim()));
            return p.enabled !== false && !!hasKey;
        });
        const byPriority = (a, b) => (((providers[a] || {}).priority || 99) - ((providers[b] || {}).priority || 99));
        if (strategy === 'cost-optimized') {
            const cost = n => (((providers[n] || {}).costPerMillionInput || 0) + ((providers[n] || {}).costPerMillionOutput || 0));
            names.sort((a, b) => cost(a) - cost(b));
        } else if (strategy === 'latency-optimized') {
            names.sort((a, b) => (((providers[a] || {}).latencyMs || 500) - ((providers[b] || {}).latencyMs || 500)));
        } else {
            names.sort(byPriority); // priority + round-robin (rotation start is runtime state)
        }
        const arrow = ' ' + String.fromCharCode(0x2192) + ' '; // right arrow (ASCII-safe)
        el.textContent = names.length
            ? `Active chain: ${names.map(n => PROVIDER_LABELS[n] || n).join(arrow)}${strategy === 'round-robin' ? ' (rotates)' : ''}`
            : 'Active chain: (none - add API keys in the API Keys view)';
    }

    /** Refreshes the #1..#N badges to match the current DOM order. */
    function renumberPriorityList() {
        document.querySelectorAll('#priorityList .priority-item').forEach((row, index) => {
            const rank = row.querySelector('.priority-rank');
            if (rank) rank.textContent = `#${index + 1}`;
        });
    }

    // The row currently being dragged (HTML5 drag & drop)
    let draggedItem = null;

    /** Wires drag & drop handlers so rows can be reordered by dragging. */
    function attachDragHandlers() {
        document.querySelectorAll('#priorityList .priority-item').forEach(row => {
            row.addEventListener('dragstart', () => {
                draggedItem = row;
                row.classList.add('dragging');
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('dragging');
                draggedItem = null;
                renumberPriorityList();
            });
            row.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!draggedItem || draggedItem === row) return;
                const rect = row.getBoundingClientRect();
                const insertAfter = (e.clientY - rect.top) > rect.height / 2;
                row.parentElement.insertBefore(draggedItem, insertAfter ? row.nextSibling : row);
                renumberPriorityList();
            });
        });
    }

    /** The thinking-level selector only applies to Gemini, so hide it when Gemini is disabled. */
    function updateThinkingVisibility() {
        const group = document.getElementById('thinkingGroup');
        if (!group) return;
        const toggle = document.querySelector('#priorityList .priority-item[data-provider="gemini"] .priority-enabled');
        group.style.display = (!toggle || toggle.checked) ? '' : 'none';
    }

    /** Builds the per-provider temperature / max output token controls. */
    function renderSliders(providers) {
        const container = document.getElementById('sliderContainer');
        if (!container) return;
        container.replaceChildren();
        Object.keys(MODEL_SELECT_IDS).forEach(provider => {
            const conf = providers[provider] || {};
            const block = document.createElement('div');
            block.className = 'provider-sliders';
            block.dataset.provider = provider;

            const title = document.createElement('strong');
            title.textContent = PROVIDER_LABELS[provider];

            // Temperature: 0.0 - 2.0
            const tempRow = document.createElement('div');
            tempRow.className = 'slider-row';
            const tempLabel = document.createElement('label');
            tempLabel.textContent = 'Temperature';
            const tempInput = document.createElement('input');
            tempInput.type = 'range';
            tempInput.min = '0';
            tempInput.max = '2';
            tempInput.step = '0.1';
            tempInput.className = 'temperature-slider';
            tempInput.value = String(typeof conf.temperature === 'number' ? conf.temperature : 0.7);
            const tempValue = document.createElement('span');
            tempValue.className = 'slider-value';
            tempValue.textContent = tempInput.value;
            tempInput.addEventListener('input', () => { tempValue.textContent = tempInput.value; });
            tempRow.append(tempLabel, tempInput, tempValue);

            // Max output tokens: 256 - 65536
            const tokRow = document.createElement('div');
            tokRow.className = 'slider-row';
            const tokLabel = document.createElement('label');
            tokLabel.textContent = 'Max output tokens';
            const tokInput = document.createElement('input');
            tokInput.type = 'number';
            tokInput.min = '256';
            tokInput.max = '65536';
            tokInput.step = '256';
            tokInput.className = 'max-tokens-input';
            tokInput.value = String(typeof conf.maxTokens === 'number' ? conf.maxTokens : 8192);
            tokRow.append(tokLabel, tokInput);

            block.append(title, tempRow, tokRow);
            container.appendChild(block);
        });
    }

    /** Loads providers + routing config into the AI Settings view. */
    async function loadAiSettings() {
        try {
            const providers = await window.electronAPI.getConfig('providers') || {};
            const routing = await window.electronAPI.getConfig('routing') || {};

            Object.keys(MODEL_SELECT_IDS).forEach(provider => {
                populateModelDropdown(provider, (providers[provider] || {}).model);
            });

            const thinking = (providers.gemini || {}).thinkingLevel || 'medium';
            const radio = document.querySelector(`input[name="thinkingLevel"][value="${thinking}"]`);
            if (radio) radio.checked = true;

            const strategySelect = document.getElementById('routingStrategy');
            if (strategySelect) strategySelect.value = routing.strategy || 'priority';

            // Load the system prompt (persisted in aiConfig.systemPrompt)
            const aiCfg = await window.electronAPI.getConfig('aiConfig') || {};
            const spInput = document.getElementById('systemPromptInput');
            if (spInput) spInput.value = aiCfg.systemPrompt || '';
            const styleSel = document.getElementById('designStyleSelect');
            if (styleSel) styleSel.value = (aiCfg && aiCfg.designStyle) || 'auto';

            renderPriorityList(providers);
            renderSliders(providers);
            updateModelHints(providers);
            updateActiveChain(providers, routing);
        } catch (error) {
            console.error('Failed to load AI settings:', error);
        }
    }

    // --- 4. Load Configurations via IPC ---
    async function loadConfigs() {
        try {
            // Load providers config (smart multi-provider router)
            const providers = await window.electronAPI.getConfig('providers');
            if (providers) {
                for (const [provider, inputId] of Object.entries(PROVIDER_INPUTS)) {
                    const conf = providers[provider];
                    if (conf && conf.apiKey) document.getElementById(inputId).value = conf.apiKey;
                    updateProviderHint(provider);
                }
                // ISSUE 4 FIX: additional Gemini keys (one per line) for 429 rotation
                const geminiConf = providers.gemini || {};
                const extraKeysEl = document.getElementById('geminiExtraKeys');
                if (extraKeysEl) extraKeysEl.value = (Array.isArray(geminiConf.apiKeys) ? geminiConf.apiKeys : []).join('\n');
            }

            // Load VS Code Config
            const vsConfig = await window.electronAPI.getConfig('vscodeAutomation');
            if (vsConfig) {
                document.getElementById('aiExtensionSelect').value = vsConfig.aiExtension || 'cline';
                document.getElementById('promptWaitTime').value = vsConfig.waitBetweenPromptsSec || 30;
            }

            // Load background & notification toggles (appConfig; default ON)
            const appCfg = await window.electronAPI.getConfig('appConfig');
            document.getElementById('appSilentNotifications').checked = !appCfg || appCfg.silentNotifications !== false;
            document.getElementById('appCloseToTray').checked = !appCfg || appCfg.closeToTray !== false;
            
            // Load Settings/AI Config (legacy global fallback values)
            const aiConfig = await window.electronAPI.getConfig('aiConfig');
            if (aiConfig) {
                document.getElementById('activeModelSelect').value = aiConfig.activeModel || 'gemini-3.8-flash';
            }

            // Load the advanced AI Settings view (models, thinking level,
            // routing strategy, priorities, generation limits)
            await loadAiSettings();

        } catch (error) {
            console.error('Failed to load configs:', error);
        }
    }
    await loadConfigs();

    // --- 5. Save Forms Logic ---
    
    // Save providers config (smart multi-provider router) â€” read-merge-write so
    // each field is saved individually without clobbering models/priorities.
    document.getElementById('saveApiKeys').addEventListener('click', async () => {
        const providers = await window.electronAPI.getConfig('providers') || {};
        for (const [provider, inputId] of Object.entries(PROVIDER_INPUTS)) {
            providers[provider] = { ...(providers[provider] || {}), apiKey: document.getElementById(inputId).value.trim() };
        }
        // ISSUE 4 FIX: collect the additional Gemini keys (one per line) into
        // providers.gemini.apiKeys â€” apiManager rotates them automatically on 429.
        const geminiExtra = String((document.getElementById('geminiExtraKeys') || {}).value || '')
            .split(/\r?\n/).map(k => k.trim()).filter(Boolean);
        providers.gemini = { ...(providers.gemini || {}), apiKeys: geminiExtra };
        const res = await window.electronAPI.saveConfig('providers', providers);
        if (res.success) showToast('API Keys Encrypted & Saved Successfully.', 'success');
        updateActiveChain(providers, await window.electronAPI.getConfig('routing') || {});
    });

    // --- API Key Connection Tests ---
    document.querySelectorAll('.btn-test').forEach(btn => {
        btn.addEventListener('click', async () => {
            const provider = btn.getAttribute('data-provider');
            const input = document.getElementById(btn.getAttribute('data-key'));
            // Use the typed key; fall back to the stored one if the field is empty
            const providers = await window.electronAPI.getConfig('providers') || {};
            const key = input.value.trim() || (providers[provider] && providers[provider].apiKey) || '';
            btn.disabled = true;
            try {
                const res = await window.electronAPI.testApiConnection(provider, key);
                showToast(res.success ? `âœ… ${res.result}` : `âŒ Test failed: ${res.error}`, res.success ? 'success' : 'error');
            } finally {
                btn.disabled = false;
            }
        });
    });

    // --- Fetch Models buttons (live /models list per provider) ---
    document.querySelectorAll('.btn-fetch-models').forEach(btn => {
        btn.addEventListener('click', async () => {
            const provider = btn.getAttribute('data-provider');
            const selectId = btn.getAttribute('data-select');
            const original = btn.innerHTML;
            btn.disabled = true;
            btn.textContent = 'Loading...';
            try {
                const models = await window.electronAPI.fetchModels(provider);
                const sel = document.getElementById(selectId);
                if (sel && Array.isArray(models) && models.length) {
                    sel.innerHTML = models.map(m =>
                        `<option value="${String(m.id).replace(/"/g, '&quot;')}">${String(m.name || m.id).replace(/</g, '&lt;')}</option>`
                    ).join('');
                } else if (sel) {
                    showToast(`No models returned for ${provider}. Check the API key.`, 'error');
                }
            } catch (e) {
                showToast('Fetch failed: ' + e.message, 'error');
            } finally {
                btn.disabled = false;
                btn.innerHTML = original;
            }
        });
    });

    // --- Save AI Settings (models, thinking level, routing, priorities, limits) ---
    document.getElementById('saveAiSettings').addEventListener('click', async () => {
        // Read-merge-write: keeps apiKeys and any keys not edited here intact.
        const providers = await window.electronAPI.getConfig('providers') || {};
        const routing = await window.electronAPI.getConfig('routing') || {};

        // Priority order + enabled toggles come from the drag-and-drop list order
        document.querySelectorAll('#priorityList .priority-item').forEach((row, index) => {
            const provider = row.dataset.provider;
            const toggle = row.querySelector('.priority-enabled');
            providers[provider] = {
                ...(providers[provider] || {}),
                priority: index + 1,
                enabled: toggle ? toggle.checked : true
            };
        });

        // Models per provider
        Object.entries(MODEL_SELECT_IDS).forEach(([provider, selectId]) => {
            const select = document.getElementById(selectId);
            if (select) providers[provider] = { ...(providers[provider] || {}), model: select.value };
        });

        // Thinking level (Gemini only)
        const checkedThinking = document.querySelector('input[name="thinkingLevel"]:checked');
        if (checkedThinking) {
            providers.gemini = { ...(providers.gemini || {}), thinkingLevel: checkedThinking.value };
        }

        // Temperature + max output tokens per provider
        document.querySelectorAll('#sliderContainer .provider-sliders').forEach(block => {
            const provider = block.dataset.provider;
            const temp = block.querySelector('.temperature-slider');
            const tokens = block.querySelector('.max-tokens-input');
            providers[provider] = {
                ...(providers[provider] || {}),
                temperature: temp ? parseFloat(temp.value) : 0.7,
                maxTokens: tokens ? parseInt(tokens.value, 10) : 8192
            };
        });

        const resProviders = await window.electronAPI.saveConfig('providers', providers);
        const resRouting = await window.electronAPI.saveConfig('routing', {
            ...routing,
            strategy: document.getElementById('routingStrategy').value
        });
        // Persist the system prompt (read-merge-write, keeps other aiConfig keys)
        const resAi = await window.electronAPI.saveConfig('aiConfig', {
            ...(await window.electronAPI.getConfig('aiConfig') || {}),
            systemPrompt: (document.getElementById('systemPromptInput') || {}).value || ''
,
            designStyle: (document.getElementById('designStyleSelect') || {}).value || 'auto'
        });

        if (resProviders.success && resRouting.success && resAi.success) {
            updateModelHints(providers);
            updateActiveChain(providers, { ...routing, strategy: document.getElementById('routingStrategy').value });
            showToast('AI Settings saved.', 'success');
        } else {
            showToast('Failed to save AI Settings. Check the logs for details.', 'error');
        }
    });

    // Save VS Code config
    document.getElementById('saveVsCodeConfig').addEventListener('click', async () => {
        const currentConf = await window.electronAPI.getConfig('vscodeAutomation') || {};
        currentConf.aiExtension = document.getElementById('aiExtensionSelect').value;
        currentConf.waitBetweenPromptsSec = parseInt(document.getElementById('promptWaitTime').value, 10);
        
        const res = await window.electronAPI.saveConfig('vscodeAutomation', currentConf);
        if(res.success) showToast('IDE Settings Saved.', 'success');
    });

    // Save Scheduler config (BUGFIX: buttons existed in HTML but had no handlers)
    document.getElementById('saveScheduler').addEventListener('click', async () => {
        const time = document.getElementById('schedTime').value || '19:00';
        const data = {
            enabled: document.getElementById('schedEnabled').checked,
            time
        };
        const res = await window.electronAPI.saveConfig('scheduler', data);
        if (res.success) {
            await window.electronAPI.reloadSchedule();
            await updateNextRunTime();
            showToast('Schedule saved and reloaded.', 'success');
        }
    });

    // Save Prompts file path
    document.getElementById('saveFileConfig').addEventListener('click', async () => {
        // Read-merge-write: preserve other stored fileConfig keys (e.g. outputDirectory)
        const current = await window.electronAPI.getConfig('fileConfig') || {};
        const res = await window.electronAPI.saveConfig('fileConfig', {
            ...current,
            promptFilePath: document.getElementById('promptFilePath').value.trim()
        });
        if (res.success) showToast('Prompt file path saved.', 'success');
    });

    // Browse for a prompt file (Fix 9: button existed in HTML but had no handler)
    document.getElementById('browsePromptFile').addEventListener('click', async () => {
        const res = await window.electronAPI.openFileDialog({
            title: 'Select Prompts File',
            filters: [{ name: 'Text Files', extensions: ['txt'] }]
        });
        if (res.success && res.path) {
            document.getElementById('promptFilePath').value = res.path;
        }
    });

    // --- Prompts Preview Panel (Fix 9) ---
    const promptsPreview = document.getElementById('promptsPreview');
    const promptsStatus = document.getElementById('promptsStatus');

    function renderPromptGroup(title, items) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-dark); border: 1px solid var(--border); border-radius: 4px; padding: 12px; margin-bottom: 10px;';
        const heading = document.createElement('strong');
        heading.textContent = title;
        card.appendChild(heading);
        const list = document.createElement('ol');
        list.style.cssText = 'margin: 8px 0 0 20px; color: var(--text-muted);';
        items.forEach(text => {
            const li = document.createElement('li');
            li.style.whiteSpace = 'pre-wrap';
            li.textContent = text.length > 300 ? text.slice(0, 300) + 'â€¦' : text;
            list.appendChild(li);
        });
        card.appendChild(list);
        return card;
    }

    document.getElementById('loadPromptsPreview').addEventListener('click', async () => {
        const filePath = document.getElementById('promptFilePath').value.trim() || null;
        promptsStatus.textContent = 'Loading...';
        promptsPreview.innerHTML = '';
        const res = await window.electronAPI.readPrompts(filePath);
        if (!res.success) {
            promptsStatus.textContent = `Error: ${res.error}`;
            return;
        }
        promptsStatus.textContent = `Loaded ${res.path} â€” ${res.structurePrompts.length} structure prompt(s), ${res.extensionPrompts.length} extension prompt(s).`;
        if (res.structurePrompts.length) promptsPreview.appendChild(renderPromptGroup('Structure Prompts (sent to the AI API)', res.structurePrompts));
        if (res.extensionPrompts.length) promptsPreview.appendChild(renderPromptGroup('Extension Prompts (sent to VS Code/Cline)', res.extensionPrompts));
    });

    document.getElementById('clearPromptsPreview').addEventListener('click', () => {
        promptsPreview.innerHTML = '';
        promptsStatus.textContent = 'No file loaded yet.';
    });

    // --- Prompts Manager (folder-based, ordered, multi-language) ---
    const promptState = {
        folder: 'frontend',
        prompts: { frontend: [], backend: [] },
        editing: null // filename being edited, or null for a new prompt
    };
    const promptFolderStatus = document.getElementById('promptFolderStatus');
    const promptListEl = document.getElementById('promptList');
    const promptEditorEl = document.getElementById('promptEditor');

    // Renderer-side mirror of promptManager.detectLanguage (same Unicode ranges,
    // same precedence). No filtering anywhere: badges are informational only.
    const URDU_MARKERS = /[\u0679\u067e\u0686\u0688\u0691\u06ba\u06be\u06c1\u06d2\u06af\u06cc\u0698]/;
    function detectPromptLanguageLocal(text) {
        const sample = String(text == null ? '' : text).slice(0, 100);
        if (!sample.trim()) return 'en';
        if (/[\u3040-\u30ff]/.test(sample)) return 'ja';
        if (/[\uac00-\ud7af]/.test(sample)) return 'ko';
        if (/[\u0600-\u06ff\u0750-\u077f]/.test(sample)) return URDU_MARKERS.test(sample) ? 'ur' : 'ar';
        if (/[\u0900-\u097f]/.test(sample)) return 'hi';
        if (/[\u4e00-\u9fff]/.test(sample)) return 'zh';
        if (/[\u0590-\u05ff]/.test(sample)) return 'he';
        if (/[\u0400-\u04ff]/.test(sample)) return 'ru';
        return 'en';
    }
    const PROMPT_LANGUAGE_LABELS = { en: 'English', ur: 'Urdu', ar: 'Arabic', hi: 'Hindi', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ru: 'Russian', he: 'Hebrew' };

    function formatPromptSize(bytes) {
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        if (bytes < 1024) return `${bytes} B`;
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    function showPromptEditor(show) {
        promptEditorEl.classList.toggle('hidden', !show);
        if (show) promptEditorEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function updateEditorLangBadge() {
        const badge = document.getElementById('promptEditorLang');
        const code = detectPromptLanguageLocal(document.getElementById('promptEditorContent').value);
        badge.textContent = PROMPT_LANGUAGE_LABELS[code] || code;
        badge.className = `prompt-lang-badge lang-${code}`;
    }
    document.getElementById('promptEditorContent').addEventListener('input', updateEditorLangBadge);

    function openPromptEditor(prompt) {
        promptState.editing = prompt ? prompt.filename : null;
        document.getElementById('promptEditorTitle').textContent = prompt ? `Edit: ${prompt.filename}` : 'New Prompt';
        document.getElementById('promptEditorName').value = prompt ? prompt.filename : '';
        document.getElementById('promptEditorContent').value = prompt ? prompt.content : '';
        updateEditorLangBadge();
        showPromptEditor(true);
    }

    function renderPromptList() {
        const prompts = promptState.prompts[promptState.folder] || [];
        promptListEl.innerHTML = '';
        prompts.forEach((prompt, index) => {
            const row = document.createElement('div');
            row.className = 'prompt-item';

            const order = document.createElement('span');
            order.className = 'prompt-order';
            order.textContent = String(prompt.order).padStart(2, '0');

            const name = document.createElement('span');
            name.className = 'prompt-name';
            name.textContent = prompt.name || prompt.filename;

            const meta = document.createElement('span');
            meta.className = 'prompt-meta';
            const size = document.createElement('span');
            size.className = 'prompt-size';
            size.textContent = formatPromptSize(prompt.sizeBytes);
            const lang = document.createElement('span');
            lang.className = `prompt-lang-badge lang-${prompt.language || 'en'}`;
            lang.textContent = PROMPT_LANGUAGE_LABELS[prompt.language] || prompt.language || 'text';
            meta.append(size, lang);

            const actions = document.createElement('span');
            actions.className = 'prompt-item-actions';

            const upBtn = document.createElement('button');
            upBtn.title = 'Move up';
            upBtn.innerHTML = '&#9650;';
            upBtn.disabled = index === 0;
            const downBtn = document.createElement('button');
            downBtn.title = 'Move down';
            downBtn.innerHTML = '&#9660;';
            downBtn.disabled = index === prompts.length - 1;
            const editBtn = document.createElement('button');
            editBtn.title = 'Edit';
            editBtn.innerHTML = '&#9998;';
            const delBtn = document.createElement('button');
            delBtn.title = 'Delete';
            delBtn.innerHTML = '&#128465;';
            const retryBtn = document.createElement('button');
            retryBtn.title = 'Retry this prompt (right-click on a row does the same)';
            retryBtn.innerHTML = '&#8635;';

            upBtn.addEventListener('click', () => movePrompt(index, index - 1));
            downBtn.addEventListener('click', () => movePrompt(index, index + 1));
            editBtn.addEventListener('click', () => openPromptEditor(prompt));
            delBtn.addEventListener('click', async () => {
                if (!confirm(`Delete prompt "${prompt.filename}"?`)) return;
                const res = await window.electronAPI.deleteOnePrompt(promptState.folder, prompt.filename);
                if (res.success) await loadPromptFolders();
                else showToast(`Delete failed: ${res.error}`, 'error');
            });
            retryBtn.addEventListener('click', () => retryPrompt(prompt));

            actions.append(upBtn, downBtn, editBtn, delBtn, retryBtn);
            row.append(order, name, meta, actions);
            // Right-click â†’ "Retry this prompt" (FEATURE 5)
            row.addEventListener('contextmenu', (e) => { e.preventDefault(); retryPrompt(prompt); });
            promptListEl.appendChild(row);
        });
        promptFolderStatus.textContent = prompts.length
            ? `${promptState.folder}/: ${prompts.length} prompt(s), executed in order.`
            : `${promptState.folder}/ is empty â€” click "Add Prompt" to create 01_your_name.txt.`;
    }

    async function loadPromptFolders() {
        try {
            promptFolderStatus.textContent = 'Loading prompts...';
            const res = await window.electronAPI.readPromptFolders();
            if (!res.success) throw new Error(res.error);
            promptState.prompts = { frontend: res.frontend || [], backend: res.backend || [] };
            renderPromptList();
        } catch (error) {
            promptFolderStatus.textContent = `Error loading prompts: ${error.message}`;
        }
    }

    async function movePrompt(from, to) {
        const prompts = promptState.prompts[promptState.folder] || [];
        if (to < 0 || to >= prompts.length) return;
        const reordered = prompts.map(p => p.filename);
        const [moved] = reordered.splice(from, 1);
        reordered.splice(to, 0, moved);
        const res = await window.electronAPI.reorderPrompts(promptState.folder, reordered);
        if (res.success) await loadPromptFolders();
        else showToast(`Reorder failed: ${res.error}`, 'error');
    }

    // Folder tabs (frontend = Phase 1, backend = Phase 2)
    document.querySelectorAll('#promptTabs .prompt-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('#promptTabs .prompt-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            promptState.folder = tab.dataset.folder;
            renderPromptList();
        });
    });

    document.getElementById('btnRefreshPrompts').addEventListener('click', loadPromptFolders);
    document.getElementById('btnAddPrompt').addEventListener('click', () => openPromptEditor(null));
    document.getElementById('btnOpenPromptFolder').addEventListener('click', () => {
        window.electronAPI.openPromptFolderInExplorer(promptState.folder);
    });
    document.getElementById('btnCancelPrompt').addEventListener('click', () => showPromptEditor(false));

    document.getElementById('btnSavePrompt').addEventListener('click', async () => {
        const nameInput = document.getElementById('promptEditorName');
        const contentInput = document.getElementById('promptEditorContent');
        const name = nameInput.value.trim();
        const content = contentInput.value;
        if (!name) { showToast('Please enter a file name (e.g. dashboard_layout).', 'warning'); return; }
        if (!content.trim()) { showToast('The prompt content is empty â€” it would be skipped during execution.', 'warning'); return; }
        // On edit, filename already carries its number prefix -> overwrites in place.
        const res = await window.electronAPI.saveOnePrompt(promptState.folder, promptState.editing || name, content);
        if (res.success) {
            showPromptEditor(false);
            await loadPromptFolders();
        } else {
            showToast(`Save failed: ${res.error}`, 'error');
        }
    });

    await loadPromptFolders();

    // --- File tree viewer (FEATURE 4) ---
    const fileTreeEl = document.getElementById('fileTree');
    const filePreviewModal = document.getElementById('filePreviewModal');
    const filePreviewContent = document.getElementById('filePreviewContent');
    const filePreviewTitle = document.getElementById('filePreviewTitle');

    async function loadFileTree() {
        try {
            const res = await window.electronAPI.listOutputFiles();
            fileTreeEl.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'file-tree-empty';
            if (!res.success) {
                empty.textContent = `Could not list the output folder: ${res.error}`;
                fileTreeEl.appendChild(empty);
                return;
            }
            if (!res.files.length) {
                empty.textContent = 'No generated files yet â€” run the automation or retry a prompt.';
                fileTreeEl.appendChild(empty);
                return;
            }
            res.files.forEach(f => {
                const row = document.createElement('div');
                row.className = 'file-tree-row ' + (f.isDir ? 'dir' : 'file');
                const icon = document.createElement('span');
                icon.textContent = f.isDir ? 'ðŸ“' : 'ðŸ“„';
                const name = document.createElement('span');
                name.className = 'ft-name';
                name.textContent = f.path;
                row.append(icon, name);
                if (!f.isDir) {
                    const size = document.createElement('span');
                    size.className = 'ft-size';
                    size.textContent = formatPromptSize(f.sizeBytes);
                    row.appendChild(size);
                    row.addEventListener('click', () => openFilePreview(f.path));
                }
                row.title = f.path;
                fileTreeEl.appendChild(row);
            });
        } catch (error) {
            fileTreeEl.innerHTML = '';
            const empty = document.createElement('div');
            empty.className = 'file-tree-empty';
            empty.textContent = `File tree error: ${error.message}`;
            fileTreeEl.appendChild(empty);
        }
    }

    async function openFilePreview(relPath) {
        filePreviewTitle.textContent = relPath;
        filePreviewContent.textContent = 'Loading...';
        filePreviewModal.style.display = 'flex';
        const res = await window.electronAPI.readOutputFile(relPath);
        filePreviewContent.textContent = res.success ? res.content : `Error: ${res.error}`;
    }
    document.getElementById('btnRefreshFileTree').addEventListener('click', loadFileTree);
    document.getElementById('btnCloseFilePreview').addEventListener('click', () => { filePreviewModal.style.display = 'none'; });
    filePreviewModal.addEventListener('click', (e) => {
        if (e.target === filePreviewModal) filePreviewModal.style.display = 'none'; // click outside closes
    });
    loadFileTree();

    // --- Retry individual prompt (FEATURE 5) ---
    // Runs ONLY this prompt through the AI router and writes the generated
    // files into the output folder (no VS Code automation, no other prompts).
    async function retryPrompt(prompt) {
        if (!confirm(`Retry "${prompt.filename}" now?\nThis calls the AI and writes the generated files to the output folder.`)) return;
        promptFolderStatus.textContent = `Retrying ${prompt.filename}...`;
        const res = await window.electronAPI.runSinglePrompt(promptState.folder, prompt.filename);
        if (res.success) {
            promptFolderStatus.textContent = `Retry OK (via ${res.provider}): wrote ${(res.written || []).join(', ') || 'no files'}.`;
            await loadFileTree();
        } else {
            promptFolderStatus.textContent = `Retry failed: ${res.error}`;
        }
    }

    // --- Command palette (FEATURE 1: Ctrl+K) ---
    const commandPalette = document.getElementById('commandPalette');
    const commandInput = document.getElementById('commandInput');
    const commandList = document.getElementById('commandList');
    let paletteItems = [];
    let paletteSelected = 0;

    function switchToView(targetId) {
        const navItem = document.querySelector(`.nav-links li[data-target="${targetId}"]`);
        if (navItem) navItem.click();
    }

    // Downloads every stored config module (key material is encrypted at rest
    // by encryption.js, so the dump contains the stored values, not plaintext).
    function exportConfigJson() {
        (async () => {
            const modules = ['scheduler', 'providers', 'routing', 'aiConfig', 'vscodeAutomation', 'fileConfig', 'appConfig', 'costs'];
            const dump = {};
            for (const m of modules) dump[m] = await window.electronAPI.getConfig(m);
            const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `autodash-config-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        })();
    }

    function buildPaletteCommands() {
        return [
            { label: 'Run Now', hint: 'Force run the automation pipeline', run: () => { if (confirm('Are you sure you want to force run the automation pipeline now?')) window.electronAPI.forceRunAutomation(); } },
            { label: 'Stop', hint: 'Emergency stop of the running workflow', run: () => window.electronAPI.stopAutomation() },
            { label: 'Open Logs', hint: 'Switch to the Logs view', run: () => switchToView('logs-view') },
            { label: 'Open Settings', hint: 'Switch to the Settings view', run: () => switchToView('settings-view') },
            { label: 'Switch Theme', hint: 'Toggle dark / light mode', run: toggleTheme },
            { label: 'Export Config', hint: 'Download all config modules as JSON', run: exportConfigJson }
        ];
    }

    function renderPaletteList(filter) {
        const f = String(filter || '').trim().toLowerCase();
        paletteItems = buildPaletteCommands().filter(c =>
            !f || c.label.toLowerCase().includes(f) || (c.hint || '').toLowerCase().includes(f));
        paletteSelected = 0;
        commandList.innerHTML = '';
        paletteItems.forEach((cmd, index) => {
            const row = document.createElement('div');
            row.className = 'command-item' + (index === paletteSelected ? ' selected' : '');
            const label = document.createElement('span');
            label.textContent = cmd.label;
            const hint = document.createElement('small');
            hint.textContent = cmd.hint || '';
            row.append(label, hint);
            row.addEventListener('click', () => { closePalette(); cmd.run(); });
            commandList.appendChild(row);
        });
    }

    function highlightPalette() {
        Array.from(commandList.children).forEach((row, i) => row.classList.toggle('selected', i === paletteSelected));
        const sel = commandList.children[paletteSelected];
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }

    function openPalette() {
        renderPaletteList('');
        commandInput.value = '';
        commandPalette.style.display = 'block';
        commandInput.focus();
    }
    function closePalette() { commandPalette.style.display = 'none'; }

    commandInput.addEventListener('input', () => renderPaletteList(commandInput.value));
    commandInput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            paletteSelected = Math.min(paletteSelected + 1, Math.max(paletteItems.length - 1, 0));
            highlightPalette();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            paletteSelected = Math.max(paletteSelected - 1, 0);
            highlightPalette();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const cmd = paletteItems[paletteSelected];
            if (cmd) { closePalette(); cmd.run(); }
        }
    });

    // Global keyboard shortcuts: Ctrl+K opens/closes the palette; Escape closes
    // the palette and the file preview modal.
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
            e.preventDefault();
            commandPalette.style.display === 'block' ? closePalette() : openPalette();
        } else if (e.key === 'Escape') {
            if (commandPalette.style.display === 'block') closePalette();
            if (filePreviewModal.style.display !== 'none') filePreviewModal.style.display = 'none';
        }
    });

    // Save general settings (active model + output directory)
    document.getElementById('saveSettingsConfig').addEventListener('click', async () => {
        // Read-merge-write so other stored aiConfig keys are preserved
        const res = await window.electronAPI.saveConfig('aiConfig', {
            ...(await window.electronAPI.getConfig('aiConfig') || {}),
            activeModel: document.getElementById('activeModelSelect').value
        });
        const resDir = await window.electronAPI.saveConfig('fileConfig', {
            ...(await window.electronAPI.getConfig('fileConfig') || {}),
            outputDirectory: document.getElementById('outputDir').value.trim()
        });
        // Read-merge-write keeps other appConfig keys (minimizeToTray, startWithWindows) intact
        const resApp = await window.electronAPI.saveConfig('appConfig', {
            ...(await window.electronAPI.getConfig('appConfig') || {}),
            silentNotifications: document.getElementById('appSilentNotifications').checked,
            closeToTray: document.getElementById('appCloseToTray').checked
        });
        if (res.success && resDir.success && resApp.success) showToast('Settings saved.', 'success');
    });

    // --- 6. Automation Controls ---
    // ISSUE 2 FIX: guard + debounce â€” even if this file is ever refactored so
    // this block runs twice, a second listener is refused; rapid re-clicks are
    // debounced for 3s. The scheduler additionally queues duplicate triggers.
    let forceRunListenerAttached = false;
    if (!forceRunListenerAttached) {
        forceRunListenerAttached = true;
        document.getElementById('btnForceRun').addEventListener('click', async () => {
            const btn = document.getElementById('btnForceRun');
            if (btn.disabled) return;
            if (!confirm('Are you sure you want to force run the automation pipeline now?')) return;
            btn.disabled = true;
            try {
                await window.electronAPI.forceRunAutomation();
            } finally {
                setTimeout(() => { btn.disabled = false; }, 3000);
            }
        });
    }

    document.getElementById('btnStop').addEventListener('click', async () => {
        await window.electronAPI.stopAutomation();
        showToast('Stop signal sent to main process.', 'info');
    });

    // Pause / Resume automation controls
    document.getElementById('btnPause').addEventListener('click', () => window.electronAPI.pauseAutomation());
    document.getElementById('btnResume').addEventListener('click', () => window.electronAPI.resumeAutomation());

    // --- Live automation status (object payload: {state, step, total, message}) ---
    const sysStatus = document.getElementById('sysStatus');
    const btnForceRun = document.getElementById('btnForceRun');
    const btnStopBtn = document.getElementById('btnStop');
    const statusColors = { running: '#e3b341', completed: '#3fb950', failed: '#f85149', stopped: '#e3b341', paused: '#e3b341', idle: '#3fb950' };
    window.electronAPI.onStatusUpdate((status) => {
        if (typeof status === 'string') status = { state: status };
        const { state = '', step = 0, total = 0, message = '' } = status;
        sysStatus.textContent = `Status: ${state}`;
        sysStatus.style.color = statusColors[state] || 'inherit';
        const bar = document.getElementById('workflowProgressBar');
        const txt = document.getElementById('workflowProgressText');
        const wrap = document.getElementById('workflowProgressWrap');
        const btnPause = document.getElementById('btnPause');
        const btnResume = document.getElementById('btnResume');
        if (step > 0 && total > 0) {
            wrap.classList.remove('hidden');
            const pct = Math.round((step / total) * 100);
            bar.style.width = pct + '%';
            txt.textContent = `${message || ''} (${step}/${total})`;
        } else if (['completed', 'failed', 'stopped'].includes(state)) {
            wrap.classList.remove('hidden');
            bar.style.width = '100%';
            txt.textContent = message || state;
            setTimeout(() => wrap.classList.add('hidden'), 3000);
        }
        if (state === 'running') { btnPause.classList.remove('hidden'); btnResume.classList.add('hidden'); }
        else if (state === 'paused') { btnPause.classList.add('hidden'); btnResume.classList.remove('hidden'); }
        else { btnPause.classList.add('hidden'); btnResume.classList.add('hidden'); }
    });

    // --- 7. Logs: Terminal + Error Center + Guide (3 tabs) ---
    // Terminal  : xterm.js (vendored under vendor/xterm) fed by the same `log:new`
    //             stream the app always used, plus live `api:stream` tokens.
    //             Degrades to a plain DOM terminal if the bundle is missing.
    // Error Ctr : runs/errors.json through the errors:* IPC channels.
    // Guide     : rendered from ERROR_CODES via `errors:catalog`, so the reference
    //             text lives in ONE place (src/modules/errorStore.js).
    const logsState = {
        tab: 'terminal',
        lines: [],
        maxLines: 5000,
        showTimestamps: true,
        terminal: null,
        fitAddon: null,
        searchAddon: null,
        serializeAddon: null,
        matchCount: 0,
        painted: false
    };
    const logTerminal = document.getElementById('logTerminal');   // DOM fallback host
    const xtermContainer = document.getElementById('xtermContainer');
    const logFilterInput = document.getElementById('logFilter');
    const logLevelSelect = document.getElementById('logLevelFilter');
    const terminalStatusEl = document.getElementById('terminalStatus');

    const ANSI = {
        error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m',
        debug: '\x1b[90m', success: '\x1b[32m', dim: '\x1b[90m', reset: '\x1b[0m'
    };

    // --- 7a. Tab switching ---
    function showLogsTab(name) {
        logsState.tab = name;
        document.querySelectorAll('.logs-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.logsTab === name);
        });
        ['terminal', 'errors', 'guide'].forEach(which => {
            const panel = document.getElementById('logs-panel-' + which);
            if (panel) panel.classList.toggle('hidden', which !== name);
        });
        if (name === 'terminal') {
            setTimeout(() => {
                try {
                    if (logsState.fitAddon) logsState.fitAddon.fit();
                } catch (e) { /* ignore */ }
                ensureTerminalPainted();
            }, 40);
        }
        if (name === 'errors') loadErrorCenter();
        if (name === 'guide') loadGuide();
    }
    document.querySelectorAll('.logs-tab').forEach(tab => {
        tab.addEventListener('click', () => showLogsTab(tab.dataset.logsTab));
    });

    // --- 7b. Terminal backend: xterm.js, with a DOM fallback ---
    function initTerminal() {
        try {
            if (typeof window.Terminal !== 'function') throw new Error('xterm.js bundle not loaded');
            const term = new window.Terminal({
                convertEol: true,
                cursorBlink: false,
                disableStdin: true,          // read-only log view
                fontSize: 12,
                fontFamily: 'Consolas, "Courier New", monospace',
                scrollback: logsState.maxLines,
                theme: { background: '#000000', foreground: '#d7d7d7', cursor: '#000000' }
            });
            term.open(xtermContainer);
            if (window.FitAddon && window.FitAddon.FitAddon) {
                logsState.fitAddon = new window.FitAddon.FitAddon();
                term.loadAddon(logsState.fitAddon);
                logsState.fitAddon.fit();
            }
            if (window.SearchAddon && window.SearchAddon.SearchAddon) {
                logsState.searchAddon = new window.SearchAddon.SearchAddon();
                term.loadAddon(logsState.searchAddon);
            }
            if (window.SerializeAddon && window.SerializeAddon.SerializeAddon) {
                logsState.serializeAddon = new window.SerializeAddon.SerializeAddon();
                term.loadAddon(logsState.serializeAddon);
            }
            logsState.terminal = term;
            xtermContainer.classList.remove('hidden');
            logTerminal.classList.add('hidden');
            window.addEventListener('resize', () => {
                try { logsState.fitAddon && logsState.fitAddon.fit(); } catch (e) { /* ignore */ }
            });
        } catch (error) {
            // Graceful degradation: never lose log output because a bundle failed.
            logsState.terminal = null;
            xtermContainer.classList.add('hidden');
            logTerminal.classList.remove('hidden');
            console.warn('[Logs] xterm.js unavailable, using the DOM terminal:', error.message);
        }
    }

    /**
     * Repaints the buffer the first time the pane actually has a measurable size.
     * An xterm opened inside a display:none container cannot paint, so lines that
     * arrived while the Logs view was closed would otherwise stay invisible until
     * the next resize.
     */
    function ensureTerminalPainted() {
        if (!logsState.terminal || logsState.painted) return;
        logsState.painted = true;
        renderTerminal();
        try { logsState.terminal.scrollToBottom(); } catch (e) { /* ignore */ }
    }

    function terminalTime(timestamp) {
        if (!logsState.showTimestamps) return '';
        const when = timestamp ? new Date(timestamp) : new Date();
        const shown = isNaN(when.getTime()) ? new Date() : when;
        return '[' + shown.toLocaleTimeString() + '] ';
    }

    function matchesLogFilter(line) {
        const textFilter = String(logFilterInput.value || '').trim().toLowerCase();
        const levelFilter = logLevelSelect.value || 'all';
        const levelOk = levelFilter === 'all' || line.level === levelFilter;
        const textOk = !textFilter || String(line.text).toLowerCase().includes(textFilter);
        return levelOk && textOk;
    }

    function appendFallbackLine(line) {
        const el = document.createElement('div');
        el.className = 'log-line';
        el.dataset.level = line.level;
        // SECURITY: textContent only - log text carries untrusted model output.
        el.textContent = terminalTime(line.timestamp) + '[' + String(line.level).toUpperCase() + '] ' + line.text;
        el.style.color = getColorForLevel(line.level);   // reuse the existing palette
        logTerminal.appendChild(el);
        while (logTerminal.children.length > logsState.maxLines) {
            logTerminal.removeChild(logTerminal.firstChild);
        }
        return el;
    }

    function updateTerminalStatus() {
        if (!terminalStatusEl) return;
        const backend = logsState.terminal ? 'xterm.js' : 'DOM fallback';
        terminalStatusEl.textContent = logsState.matchCount + '/' + logsState.lines.length + ' lines | ' + backend;
    }

    /** Full replay of the buffer - used whenever the filter changes. */
    function renderTerminal() {
        const visible = logsState.lines.filter(matchesLogFilter);
        logsState.matchCount = visible.length;
        if (logsState.terminal) {
            logsState.terminal.reset();
            if (visible.length) {
                logsState.terminal.write(visible.map(line =>
                    ANSI.dim + terminalTime(line.timestamp) + ANSI.reset +
                    (ANSI[line.level] || ANSI.info) + line.text + ANSI.reset
                ).join('\r\n') + '\r\n');
            }
        } else {
            logTerminal.innerHTML = '';
            visible.forEach(appendFallbackLine);
            logTerminal.scrollTop = logTerminal.scrollHeight;
        }
        updateTerminalStatus();
    }

    /** Pushes one line into the buffer and, when it passes the filter, the pane. */
    function terminalWrite(level, text, timestamp) {
        const line = {
            level: String(level || 'info').toLowerCase(),
            text: String(text == null ? '' : text),
            timestamp: timestamp || new Date().toISOString()
        };
        logsState.lines.push(line);
        if (logsState.lines.length > logsState.maxLines) logsState.lines.shift();
        if (matchesLogFilter(line)) {
            logsState.matchCount++;
            if (logsState.terminal) {
                logsState.terminal.write(
                    ANSI.dim + terminalTime(line.timestamp) + ANSI.reset +
                    (ANSI[line.level] || ANSI.info) + line.text + ANSI.reset + '\r\n'
                );
            } else {
                appendFallbackLine(line);
            }
        }
        updateTerminalStatus();
    }

    /** Plain-text view of the buffer (Copy / Download). */
    function terminalText(onlyVisible) {
        const source = onlyVisible ? logsState.lines.filter(matchesLogFilter) : logsState.lines;
        return source.map(line =>
            terminalTime(line.timestamp) + '[' + String(line.level).toUpperCase() + '] ' + line.text
        ).join('\r\n');
    }

    initTerminal();
    renderTerminal();

    let logFilterTimer = null;
    logFilterInput.addEventListener('input', () => {
        clearTimeout(logFilterTimer);
        logFilterTimer = setTimeout(renderTerminal, 150);
    });
    logLevelSelect.addEventListener('change', renderTerminal);

    // xterm.js cannot measure a display:none container, so refit every time the
    // Logs view becomes visible (nav switch) as well as on tab switches.
    const logsViewEl = document.getElementById('logs-view');
    if (logsViewEl && typeof MutationObserver === 'function') {
        new MutationObserver(() => {
            if (!logsViewEl.classList.contains('hidden')) {
                setTimeout(() => {
                    try {
                        if (logsState.fitAddon) logsState.fitAddon.fit();
                    } catch (e) { /* ignore */ }
                    ensureTerminalPainted();
                }, 40);
            }
        }).observe(logsViewEl, { attributes: true, attributeFilter: ['class'] });
    }

    // --- 7c. Error Center (runs/errors.json via IPC) ---
    const errorsTableBody = document.querySelector('#errorsTable tbody');
    const errorsEmptyEl = document.getElementById('errorsEmpty');
    const errorsBadge = document.getElementById('errorsBadge');
    const errorFilterSel = document.getElementById('errorFilter');
    const errorProviderSel = document.getElementById('errorProviderFilter');
const errorSourceSel = document.getElementById('errorSourceFilter');
    let errorEntries = [];

    /** 5xx / 429 / 408 = provider-side (red), other 4xx = user-fixable (yellow), resolved = gray. */
    function severityClass(entry) {
        if (entry.resolved) return 'sev-gray';
        const code = Number(entry.code);
        if (entry.codeGroup === 'server' || code === 429 || code === 408) return 'sev-red';
        return 'sev-yellow';
    }

    async function loadErrorCenter() {
        try {
            const res = await window.electronAPI.listErrors({
                status: errorFilterSel.value || 'all',
                provider: errorProviderSel.value || 'all',
                source: (errorSourceSel && errorSourceSel.value) || 'all'
            });
            if (res && res.success === false) throw new Error(res.error || 'Unknown error');
            errorEntries = (res && res.errors) || [];
            renderErrorCenter();
        } catch (error) {
            showToast('Could not load the Error Center: ' + error.message, 'error');
        }
    }

    function errorCell(text, className) {
        const td = document.createElement('td');
        if (className) td.className = className;
        td.textContent = (text == null || text === '') ? '-' : String(text);
        return td;
    }

    function renderErrorCenter() {
        errorsTableBody.innerHTML = '';
        const unresolved = errorEntries.filter(e => !e.resolved).length;
        if (errorsBadge) {
            errorsBadge.textContent = String(unresolved);
            errorsBadge.classList.toggle('hidden', unresolved === 0);
        }
        if (errorsEmptyEl) errorsEmptyEl.classList.toggle('hidden', errorEntries.length > 0);

        errorEntries.forEach(entry => {
            const tr = document.createElement('tr');
            if (entry.resolved) tr.classList.add('resolved');

            const dotCell = document.createElement('td');
            const dot = document.createElement('span');
            dot.className = 'err-dot ' + severityClass(entry);
            dot.title = entry.resolved ? 'Resolved' : 'Unresolved';
            dotCell.appendChild(dot);

            const codeCell = document.createElement('td');
            const pill = document.createElement('span');
            pill.className = 'err-code';
            pill.textContent = String(entry.code);
            pill.title = (entry.codeName || '') + (entry.retryable ? ' - retryable' : ' - not retryable');
            codeCell.appendChild(pill);

            const actionCell = document.createElement('td');
            if (!entry.resolved) {
                const btn = document.createElement('button');
                btn.className = 'err-resolve';
                btn.textContent = 'Resolve';
                btn.addEventListener('click', async () => {
                    try {
                        await window.electronAPI.resolveError(entry.id);
                        await loadErrorCenter();
                    } catch (error) {
                        showToast('Could not resolve that entry: ' + error.message, 'error');
                    }
                });
                actionCell.appendChild(btn);
            }

            const message = String(entry.message || '') + (entry.context ? '  (' + entry.context + ')' : '');
            tr.append(
                dotCell,
                errorCell(new Date(entry.timestamp).toLocaleString()),
                codeCell,
                errorCell(entry.provider),
                errorCell(entry.source || 'app'),
                errorCell(message, 'err-msg'),
                errorCell(entry.cause),
                errorCell(entry.suggestion),
                actionCell
            );
            errorsTableBody.appendChild(tr);
        });
    }

    /** Streams the export straight to a download (same pattern as the config export). */
    async function exportErrors(format) {
        try {
            const res = await window.electronAPI.exportErrors(format);
            if (!res || !res.success) throw new Error((res && res.error) || 'Export failed');
            const blob = new Blob([res.content], { type: (res.mime || 'application/json') + ';charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = res.filename || ('autodash-errors.' + format);
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            showToast('Exported ' + a.download, 'success');
        } catch (error) {
            showToast('Export failed: ' + error.message, 'error');
        }
    }

    document.getElementById('errorsRefresh').addEventListener('click', loadErrorCenter);
    document.getElementById('errorsExport').addEventListener('click', () => exportErrors('json'));
    document.getElementById('errorsExportCsv').addEventListener('click', () => exportErrors('csv'));
    document.getElementById('errorsClear').addEventListener('click', async () => {
        if (!confirm('Delete every recorded error? This cannot be undone.')) return;
        try {
            await window.electronAPI.clearErrors();
            await loadErrorCenter();
            showToast('Error Center cleared.', 'info');
        } catch (error) {
            showToast('Could not clear the Error Center: ' + error.message, 'error');
        }
    });
    errorFilterSel.addEventListener('change', loadErrorCenter);
    errorProviderSel.addEventListener('change', loadErrorCenter);
    if (errorSourceSel) errorSourceSel.addEventListener('change', loadErrorCenter);

    // Live push from the main process (recordError -> 'errors:new')
    window.electronAPI.onErrorNew((entry) => {
        if (!entry) return;
        const status = entry.resolved ? 'resolved' : 'unresolved';
        const visible = (errorFilterSel.value === 'all' || errorFilterSel.value === status)
            && (errorProviderSel.value === 'all' || errorProviderSel.value === entry.provider)
            && (!errorSourceSel || errorSourceSel.value === 'all' || (entry.source || 'app') === errorSourceSel.value);
        if (visible) {
            errorEntries.unshift(entry);
            renderErrorCenter();
        } else if (errorsBadge && !entry.resolved) {
            errorsBadge.textContent = String(Number(errorsBadge.textContent || 0) + 1);
            errorsBadge.classList.remove('hidden');
        }
        showToast('Error ' + entry.code + ' (' + (entry.codeName || 'unknown') + '): ' + entry.message, 'error');
    });

    // --- 7d. Guide tab (rendered from ERROR_CODES - single source of truth) ---
    const GUIDE_GROUPS = [
        { key: 'client', title: 'Client errors (4xx) - usually fixable in this app' },
        { key: 'server', title: 'Server errors (5xx) - the provider is at fault' },
        { key: 'local', title: 'Local errors - this machine or its configuration' }
    ];
    let guideLoaded = false;

    function guideRow(label, value) {
        const row = document.createElement('div');
        row.className = 'guide-row';
        const l = document.createElement('span');
        l.className = 'guide-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'guide-value';
        v.textContent = value;
        row.append(l, v);
        return row;
    }

    function renderGuide(codes, retentionDays) {
        const host = document.getElementById('guideContent');
        host.innerHTML = '';
        const title = document.createElement('h2');
        title.textContent = 'Error Code Reference';
        const intro = document.createElement('p');
        intro.className = 'guide-intro';
        intro.textContent = 'What each code means, why it happens and what to do about it. The Error '
            + 'Center records the codes this app actually hits; this page explains them. Entries older than '
            + (retentionDays || 30) + ' days are cleaned up automatically.';
        host.append(title, intro);

        GUIDE_GROUPS.forEach(group => {
            const keys = Object.keys(codes).filter(code => codes[code].group === group.key);
            if (!keys.length) return;
            const heading = document.createElement('h3');
            heading.textContent = group.title;
            host.appendChild(heading);
            keys.forEach(code => {
                const meta = codes[code];
                const card = document.createElement('div');
                card.className = 'guide-card ' + meta.group;
                const head = document.createElement('div');
                head.className = 'guide-head';
                const codeEl = document.createElement('span');
                codeEl.className = 'guide-code';
                codeEl.textContent = code;
                const nameEl = document.createElement('span');
                nameEl.className = 'guide-name';
                nameEl.textContent = meta.name;
                const retry = document.createElement('span');
                retry.className = 'guide-retry ' + (meta.retryable ? 'yes' : 'no');
                retry.textContent = meta.retryable ? 'Retryable: yes' : 'Retryable: no';
                head.append(codeEl, nameEl, retry);
                card.append(head, guideRow('What', meta.meaning), guideRow('Why', meta.why), guideRow('Fix', meta.fix));
                host.appendChild(card);
            });
        });

        const heading = document.createElement('h3');
        heading.textContent = 'Quick reference';
        const table = document.createElement('table');
        table.className = 'guide-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['Code', 'Name', 'Retry?', 'Action'].forEach(label => {
            const th = document.createElement('th');
            th.textContent = label;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        const tbody = document.createElement('tbody');
        Object.keys(codes).forEach(code => {
            const meta = codes[code];
            const tr = document.createElement('tr');
            [code, meta.name, meta.retryable ? 'Yes' : 'No', meta.fix].forEach(value => {
                const td = document.createElement('td');
                td.textContent = value;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.append(thead, tbody);
        host.append(heading, table);
    }

    async function loadGuide() {
        if (guideLoaded) return;
        try {
            const res = await window.electronAPI.getErrorCatalog();
            if (!res || !res.success) throw new Error((res && res.error) || 'Catalog unavailable');
            renderGuide(res.codes || {}, res.retentionDays);
            guideLoaded = true;
        } catch (error) {
            document.getElementById('guideContent').textContent = 'Could not load the error reference: ' + error.message;
        }
    }

    // --- 7e. Terminal streams + toolbar ---
    // Every logger line already arrives on `log:new`; the Terminal is a formatted
    // view of that stream (logger.terminal() is used by scheduler/apiManager for the
    // step-by-step lines). No second IPC channel, so nothing is ever duplicated.
    window.electronAPI.onLogUpdate((logData) => {
        terminalWrite(logData && logData.level, logData && logData.text, logData && logData.timestamp);
    });

    // FEATURE B: live AI tokens - written into the pane as they arrive so a long
    // generation reads like real terminal output instead of one line per chunk.
    let liveStreamOpen = false;
    let liveStreamTimer = null;
    function closeLiveStream() {
        if (!liveStreamOpen) return;
        liveStreamOpen = false;
        if (logsState.terminal) {
            logsState.terminal.write('\r\n');
            updateTerminalStatus();
        } else {
            logTerminal.scrollTop = logTerminal.scrollHeight;
        }
    }
    window.electronAPI.onApiStream((chunk) => {
        if (!chunk || typeof chunk.text !== 'string') return;
        if (!liveStreamOpen) {
            liveStreamOpen = true;
            terminalWrite('debug', '[stream:' + (chunk.provider || 'ai') + '] ', new Date().toISOString());
        }
        if (logsState.terminal) {
            // Untrusted model output: written straight to the terminal buffer.
            logsState.terminal.write(ANSI.debug + String(chunk.text).replace(/\r?\n/g, '\r\n') + ANSI.reset);
        } else {
            const last = logTerminal.lastChild;
            if (last) last.textContent += chunk.text;
            logTerminal.scrollTop = logTerminal.scrollHeight;
        }
        clearTimeout(liveStreamTimer);
        liveStreamTimer = setTimeout(closeLiveStream, 1500);
    });

    document.getElementById('terminalCopy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(terminalText(false));
            showToast('Terminal copied to the clipboard.', 'success');
        } catch (error) {
            showToast('Copy failed: ' + error.message, 'error');
        }
    });

    document.getElementById('terminalDownload').addEventListener('click', () => {
        // Prefer the serialized scrollback (exactly what the pane shows) when xterm
        // is active; otherwise export the plain line buffer.
        let content = terminalText(false);
        if (logsState.serializeAddon) {
            try { content = logsState.serializeAddon.serialize(); } catch (e) { /* keep plain text */ }
        }
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'autodash-terminal-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.log';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showToast('Terminal log downloaded.', 'success');
    });

    document.getElementById('clearLogs').addEventListener('click', () => {
        logsState.lines = [];
        logsState.matchCount = 0;
        if (logsState.terminal) logsState.terminal.reset();
        logTerminal.innerHTML = '';
        updateTerminalStatus();
    });

    // --- 7f. logsConfig (terminalMaxLines / showTimestamps) ---
    (async () => {
        try {
            const cfg = (await window.electronAPI.getConfig('logsConfig')) || {};
            const maxLines = Number(cfg.terminalMaxLines);
            if (Number.isFinite(maxLines) && maxLines > 0) {
                logsState.maxLines = maxLines;
                if (logsState.terminal) logsState.terminal.options.scrollback = maxLines;
            }
            if (cfg.showTimestamps === false) logsState.showTimestamps = false;
            updateTerminalStatus();
        } catch (error) {
            console.warn('[Logs] logsConfig unavailable, using defaults:', error.message);
        }
    })();

        function getColorForLevel(level) {
        switch(level) {
            case 'info': return '#03dac6'; // Cyan
            case 'warn': return '#ffeb3b'; // Yellow
            case 'error': return '#cf6679'; // Red
            default: return '#e0e0e0';
        }
    }
});

// === Live AI Chat Section ===
(() => {
    // Reuse MODEL_OPTIONS from the AI Settings IIFE via a global alias.
    // We define our own lightweight copy here for independence.
    const MODEL_ENUMS = {
        gemini: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
        groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'groq/compound-mini'],
        kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
        openrouter: ['auto', 'google/gemini-3.8-flash', 'anthropic/claude-sonnet-4', 'meta-llama/llama-3.3-70b']
    };

    // Chat state
    let chatHistory = [];
    let chatStreaming = false;

    // Load models for selected provider
    function loadChatModels() {
        const provider = document.getElementById('chatProvider').value;
        const modelSelect = document.getElementById('chatModel');
        modelSelect.innerHTML = '';
        const models = MODEL_ENUMS[provider] || [];
        models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            modelSelect.appendChild(opt);
        });
    }

    // Send message
    async function sendChatMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text || chatStreaming) return;

        const provider = document.getElementById('chatProvider').value;
        const model = document.getElementById('chatModel').value;
        const thinking = document.getElementById('chatThinking').value;

        // Add user message
        addChatMessage('user', text, { provider, model });
        chatHistory.push({ role: 'user', content: text });
        input.value = '';

        // Show stop button
        document.getElementById('chatSendBtn').style.display = 'none';
        document.getElementById('chatStopBtn').style.display = 'inline-flex';
        chatStreaming = true;

        try {
            const providers = await window.electronAPI.getConfig('providers') || {};
            const providerConf = providers[provider] || {};
            const apiKey = providerConf.apiKey;

            if (!apiKey) {
                addChatMessage('assistant', `Error: No API key for ${provider}. Please configure it in API Keys.`, { error: true });
                return;
            }

            const res = await window.electronAPI.chatStream({
                provider, model, thinking,
                messages: chatHistory,
                apiKey
            });
            // main.js resolves { success:false, error } instead of rejecting, so the
            // failure must be surfaced here or the chat would silently stall.
            if (res && res.success === false) throw new Error(res.error || 'Chat stream failed');
        } catch (err) {
            addChatMessage('assistant', `Error: ${err.message}`, { error: true });
        } finally {
            chatStreaming = false;
            document.getElementById('chatSendBtn').style.display = 'inline-flex';
            document.getElementById('chatStopBtn').style.display = 'none';
        }
    }

        function addChatMessage(role, content, meta = {}) {
        const messages = document.getElementById('chatMessages');
        if (messages.querySelector('.chat-welcome')) messages.innerHTML = '';
        const div = document.createElement('div');
        div.className = `chat-msg ${role}`;
        const time = new Date().toLocaleTimeString();
        const header = meta.provider
            ? `${meta.provider} · ${meta.model || ''} · ${time}`
            : time;
        div.innerHTML = `
            <div class="msg-header"><span>${role === 'user' ? 'You' : 'AI'}</span><span>${header}</span></div>
            <div class="msg-content"></div>
        `;
        div.querySelector('.msg-content').textContent = content;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
        return div;
    }

    // Wire events (guard for when elements don't exist)
    const providerEl = document.getElementById('chatProvider');
    const sendBtn = document.getElementById('chatSendBtn');
    const clearBtn = document.getElementById('chatClearBtn');
    const inputEl = document.getElementById('chatInput');

    if (providerEl) providerEl.addEventListener('change', loadChatModels);
    if (sendBtn) sendBtn.addEventListener('click', sendChatMessage);
    if (clearBtn) clearBtn.addEventListener('click', () => {
        chatHistory = [];
        document.getElementById('chatMessages').innerHTML = `
            <div class="chat-welcome">
                <i class="fa-solid fa-robot"></i>
                <h3>Live AI Chat</h3>
                <p>Chat cleared. Start a new conversation.</p>
            </div>`;
    });
    if (inputEl) inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });

    // Streaming listener
    window.electronAPI.onChatStream((data) => {
        if (data.type === 'start') {
            chatStreaming = true;
            addChatMessage('assistant', '', { provider: data.provider, model: data.model });
        } else if (data.type === 'chunk') {
            const lastMsg = document.querySelector('.chat-msg.assistant:last-child .msg-content');
            if (lastMsg) {
                lastMsg.textContent += data.text;
                document.getElementById('chatMessages').scrollTop =
                    document.getElementById('chatMessages').scrollHeight;
            }
        } else if (data.type === 'stats') {
            if (data.tokens !== undefined) document.getElementById('chatTokensLive').textContent = `${data.tokens} tokens`;
            if (data.cost !== undefined) document.getElementById('chatCostLive').textContent = `$${data.cost.toFixed(4)}`;
            if (data.latency !== undefined) document.getElementById('chatLatencyLive').textContent = `${data.latency}ms`;
        } else if (data.type === 'end') {
            chatHistory.push({ role: 'assistant', content: data.fullText });
            chatStreaming = false;
        } else if (data.type === 'error') {
            addChatMessage('assistant', `[ERROR] ${data.message}`, { error: true });
            chatStreaming = false;
        }
    });

    // === Live Credits (top bar + AI Settings panel) ===
    function loadLiveCredits() {
        window.electronAPI.getCosts().then(costs => {
            const tokens = costs.tokensToday || 0;
            const cost = costs.costToday || 0;
            const requests = costs.requestsToday || 0;
            const lastProvider = costs.lastProvider || '—';
            const avgLatency = costs.avgLatency ? `${costs.avgLatency}ms` : '—';

            const topTok = document.getElementById('topTokens');
            const topCost = document.getElementById('topCost');
            if (topTok) topTok.textContent = `${tokens} tok`;
            if (topCost) topCost.textContent = `$${cost.toFixed(2)}`;

            const ltt = document.getElementById('liveTokensToday');
            const lct = document.getElementById('liveCostToday');
            const lrt = document.getElementById('liveRequestsToday');
            const llp = document.getElementById('liveLastProvider');
            const lal = document.getElementById('liveAvgLatency');
            if (ltt) ltt.textContent = tokens.toLocaleString();
            if (lct) lct.textContent = `$${cost.toFixed(2)}`;
            if (lrt) lrt.textContent = requests.toLocaleString();
            if (llp) llp.textContent = lastProvider;
            if (lal) lal.textContent = avgLatency;
            }).catch(err => {
                console.warn('[loadLiveCredits] error:', err && err.message ? err.message : String(err));
            });
    }

    loadLiveCredits();
    setInterval(loadLiveCredits, 5000);

    // Initialize model dropdown on first load
    loadChatModels();


    // Wire save button loading states (show spinner during save, remove after)
    updatePanelStates();

})();
