import { chat, getRequestHeaders, messageFormatting, saveSettingsDebounced, scrollChatToBottom, updateMessageBlock } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';

const { eventSource, event_types, renderExtensionTemplateAsync } = SillyTavern.getContext();

const extensionName = 'StructuredPrefill';
const extensionPath = 'third-party/StructuredPrefill';

const defaultSettings = {
    enabled: true,
    hide_prefill_in_display: true,
    newline_token: '\\n',
    // Require some actual continuation beyond the prefix (in chars).
    min_chars_after_prefix: 80,
    // Number of characters from the end of the existing message used as overlap for Continue.
    continue_overlap_chars: 14,
    // Anti-Slop: newline-separated list of banned words/phrases.
    anti_slop_ban_list: '',

    // Prefill Generator: if the prefill template contains `[[pg]]`, we run a separate (non-streaming) generation
    // using a different connection profile and splice the output into the template before injecting json_schema.
    prefill_gen_enabled: false,
    prefill_gen_profile_id: '',
    prefill_gen_max_tokens: 15,
    prefill_gen_stop: '',
    prefill_gen_timeout_ms: 12000,
};

const runtimeState = {
    active: false,
    lastInjectedAt: 0,
    latestStreamText: '',
    lastAppliedText: '',
    expectedPrefill: '',
    newlineToken: '',
    patternMode: 'default',
    knownNames: [],
    continue: {
        active: false,
        messageId: -1,
        baseText: '',
        // For hide-prefill display during Continue we need a stable "display base" that does not grow as tokens stream in.
        // Otherwise we'd repeatedly append the whole delta and blow up `extra.display_text`.
        displayBase: '',
        // Continue can have a "prompt manager" assistant prefill that gets combined with the continued message.
        // We strip that prefix from the decoded value before applying it to the message (so Continue does not
        // re-add the PM prefill to the chat history).
        pmStripLiteral: '',
        pmStripRegex: null,
        // Continue can require a small overlap prefix so the model "hooks" onto the existing text naturally.
        // We strip the overlap back out before appending to the base message.
        overlapText: '',
        overlapStripLiteral: '',
        overlapStripRegex: null,
        stripLiteral: '',
        stripRegex: null,
    },
    hidePrefillLiteral: '',
    hidePrefillRegex: null,
    streamObserver: null,
    observedMessageId: -1,
    renderQueued: false,
    stopCleanupTimer: null,
    stopping: false,
    stopSessionAt: 0,
    trackedSwipeId: -1,
    applyingDom: 0,
    postFrameQueued: false,
    userScrollLocked: false,
    lastUserScrollIntentAt: 0,
    scrollIntentListenersAttached: false,
    streamGuard: {
        startedAt: 0,
        lastRawLen: 0,
        lastDecodedLen: 0,
        lastProgressAt: 0,
        suspiciousStreak: 0,
        stopRequested: false,
    },
};

function getChatScrollElement() {
    const el = document.getElementById('chat');
    return el instanceof HTMLElement ? el : null;
}

function isChatScrolledToBottom(el, thresholdPx = 5) {
    if (!(el instanceof HTMLElement)) return false;
    return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < thresholdPx;
}

function markUserScrollIntent() {
    runtimeState.lastUserScrollIntentAt = Date.now();
}

function userRecentlyIntendedScroll(windowMs = 800) {
    return Date.now() - (runtimeState.lastUserScrollIntentAt || 0) < windowMs;
}

function updateUserScrollLockFromScrollEvent() {
    const el = getChatScrollElement();
    if (!el) return;

    // Mirror ST’s “lock when user scrolls up, unlock when they reach bottom”,
    // but don’t lock due to incidental scroll anchoring/layout shifts unless the user actually tried to scroll.
    const atBottom = isChatScrolledToBottom(el, 5);
    if (atBottom) {
        runtimeState.userScrollLocked = false;
        return;
    }

    if (userRecentlyIntendedScroll(800)) {
        runtimeState.userScrollLocked = true;
    }
}

function ensureScrollIntentListeners() {
    if (runtimeState.scrollIntentListenersAttached) return;
    const el = getChatScrollElement();
    if (!el) return;

    runtimeState.scrollIntentListenersAttached = true;

    el.addEventListener('wheel', markUserScrollIntent, { passive: true });
    el.addEventListener('touchstart', markUserScrollIntent, { passive: true });
    el.addEventListener('touchmove', markUserScrollIntent, { passive: true });
    el.addEventListener('pointerdown', markUserScrollIntent, { passive: true });
    el.addEventListener('mousedown', markUserScrollIntent, { passive: true });
    el.addEventListener('scroll', updateUserScrollLockFromScrollEvent, { passive: true });

    // Initialize lock state based on current scroll position.
    runtimeState.userScrollLocked = !isChatScrolledToBottom(el, 5);
}

function schedulePostFrameGuard(messageId) {
    if (runtimeState.postFrameQueued) return;
    runtimeState.postFrameQueued = true;

    requestAnimationFrame(() => {
        runtimeState.postFrameQueued = false;
        if (!runtimeState.active) return;
        if (messageId !== runtimeState.observedMessageId) return;

        const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        const domText = textEl instanceof HTMLElement ? String(textEl.textContent ?? '') : '';
        // If ST’s own streaming renderer overwrote us after our observer pass, stomp JSON again.
        const domContainsStructuredJson = looksLikeStructuredJsonBlob(domText);
        if (domContainsStructuredJson && typeof runtimeState.lastAppliedText === 'string') {
            applyTextToMessageStreaming(messageId, runtimeState.lastAppliedText);
        }
    });
}

function loadSettings() {
    extension_settings[extensionName] ??= {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        extension_settings[extensionName][key] ??= value;
    }
}

function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapePrefixLiteral(str) {
    // In practice, models sometimes "double-escape" quotes while inside JSON strings (outputting `\"` as two characters
    // backslash+quote in the decoded value). If we require a raw `"` in the prefix, the grammar can get stuck at the
    // first quote and terminate early. Allow any number of literal backslashes before quotes in *literal* prefix segments.
    return escapeRegExp(str).replace(/"/g, '(?:\\\\)*"');
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.trunc(num);
    return Math.min(max, Math.max(min, int));
}

function parseStopStrings(raw) {
    const s = String(raw ?? '');
    const lines = s.split(/\r?\n/g).map(x => String(x ?? '').trim()).filter(Boolean);
    return lines;
}

function getConnectionProfilesSafe() {
    const profiles = extension_settings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

function renderPrefillGenProfileSelect() {
    const select = document.getElementById('structuredprefill_prefill_gen_profile');
    if (!(select instanceof HTMLSelectElement)) return;

    const current = String(extension_settings?.[extensionName]?.prefill_gen_profile_id ?? '');
    const profiles = getConnectionProfilesSafe()
        .filter(p => p && typeof p === 'object')
        .filter(p => String(p.mode ?? '').toLowerCase() === 'cc')
        .slice()
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));

    select.innerHTML = '';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '<None>';
    select.appendChild(none);

    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = String(p.id ?? '');
        opt.textContent = String(p.name ?? p.id ?? 'Profile');
        select.appendChild(opt);
    }

    // Best-effort: restore selection.
    select.value = current;
    if (select.value !== current) {
        select.value = '';
    }
}

function templateHasPrefillGenSlot(template) {
    return /\[\[\s*pg\s*\]\]/i.test(String(template ?? ''));
}

function extractPlainTextFromCompletionResponse(data) {
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // Some sources use array-of-parts formats; keep only text-ish parts.
        return content.map(x => (typeof x === 'string' ? x : (x?.text ?? ''))).filter(Boolean).join('');
    }
    return '';
}

async function runPrefillGeneratorOrEmpty({ generateData, tailIndex, timeoutMs, maxTokens, stopStrings, profileId }) {
    const profiles = getConnectionProfilesSafe();
    const profile = profiles.find(p => String(p?.id ?? '') === String(profileId ?? '')) ?? null;
    if (!profile) {
        throw new Error('Prefill generator: connection profile not found');
    }
    if (String(profile.mode ?? '').toLowerCase() !== 'cc') {
        throw new Error('Prefill generator: selected profile is not a Chat Completion profile');
    }

    const source = String(profile.api ?? '').trim().toLowerCase();
    const model = String(profile.model ?? '').trim();
    if (!source) {
        throw new Error('Prefill generator: profile has no API (api) value');
    }
    if (!model) {
        throw new Error('Prefill generator: profile has no model value');
    }

    // Full chat context minus the trailing assistant prefill template.
    const baseMessages = Array.isArray(generateData?.messages)
        ? generateData.messages.filter((_, i) => i !== tailIndex).map(m => ({ ...m }))
        : [];

    if (!baseMessages.length) {
        throw new Error('Prefill generator: no messages to generate from');
    }

    // Some routed providers reject assistant-role final messages. Ensure last role is not assistant.
    const last = baseMessages[baseMessages.length - 1];
    if (last?.role === 'assistant') {
        baseMessages[baseMessages.length - 1] = { ...last, role: 'user' };
    }

    const payload = {
        type: 'quiet',
        messages: baseMessages,
        model: model,
        temperature: 1,
        top_p: 1,
        max_tokens: maxTokens,
        stream: false,
        stop: (Array.isArray(stopStrings) && stopStrings.length) ? stopStrings : undefined,
        chat_completion_source: source,
        user_name: generateData?.user_name,
        char_name: generateData?.char_name,
        group_names: generateData?.group_names,
        include_reasoning: false,
        enable_web_search: false,
        request_images: false,
    };

    // Custom OpenAI-compatible requires an explicit URL.
    if (source === 'custom') {
        const url = String(profile['api-url'] ?? '').trim();
        if (!url) {
            throw new Error('Prefill generator: custom profile missing api-url');
        }
        payload.custom_url = url;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));

    try {
        const res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Prefill generator: backend returned ${res.status} ${res.statusText}${text ? `: ${text}` : ''}`);
        }

        const data = await res.json();
        if (data?.error) {
            const msg = String(data?.error?.message ?? data?.message ?? 'Unknown error');
            throw new Error(`Prefill generator: ${msg}`);
        }

        return extractPlainTextFromCompletionResponse(data);
    } finally {
        clearTimeout(timer);
    }
}

function supportsStructuredPrefillForSource(chatCompletionSource) {
    // IMPORTANT: We only activate on sources that (in SillyTavern server) apply `json_schema`
    // as a real structured output mechanism (OpenAI-style `response_format: json_schema` or
    // an equivalent JSON-schema response feature). Some sources translate `json_schema` to
    // JSON-mode / prompt hacks or forced tooling, which would break this extension’s contract.
    const src = String(chatCompletionSource ?? '').toLowerCase();
    const incompatible = new Set([
        // Tool-based or non-OpenAI response format.
        'claude',
        // These providers map `json_schema` to JSON mode / prompt hacks on the server.
        'ai21',
        'deepseek',
        'moonshot',
        'zai',
        'siliconflow',
        // Currently disabled server-side.
        'cometapi',
        '',
    ]);

    return !incompatible.has(src);
}

function normalizeNewlines(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function prefixHasSlots(prefix) {
    return /\[\[[^\]]+?\]\]/.test(String(prefix ?? ''));
}

function looksLikeStructuredJsonBlob(text) {
    const s = String(text ?? '');
    if (!s.includes('{') || !s.includes('"')) return false;
    // Detect our JSON wrapper even if it appears *after* a Continue base message ("Foo... {\"value\":\"...\"}").
    return /\{\s*"(?:value|prefix|content)"\s*:/.test(s);
}

function clearHidePrefillState() {
    runtimeState.hidePrefillLiteral = '';
    runtimeState.hidePrefillRegex = null;
}

function clearContinueState() {
    runtimeState.continue.active = false;
    runtimeState.continue.messageId = -1;
    runtimeState.continue.baseText = '';
    runtimeState.continue.displayBase = '';
    runtimeState.continue.pmStripLiteral = '';
    runtimeState.continue.pmStripRegex = null;
    runtimeState.continue.overlapText = '';
    runtimeState.continue.overlapStripLiteral = '';
    runtimeState.continue.overlapStripRegex = null;
    runtimeState.continue.stripLiteral = '';
    runtimeState.continue.stripRegex = null;
}

function getLastAssistantMessageId() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m) continue;
        if (m.is_user) continue;
        if (m.is_system) continue;
        return i;
    }
    return -1;
}

function getActiveAssistantMessageIdForStreaming() {
    const id = runtimeState.continue.active ? runtimeState.continue.messageId : (chat.length - 1);
    if (Number.isInteger(id) && id >= 0 && id < chat.length && !chat[id]?.is_user && !chat[id]?.is_system) return id;
    const last = getLastAssistantMessageId();
    return last >= 0 ? last : (chat.length - 1);
}

function resetStreamGuard() {
    runtimeState.streamGuard.startedAt = Date.now();
    runtimeState.streamGuard.lastRawLen = 0;
    runtimeState.streamGuard.lastDecodedLen = 0;
    runtimeState.streamGuard.lastProgressAt = Date.now();
    runtimeState.streamGuard.suspiciousStreak = 0;
    runtimeState.streamGuard.stopRequested = false;
}

function showGuardToast(message) {
    try {
        if (window?.toastr?.error) {
            window.toastr.error(String(message ?? ''), extensionName, { timeOut: 9000, closeButton: true });
            return;
        }
    } catch {
        // ignore
    }
    console.warn(`[${extensionName}] ${String(message ?? '')}`);
}

function tryStopGeneration() {
    // ST renders an "Abort request" button while generating.
    // Triggering its click is the most compatible way for an extension to stop generation.
    try {
        const btn = document.getElementById('mes_stop') || document.querySelector('.mes_stop');
        if (btn instanceof HTMLElement) {
            btn.click();
            return true;
        }
    } catch {
        // ignore
    }
    return false;
}

function getDecodedValueForGuard(rawText) {
    // Guard uses the *full* decoded value (before "hide prefill text") so we don't falsely detect "no progress"
    // while the model is still streaming the hidden prefix.
    const decode = (s) => decodeNewlines(s, runtimeState.newlineToken);
    try {
        const parsed = JSON.parse(String(rawText ?? ''));
        if (parsed && typeof parsed === 'object' && typeof parsed.value === 'string') return decode(parsed.value);
    } catch {
        // ignore
    }
    const legacy = tryExtractJsonStringField(String(rawText ?? ''), 'value');
    if (typeof legacy === 'string') return decode(legacy);
    return null;
}

function isSuspiciousPaddingDelta(delta) {
    const s = String(delta ?? '');
    if (s.length < 120) return false;

    // If the model is "stuck" trying to satisfy a regex, it often emits long runs of punctuation, slashes, commas, etc.
    const backslashes = (s.match(/\\/g) || []).length;
    const commas = (s.match(/,/g) || []).length;
    const punct = (s.match(/[\\,.;:!?'"()\[\]{}<>/~`|_-]/g) || []).length;

    const punctRatio = punct / Math.max(1, s.length);
    const slashRatio = backslashes / Math.max(1, s.length);

    if (slashRatio > 0.25) return true;
    if (commas > 80 && punctRatio > 0.45) return true;
    if (punctRatio > 0.60) return true;

    // A long "word" with lots of commas and no spaces is also a common failure mode (word-slot cheating / schema thrash).
    if (!s.includes(' ') && s.length > 260 && /[A-Za-z]/.test(s) && commas > 40) return true;

    // Extremely repetitive single-character runs.
    if (/^(.)\1{250,}$/s.test(s)) return true;
    if (/\\{250,}/.test(s)) return true;

    return false;
}

