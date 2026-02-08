import { chat, messageFormatting, saveSettingsDebounced, scrollChatToBottom, updateMessageBlock } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const { eventSource, event_types, renderExtensionTemplateAsync } = SillyTavern.getContext();

const extensionName = 'StructuredPrefill';
const extensionPath = 'third-party/StructuredPrefill';

const defaultSettings = {
    enabled: true,
    hide_prefill_in_display: false,
    newline_token: '<NL>',
    // Require some actual continuation beyond the prefix (in chars).
    min_chars_after_prefix: 80,
};

const runtimeState = {
    active: false,
    lastInjectedAt: 0,
    latestStreamText: '',
    lastAppliedText: '',
    expectedPrefill: '',
    newlineToken: '',
    patternMode: 'default',
    hidePrefillLiteral: '',
    hidePrefillRegex: null,
    streamObserver: null,
    observedMessageId: -1,
    renderQueued: false,
    stopCleanupTimer: null,
    stopping: false,
    stopSessionAt: 0,
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
        const domLooksLikeStructuredJson = domText.trimStart().startsWith('{') && domText.includes('"value"');
        if (domLooksLikeStructuredJson && typeof runtimeState.lastAppliedText === 'string') {
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
        'pollinations',
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

function clearHidePrefillState() {
    runtimeState.hidePrefillLiteral = '';
    runtimeState.hidePrefillRegex = null;
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
    // Be conservative to avoid false positives in the first couple seconds.
    if (sinceStart > 3500 && sinceProgress > 8000 && rawLen > 5000) {
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

    return 'default';
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

    // Unknown placeholder: default to a single non-space token.
    return wordToken;
}

function buildPrefixRegexFromWireTemplate(wireTemplate) {
    const template = String(wireTemplate ?? '');
    const slotRe = /\[\[([^\]]+?)\]\]/g;
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

function buildJsonSchemaForPrefillValuePattern(prefix, minCharsAfterPrefix) {
    const minChars = clampInt(minCharsAfterPrefix, 1, 10000, 1);
    const newlineToken = runtimeState.newlineToken || '<NL>';
    const wirePrefix = encodeNewlines(prefix, newlineToken);

    // NOTE: This is a JSON-schema regex pattern string. It must NOT contain literal newlines when using strict structured outputs.
    // We encode any prefill newlines as a token (e.g. "<NL>") and later decode for display.
    // Enforce:
    // - starts with wirePrefix
    // - continuation (after prefix) has at least `minChars` characters
    // - continuation contains at least one non-whitespace character (prevents whitespace padding)
    const prefixRegex = buildPrefixRegexFromWireTemplate(wirePrefix);
    // Avoid lookaheads for broader provider compatibility.
    //
    // Provider differences:
    // - OpenAI-style schema regex generally supports `{n,m}` quantifiers.
    // - Anthropic (often via OpenRouter translation) rejects some patterns, including certain range quantifiers.
    //
    // So we use a conservative mode for Anthropic: require at least one non-whitespace after prefix,
    // but do not enforce `min_chars_after_prefix` with a `{n,}` range.
    const minMinusOne = Math.max(0, minChars - 1);
    const anyChar = anyCharIncludingNewlineExpr();
    let pattern = '';
    if (runtimeState.patternMode === 'anthropic') {
        pattern = `^(?:${prefixRegex})${anyChar}*[^\\s]${anyChar}*$`;
    } else {
        // Avoid `\S` / `[\s\S]` because some providers reject `\S` in schema patterns.
        pattern = `^(?:${prefixRegex})${anyChar}{${minMinusOne},}[^\\s]${anyChar}*$`;
    }

    // Best-effort local validation so a bad directive regex doesn't brick generation.
    try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
    } catch (err) {
        console.warn(`[${extensionName}] Invalid injected regex pattern; falling back to a minimal-safe pattern.`, err);
        pattern = runtimeState.patternMode === 'anthropic'
            ? `^(?:${prefixRegex})${anyChar}*[^\\s]${anyChar}*$`
            : `^(?:${prefixRegex})${anyChar}{${minMinusOne},}[^\\s]${anyChar}*$`;
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

function tryUnwrapStructuredOutput(text) {
    if (typeof text !== 'string' || text.length === 0) return null;

    const decode = (s) => decodeNewlines(s, runtimeState.newlineToken);

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.value === 'string') {
                // Back-compat with older schema.
                return maybeHidePrefillForDisplay(decode(parsed.value));
            }
            if (typeof parsed.prefix === 'string' || typeof parsed.content === 'string') {
                const prefix = typeof parsed.prefix === 'string' ? decode(parsed.prefix) : '';
                const content = typeof parsed.content === 'string' ? decode(parsed.content) : '';
                const joined = prefix + content;
                return joined.length > 0 ? maybeHidePrefillForDisplay(joined) : '';
            }
            // Back-compat with the previous multi-field attempt.
            if (typeof parsed.content === 'string') return String(runtimeState.expectedPrefill ?? '') + parsed.content;
        }
    } catch {
        // Fall back to partial extraction (useful during streaming).
    }

    // Back-compat: single-field schema.
    const legacy = tryExtractJsonStringField(text, 'value');
    if (typeof legacy === 'string') return maybeHidePrefillForDisplay(decode(legacy));

    const prefix = tryExtractJsonStringField(text, 'prefix');
    const content2 = tryExtractJsonStringField(text, 'content');
    if (typeof prefix === 'string' || typeof content2 === 'string') {
        const joined = decode(prefix ?? '') + decode(content2 ?? '');
        return joined.length > 0 ? maybeHidePrefillForDisplay(joined) : '';
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
    if (!forceRerender && message.mes === newText) return;

    message.mes = newText;
    // If ST cached an alternate render string during streaming, drop it so the UI consistently reflects `mes`.
    if (message.extra && Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        delete message.extra.display_text;
    }
    if (Array.isArray(message.swipes)) {
        message.swipes[message.swipe_id] = newText;
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

    ensureScrollIntentListeners();

    // Keep the backing data decoded even during streaming so edit/cancel doesn't resurrect raw JSON.
    message.mes = newText;
    if (message.extra && Object.prototype.hasOwnProperty.call(message.extra, 'display_text')) {
        delete message.extra.display_text;
    }
    if (Array.isArray(message.swipes)) {
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
            const isHuge = newText.length > 80000;
            const previewText = hasUnclosedCodeFence(newText) ? sanitizeUnclosedCodeFencesForPreview(newText) : newText;

            if (isHuge) {
                // Preserve newlines even when we temporarily bypass the markdown pipeline.
                textEl.style.whiteSpace = 'pre-wrap';
                textEl.textContent = newText;
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
            textEl.textContent = newText;
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
        const domLooksLikeStructuredJson = domText.trimStart().startsWith('{') && domText.includes('"value"');
        // If ST just overwrote the DOM with raw JSON, we need to re-apply even if the decoded text didn’t change.
        if (unwrapped === runtimeState.lastAppliedText && !domLooksLikeStructuredJson) return;
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
        // If a new generation started, don’t interfere.
        if (!runtimeState.active) return;
        if (runtimeState.stopSessionAt !== sessionAtStop) return;

        // Final best-effort render so markdown etc. is correct in the saved message.
        const raw = getRawCandidateForMessage(messageId);
        const unwrapped = tryUnwrapStructuredOutput(String(raw));
        if (typeof unwrapped === 'string') {
            runtimeState.lastAppliedText = unwrapped;
            applyTextToMessage(messageId, unwrapped, { forceRerender: true });
        } else if (typeof runtimeState.lastAppliedText === 'string') {
            applyTextToMessage(messageId, runtimeState.lastAppliedText, { forceRerender: true });
        }

        runtimeState.active = false;
        runtimeState.stopping = false;
        disconnectStreamObserver();
        clearStopCleanupTimer();
    }, 250);
}

function onChatCompletionSettingsReady(generateData) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;
    if (!generateData || typeof generateData !== 'object') return;

    if (!supportsStructuredPrefillForSource(generateData.chat_completion_source)) return;
    if (generateData.json_schema) return;
    // Avoid conflicts with tool-calling in early testing; can be revisited later.
    if (Array.isArray(generateData.tools) && generateData.tools.length > 0) return;

    const messages = generateData.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const src = String(generateData.chat_completion_source ?? '').toLowerCase();
    const modelId = String(generateData.model ?? '');
    runtimeState.patternMode = getPatternModeForRequest(src, modelId);
    // OpenRouter is OpenAI-compatible. Some routed providers/models may ignore or partially enforce `json_schema`.
    // We still attempt injection for any OpenRouter model and let it be a no-op if the backend doesn't enforce it.

    // Always require the last message to be an assistant-role prefill.
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || typeof last.content !== 'string') return;
    let prefix = last.content;
    if (!prefix) return;

    resetStreamGuard();

    // Remove the assistant prefill message and replace it with a structured output constraint.
    messages.pop();

    // Legacy cleanup: if the user has old `[[SP: ...]]` blocks in their prefill, strip them.
    // StructuredPrefill now uses `[[...]]` as *slots* inside the prefix template.
    prefix = String(prefix ?? '').replace(/\[\[\s*sp\s*:[^\]]*\]\]/gi, '');
    // SAFEGUARD:
    // Literal `"` characters inside the prefix are very common in templates (e.g. quoting example thoughts),
    // but in "best-effort JSON" implementations they can cause repeated premature JSON-string termination
    // (model emits an unescaped `"` and the reply gets truncated at the same spot every time).
    // Converting literal quotes to curly quotes avoids needing escapes and dramatically improves robustness.
    prefix = curlyQuoteLiteralsOutsideSlots(prefix);

    runtimeState.newlineToken = chooseNewlineToken(prefix, settings.newline_token);
    clearHidePrefillState();
    if (settings.hide_prefill_in_display) buildPrefillStripper(prefix);

    const minCharsAfterPrefix = clampInt(settings.min_chars_after_prefix, 1, 10000, 80);
    generateData.json_schema = buildJsonSchemaForPrefillValuePattern(prefix, minCharsAfterPrefix);

    // Debug: log the structured output regex pattern that we inject.
    try {
        console.debug(`[${extensionName}] Injecting structured prefill: source=${src} model=${modelId} schema=value.pattern mode=${runtimeState.patternMode}`);
        const injectedPattern = generateData?.json_schema?.value?.properties?.value?.pattern;
        if (typeof injectedPattern === 'string' && injectedPattern.length > 0) {
            console.debug(`[${extensionName}] Injected json_schema pattern (${injectedPattern.length} chars):`, injectedPattern);
            console.debug(
                `[${extensionName}] Prefix/newline info: prefix_len=${String(prefix ?? '').length}, newline_token=${runtimeState.newlineToken}, min_chars_after_prefix=${minCharsAfterPrefix}`,
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
    runtimeState.expectedPrefill = String(prefix ?? '');
}

function scheduleStreamUnwrap(rawText) {
    const settings = extension_settings[extensionName];
    if (!settings?.enabled) return;
    if (!runtimeState.active) return;

    runtimeState.latestStreamText = String(rawText ?? '');
    const messageId = chat.length - 1;
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
    clearStopCleanupTimer();
    disconnectStreamObserver();
    clearHidePrefillState();
    resetStreamGuard();
}

function onGenerationStopped() {
    if (!runtimeState.active) return;

    const messageId = chat.length - 1;
    runtimeState.stopping = true;
    runtimeState.stopSessionAt = runtimeState.lastInjectedAt;

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
    $('#structuredprefill_newline_token').val(String(settings.newline_token ?? '<NL>'));
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

    $('#structuredprefill_newline_token')
        .off('input')
        .on('input', () => {
            extension_settings[extensionName].newline_token = String($('#structuredprefill_newline_token').val() ?? '<NL>');
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
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, scheduleStreamUnwrap);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);

    console.log(`[${extensionName}] extension loaded`);
});