function maybeAbortOnStreamLoop(rawText, decodedFullText) {
    if (!runtimeState.active) return;
    if (runtimeState.streamGuard.stopRequested) return;

    const rawLen = String(rawText ?? '').length;
    const decodedLen = String(decodedFullText ?? '').length;
    const now = Date.now();

    const guard = runtimeState.streamGuard;

    // Track progress whenever decoded text actually changes length (best-effort).
    if (decodedLen !== guard.lastDecodedLen) {
        const prevLen = guard.lastDecodedLen;
        guard.lastDecodedLen = decodedLen;
        guard.lastProgressAt = now;

        if (decodedLen > prevLen) {
            const delta = String(decodedFullText ?? '').slice(prevLen);
            if (isSuspiciousPaddingDelta(delta)) {
                guard.suspiciousStreak++;
            } else {
                guard.suspiciousStreak = Math.max(0, guard.suspiciousStreak - 1);
            }
        }
    }

    // Track incoming raw stream length even if decoded text isn't moving.
    if (rawLen > guard.lastRawLen) {
        guard.lastRawLen = rawLen;
    }

    const sinceStart = now - (guard.startedAt || now);
    const sinceProgress = now - (guard.lastProgressAt || now);

    // 1) Hard stall: raw keeps growing but we can't decode any additional visible content for too long.
    // Be conservative to avoid false positives — some models (Opus 4.6 via OpenRouter) can pause
    // for 10+ seconds mid-generation while satisfying structured output constraints.
    if (sinceStart > 5000 && sinceProgress > 15000 && rawLen > 5000) {
        guard.stopRequested = true;
        showGuardToast('Detected stalled/looping structured output (no decode progress). Stopping generation.');
        if (!tryStopGeneration()) {
            showGuardToast('Failed to click Stop button; please stop generation manually.');
        }
        return;
    }

    // 2) Padding loop: repeated suspicious "garbage" deltas (often caused by bad [[re:...]] escaping).
    if (sinceStart > 1500 && guard.suspiciousStreak >= 4 && rawLen > 1500) {
        guard.stopRequested = true;
        showGuardToast('Detected runaway padding while trying to satisfy the schema. Stopping generation.');
        if (!tryStopGeneration()) {
            showGuardToast('Failed to click Stop button; please stop generation manually.');
        }
    }
}

function splitHidePrefillTemplate(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { hideTemplate: '', hasKeepMarker: false };

    // When "Hide prefill text" is enabled, users can place `[[keep]]` inside the prefill template.
    // Everything *before* the marker is hidden; everything after stays visible.
    // The marker itself is not meant to be output by the model (it matches empty in the schema regex).
    const markerRe = /\[\[\s*keep\s*\]\]/i;
    const m = markerRe.exec(normalized);
    if (!m) return { hideTemplate: normalized, hasKeepMarker: false };

    return {
        hideTemplate: normalized.slice(0, m.index),
        hasKeepMarker: true,
    };
}

function buildPrefillStripper(prefixTemplate) {
    const { hideTemplate } = splitHidePrefillTemplate(prefixTemplate);
    if (!hideTemplate) return;

    if (!prefixHasSlots(hideTemplate)) {
        runtimeState.hidePrefillLiteral = hideTemplate;
        runtimeState.hidePrefillRegex = null;
        return;
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(hideTemplate);
    try {
        runtimeState.hidePrefillRegex = new RegExp(`^((?:${prefixRegex}))`);
    } catch (err) {
        console.warn(`[${extensionName}] Failed to build hide-prefill regex; falling back to literal stripping only.`, err);
        runtimeState.hidePrefillRegex = null;
        runtimeState.hidePrefillLiteral = hideTemplate;
    }
}

function buildContinueStripper(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return;

    // For Continue, we always strip the *entire* structured prefix from the model output delta, then re-prepend the
    // real chat message text from ST (so we keep the message being continued, without duplicating it).
    if (!prefixHasSlots(normalized)) {
        runtimeState.continue.stripLiteral = normalized;
        runtimeState.continue.stripRegex = null;
        return;
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(normalized);
    try {
        runtimeState.continue.stripRegex = new RegExp(`^((?:${prefixRegex}))`);
        runtimeState.continue.stripLiteral = '';
    } catch (err) {
        console.warn(`[${extensionName}] Failed to build continue-strip regex; falling back to literal stripping only.`, err);
        runtimeState.continue.stripRegex = null;
        runtimeState.continue.stripLiteral = normalized;
    }
}

function buildContinuePmStripper(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return;

    if (!prefixHasSlots(normalized)) {
        runtimeState.continue.pmStripLiteral = normalized;
        runtimeState.continue.pmStripRegex = null;
        return;
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(normalized);
    try {
        runtimeState.continue.pmStripRegex = new RegExp(`^((?:${prefixRegex}))`);
        runtimeState.continue.pmStripLiteral = '';
    } catch (err) {
        console.warn(`[${extensionName}] Failed to build continue-pm-strip regex; falling back to literal stripping only.`, err);
        runtimeState.continue.pmStripRegex = null;
        runtimeState.continue.pmStripLiteral = normalized;
    }
}

function computeContinueOverlapBase(baseText, maxChars = 14) {
    const base = normalizeNewlines(String(baseText ?? ''));
    if (!base) return '';
    const n = clampInt(maxChars, 0, 120, 14);
    if (n <= 0) return '';
    return base.slice(Math.max(0, base.length - n));
}

function buildContinueOverlapStripper(overlapText) {
    const normalized = normalizeNewlines(overlapText);
    if (!normalized) return;

    // Overlap is treated as a literal (no slots).
    runtimeState.continue.overlapStripLiteral = normalized;
    runtimeState.continue.overlapStripRegex = null;

    // For Anthropic mode, non-ASCII characters in the overlap get replaced with `.` in the
    // schema pattern.  The model can then output *any* character in those positions, so a
    // literal startsWith check would fail.  Build a regex that mirrors the same replacement
    // so the stripper still matches.
    // eslint-disable-next-line no-control-regex
    if (runtimeState.patternMode === 'anthropic' && /[^\x00-\x7F]/.test(normalized)) {
        try {
            const regexSrc = normalized.split('').map(ch =>
                // eslint-disable-next-line no-control-regex
                /[^\x00-\x7F]/.test(ch) ? '.' : escapeRegExp(ch),
            ).join('');
            runtimeState.continue.overlapStripRegex = new RegExp(`^(${regexSrc})`);
        } catch {
            // Fall back to literal
        }
    }
}

function stripContinueOverlapPrefix(text) {
    if (!runtimeState.continue.active) return text;
    if (typeof text !== 'string' || text.length === 0) return text;
    const normalized = normalizeNewlines(text);

    if (runtimeState.continue.overlapStripRegex instanceof RegExp) {
        const m = runtimeState.continue.overlapStripRegex.exec(normalized);
        if (m && typeof m[1] === 'string') {
            return normalized.slice(m[1].length);
        }
    }

    const literal = String(runtimeState.continue.overlapStripLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    return normalized;
}

function buildContinueJoinPlaceholder(baseText) {
    // Returns a RAW regex fragment (not a [[...]] slot template).
    // This is appended directly to the prefixRegex after template processing to avoid
    // slot-parser issues with `]` inside character classes (e.g. `[^A-Z]` inside `[[re:...]]`).
    const base = normalizeNewlines(String(baseText ?? ''));
    if (base.length < 2) return '';

    const last = base[base.length - 1];
    const prev = base[base.length - 2];

    const isAsciiLetter = (ch) => /[A-Za-z]/.test(ch);
    const isAsciiUpper = (ch) => /[A-Z]/.test(ch);
    const isAsciiAlphaNum = (ch) => /[A-Za-z0-9]/.test(ch);

    // If the base ends with the *first letter* of a word (e.g. `"Oh, d`), force the next char to be
    // a word-continuation character so the model completes the word instead of inserting punctuation.
    // Allows both cases (lowercase + uppercase) to support ALL-CAPS dialogue / emphasis in roleplay.
    if (isAsciiLetter(last) && /[\s"'""''(\[{<,.;:!?-]/.test(prev)) {
        return "(?:[a-zA-Z\\-\\'])";
    }

    // If base ends with an alnum char (but not clearly mid-word), disallow an immediate uppercase
    // letter as the next char.  The model can still start a new sentence by emitting whitespace first.
    if (isAsciiAlphaNum(last) && isAsciiUpper(last) === false) {
        return '[^A-Z]';
    }

    return '';
}

function stripContinuePmPrefix(text) {
    if (!runtimeState.continue.active) return text;
    if (typeof text !== 'string' || text.length === 0) return text;
    const normalized = normalizeNewlines(text);

    if (runtimeState.continue.pmStripRegex instanceof RegExp) {
        const m = runtimeState.continue.pmStripRegex.exec(normalized);
        if (m && typeof m[1] === 'string') {
            return normalized.slice(m[1].length);
        }
    }

    const literal = String(runtimeState.continue.pmStripLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    return normalized;
}

function splitContinuePmPrefixFromTail(tailText, baseText) {
    const tail = normalizeNewlines(String(tailText ?? ''));
    const base = normalizeNewlines(String(baseText ?? ''));
    if (!tail || !base) return { pmPrefix: '', baseFound: false };
    if (tail === base) return { pmPrefix: '', baseFound: true };

    let idx = tail.indexOf(base);
    if (idx >= 0) return { pmPrefix: tail.slice(0, idx), baseFound: true };

    const tailCanon = canonicalizeForContinueMatch(tail);
    const baseCanon = canonicalizeForContinueMatch(base);
    idx = tailCanon.indexOf(baseCanon);
    if (idx >= 0) return { pmPrefix: tail.slice(0, idx), baseFound: true };

    const probeLen = Math.min(120, baseCanon.length);
    if (probeLen >= 40) {
        const probe = baseCanon.slice(0, probeLen);
        idx = tailCanon.indexOf(probe);
        if (idx >= 0) return { pmPrefix: tail.slice(0, idx), baseFound: true };
    }

    return { pmPrefix: '', baseFound: false };
}

function maybeHidePrefillForDisplay(text) {
    const settings = extension_settings[extensionName];
    if (!settings?.hide_prefill_in_display) return text;
    if (typeof text !== 'string' || text.length === 0) return text;

    const normalized = normalizeNewlines(text);

    if (runtimeState.hidePrefillRegex instanceof RegExp) {
        const m = runtimeState.hidePrefillRegex.exec(normalized);
        if (m && typeof m[1] === 'string' && m[1].length > 0) {
            return normalized.slice(m[1].length);
        }
    }

    const literal = String(runtimeState.hidePrefillLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    return normalized;
}

function storePrefillMetadataForMessage(messageId, prefixTemplate) {
    if (typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;
    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    const prefix = String(prefixTemplate ?? '');
    if (!prefix) return;

    message.extra ??= {};
    const meta = (message.extra.structuredprefill && typeof message.extra.structuredprefill === 'object')
        ? message.extra.structuredprefill
        : {};

    const { hideTemplate, hasKeepMarker } = splitHidePrefillTemplate(prefix);
    meta.prefixTemplate = prefix;
    meta.hideTemplate = hideTemplate;
    meta.hasKeepMarker = Boolean(hasKeepMarker);
    message.extra.structuredprefill = meta;
}

function tryStripPrefixForDisplayFromTemplate(fullText, prefixTemplate) {
    const normalized = normalizeNewlines(String(fullText ?? ''));
    const prefix = normalizeNewlines(String(prefixTemplate ?? ''));
    if (!normalized || !prefix) return normalized;

    if (!prefixHasSlots(prefix)) {
        return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(prefix);
    try {
        const re = new RegExp(`^((?:${prefixRegex}))`);
        const m = re.exec(normalized);
        if (m && typeof m[1] === 'string' && m[1].length > 0) {
            return normalized.slice(m[1].length);
        }
    } catch {
        // ignore
    }

    // Fallback: literal attempt even if slots exist (better than nothing).
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function onMessageUpdated(messageId) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;
    if (!settings?.hide_prefill_in_display) return;
    if (typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;

    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    const meta = message.extra?.structuredprefill;
    if (!meta || typeof meta !== 'object') return;
    if (typeof message.mes !== 'string') return;

    const hideTemplate = typeof meta.hideTemplate === 'string' ? meta.hideTemplate : '';
    if (!hideTemplate) return;

    const stripped = tryStripPrefixForDisplayFromTemplate(message.mes, hideTemplate);
    message.extra ??= {};

    // Strip the prefill from mes itself so it doesn't enter the AI's context.
    // Also update the active swipe entry so it stays in sync.
    if (stripped !== message.mes) {
        message.mes = stripped;
        if (Array.isArray(message.swipes) && message.swipe_id != null) {
            message.swipes[message.swipe_id] = stripped;
        }
    }
    // display_text is no longer needed when mes is already stripped.
    if (Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        delete message.extra.display_text;
    }

    try {
        // Re-render so message edits don't permanently un-hide prefixes.
        // IMPORTANT: must pass `message` — ST's updateMessageBlock accesses message.mes / message.extra.display_text
        // and will throw if the message object is omitted.
        updateMessageBlock(messageId, message);
    } catch {
        // ignore
    }
}

function computeDisplayText(messageId, fullText) {
    const settings = extension_settings[extensionName];
    if (!settings?.hide_prefill_in_display) return fullText;
    if (typeof fullText !== 'string' || fullText.length === 0) return fullText;

    // Continue mode:
    // Prefer preserving any existing display-only hidden prefix by appending only the delta.
    // This keeps "Hide prefill text" stable across Continue, without mutating what gets sent as history.
    if (runtimeState.continue.active) {
        const base = String(runtimeState.continue.baseText ?? '');
        if (base && fullText.startsWith(base)) {
            const delta = fullText.slice(base.length);
            const displayBase = runtimeState.continue.displayBase || base;
            return String(displayBase ?? '') + delta;
        }
        // If we can't reliably compute a delta, fall back to showing the full text (never wipe the message).
        return fullText;
    }

    return maybeHidePrefillForDisplay(fullText);
}

function canonicalizeForContinueMatch(text) {
    const input = normalizeNewlines(String(text ?? ''));
    let out = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        switch (ch) {
            case '\u00A0': out += ' '; break; // nbsp
            case '\u201C':
            case '\u201D':
                out += '"';
                break;
            case '\u2018':
            case '\u2019':
                out += '\'';
                break;
            case '\u2010':
            case '\u2011':
            case '\u2012':
            case '\u2013':
            case '\u2014':
                out += '-';
                break;
            default:
                out += ch;
                break;
        }
    }
    return out.toLowerCase();
}

function stripContinuePrefix(text) {
    if (!runtimeState.continue.active) return text;
    if (typeof text !== 'string' || text.length === 0) return text;

    const normalized = normalizeNewlines(text);

    if (runtimeState.continue.stripRegex instanceof RegExp) {
        const m = runtimeState.continue.stripRegex.exec(normalized);
        if (m && typeof m[1] === 'string') {
            return normalized.slice(m[1].length);
        }
    }

    const literal = String(runtimeState.continue.stripLiteral ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    const canonicalize = (s) => {
        const input = normalizeNewlines(String(s ?? ''));
        let out = '';
        for (let i = 0; i < input.length; i++) {
            const ch = input[i];
            switch (ch) {
                case '\u00A0': out += ' '; break; // nbsp
                case '\u201C': // “
                case '\u201D': // ”
                    out += '"';
                    break;
                case '\u2018': // ‘
                case '\u2019': // ’
                    out += '\'';
                    break;
                case '\u2010': // ‐
                case '\u2011': // ‑
                case '\u2012': // ‒
                case '\u2013': // –
                case '\u2014': // —
                    out += '-';
                    break;
                default:
                    out += ch;
                    break;
            }
        }
        return out.toLowerCase();
    };

    // Fallback for providers that don't strictly enforce the prefix regex (so we can't regex-strip reliably):
    // try to locate the end of the *existing* message text within the decoded value and strip up to it.
    const base = String(runtimeState.continue.baseText ?? '');
    if (base) {
        const baseCanon = canonicalizeForContinueMatch(base);
        const textCanon = canonicalizeForContinueMatch(normalized);

        // If the decoded value starts with the base message (modulo canonicalization), strip by length.
        // This avoids "doubling" when providers don't strictly enforce the schema prefix.
        if (baseCanon.length >= 40 && textCanon.startsWith(baseCanon)) {
            return normalized.slice(baseCanon.length);
        }

        const tryTailLen = (tailLen) => {
            const len = Math.min(tailLen, baseCanon.length, textCanon.length);
            if (len < 20) return null;
            const needle = baseCanon.slice(baseCanon.length - len);
            const expected = Math.max(0, baseCanon.length - len);

            let bestPos = -1;
            let bestScore = Number.POSITIVE_INFINITY;
            let start = 0;
            while (true) {
                const pos = textCanon.indexOf(needle, start);
                if (pos === -1) break;
                const score = Math.abs(pos - expected);
                if (score < bestScore) {
                    bestScore = score;
                    bestPos = pos;
                    // Good enough; don't scan forever.
                    if (bestScore === 0) break;
                }
                start = pos + 1;
            }

            if (bestPos >= 0) {
                const cut = bestPos + len;
                if (cut >= 0 && cut <= normalized.length) return normalized.slice(cut);
            }

            return null;
        };

        // Prefer longer overlaps, but fall back progressively.
        const maxLen = Math.min(520, baseCanon.length, textCanon.length);
        for (let len = maxLen; len >= 40; len -= 20) {
            const candidate = tryTailLen(len);
            if (typeof candidate === 'string') return candidate;
        }

        const candidate = (
            tryTailLen(220) ??
            tryTailLen(140) ??
            tryTailLen(90) ??
            tryTailLen(60) ??
            tryTailLen(40)
        );

        if (typeof candidate === 'string') return candidate;
    }

    return normalized;
}

function chooseNewlineToken(prefix, preferredToken) {
    let token = String(preferredToken ?? '').trim();
    if (!token || /[\r\n]/.test(token)) token = '<NL>';

    const normalized = normalizeNewlines(prefix);
    if (!normalized.includes(token)) return token;

    // Find an alternative token that doesn't appear in the prefix.
    for (let i = 2; i <= 25; i++) {
        const candidate = `<NL${i}>`;
        if (!normalized.includes(candidate)) return candidate;
    }

    // Worst-case fallback: a rarely-used unicode symbol.
    const unicodeFallback = '␤';
    if (!normalized.includes(unicodeFallback)) return unicodeFallback;

    // If *everything* is present, keep the preferred token and accept ambiguity.
    return token;
}

function encodeNewlines(text, newlineToken) {
    const token = String(newlineToken ?? '');
    if (!token) return String(text ?? '');
    return normalizeNewlines(text).replace(/\n/g, token);
}

function decodeNewlines(text, newlineToken) {
    const token = String(newlineToken ?? '');
    if (!token) return String(text ?? '');
    return String(text ?? '').split(token).join('\n');
}

function sanitizeUserRegex(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return '';
    if (/[\r\n]/.test(s)) return '';

    // Allow /pattern/flags (we ignore flags because JSON-schema patterns don't support them).
    if (s.startsWith('/') && s.lastIndexOf('/') > 0) {
        const lastSlash = s.lastIndexOf('/');
        if (lastSlash > 0) {
            const inner = s.slice(1, lastSlash);
            // If it looks like /.../flags, accept the inner.
            if (inner) s = inner;
        }
    }

    // Remove anchors; we embed this into a larger ^prefix...$ pattern.
    s = s.replace(/^\^+/, '').replace(/\$+$/, '');
    return s.trim();
}

function parseOptionsList(raw) {
    const parts = String(raw ?? '')
        .split(/[|,]/g)
        .map(x => x.trim())
        .filter(Boolean);
    return Array.from(new Set(parts)).slice(0, 50);
}

function anyCharIncludingNewlineExpr() {
    // Avoid `[\s\S]` because some providers (notably Anthropic via OpenRouter) reject `\S` in schema patterns.
    // `(?:.|\n)` is a widely-supported equivalent for "any char including newline" without using `\S`.
    return '(?:.|\\n)';
}

function getPatternModeForRequest(source, modelId) {
    const src = String(source ?? '').toLowerCase();
    const model = String(modelId ?? '').toLowerCase();

    // Direct Anthropic/Claude provider implementations tend to have stricter schema-regex support than OpenAI.
    // Use the conservative pattern set to avoid rejected patterns like `\\S` and some `{n,m}` quantifiers.
    if (src === 'claude' || src === 'anthropic') {
        return 'anthropic';
    }

    // OpenRouter routes to many providers. When the routed provider is Anthropic, their schema-regex
    // implementation is stricter than OpenAI's and rejects several patterns we use (notably `\S` and
    // some `{n,m}` range quantifiers). Use a more conservative pattern set.
    if (src === 'openrouter' && (model.startsWith('anthropic/') || model.includes('claude'))) {
        return 'anthropic';
    }

    // OpenAI-compatible providers (proxies, etc.) routing to Anthropic/Claude models have the same
    // strict regex limitations. Detect by model name.
    if (model.includes('claude') || model.includes('anthropic')) {
        return 'anthropic';
    }

    return 'default';
}

/**
 * Build a DFA-complement regex from the anti-slop ban list.
 * Returns a regex group that matches one "step" (1+ chars) without completing
 * any banned word, or null if the list is empty / unsupported.
 * Usage: replace `(?:.|\\n)` with the returned group in the continuation.
 *
 * Approach: build a trie of banned words, then convert it to a complement regex.
 * Each iteration of the outer group consumes 1+ chars without completing any banned word.
 * E.g. banning "gaze" → ([^gG]|[gG]([^aA]|[aA]([^zZ]|[zZ][^eE])))
 */
function buildAntiSlopContinuation(banListStr) {
    const raw = String(banListStr ?? '');
    if (!raw.trim()) return null;

    const seen = new Set();
    const words = [];
    for (const line of raw.split('\n')) {
        const entry = line.trim();
        if (!entry || seen.has(entry.toLowerCase())) continue;
        seen.add(entry.toLowerCase());
        words.push(entry);
    }
    if (words.length === 0) return null;

    // Build trie (keyed by lowercase)
    const mkNode = () => ({ ch: new Map(), end: false });
    const root = mkNode();
    for (const word of words) {
        let node = root;
        for (const c of word) {
            const k = c.toLowerCase();
            if (!node.ch.has(k)) node.ch.set(k, mkNode());
            node = node.ch.get(k);
        }
        node.end = true;
    }

    const escClass = (c) => (c === ']' || c === '\\' || c === '^' || c === '-') ? '\\' + c : c;

    // Recursively convert a trie node to a complement regex group.
    // The returned group matches one "safe step" from this node's perspective.
    function toRegex(node) {
        if (node.ch.size === 0) return null; // leaf — no further constraints

        const excludes = []; // chars to exclude in the safe catch-all class
        const branches = []; // branches for chars that start a potential match

        for (const [key, child] of node.ch) {
            const lo = key.toLowerCase();
            const up = key.toUpperCase();
            const hasCase = lo !== up;
            excludes.push(escClass(lo));
            if (hasCase) excludes.push(escClass(up));

            if (child.end) {
                // This char completes a banned word — blocked by the exclude class.
                // Even if the child has further children (longer words sharing this prefix),
                // the shorter banned word already blocks this path.
                continue;
            }

            // Not end — recurse deeper
            const charExpr = hasCase ? `[${up}${lo}]` : escClass(key);
            const sub = toRegex(child);
            if (sub) {
                branches.push(`${charExpr}${sub}`);
            } else {
                // Child is a leaf but not end — shouldn't happen, but treat as safe
                branches.push(charExpr);
            }
        }

        const safeClass = `[^${excludes.join('')}]`;
        const parts = [safeClass, ...branches];
        return `(${parts.join('|')})`;
    }

    const expr = toRegex(root);
    if (!expr) return null;

    try {
        new RegExp(expr);
    } catch {
        console.warn(`[${extensionName}] Anti-slop pattern failed validation, skipping.`);
        return null;
    }
    return expr;
}

function splitHintSuffix(placeholderBody) {
    const body = String(placeholderBody ?? '');
    const idx = body.toLowerCase().lastIndexOf('|hint:');
    if (idx === -1) return { spec: body.trim(), hint: '' };
    return {
        spec: body.slice(0, idx).trim(),
        hint: body.slice(idx + 6).trim(),
    };
}

function curlyQuoteLiteralsOutsideSlots(template) {
    const s = String(template ?? '');
    const slotRe = /\[\[[^\]]+?\]\]/g;
    let out = '';
    let last = 0;
    let m;
    let open = true;

    const transformLiteral = (lit) => String(lit).replace(/"/g, () => (open ? (open = false, '“') : (open = true, '”')));

    while ((m = slotRe.exec(s)) !== null) {
        out += transformLiteral(s.slice(last, m.index));
        out += m[0];
        last = m.index + m[0].length;
    }
    out += transformLiteral(s.slice(last));
    return out;
}

function buildWordCountPatternNoRanges(minWords, maxWords, { wordToken, wordSep }) {
    const min = clampInt(minWords, 1, 2000, 1);
    const max = clampInt(maxWords, 1, 2000, min);
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);

    // Construct an explicit sequence without `{n,m}` ranges.
    // After a cap, allow extra words via `*` (no range quantifier).
    const cap = 40;
    const cappedHi = Math.min(hi, cap);

    let out = '';
    for (let i = 0; i < lo; i++) {
        out += (i === 0) ? wordToken : `${wordSep}${wordToken}`;
    }
    for (let i = lo; i < cappedHi; i++) {
        out += `(?:${wordSep}${wordToken})?`;
    }
    if (hi > cap) {
        out += `(?:${wordSep}${wordToken})*`;
    }
    return out;
}

function buildPlaceholderRegex(placeholderBody) {
    const { spec: body } = splitHintSuffix(placeholderBody);
    const escapeForCharClass = (ch) => String(ch).replace(/[-\\\]^]/g, '\\$&');
    const newlineTok = String(runtimeState.newlineToken ?? '');
    const newlineTokSingle = newlineTok.length === 1 ? escapeForCharClass(newlineTok) : '';
    // IMPORTANT:
    // - Disallow `<` / `>` inside "word" tokens so the model can't smuggle our newline token (default "<NL>") into slots.
    // - If the newline token is a single character (e.g. "␤"), also disallow that character inside "word" tokens.
    const wordTokenCore = newlineTokSingle ? `[^\\s,<>${newlineTokSingle}]+` : `[^\\s,<>]+`;
    const wordToken = `${wordTokenCore}[,\\.!\\?;:'"\\)\\]\\}~-]*`;
    const wordSep = `[\\t ]+`;
    if (!body) return wordToken;

    const lower = body.toLowerCase();

    // [[w:2]] or [[words:2]] or [[w:2-5]]
    let m = /^(w|words)\s*:\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(lower);
    if (m) {
        const a = clampInt(m[2], 1, 2000, 1);
        const b = m[3] != null ? clampInt(m[3], 1, 2000, a) : a;
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        // IMPORTANT:
        // - Only count "words" separated by spaces/tabs (not newlines), so one slot can't span multiple lines.
        // - Disallow commas inside tokens, so models can't pack many words into a single "word" via comma-joining.
        if (runtimeState.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(min, max, { wordToken, wordSep });
        }

        const minTail = Math.max(0, min - 1);
        const maxTail = Math.max(0, max - 1);
        return `${wordToken}(?:${wordSep}${wordToken}){${minTail},${maxTail}}`;
    }

    // [[opt:yes|no]] / [[options:...]]
    m = /^(opt|options)\s*:\s*(.+?)\s*$/.exec(body);
    if (m) {
        const options = parseOptionsList(m[2]);
        if (options.length > 0) return `(?:${options.map(escapeRegExp).join('|')})`;
        return wordToken;
    }

    // [[re:...]] / [[regex:...]]
    m = /^(re|regex)\s*:\s*(.+?)\s*$/.exec(body);
    if (m) {
        const userRegex = sanitizeUserRegex(m[2]);
        if (userRegex) {
            // Anthropic/OpenRouter rejects some regex features (notably `\S` and some range quantifiers).
            // If the user-provided regex looks risky, fall back to a permissive wildcard.
            if (runtimeState.patternMode === 'anthropic' && (/[{}]/.test(userRegex) || /\\S/.test(userRegex))) {
                return `${anyCharIncludingNewlineExpr()}*`;
            }
            return `(?:${userRegex})`;
        }
        return `${anyCharIncludingNewlineExpr()}*`;
    }

    // [[free]]: allow any non-empty chunk, but prefer minimal match to allow following literals to match.
    if (/^free\s*$/i.test(body)) {
        return `${anyCharIncludingNewlineExpr()}+`;
    }

    // [[keep]]: display-only marker used with "Hide prefill text".
    // It is not output by the model; it matches empty in the prefix template.
    if (/^keep\s*$/i.test(body)) {
        return '(?:)';
    }

    // [[emotion]] / [[mood]]: common RP emotion word.
    if (/^(emotion|mood)\s*$/i.test(body)) {
        const emotions = [
            'happy', 'sad', 'angry', 'nervous', 'excited', 'scared', 'confused',
            'amused', 'annoyed', 'anxious', 'bored', 'calm', 'curious', 'desperate',
            'disgusted', 'embarrassed', 'frustrated', 'grateful', 'guilty', 'hopeful',
            'hurt', 'jealous', 'lonely', 'nostalgic', 'panicked', 'playful', 'proud',
            'relieved', 'shy', 'smug', 'surprised', 'suspicious', 'tender', 'terrified',
            'thoughtful', 'tired', 'uncomfortable', 'worried', 'flustered', 'melancholic',
            'determined', 'fearful', 'content', 'bitter', 'affectionate', 'giddy',
            'resigned', 'defiant', 'wistful', 'somber',
        ];
        return `(?:${emotions.join('|')})`;
    }

    // [[line]] or [[lines:2-4]]: full line(s) of text (no embedded newlines per line).
    // Each line matches `.+` (at least one char, no newlines). Multiple lines are separated by newline tokens.
    m = /^(line|lines)\s*(?::\s*(\d+)(?:\s*-\s*(\d+))?)?\s*$/i.exec(body);
    if (m) {
        const lineExpr = '.+';
        const nlExpr = newlineTok ? `(?:${escapeRegExp(newlineTok)}|\\n)` : '\\n';
        if (!m[2]) {
            // [[line]]: exactly one line
            return lineExpr;
        }
        const a = clampInt(m[2], 1, 50, 1);
        const b = m[3] != null ? clampInt(m[3], 1, 50, a) : a;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (runtimeState.patternMode === 'anthropic') {
            // Anthropic doesn't support range quantifiers — unroll lines
            let out = lineExpr; // first line always present
            for (let i = 1; i < lo; i++) {
                out += `${nlExpr}${lineExpr}`;
            }
            for (let i = lo; i < hi; i++) {
                out += `(?:${nlExpr}${lineExpr})?`;
            }
            return out;
        }
        if (lo === hi) {
            const tailCount = lo - 1;
            return tailCount === 0 ? lineExpr : `${lineExpr}(?:${nlExpr}${lineExpr}){${tailCount}}`;
        }
        return `${lineExpr}(?:${nlExpr}${lineExpr}){${lo - 1},${hi - 1}}`;
    }

    // [[name]]: matches any character name in the current chat (user, char, group members).
    // Names are collected at generation time and stored in runtimeState.knownNames.
    if (/^name\s*$/i.test(body)) {
        const names = (runtimeState.knownNames ?? []).filter(n => n.length > 0);
        if (names.length > 0) {
            return `(?:${names.map(escapeRegExp).join('|')})`;
        }
        // Fallback: capitalized word(s) like a typical name
        if (runtimeState.patternMode === 'anthropic') {
            return `[A-Z][a-z]+(?:[\\t ]+[A-Z][a-z]+)?`;
        }
        return `[A-Z][a-z]+(?:[\\t ]+[A-Z][a-z]+){0,2}`;
    }

    // [[action]]: short narration phrase, 1-6 words, no dialogue quotes.
    // Good for `*[[action]]*` style RP actions.
    if (/^action\s*$/i.test(body)) {
        const actionWord = newlineTokSingle ? `[^\\s"<>${newlineTokSingle}]+` : `[^\\s"<>]+`;
        const sep = `[\\t ]+`;
        if (runtimeState.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(1, 6, { wordToken: actionWord, wordSep: sep });
        }
        return `${actionWord}(?:${sep}${actionWord}){0,5}`;
    }

    // [[thought]]: inner monologue phrase, 1-10 words, no dialogue quotes.
    if (/^thought\s*$/i.test(body)) {
        const thoughtWord = newlineTokSingle ? `[^\\s"<>${newlineTokSingle}]+` : `[^\\s"<>]+`;
        const sep = `[\\t ]+`;
        if (runtimeState.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(1, 10, { wordToken: thoughtWord, wordSep: sep });
        }
        return `${thoughtWord}(?:${sep}${thoughtWord}){0,9}`;
    }

    // [[num]] or [[number:1-100]]: numeric value. Optionally constrained to a range.
    m = /^(num|number)\s*(?::\s*(-?\d+)\s*-\s*(-?\d+))?\s*$/i.exec(body);
    if (m) {
        if (!m[2]) {
            // [[num]]: any integer (with optional negative sign)
            return `-?[0-9]+`;
        }
        const lo = parseInt(m[2], 10);
        const hi = parseInt(m[3], 10);
        const minVal = Math.min(lo, hi);
        const maxVal = Math.max(lo, hi);
        // For small ranges (≤30 values), enumerate them for strict constraint
        if (maxVal - minVal <= 30) {
            const vals = [];
            for (let v = minVal; v <= maxVal; v++) vals.push(String(v));
            return `(?:${vals.join('|')})`;
        }
        // For larger ranges, constrain by digit count
        const minDigits = String(Math.abs(minVal)).length;
        const maxDigits = String(Math.abs(maxVal)).length;
        const prefix = minVal < 0 ? '-?' : '';
        if (runtimeState.patternMode === 'anthropic') {
            // Unroll digit counts since Anthropic doesn't support {n,m}
            const alts = [];
            for (let d = minDigits; d <= maxDigits; d++) {
                alts.push(`[0-9]${'[0-9]'.repeat(d - 1)}`);
            }
            return `${prefix}(?:${alts.join('|')})`;
        }
        return `${prefix}[0-9]{${minDigits},${maxDigits}}`;
    }

    // Unknown placeholder: default to a single non-space token.
    return wordToken;
}

function buildPrefixRegexFromWireTemplate(wireTemplate) {
    const template = String(wireTemplate ?? '');
    const slotRe = /\[\[(.+?)\]\]/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = slotRe.exec(template)) !== null) {
        out += escapePrefixLiteral(template.slice(last, m.index));
        out += buildPlaceholderRegex(m[1]);
        last = m.index + m[0].length;
    }
    out += escapePrefixLiteral(template.slice(last));
    return out;
}

function buildJsonSchemaForPrefillValuePattern(prefix, minCharsAfterPrefix, joinSuffixRegex = '') {
    const minChars = clampInt(minCharsAfterPrefix, 1, 10000, 1);
    const newlineToken = runtimeState.newlineToken || '<NL>';
    const wirePrefix = encodeNewlines(prefix, newlineToken);

    // NOTE: This is a JSON-schema regex pattern string. It must NOT contain literal newlines when using strict structured outputs.
    // We encode any prefill newlines as a token (e.g. "<NL>") and later decode for display.
    // Enforce:
    // - starts with wirePrefix
    // - continuation (after prefix) has at least `minChars` characters
    // - continuation contains at least one non-whitespace character (prevents whitespace padding)
    let prefixRegex = buildPrefixRegexFromWireTemplate(wirePrefix);

    // Robust newline handling:
    // Some models/providers will emit real newlines in the parsed JSON string instead of the chosen newline token.
    // If we require `<NL>` literally, the model can get stuck trying to satisfy the schema. Allow either.
    if (newlineToken) {
        const escapedToken = escapeRegExp(newlineToken);
        // Replace literal occurrences of the encoded token in the prefix regex with an alternation.
        // NOTE: This is a string replace on the regex *source*.
        prefixRegex = prefixRegex.split(escapedToken).join(`(?:${escapedToken}|\\n)`);
    }

    // Anthropic's structured-output regex validator only accepts ASCII patterns and rejects
    // shorthand character classes like `\s`, `\S`. Replace non-ASCII characters with `.`
    // (any-char wildcard) so the pattern is accepted.
    if (runtimeState.patternMode === 'anthropic') {
        // eslint-disable-next-line no-control-regex
        prefixRegex = prefixRegex.replace(/[^\x00-\x7F]/g, '.');
    }

    // Append raw join-suffix regex (e.g. `[^A-Z]`) for Continue flows.
    // This is injected directly (not via [[re:...]] slot syntax) to avoid slot-parser issues
    // with `]` inside character classes.
    if (joinSuffixRegex) {
        prefixRegex += joinSuffixRegex;
    }

    // Avoid lookaheads for broader provider compatibility.
    //
    // Provider differences:
    // - OpenAI-style schema regex generally supports `{n,m}` quantifiers.
    // - Anthropic (often via OpenRouter translation) rejects some patterns, including certain range quantifiers.
    //
    // So we use a conservative mode for Anthropic: require at least one character after prefix,
    // but do not enforce `min_chars_after_prefix` with a `{n,}` range.
    // Use `${anyChar}+` for simplicity; the stream guard already protects against pathological padding.
    const minMinusOne = Math.max(0, minChars - 1);
    const defaultAnyChar = anyCharIncludingNewlineExpr();
    const antiSlopExpr = buildAntiSlopContinuation(extension_settings[extensionName]?.anti_slop_ban_list);
    const anyChar = antiSlopExpr || defaultAnyChar;
    let pattern = '';
    if (runtimeState.patternMode === 'anthropic') {
        pattern = `^(?:${prefixRegex})${anyChar}+$`;
    } else {
        // Avoid `\S` / `[\s\S]` because some providers reject `\S` in schema patterns.
        //
        // IMPORTANT:
        // Do NOT force a non-whitespace character at a specific position after the prefix.
        // That can deadlock on "newline-y" continuations (e.g. the model wants to start a new paragraph
        // right after the minimum length, but the regex requires a non-whitespace there).
        // Length-only is enough; the stream guard already protects against pathological padding loops.
        pattern = `^(?:${prefixRegex})${anyChar}{${minChars},}$`;
    }

    // Best-effort local validation so a bad directive regex doesn't brick generation.
    try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
    } catch (err) {
        console.warn(`[${extensionName}] Invalid injected regex pattern; falling back to a minimal-safe pattern.`, err);
        pattern = runtimeState.patternMode === 'anthropic'
            ? `^(?:${prefixRegex})${anyChar}+$`
            : `^(?:${prefixRegex})${anyChar}{${minChars},}$`;
    }

    return {
        name: 'structured_prefill',
        description: 'Constrain output so it begins with a prefix (prefill-like) and continues with additional content.',
        strict: true,
        value: {
            type: 'object',
            properties: {
                value: {
                    type: 'string',
                    description: 'Full assistant reply text. Must start with the required prefix template (with any [[...]] slots filled) and then continue.',
                    pattern: pattern,
                },
            },
            required: ['value'],
            additionalProperties: false,
        },
    };
}

function tryExtractJsonStringField(rawText, fieldName) {
    if (typeof rawText !== 'string' || rawText.length === 0) return null;

    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeField) return null;

    // Find `"field": "`
    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(rawText);
    if (!match) return null;

    let index = match.index + match[0].length;
    let out = '';
    let isEscaped = false;
    let unicodeRemaining = 0;
    let unicodeBuffer = '';

    for (let i = index; i < rawText.length; i++) {
        const ch = rawText[i];

        if (unicodeRemaining > 0) {
            unicodeBuffer += ch;
            unicodeRemaining--;
            if (unicodeRemaining === 0) {
                if (/^[0-9a-fA-F]{4}$/.test(unicodeBuffer)) {
                    out += String.fromCharCode(parseInt(unicodeBuffer, 16));
                }
                unicodeBuffer = '';
            }
            continue;
        }

        if (isEscaped) {
            isEscaped = false;
            switch (ch) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u':
                    unicodeRemaining = 4;
                    unicodeBuffer = '';
                    break;
                default:
                    out += ch;
                    break;
            }
            continue;
        }

        if (ch === '\\') {
            isEscaped = true;
            continue;
        }

        if (ch === '"') {
            // End of JSON string
            break;
        }

        out += ch;
    }

    return out.length > 0 ? out : '';
}

// Best-effort JSON-string extractor that tolerates models/providers that emit invalid JSON
// (most commonly: forgetting to escape `"` inside the string, or prematurely closing the string
// and then continuing to emit content).
//
// Strategy:
// - Parse escape sequences like a normal JSON string (`\\n`, `\\\"`, `\\uXXXX`, etc.).
// - Treat an unescaped `"` as the *end* of the string only if the next non-whitespace
//   character is `}` or `,` (i.e., it looks like a real JSON terminator).
// - Otherwise, keep the quote as a literal character and continue scanning.
function tryExtractJsonStringFieldLoose(rawText, fieldName) {
    if (typeof rawText !== 'string' || rawText.length === 0) return null;

    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeField) return null;

    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(rawText);
    if (!match) return null;

    const findNextNonWhitespace = (from) => {
        for (let i = from; i < rawText.length; i++) {
            const ch = rawText[i];
            if (!/[\s\r\n\t]/.test(ch)) return ch;
        }
        return '';
    };

    let index = match.index + match[0].length;
    let out = '';
    let isEscaped = false;
    let unicodeRemaining = 0;
    let unicodeBuffer = '';

    for (let i = index; i < rawText.length; i++) {
        const ch = rawText[i];

        if (unicodeRemaining > 0) {
            unicodeBuffer += ch;
            unicodeRemaining--;
            if (unicodeRemaining === 0) {
                if (/^[0-9a-fA-F]{4}$/.test(unicodeBuffer)) {
                    out += String.fromCharCode(parseInt(unicodeBuffer, 16));
                }
                unicodeBuffer = '';
            }
            continue;
        }

        if (isEscaped) {
            isEscaped = false;
            switch (ch) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u':
                    unicodeRemaining = 4;
                    unicodeBuffer = '';
                    break;
                default:
                    out += ch;
                    break;
            }
            continue;
        }

        if (ch === '\\') {
            isEscaped = true;
            continue;
        }

        if (ch === '"') {
            const next = findNextNonWhitespace(i + 1);
            if (next === '}' || next === ',') {
                break;
            }
            // The quote isn't followed by '}' or ',' so it's not a real JSON terminator.
            // Include it in the output — it's almost certainly content (e.g. dialogue) that
            // the model/provider failed to escape as \".
            out += '"';
            continue;
        }

        out += ch;
    }

    return out.length > 0 ? out : '';
}

/**
 * Convert curly ("smart") quotes back to straight ASCII quotes.
 *
 * `curlyQuoteLiteralsOutsideSlots` intentionally converts straight `"` to `\u201C`/`\u201D`
 * in the prefill template so the model's JSON output doesn't break on unescaped quotes.
 * Once JSON extraction is done, we straighten them back so the chat shows normal quotes.
 */
function straightenCurlyQuotes(s) {
    return String(s ?? '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
}

function tryUnwrapStructuredOutput(text) {
    if (typeof text !== 'string' || text.length === 0) return null;

    const decode = (s) => straightenCurlyQuotes(decodeNewlines(s, runtimeState.newlineToken));
    const applyContinueJoin = (decodedValue) => {
        // Continue can carry prompt-manager prefills that should not be re-added to the message.
        // Strip those first, then perform the normal "append to base" join.
        const s = stripContinuePmPrefix(String(decodedValue ?? ''));
        if (!runtimeState.continue.active) return s;
        const base = String(runtimeState.continue.baseText ?? '');
        if (!base) return s;

        // Preferred: strip a small overlap prefix (model echoes the end of the base for a cleaner join).
        const afterOverlap = stripContinueOverlapPrefix(s);
        if (afterOverlap !== s) return base + afterOverlap;

        // Next: strip a whole-base prefix (provider echoed the entire base).
        const delta = stripContinuePrefix(s);
        if (delta !== s) return base + delta;

        // If stripping failed but the model already returned the full message (base + continuation),
        // do NOT prepend `base` again (that causes doubled output).
        const baseCanon = canonicalizeForContinueMatch(base);
        const textCanon = canonicalizeForContinueMatch(s);
        const probe = Math.min(120, baseCanon.length, textCanon.length);
        // If the extracted value is just a partial prefix of the base, keep the base unchanged for now.
        if (s.length < base.length && probe >= 20 && baseCanon.startsWith(textCanon.slice(0, probe))) {
            return base;
        }
        // IMPORTANT:
        // During streaming we may temporarily extract only a *prefix* of the base text. If we treat that as a "full"
        // return, we can wipe the already-rendered continued message and make it look like it "disappeared".
        // Only accept "already full" when the extracted text is at least as long as the base.
        if (s.length >= base.length && probe >= 40 && textCanon.startsWith(baseCanon.slice(0, probe))) {
            return s;
        }

        return base + s;
    };

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.value === 'string') {
                // Back-compat with older schema.
                const decoded = decode(parsed.value);
                return runtimeState.continue.active ? applyContinueJoin(decoded) : decoded;
            }
            if (typeof parsed.prefix === 'string' || typeof parsed.content === 'string') {
                const prefix = typeof parsed.prefix === 'string' ? decode(parsed.prefix) : '';
                const content = typeof parsed.content === 'string' ? decode(parsed.content) : '';
                const joined = prefix + content;
                if (joined.length === 0) return '';
                return runtimeState.continue.active ? applyContinueJoin(joined) : joined;
            }
            // Back-compat with the previous multi-field attempt.
            if (typeof parsed.content === 'string') return String(runtimeState.expectedPrefill ?? '') + parsed.content;
        }
    } catch {
        // JSON.parse failed. Some providers/models still *mostly* follow the schema but emit invalid JSON,
        // commonly due to unescaped quotes inside the `value` string (causing early termination).
        //
        // Use a tolerant extractor first; fall back to strict extraction only if needed.
        const looseValue = tryExtractJsonStringFieldLoose(text, 'value');
        if (typeof looseValue === 'string') {
            const decoded = decode(looseValue);
            return runtimeState.continue.active ? applyContinueJoin(decoded) : decoded;
        }
        const loosePrefix = tryExtractJsonStringFieldLoose(text, 'prefix');
        const looseContent = tryExtractJsonStringFieldLoose(text, 'content');
        if (typeof loosePrefix === 'string' || typeof looseContent === 'string') {
            const joined = decode(loosePrefix ?? '') + decode(looseContent ?? '');
            if (joined.length === 0) return '';
            return runtimeState.continue.active ? applyContinueJoin(joined) : joined;
        }

        // Fall back to partial extraction (useful during early streaming).
    }

    // Back-compat: single-field schema.
    const legacy = tryExtractJsonStringField(text, 'value');
    if (typeof legacy === 'string') {
        const decoded = decode(legacy);
        return runtimeState.continue.active ? applyContinueJoin(decoded) : decoded;
    }

    const prefix = tryExtractJsonStringField(text, 'prefix');
    const content2 = tryExtractJsonStringField(text, 'content');
    if (typeof prefix === 'string' || typeof content2 === 'string') {
        const joined = decode(prefix ?? '') + decode(content2 ?? '');
        if (joined.length === 0) return '';
        return runtimeState.continue.active ? applyContinueJoin(joined) : joined;
    }

    // Back-compat with the previous multi-field attempt.
    const content = tryExtractJsonStringField(text, 'content');
    if (typeof content === 'string') return String(runtimeState.expectedPrefill ?? '') + content;
    return null;
}

function applyTextToMessage(messageId, newText, { forceRerender = false } = {}) {
    if (typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;
    const message = chat[messageId];
    if (!message || message.is_user) return;
    if (typeof newText !== 'string') return;

    // If the user swiped/reverted during generation, do not apply decoded text to the wrong swipe.
    if (runtimeState.trackedSwipeId !== -1 && typeof message.swipe_id === 'number' && message.swipe_id !== runtimeState.trackedSwipeId) {
        console.debug(`[${extensionName}] Skipping applyTextToMessage for message ${messageId} due to swipe_id mismatch (${runtimeState.trackedSwipeId} != ${message.swipe_id})`);
        return;
    }

    // Don't replace meaningful content with empty strings (e.g., on early abort)
    if (newText.trim().length === 0 && message.mes && message.mes.trim().length > 0) {
        console.debug(`[${extensionName}] Skipping empty text application to message ${messageId} (has existing content)`);
        return;
    }
    if (!forceRerender && message.mes === newText) return;

    // Apply user regex scripts (global + preset) to the decoded AI output.
    // ST's own cleanUpMessage runs regex on the raw API response, which is JSON when structured
    // output is active. We overwrite message.mes with the decoded text, so we need to apply
    // regex ourselves. This mirrors ST's behaviour: full regex runs once at the final save,
    // while messageFormatting() handles display-only (markdownOnly) scripts during streaming.
    const regexedText = getRegexedString(newText, regex_placement.AI_OUTPUT, {
        characterOverride: message.name,
        isMarkdown: false,
        isPrompt: false,
        isEdit: false,
        depth: 0,
    });
    const textAfterRegex = typeof regexedText === 'string' && regexedText.length > 0 ? regexedText : newText;

    const displayText = computeDisplayText(messageId, textAfterRegex);

    message.extra ??= {};
    // Persist the prefix template so edits can re-apply hide-prefill consistently.
    if (!runtimeState.continue.active) {
        const expected = String(runtimeState.expectedPrefill ?? '');
        if (expected) storePrefillMetadataForMessage(messageId, expected);
    }

    // When hide-prefill is active and the display text differs from the full text,
    // store the *stripped* version in message.mes so the prefill doesn't enter the AI's
    // context on subsequent generations.  The full text is recoverable from
    // message.extra.structuredprefill.prefixTemplate if ever needed.
    const settings = extension_settings[extensionName];
    const prefillWasStripped = settings?.hide_prefill_in_display && displayText !== textAfterRegex;
    // If an early-aborted response only contains the prefix, stripping would make it look like the message vanished.
    // In that case, keep the full decoded text visible instead of replacing it with empty.
    const mesText = (prefillWasStripped && displayText.trim().length === 0) ? textAfterRegex : (prefillWasStripped ? displayText : textAfterRegex);

    message.mes = mesText;
    if (displayText !== mesText) {
        message.extra.display_text = displayText;
    } else if (Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        delete message.extra.display_text;
    }
    if (Array.isArray(message.swipes)) {
        message.swipes[message.swipe_id] = mesText;
    }

    updateMessageBlock(messageId, message, { rerenderMessage: true });
}

function hasUnclosedCodeFence(text) {
    const s = String(text ?? '');
    const backtick = (s.match(/```/g) || []).length;
    const tilde = (s.match(/~~~/g) || []).length;
    return (backtick % 2 === 1) || (tilde % 2 === 1);
}

function sanitizeUnclosedCodeFencesForPreview(text) {
    // Some models emit an opening fence like ```json{ mid-stream and never close it until later.
    // While the fence is unclosed, ST's markdown pipeline can become very expensive and/or error-prone.
    //
    // We do NOT want to append visible junk like "~~~" at the end.
    // Instead, for *preview rendering only*, break the last unmatched fence marker with a zero-width char
    // so it won't be treated as an active fence by downstream markdown logic.
    const s = String(text ?? '');

    const breakLast = (input, marker, brokenMarker) => {
        const idx = input.lastIndexOf(marker);
        if (idx === -1) return input;
        return input.slice(0, idx) + brokenMarker + input.slice(idx + marker.length);
    };

    const backtick = (s.match(/```/g) || []).length;
    const tilde = (s.match(/~~~/g) || []).length;

    let out = s;
    if (backtick % 2 === 1) out = breakLast(out, '```', '`\u200B``');
    if (tilde % 2 === 1) out = breakLast(out, '~~~', '~\u200B~~');
    return out;
}

function applyTextToMessageStreaming(messageId, newText) {
    if (typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return;
    const message = chat[messageId];
    if (!message || message.is_user) return;
    if (typeof newText !== 'string') return;

    // Lock onto the swipe we're generating into as soon as we can.
    if (runtimeState.trackedSwipeId === -1 && typeof message.swipe_id === 'number') {
        runtimeState.trackedSwipeId = message.swipe_id;
    }
    // If the swipe changed (user swipe/revert), do not overwrite a different swipe's content.
    if (runtimeState.trackedSwipeId !== -1 && typeof message.swipe_id === 'number' && message.swipe_id !== runtimeState.trackedSwipeId) {
        return;
    }

    // Don't replace meaningful content with empty strings (e.g., on very early abort)
    if (newText.trim().length === 0 && typeof message.mes === 'string' && message.mes.trim().length > 0) {
        return;
    }

    ensureScrollIntentListeners();

    const displayText = computeDisplayText(messageId, newText);

    // Keep the backing data decoded even during streaming so edit/cancel doesn't resurrect raw JSON.
    message.mes = newText;
    message.extra ??= {};
    if (!runtimeState.continue.active) {
        const expected = String(runtimeState.expectedPrefill ?? '');
        if (expected) storePrefillMetadataForMessage(messageId, expected);
    }
    if (displayText !== newText) {
        message.extra.display_text = displayText;
    } else if (Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        delete message.extra.display_text;
    }
    if (Array.isArray(message.swipes) && typeof message.swipe_id === 'number') {
        message.swipes[message.swipe_id] = newText;
    }

    // Replace whatever ST just rendered (raw JSON) before the next paint, but keep markdown formatting.
    const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    if (textEl instanceof HTMLElement) {
        runtimeState.applyingDom++;
        try {
            // SAFEGUARD:
            // Rendering markdown on every token can be expensive. This was especially crashy when the model emitted
            // an *unclosed* code fence like ```json{ mid-stream.
            //
            // Instead of falling back to plain text (which breaks quote-highlighting + regex formatting), we keep
            // `messageFormatting()` during streaming but "break" the last unmatched fence marker for preview only.
            // This avoids visible junk being appended to the message (no trailing ~~~), and keeps visuals consistent.
            const isHuge = displayText.length > 80000;
            const previewText = hasUnclosedCodeFence(displayText) ? sanitizeUnclosedCodeFencesForPreview(displayText) : displayText;

            if (isHuge) {
                // Preserve newlines even when we temporarily bypass the markdown pipeline.
                textEl.style.whiteSpace = 'pre-wrap';
                textEl.textContent = displayText;
            } else {
                textEl.style.whiteSpace = '';
                const formatted = messageFormatting(
                    previewText,
                    message?.name ?? '',
                    !!message?.is_system,
                    !!message?.is_user,
                    messageId,
                    {},
                    false,
                );
                textEl.innerHTML = formatted;
            }
        } catch (err) {
            console.warn(`[${extensionName}] Streaming render failed; falling back to plain text.`, err);
            textEl.style.whiteSpace = 'pre-wrap';
            textEl.textContent = displayText;
        } finally {
            runtimeState.applyingDom = Math.max(0, runtimeState.applyingDom - 1);
        }
        schedulePostFrameGuard(messageId);

        // Keep autoscroll working during our custom streaming renderer.
        // ST can sometimes lock autoscroll due to incidental scroll shifts when the DOM height changes.
        // We only force-scroll if the user hasn’t intentionally scrolled up.
        if (!runtimeState.userScrollLocked) {
            scrollChatToBottom({ waitForFrame: true });
        }
    }
}

function disconnectStreamObserver() {
    try {
        runtimeState.streamObserver?.disconnect?.();
    } catch {
        // ignore
    }
    runtimeState.streamObserver = null;
    runtimeState.observedMessageId = -1;
    runtimeState.renderQueued = false;
}

function clearStopCleanupTimer() {
    if (runtimeState.stopCleanupTimer) {
        clearTimeout(runtimeState.stopCleanupTimer);
        runtimeState.stopCleanupTimer = null;
    }
}

function getRawCandidateForMessage(messageId) {
    const mes = chat?.[messageId]?.mes;
    if (typeof mes === 'string' && mes.includes('"value"')) return mes;
    const latest = String(runtimeState.latestStreamText ?? '');
    if (latest.trimStart().startsWith('{')) return latest;
    return mes || latest || '';
}

function forceUnwrapMessage(messageId) {
    if (typeof messageId !== 'number' || messageId < 0 || messageId >= chat.length) return false;

    const raw = getRawCandidateForMessage(messageId);
    const unwrapped = tryUnwrapStructuredOutput(String(raw));
    if (typeof unwrapped !== 'string') return false;
    if (unwrapped === runtimeState.lastAppliedText) return true;

    runtimeState.lastAppliedText = unwrapped;
    applyTextToMessage(messageId, unwrapped, { forceRerender: true });
    return true;
}

function scheduleDecodedRender(messageId) {
    if (!runtimeState.active) return;
    if (runtimeState.renderQueued) return;
    runtimeState.renderQueued = true;

    queueMicrotask(() => {
        runtimeState.renderQueued = false;
        // Ensure we're still looking at the same message.
        if (!runtimeState.active) return;
        if (messageId !== runtimeState.observedMessageId) return;

        const raw = getRawCandidateForMessage(messageId);
        const rawStr = String(raw ?? '');
        let unwrapped = tryUnwrapStructuredOutput(rawStr);
        if (typeof unwrapped !== 'string') {
            // If we can’t extract yet (very early tokens), never show raw JSON.
            const trimmed = rawStr.trimStart();
            if (trimmed.startsWith('{')) {
                unwrapped = typeof runtimeState.lastAppliedText === 'string' ? runtimeState.lastAppliedText : '';
            } else {
                return;
            }
        }
        // Loop/guard detection uses the full decoded value (before display-only hide-prefill).
        const guardDecoded = getDecodedValueForGuard(rawStr);
        if (typeof guardDecoded === 'string') {
            maybeAbortOnStreamLoop(rawStr, guardDecoded);
        }
        const textEl = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        const domText = textEl instanceof HTMLElement ? String(textEl.textContent ?? '') : '';
        const domContainsStructuredJson = looksLikeStructuredJsonBlob(domText);
        // If ST just overwrote the DOM with raw JSON, we need to re-apply even if the decoded text didn’t change.
        if (unwrapped === runtimeState.lastAppliedText && !domContainsStructuredJson) return;
        runtimeState.lastAppliedText = unwrapped;
        applyTextToMessageStreaming(messageId, unwrapped);
    });
}

function ensureStreamObserver(messageId) {
    if (!runtimeState.active) return false;
    if (runtimeState.streamObserver && runtimeState.observedMessageId === messageId) return true;

    disconnectStreamObserver();

    const mesEl = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mesEl) return false;

    runtimeState.observedMessageId = messageId;
    runtimeState.streamObserver = new MutationObserver(() => {
        // Ignore only the mutations we cause ourselves, but still catch any late ST overwrites.
        if (runtimeState.applyingDom > 0) return;
        scheduleDecodedRender(messageId);
        // If the user hit Stop, keep decoding until the DOM goes quiet (prevents “JSON popping back”).
        if (runtimeState.stopping) touchStopCleanup(messageId, runtimeState.stopSessionAt);
    });
    // Observe the whole message node so we survive `.mes_text` being replaced.
    runtimeState.streamObserver.observe(mesEl, { childList: true, subtree: true, characterData: true });
    return true;
}

function touchStopCleanup(messageId, sessionAtStop) {
    if (!runtimeState.stopping) return;
    if (runtimeState.stopSessionAt !== sessionAtStop) return;

    clearStopCleanupTimer();
    runtimeState.stopCleanupTimer = setTimeout(() => {
        // If a new generation started, don't interfere.
        if (!runtimeState.active) return;
        if (runtimeState.stopSessionAt !== sessionAtStop) return;

        // Validate message still exists and hasn't been deleted/reverted
        const message = chat?.[messageId];
        if (!message || message.is_user) {
            console.debug(`[${extensionName}] Stop cleanup: message ${messageId} no longer valid, skipping`);
            runtimeState.active = false;
            runtimeState.stopping = false;
            runtimeState.trackedSwipeId = -1;
            disconnectStreamObserver();
            clearStopCleanupTimer();
            clearHidePrefillState();
            clearContinueState();
            resetStreamGuard();
            return;
        }

        // If swipe_id has changed (user swiped or ST reverted), don't apply to wrong swipe
        if (runtimeState.trackedSwipeId !== -1 && message.swipe_id !== runtimeState.trackedSwipeId) {
            console.debug(`[${extensionName}] Stop cleanup: swipe_id changed (${runtimeState.trackedSwipeId} → ${message.swipe_id}), skipping`);
            runtimeState.active = false;
            runtimeState.stopping = false;
            runtimeState.trackedSwipeId = -1;
            disconnectStreamObserver();
            clearStopCleanupTimer();
            clearHidePrefillState();
            clearContinueState();
            resetStreamGuard();
            return;
        }

        // Final best-effort render so markdown etc. is correct in the saved message.
        const raw = getRawCandidateForMessage(messageId);
        const unwrapped = tryUnwrapStructuredOutput(String(raw));

        // Only apply if we have meaningful content (prevent applying empty strings on early abort)
        const textToApply = typeof unwrapped === 'string' ? unwrapped : runtimeState.lastAppliedText;
        if (typeof textToApply === 'string' && textToApply.trim().length > 0) {
            runtimeState.lastAppliedText = textToApply;
            applyTextToMessage(messageId, textToApply, { forceRerender: true });
        } else {
            console.debug(`[${extensionName}] Stop cleanup: no valid text to apply, skipping render`);
        }

        runtimeState.active = false;
        runtimeState.stopping = false;
        runtimeState.trackedSwipeId = -1;
        disconnectStreamObserver();
        clearStopCleanupTimer();
        clearHidePrefillState();
        clearContinueState();
        resetStreamGuard();
    }, 250);
}

async function onChatCompletionSettingsReady(generateData) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;
    if (!generateData || typeof generateData !== 'object') return;

    if (!supportsStructuredPrefillForSource(generateData.chat_completion_source)) return;
    if (generateData.json_schema) return;
    // Avoid conflicts with tool-calling in early testing; can be revisited later.
    if (Array.isArray(generateData.tools) && generateData.tools.length > 0) return;

    const requestType = String(generateData.type ?? '').toLowerCase();

    // Impersonate and quiet (e.g. summarization) don't produce chat messages — they write to
    // the input textarea or return text silently. Injecting structured output would break them:
    // the model returns `{"value":"..."}` JSON that ST can't use, and the stream observer would
    // incorrectly overwrite the last assistant message.
    if (requestType === 'impersonate' || requestType === 'quiet') return;

    const isContinue = requestType === 'continue';

    const messages = generateData.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const src = String(generateData.chat_completion_source ?? '').toLowerCase();
    const modelId = String(generateData.model ?? '');
    runtimeState.patternMode = getPatternModeForRequest(src, modelId);

    // Collect known character names for the [[name]] placeholder.
    {
        const names = new Set();
        const userName = String(generateData.user_name ?? '').trim();
        const charName = String(generateData.char_name ?? '').trim();
        if (userName) names.add(userName);
        if (charName) names.add(charName);
        const groupNames = generateData.group_names;
        if (Array.isArray(groupNames)) {
            for (const gn of groupNames) {
                const n = String(gn ?? '').trim();
                if (n) names.add(n);
            }
        }
        runtimeState.knownNames = [...names];
    }

    // OpenRouter is OpenAI-compatible. Some routed providers/models may ignore or partially enforce `json_schema`.
    // We still attempt injection for any OpenRouter model and let it be a no-op if the backend doesn't enforce it.

    // We only activate when the chat "tail" is an assistant message (prefill-like).
    // For Continue, ST commonly appends a trailing system instruction, so we look at the last *non-system* message.
    let tailIndex = messages.length - 1;
    while (tailIndex >= 0 && messages[tailIndex]?.role === 'system') tailIndex--;
    const tail = tailIndex >= 0 ? messages[tailIndex] : null;

    if (!tail || tail.role !== 'assistant' || typeof tail.content !== 'string') return;
    let tailContent = tail.content;
    if (!tailContent) return;

    // When ST's "Character Names Behavior" is set to "Message Content", all message contents
    // in the messages array get "CharName: " prepended (openai.js setOpenAIMessages).
    // Strip it: baseText (from chat[].mes) never has the prefix, so leaving it causes mismatches
    // in Continue logic and leaks the name into the schema pattern.
    {
        const names = (runtimeState.knownNames ?? []).slice().sort((a, b) => b.length - a.length);
        for (const name of names) {
            if (name && tailContent.startsWith(name + ': ')) {
                tailContent = tailContent.slice(name.length + 2);
                tail.content = tailContent;
                break;
            }
        }
    }

    resetStreamGuard();
    clearHidePrefillState();
    clearContinueState();

    // Reset per-generation targeting so we don't apply to an unrelated swipe.
    runtimeState.trackedSwipeId = -1;

    // Build schema + state differently for Continue vs normal generations.
    // - Normal: remove assistant prefill and enforce it via schema.
    // - Continue: keep (or replace) the tail assistant message so the model can see the message to continue,
    //            and only constrain the *output wrapper* (we append to the existing message locally).
    let schemaPrefix = '';
    let joinSuffixRegex = '';
    let prefillTemplate = String(tailContent ?? '');

    if (isContinue) {
        runtimeState.continue.active = true;
        runtimeState.continue.messageId = getLastAssistantMessageId();
        runtimeState.continue.baseText = (runtimeState.continue.messageId >= 0 && typeof chat?.[runtimeState.continue.messageId]?.mes === 'string')
            ? chat[runtimeState.continue.messageId].mes
            : '';
        runtimeState.continue.displayBase = '';
        if (runtimeState.continue.messageId >= 0) {
            const m = chat?.[runtimeState.continue.messageId];
            if (m?.extra && typeof m.extra.display_text === 'string') {
                runtimeState.continue.displayBase = m.extra.display_text;
            }
        }
        runtimeState.lastAppliedText = String(runtimeState.continue.baseText ?? '');

        runtimeState.continue.pmStripLiteral = '';
        runtimeState.continue.pmStripRegex = null;

        // Ensure the request includes the message we're actually continuing (not prompt-manager assistant prefill),
        // while optionally moving any prompt-manager assistant prefill into structured output constraints.
        const baseText = String(runtimeState.continue.baseText ?? '');
        const baseCanon = canonicalizeForContinueMatch(baseText);
        const tailCanon = canonicalizeForContinueMatch(prefillTemplate);
        const probe = 60;
        const baseProbe = baseCanon.slice(0, Math.min(probe, baseCanon.length));
        const tailProbe = tailCanon.slice(0, Math.min(probe, tailCanon.length));
        const looksLikeBase = !!(baseText && ((baseProbe && tailCanon.startsWith(baseProbe)) || (tailProbe && baseCanon.startsWith(tailProbe))));

        // If the assistant "tail" in the request doesn't resemble the message we plan to Continue in the UI,
        // bail out entirely (this can happen on welcome-page assistant flows or other non-chat contexts).
        if (baseText && prefillTemplate) {
            const { baseFound } = splitContinuePmPrefixFromTail(prefillTemplate, baseText);
            if (!looksLikeBase && !baseFound) {
                clearContinueState();
                return;
            }
        }

        let pmPrefix = '';
        if (baseText) {
            const { pmPrefix: fromSplit, baseFound } = splitContinuePmPrefixFromTail(prefillTemplate, baseText);
            if (baseFound) {
                // Tail contains the base message (possibly with a PM prefix).
                pmPrefix = fromSplit || '';
            } else if (!looksLikeBase && prefillTemplate) {
                // Tail doesn't look like the base message; treat the whole tail as a PM prefill template.
                pmPrefix = prefillTemplate;
            }
        }

        if (baseText) {
            if (!looksLikeBase) {
                tail.content = baseText;
                try {
                    console.debug(`[${extensionName}] Continue: replaced tail assistant content with base message (${baseText.length} chars).`);
                } catch {
                    // ignore
                }
            } else if (pmPrefix) {
                // Tail contains base message but also a PM prefill prefix: keep only the base in messages.
                tail.content = baseText;
            }
        }

        buildContinueStripper(baseText);

        const overlapChars = clampInt(settings.continue_overlap_chars, 0, 120, 14);
        const overlap = computeContinueOverlapBase(baseText, overlapChars);
        runtimeState.continue.overlapText = overlap;
        buildContinueOverlapStripper(overlap);
        joinSuffixRegex = buildContinueJoinPlaceholder(baseText);

        if (pmPrefix) {
            buildContinuePmStripper(pmPrefix);
        }

        // Continue schema prefix:
        // - Optional PM prefill (will be stripped back out locally)
        // - Short overlap of the existing message tail (also stripped back out)
        // joinPlaceholder is raw regex appended directly to the prefix pattern (not a [[...]] slot)
        // to avoid slot-parser issues with `]` inside character classes.
        schemaPrefix = `${pmPrefix || ''}${overlap}`;
        runtimeState.newlineToken = chooseNewlineToken(schemaPrefix || baseText, settings.newline_token);
    } else {
        // Prefill generator: replace any `[[pg]]` placeholders by calling a separate model/profile.
        // If disabled (or if generation fails), replace `[[pg]]` with an empty string and proceed normally.
        if (templateHasPrefillGenSlot(prefillTemplate)) {
            const profileId = String(settings.prefill_gen_profile_id ?? '');
            const maxTokens = clampInt(settings.prefill_gen_max_tokens, 1, 2048, 15);
            const timeoutMs = clampInt(settings.prefill_gen_timeout_ms, 500, 120000, 12000);
            const stopStrings = parseStopStrings(settings.prefill_gen_stop);

            let generated = '';
            if (settings.prefill_gen_enabled) {
                try {
                    generated = await runPrefillGeneratorOrEmpty({
                        generateData,
                        tailIndex,
                        timeoutMs,
                        maxTokens,
                        stopStrings,
                        profileId,
                    });
                } catch (err) {
                    try {
                        console.warn(`[${extensionName}] Prefill generator failed:`, err);
                    } catch {
                        // ignore
                    }
                    if (window?.toastr?.error) {
                        window.toastr.error(String(err?.message ?? err ?? 'Prefill generator failed'), extensionName, { timeOut: 9000, closeButton: true });
                    }
                    generated = '';
                }
            }

            prefillTemplate = String(prefillTemplate ?? '').replace(/\[\[\s*pg\s*\]\]/gi, String(generated ?? ''));
        }

        // Remove the assistant prefill message and replace it with a structured output constraint.
        messages.splice(tailIndex, 1);

        // Legacy cleanup: if the user has old `[[SP: ...]]` blocks in their prefill, strip them.
        // StructuredPrefill now uses `[[...]]` as *slots* inside the prefix template.
        prefillTemplate = String(prefillTemplate ?? '').replace(/\[\[\s*sp\s*:[^\]]*\]\]/gi, '');
        // SAFEGUARD:
        // Literal `"` characters inside the prefix are very common in templates (e.g. quoting example thoughts),
        // but in "best-effort JSON" implementations they can cause repeated premature JSON-string termination
        // (model emits an unescaped `"` and the reply gets truncated at the same spot every time).
        // Converting literal quotes to curly quotes avoids needing escapes and dramatically improves robustness.
        prefillTemplate = curlyQuoteLiteralsOutsideSlots(prefillTemplate);

        schemaPrefix = prefillTemplate;
        runtimeState.newlineToken = chooseNewlineToken(schemaPrefix, settings.newline_token);
        if (settings.hide_prefill_in_display) {
            // Build the stripper from the *straight-quoted* version of the template.
            // `curlyQuoteLiteralsOutsideSlots` converts `"` to curly `""` for JSON robustness in the schema pattern,
            // but the decoded output is straightened back by `straightenCurlyQuotes` in the decode pipeline.
            // The stripper must match straight quotes in the decoded text.
            buildPrefillStripper(straightenCurlyQuotes(schemaPrefix));
        }
    }

    // User constraint (repo-local): do not insert any new "nudge" message content.
    // However, some routed providers reject requests that *end* with an assistant-role message (assistant-prefill).
    // For Opus 4.6 via OpenRouter/Anthropic, this can fail even without structured outputs:
    // "This model does not support assistant message prefill. The conversation must end with a user message."
    //
    // For Continue, we can satisfy this without adding new instructions by re-labeling the final message role.
    if (messages.length) {
        if (isContinue && runtimeState.patternMode === 'anthropic') {
            // When "continue prefill" is disabled in ST, the request may have a trailing system message
            // (e.g. "[Continue your last message...]") after the assistant tail.  We need the last message
            // to be user-role for Anthropic. Strip trailing system messages and convert the tail to user.
            while (messages.length > 1 && messages[messages.length - 1]?.role === 'system') {
                messages.pop();
            }
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === 'assistant') {
                lastMsg.role = 'user';
            }
        }

        const lastMsg = messages[messages.length - 1];

        // Non-Continue: if we end on assistant, this is assistant-prefill and many providers reject it with output formats.
        if (!isContinue && lastMsg?.role === 'assistant') return;

        // Anthropic/OpenRouter strictness: if the request still doesn't end on user, do not inject structured outputs.
        // (We intentionally avoid mutating system messages.)
        if (runtimeState.patternMode === 'anthropic' && lastMsg?.role !== 'user') return;
    }

    const minCharsSetting = clampInt(settings.min_chars_after_prefix, 1, 10000, 80);
    const minCharsAfterPrefix = isContinue ? 1 : minCharsSetting;
    generateData.json_schema = buildJsonSchemaForPrefillValuePattern(schemaPrefix, minCharsAfterPrefix, joinSuffixRegex);

    // Debug: log the structured output regex pattern that we inject.
    try {
        console.debug(`[${extensionName}] Injecting structured prefill: source=${src} model=${modelId} schema=value.pattern mode=${runtimeState.patternMode}`);
        const injectedPattern = generateData?.json_schema?.value?.properties?.value?.pattern;
        if (typeof injectedPattern === 'string' && injectedPattern.length > 0) {
            console.debug(`[${extensionName}] Injected json_schema pattern (${injectedPattern.length} chars):`, injectedPattern);
            const continueBaseLen = runtimeState.continue.active ? String(runtimeState.continue.baseText ?? '').length : 0;
            console.debug(
                `[${extensionName}] Prefix/newline info: schema_prefix_len=${String(schemaPrefix ?? '').length}, continue_base_len=${continueBaseLen}, newline_token=${runtimeState.newlineToken}, min_chars_after_prefix=${minCharsAfterPrefix}`,
            );
        }
    } catch {
        // ignore
    }

    runtimeState.active = true;
    runtimeState.stopping = false;
    runtimeState.stopSessionAt = 0;
    clearStopCleanupTimer();
    runtimeState.lastInjectedAt = Date.now();
    // Store the straight-quoted version: curly quotes only exist for JSON wire robustness,
    // but the decoded output is always straightened, so metadata/stripping must match straight quotes.
    runtimeState.expectedPrefill = straightenCurlyQuotes(String(schemaPrefix ?? ''));

    // If this generation updates an existing assistant message (e.g., swipes), seed the fallback with the
    // currently displayed content so early-abort / early-token cases don't blank the message.
    try {
        const tailChatMessage = chat?.[chat.length - 1];
        if (tailChatMessage && !tailChatMessage.is_user && !tailChatMessage.is_system) {
            if (typeof tailChatMessage.swipe_id === 'number') {
                runtimeState.trackedSwipeId = tailChatMessage.swipe_id;
            }
            if (typeof tailChatMessage.mes === 'string' && tailChatMessage.mes.trim().length > 0) {
                runtimeState.lastAppliedText = tailChatMessage.mes;
            }
        }
    } catch {
        // ignore
    }
}

function scheduleStreamUnwrap(rawText) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;
    if (!runtimeState.active) return;

    runtimeState.latestStreamText = String(rawText ?? '');
    const messageId = getActiveAssistantMessageIdForStreaming();
    // Reduce flicker: decode immediately and replace raw JSON before ST paints it for long.
    try {
        const rawStr = String(rawText ?? '');
        const unwrapped = tryUnwrapStructuredOutput(rawStr);
        if (typeof unwrapped === 'string') {
            runtimeState.lastAppliedText = unwrapped;
            applyTextToMessageStreaming(messageId, unwrapped);
        } else if (rawStr.trimStart().startsWith('{')) {
            // If we can't extract yet (very early tokens), never show raw JSON.
            const fallback = typeof runtimeState.lastAppliedText === 'string' ? runtimeState.lastAppliedText : '';
            applyTextToMessageStreaming(messageId, fallback);
        }
    } catch {
        // ignore
    }
    ensureStreamObserver(messageId);
    scheduleDecodedRender(messageId);
}

function onMessageReceived(messageId) {
    if (!runtimeState.active) return;

    const raw = getRawCandidateForMessage(messageId);
    const unwrapped = tryUnwrapStructuredOutput(String(raw));
    if (typeof unwrapped === 'string') runtimeState.lastAppliedText = unwrapped;
    applyTextToMessage(messageId, (typeof unwrapped === 'string' ? unwrapped : chat?.[messageId]?.mes ?? ''), { forceRerender: true });

    runtimeState.active = false;
    runtimeState.stopping = false;
    runtimeState.trackedSwipeId = -1;
    clearStopCleanupTimer();
    disconnectStreamObserver();
    clearHidePrefillState();
    clearContinueState();
    resetStreamGuard();
}

function onGenerationStopped() {
    if (!runtimeState.active) return;

    const messageId = getActiveAssistantMessageIdForStreaming();
    runtimeState.stopping = true;
    runtimeState.stopSessionAt = runtimeState.lastInjectedAt;

    // Track the current swipe_id to validate it hasn't changed when cleanup fires.
    // If it was already captured at injection time (e.g., swipe generation), don't overwrite it.
    if (runtimeState.trackedSwipeId === -1) {
        const message = chat?.[messageId];
        runtimeState.trackedSwipeId = message?.swipe_id ?? -1;
    }

    ensureStreamObserver(messageId);
    // Decode immediately and then keep decoding until the DOM goes quiet.
    scheduleDecodedRender(messageId);
    touchStopCleanup(messageId, runtimeState.stopSessionAt);
}

function renderSettingsToUi() {
    const settings = extension_settings[extensionName];
    $('#structuredprefill_enabled').prop('checked', !!settings.enabled);
    $('#structuredprefill_hide_prefill_in_display').prop('checked', !!settings.hide_prefill_in_display);
    $('#structuredprefill_min_chars_after_prefix').val(String(settings.min_chars_after_prefix ?? 80));
    $('#structuredprefill_prefill_gen_enabled').prop('checked', !!settings.prefill_gen_enabled);
    $('#structuredprefill_prefill_gen_max_tokens').val(String(settings.prefill_gen_max_tokens ?? 15));
    $('#structuredprefill_prefill_gen_stop').val(String(settings.prefill_gen_stop ?? ''));
    $('#structuredprefill_prefill_gen_timeout_ms').val(String(settings.prefill_gen_timeout_ms ?? 12000));
    renderPrefillGenProfileSelect();
    $('#structuredprefill_newline_token').val(String(settings.newline_token ?? '<NL>'));
    $('#structuredprefill_continue_overlap_chars').val(String(settings.continue_overlap_chars ?? 14));
    $('#structuredprefill_anti_slop_ban_list').val(String(settings.anti_slop_ban_list ?? ''));
}

function setupUiListeners() {
    $('#structuredprefill_enabled')
        .off('click')
        .on('click', () => {
            extension_settings[extensionName].enabled = !!$('#structuredprefill_enabled').prop('checked');
            saveSettingsDebounced();
        });

    $('#structuredprefill_hide_prefill_in_display')
        .off('click')
        .on('click', () => {
            extension_settings[extensionName].hide_prefill_in_display = !!$('#structuredprefill_hide_prefill_in_display').prop('checked');
            saveSettingsDebounced();
        });

    $('#structuredprefill_min_chars_after_prefix')
        .off('change')
        .on('change', () => {
            extension_settings[extensionName].min_chars_after_prefix = clampInt($('#structuredprefill_min_chars_after_prefix').val(), 1, 10000, 80);
            $('#structuredprefill_min_chars_after_prefix').val(String(extension_settings[extensionName].min_chars_after_prefix));
            saveSettingsDebounced();
        });

    $('#structuredprefill_prefill_gen_enabled')
        .off('click')
        .on('click', () => {
            extension_settings[extensionName].prefill_gen_enabled = !!$('#structuredprefill_prefill_gen_enabled').prop('checked');
            saveSettingsDebounced();
        });

    $('#structuredprefill_prefill_gen_profile')
        .off('change')
        .on('change', () => {
            extension_settings[extensionName].prefill_gen_profile_id = String($('#structuredprefill_prefill_gen_profile').val() ?? '');
            saveSettingsDebounced();
        });

    $('#structuredprefill_prefill_gen_max_tokens')
        .off('change')
        .on('change', () => {
            extension_settings[extensionName].prefill_gen_max_tokens = clampInt($('#structuredprefill_prefill_gen_max_tokens').val(), 1, 2048, 15);
            $('#structuredprefill_prefill_gen_max_tokens').val(String(extension_settings[extensionName].prefill_gen_max_tokens));
            saveSettingsDebounced();
        });

    $('#structuredprefill_prefill_gen_stop')
        .off('input')
        .on('input', () => {
            extension_settings[extensionName].prefill_gen_stop = String($('#structuredprefill_prefill_gen_stop').val() ?? '');
            saveSettingsDebounced();
        });

    $('#structuredprefill_prefill_gen_timeout_ms')
        .off('change')
        .on('change', () => {
            extension_settings[extensionName].prefill_gen_timeout_ms = clampInt($('#structuredprefill_prefill_gen_timeout_ms').val(), 500, 120000, 12000);
            $('#structuredprefill_prefill_gen_timeout_ms').val(String(extension_settings[extensionName].prefill_gen_timeout_ms));
            saveSettingsDebounced();
        });

    $('#structuredprefill_newline_token')
        .off('input')
        .on('input', () => {
            extension_settings[extensionName].newline_token = String($('#structuredprefill_newline_token').val() ?? '<NL>');
            saveSettingsDebounced();
        });

    $('#structuredprefill_continue_overlap_chars')
        .off('change')
        .on('change', () => {
            extension_settings[extensionName].continue_overlap_chars = clampInt($('#structuredprefill_continue_overlap_chars').val(), 0, 120, 14);
            $('#structuredprefill_continue_overlap_chars').val(String(extension_settings[extensionName].continue_overlap_chars));
            saveSettingsDebounced();
        });

    $('#structuredprefill_anti_slop_ban_list')
        .off('input')
        .on('input', () => {
            extension_settings[extensionName].anti_slop_ban_list = String($('#structuredprefill_anti_slop_ban_list').val() ?? '');
            saveSettingsDebounced();
        });
}

jQuery(async () => {
    if ($('.structuredprefill_settings').length === 0) {
        $('#extensions_settings').append(await renderExtensionTemplateAsync(extensionPath, 'settings'));
    }

    loadSettings();
    renderSettingsToUi();
    setupUiListeners();
    ensureScrollIntentListeners();

    eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, onChatCompletionSettingsReady);
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, renderPrefillGenProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_CREATED, renderPrefillGenProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_UPDATED, renderPrefillGenProfileSelect);
    eventSource.on(event_types.CONNECTION_PROFILE_DELETED, renderPrefillGenProfileSelect);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, scheduleStreamUnwrap);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageUpdated);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    console.log(`[${extensionName}] extension loaded`);
});
