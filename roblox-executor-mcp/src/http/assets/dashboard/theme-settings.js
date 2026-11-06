export function createThemeSettings({ $, escapeHtml, showToast, copyText, dashboardApiFetch, queueSettingsSave, scheduleSettingsAutoSave }) {
const THEME_STORAGE_KEY = 'roblox-mcp-dashboard-theme';
const THEME_IDS = new Set(['default', 'claude', 'chatgpt', 'github-dark', 'github-light', 'custom']);
const CUSTOM_THEME_PROPERTIES = [
    '--bg', '--surface', '--surface-raised', '--surface-hover', '--border', '--border-light',
    '--accent', '--blue', '--blue-dim', '--text', '--text-secondary', '--text-tertiary',
    '--topbar-bg', '--code-bg', '--overlay', '--shadow', '--shadow-soft', '--contrast-text',
    '--lift-overlay', '--media-chrome-bg', '--theme-color-scheme'
];
const DEFAULT_CUSTOM_THEME = {
    background: '#0a0a0a',
    surface: '#111111',
    raised: '#171717',
    border: '#262626',
    accent: '#3b82f6',
    text: '#ededed',
    muted: '#a1a1a1'
};
const DEFAULT_BACKGROUND_MEDIA = {
    type: 'none',
    url: '',
    fit: 'cover',
    opacity: 0.35
};
const SANS_FONT_STACKS = {
    geist: "'Geist', -apple-system, system-ui, sans-serif",
    'ibm-plex': "'IBM Plex Sans', -apple-system, system-ui, sans-serif",
    'source-sans': "'Source Sans 3', -apple-system, system-ui, sans-serif",
    system: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif"
};
const MONO_FONT_STACKS = {
    'geist-mono': "'Geist Mono', 'SF Mono', monospace",
    'ibm-plex-mono': "'IBM Plex Mono', 'SF Mono', monospace",
    'jetbrains-mono': "'JetBrains Mono', 'SF Mono', monospace",
    'system-mono': "'SF Mono', ui-monospace, monospace"
};
let selectedTheme = THEME_IDS.has(document.documentElement.dataset.theme)
    ? document.documentElement.dataset.theme
    : 'default';
let customThemeColors = { ...DEFAULT_CUSTOM_THEME };
let dashboardFonts = { sans: 'geist', mono: 'geist-mono', customSans: '', customMono: '' };
let dashboardBackgroundMedia = { ...DEFAULT_BACKGROUND_MEDIA };
let customThemeDraftColors = { ...DEFAULT_CUSTOM_THEME };
let customThemeDraftFonts = { sans: 'geist', mono: 'geist-mono', customSans: '', customMono: '' };
let customThemeDraftBackgroundMedia = { ...DEFAULT_BACKGROUND_MEDIA };

function normalizeThemeHex(value, fallback) {
    const normalized = String(value || '').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function hexToRgb(hex) {
    const value = normalizeThemeHex(hex, '#000000').slice(1);
    return {
        r: Number.parseInt(value.slice(0, 2), 16),
        g: Number.parseInt(value.slice(2, 4), 16),
        b: Number.parseInt(value.slice(4, 6), 16)
    };
}

function rgbToHex({ r, g, b }) {
    const channel = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
    return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function mixThemeColors(from, to, amount) {
    const a = hexToRgb(from);
    const b = hexToRgb(to);
    return rgbToHex({
        r: a.r + (b.r - a.r) * amount,
        g: a.g + (b.g - a.g) * amount,
        b: a.b + (b.b - a.b) * amount
    });
}

function themeLuminance(hex) {
    const channels = Object.values(hexToRgb(hex)).map(value => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function hexWithAlpha(hex, alpha) {
    const suffix = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
    return normalizeThemeHex(hex, '#000000') + suffix;
}

function sanitizeCustomThemeColors(colors) {
    const source = colors && typeof colors === 'object' ? colors : {};
    return Object.fromEntries(Object.entries(DEFAULT_CUSTOM_THEME).map(([key, fallback]) => [
        key,
        normalizeThemeHex(source[key], fallback)
    ]));
}

function sanitizeCustomFontName(value) {
    const name = String(value || '').trim();
    return /^[a-z0-9 _-]{1,60}$/i.test(name) ? name : '';
}

function sanitizeDashboardFonts(fonts) {
    const source = fonts && typeof fonts === 'object' ? fonts : {};
    return {
        sans: (SANS_FONT_STACKS[source.sans] || source.sans === 'custom') ? source.sans : 'geist',
        mono: (MONO_FONT_STACKS[source.mono] || source.mono === 'custom') ? source.mono : 'geist-mono',
        customSans: sanitizeCustomFontName(source.customSans),
        customMono: sanitizeCustomFontName(source.customMono)
    };
}

function sanitizeBackgroundMediaUrl(value) {
    const url = String(value || '').trim();
    if (!url || url.length > 2048) return '';
    if (url.startsWith('/') && !url.startsWith('//')) return url;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : '';
    } catch {
        return '';
    }
}

function sanitizeBackgroundMedia(value) {
    const source = value && typeof value === 'object' ? value : {};
    const type = source.type === 'image' || source.type === 'video' ? source.type : 'none';
    const opacity = Number(source.opacity);
    return {
        type,
        url: sanitizeBackgroundMediaUrl(source.url),
        fit: source.fit === 'contain' ? 'contain' : 'cover',
        opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0.05, opacity)) : DEFAULT_BACKGROUND_MEDIA.opacity
    };
}

function backgroundMediaValidationError(value) {
    if (value.type === 'none') return '';
    if (!value.url.trim()) return 'Enter a media URL.';
    if (!sanitizeBackgroundMediaUrl(value.url)) return 'Use an http, https, or dashboard-relative URL.';
    return '';
}

function resolveDashboardFontStacks(fontSettings) {
    const fonts = sanitizeDashboardFonts(fontSettings);
    const customSans = fonts.sans === 'custom' ? fonts.customSans : '';
    const customMono = fonts.mono === 'custom' ? fonts.customMono : '';
    return {
        sans: SANS_FONT_STACKS[fonts.sans] || (customSans ? `'${customSans}', sans-serif` : SANS_FONT_STACKS.geist),
        mono: MONO_FONT_STACKS[fonts.mono] || (customMono ? `'${customMono}', monospace` : MONO_FONT_STACKS['geist-mono'])
    };
}

function applyDashboardFonts() {
    const stacks = resolveDashboardFontStacks(dashboardFonts);
    document.documentElement.style.setProperty('--sans', stacks.sans);
    document.documentElement.style.setProperty('--mono', stacks.mono);
}

function updateBackgroundVideo(video, url) {
    if (!video) return;
    if (video.dataset.mediaUrl === url) return;
    video.pause();
    video.removeAttribute('src');
    video.dataset.mediaUrl = url;
    if (!url) {
        video.load();
        return;
    }
    video.src = url;
    video.load();
    void video.play().catch(() => undefined);
}

function applyBackgroundMediaToElements(container, image, video, value) {
    if (!container || !image || !video) return;
    const media = sanitizeBackgroundMedia(value);
    const error = backgroundMediaValidationError(value);
    const activeType = error ? 'none' : media.type;
    container.dataset.type = activeType;
    if (container.parentElement) {
        container.parentElement.dataset.hasBackgroundMedia = String(activeType !== 'none');
    }

    image.style.backgroundImage = activeType === 'image' ? `url(${JSON.stringify(media.url)})` : 'none';
    image.style.backgroundSize = media.fit;
    image.style.opacity = String(media.opacity);
    video.style.objectFit = media.fit;
    video.style.opacity = String(media.opacity);
    updateBackgroundVideo(video, activeType === 'video' ? media.url : '');
}

function applyDashboardBackgroundMedia() {
    const media = selectedTheme === 'custom' ? dashboardBackgroundMedia : DEFAULT_BACKGROUND_MEDIA;
    applyBackgroundMediaToElements(
        $('dashboardBackgroundMedia'),
        $('dashboardBackgroundImage'),
        $('dashboardBackgroundVideo'),
        media
    );
}

function applyCustomThemePreviewBackgroundMedia() {
    applyBackgroundMediaToElements(
        $('themeDemoBackgroundMedia'),
        $('themeDemoBackgroundImage'),
        $('themeDemoBackgroundVideo'),
        customThemeDraftBackgroundMedia
    );
}

function buildCustomThemeVars(colors) {
    const palette = sanitizeCustomThemeColors(colors);
    const isLight = themeLuminance(palette.background) > 0.48;
    return {
        '--bg': palette.background,
        '--surface': palette.surface,
        '--surface-raised': palette.raised,
        '--surface-hover': mixThemeColors(palette.surface, palette.text, isLight ? 0.05 : 0.08),
        '--border': palette.border,
        '--border-light': mixThemeColors(palette.border, palette.text, 0.28),
        '--accent': palette.accent,
        '--blue': palette.accent,
        '--blue-dim': hexWithAlpha(palette.accent, 0.13),
        '--text': palette.text,
        '--text-secondary': palette.muted,
        '--text-tertiary': mixThemeColors(palette.muted, palette.background, 0.24),
        '--topbar-bg': hexWithAlpha(palette.background, 0.88),
        '--code-bg': mixThemeColors(palette.background, palette.surface, 0.34),
        '--overlay': hexWithAlpha(palette.text, isLight ? 0.24 : 0.38),
        '--shadow': isLight ? '#1f23282e' : '#00000080',
        '--shadow-soft': isLight ? '#1f23281f' : '#0000004d',
        '--contrast-text': themeLuminance(palette.accent) > 0.48 ? '#111111' : '#ffffff',
        '--lift-overlay': hexWithAlpha(palette.text, 0.04),
        '--media-chrome-bg': hexWithAlpha(palette.background, isLight ? 0.76 : 0.64),
        '--theme-color-scheme': isLight ? 'light' : 'dark'
    };
}

function clearCustomThemeVars() {
    CUSTOM_THEME_PROPERTIES.forEach(property => document.documentElement.style.removeProperty(property));
}

function updateHighlightTheme(theme, vars = null) {
    const isLight = theme === 'claude' || theme === 'github-light' || (theme === 'custom' && vars?.['--theme-color-scheme'] === 'light');
    const stylesheet = $('highlightTheme');
    if (stylesheet) {
        stylesheet.href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github${isLight ? '' : '-dark'}.min.css`;
    }
}

function updateThemeControls() {
    document.querySelectorAll('[data-theme-option]').forEach(option => {
        option.setAttribute('aria-checked', String(option.dataset.themeOption === selectedTheme));
    });

    const customOption = $('customThemeOption');
    if (customOption) {
        customOption.style.setProperty('--preview-bg', customThemeColors.background);
        customOption.style.setProperty('--preview-surface', customThemeColors.surface);
        customOption.style.setProperty('--preview-accent', customThemeColors.accent);
        customOption.style.setProperty('--preview-text', customThemeColors.text);
    }
}

function updateCustomThemePreview() {
    const canvas = $('customThemeCanvas');
    if (!canvas) return;
    const vars = buildCustomThemeVars(customThemeDraftColors);
    const fontStacks = resolveDashboardFontStacks(customThemeDraftFonts);
    Object.entries(vars).forEach(([property, value]) => canvas.style.setProperty(property, value));
    canvas.style.setProperty('--sans', fontStacks.sans);
    canvas.style.setProperty('--mono', fontStacks.mono);
    const modeLabel = $('customThemeModeLabel');
    if (modeLabel) modeLabel.textContent = vars['--theme-color-scheme'] === 'light' ? 'Light palette' : 'Dark palette';
    applyCustomThemePreviewBackgroundMedia();
}

function renderCustomThemeModalControls() {
    document.querySelectorAll('[data-theme-color]').forEach(input => {
        const value = customThemeDraftColors[input.dataset.themeColor];
        input.value = value;
        const output = input.parentElement?.querySelector('output');
        if (output) output.textContent = value;
    });
    const sansSelect = $('themeSansFont');
    const monoSelect = $('themeMonoFont');
    const customSansInput = $('themeCustomSans');
    const customMonoInput = $('themeCustomMono');
    if (sansSelect) sansSelect.value = customThemeDraftFonts.sans;
    if (monoSelect) monoSelect.value = customThemeDraftFonts.mono;
    if (customSansInput) {
        customSansInput.hidden = customThemeDraftFonts.sans !== 'custom';
        customSansInput.value = customThemeDraftFonts.customSans;
    }
    if (customMonoInput) {
        customMonoInput.hidden = customThemeDraftFonts.mono !== 'custom';
        customMonoInput.value = customThemeDraftFonts.customMono;
    }
    const backgroundType = $('themeBackgroundType');
    const backgroundUrl = $('themeBackgroundUrl');
    const backgroundFit = $('themeBackgroundFit');
    const backgroundOpacity = $('themeBackgroundOpacity');
    const hasMedia = customThemeDraftBackgroundMedia.type !== 'none';
    if (backgroundType) backgroundType.value = customThemeDraftBackgroundMedia.type;
    if (backgroundUrl) backgroundUrl.value = customThemeDraftBackgroundMedia.url;
    if (backgroundFit) backgroundFit.value = customThemeDraftBackgroundMedia.fit;
    if (backgroundOpacity) backgroundOpacity.value = String(Math.round(customThemeDraftBackgroundMedia.opacity * 100));
    if ($('themeBackgroundOpacityValue')) {
        $('themeBackgroundOpacityValue').textContent = `${Math.round(customThemeDraftBackgroundMedia.opacity * 100)}%`;
    }
    if ($('themeBackgroundUrlField')) $('themeBackgroundUrlField').hidden = !hasMedia;
    if ($('themeBackgroundOptions')) $('themeBackgroundOptions').hidden = !hasMedia;
    if ($('themeBackgroundMediaError')) $('themeBackgroundMediaError').textContent = '';
    updateCustomThemePreview();
}

function openCustomThemeModal() {
    customThemeDraftColors = { ...sanitizeCustomThemeColors(customThemeColors) };
    customThemeDraftFonts = { ...sanitizeDashboardFonts(dashboardFonts) };
    customThemeDraftBackgroundMedia = { ...sanitizeBackgroundMedia(dashboardBackgroundMedia) };
    renderCustomThemeModalControls();
    $('customThemeModal')?.classList.add('open');
    $('customThemeCloseBtn')?.focus();
}

function closeCustomThemeModal() {
    $('customThemeModal')?.classList.remove('open');
    closeThemeJsonImport();
    $('customThemeOption')?.focus();
}

function dashboardSettingsPayload(
    theme = selectedTheme,
    colors = customThemeColors,
    fonts = dashboardFonts,
    backgroundMedia = dashboardBackgroundMedia
) {
    return {
        version: 1,
        theme: THEME_IDS.has(theme) ? theme : 'default',
        colors: sanitizeCustomThemeColors(colors),
        fonts: sanitizeDashboardFonts(fonts),
        backgroundMedia: sanitizeBackgroundMedia(backgroundMedia)
    };
}

function cacheDashboardSettings(settings) {
    const payload = dashboardSettingsPayload(
        settings.theme,
        settings.colors,
        settings.fonts,
        settings.backgroundMedia
    );
    const vars = payload.theme === 'custom' ? buildCustomThemeVars(payload.colors) : undefined;
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
        ...payload,
        ...(vars ? { vars } : {})
    }));
}

function commitDashboardSettings(settings) {
    const payload = dashboardSettingsPayload(
        settings.theme,
        settings.colors,
        settings.fonts,
        settings.backgroundMedia
    );
    customThemeColors = payload.colors;
    dashboardFonts = payload.fonts;
    dashboardBackgroundMedia = payload.backgroundMedia;
    applyDashboardTheme(payload.theme, payload.colors);
    applyDashboardFonts();
    cacheDashboardSettings(payload);
}

async function persistDashboardSettings(settings) {
    const response = await dashboardApiFetch('/api/dashboard-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dashboardSettingsPayload(
            settings.theme,
            settings.colors,
            settings.fonts,
            settings.backgroundMedia
        ))
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to save dashboard settings');
    return dashboardSettingsPayload(data.theme, data.colors, data.fonts, data.backgroundMedia);
}

async function syncDashboardSettingsFromServer(hadCachedSettings) {
    try {
        const response = await dashboardApiFetch('/api/dashboard-settings', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load dashboard settings');

        if (data.persisted === false && hadCachedSettings) {
            const migrated = await queueSettingsSave(() => persistDashboardSettings(dashboardSettingsPayload()));
            commitDashboardSettings(migrated);
        } else {
            commitDashboardSettings(data);
        }
        if ($('themeSettingsHint')) $('themeSettingsHint').textContent = 'Saved automatically to .roblox-mcp/dashboard-settings.json';
    } catch {
        if ($('themeSettingsHint')) $('themeSettingsHint').textContent = 'Server settings unavailable; using the browser cache.';
    }
}

function exportCustomThemeJson() {
    return JSON.stringify(
        dashboardSettingsPayload(
            'custom',
            customThemeDraftColors,
            customThemeDraftFonts,
            customThemeDraftBackgroundMedia
        ),
        null,
        2
    );
}

function isJsonObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
}

function parseImportedThemeJson(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('That is not valid JSON.');
    }
    if (!isJsonObject(parsed)) throw new Error('Theme JSON must contain an object.');
    if (parsed.version !== undefined && parsed.version !== 1) throw new Error('Only theme JSON version 1 is supported.');
    if (parsed.theme !== undefined && parsed.theme !== 'custom') throw new Error('Imported theme JSON must use "theme": "custom".');
    if (!isJsonObject(parsed.colors) && !isJsonObject(parsed.fonts)) {
        throw new Error('Theme JSON needs a colors or fonts object.');
    }

    const colors = { ...customThemeDraftColors };
    if (isJsonObject(parsed.colors)) {
        for (const key of Object.keys(DEFAULT_CUSTOM_THEME)) {
            if (!(key in parsed.colors)) continue;
            const value = parsed.colors[key];
            if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.trim())) {
                throw new Error(`${key} must be a six-digit hex color.`);
            }
            colors[key] = value.trim().toLowerCase();
        }
    }

    const fonts = { ...customThemeDraftFonts };
    if (isJsonObject(parsed.fonts)) {
        if (parsed.fonts.sans !== undefined) {
            if (!SANS_FONT_STACKS[parsed.fonts.sans] && parsed.fonts.sans !== 'custom') {
                throw new Error('Unknown interface font in theme JSON.');
            }
            fonts.sans = parsed.fonts.sans;
        }
        if (parsed.fonts.mono !== undefined) {
            if (!MONO_FONT_STACKS[parsed.fonts.mono] && parsed.fonts.mono !== 'custom') {
                throw new Error('Unknown code font in theme JSON.');
            }
            fonts.mono = parsed.fonts.mono;
        }
        if (parsed.fonts.customSans !== undefined) {
            const value = sanitizeCustomFontName(parsed.fonts.customSans);
            if (parsed.fonts.customSans && !value) throw new Error('Invalid custom interface font name.');
            fonts.customSans = value;
        }
        if (parsed.fonts.customMono !== undefined) {
            const value = sanitizeCustomFontName(parsed.fonts.customMono);
            if (parsed.fonts.customMono && !value) throw new Error('Invalid custom code font name.');
            fonts.customMono = value;
        }
    }

    if (fonts.sans === 'custom' && !sanitizeCustomFontName(fonts.customSans)) {
        throw new Error('A custom interface font name is required.');
    }
    if (fonts.mono === 'custom' && !sanitizeCustomFontName(fonts.customMono)) {
        throw new Error('A custom code font name is required.');
    }

    const backgroundMedia = { ...customThemeDraftBackgroundMedia };
    if (parsed.backgroundMedia !== undefined) {
        if (!isJsonObject(parsed.backgroundMedia)) throw new Error('backgroundMedia must be an object.');
        if (parsed.backgroundMedia.type !== undefined) {
            if (!['none', 'image', 'video'].includes(parsed.backgroundMedia.type)) {
                throw new Error('Background media type must be none, image, or video.');
            }
            backgroundMedia.type = parsed.backgroundMedia.type;
        }
        if (parsed.backgroundMedia.url !== undefined) {
            if (typeof parsed.backgroundMedia.url !== 'string') throw new Error('Background media URL must be text.');
            backgroundMedia.url = parsed.backgroundMedia.url.trim();
        }
        if (parsed.backgroundMedia.fit !== undefined) {
            if (parsed.backgroundMedia.fit !== 'cover' && parsed.backgroundMedia.fit !== 'contain') {
                throw new Error('Background media fit must be cover or contain.');
            }
            backgroundMedia.fit = parsed.backgroundMedia.fit;
        }
        if (parsed.backgroundMedia.opacity !== undefined) {
            const opacity = Number(parsed.backgroundMedia.opacity);
            if (!Number.isFinite(opacity) || opacity < 0.05 || opacity > 1) {
                throw new Error('Background media opacity must be between 0.05 and 1.');
            }
            backgroundMedia.opacity = opacity;
        }
        const mediaError = backgroundMediaValidationError(backgroundMedia);
        if (mediaError) throw new Error(mediaError);
    }

    return {
        colors: sanitizeCustomThemeColors(colors),
        fonts: sanitizeDashboardFonts(fonts),
        backgroundMedia: sanitizeBackgroundMedia(backgroundMedia)
    };
}

function openThemeJsonImport() {
    const panel = $('themeJsonImportPanel');
    if (!panel) return;
    panel.hidden = false;
    $('pasteThemeJsonBtn')?.setAttribute('aria-expanded', 'true');
    if ($('themeJsonError')) $('themeJsonError').textContent = '';
    $('themeJsonInput')?.focus();
}

function closeThemeJsonImport() {
    const panel = $('themeJsonImportPanel');
    if (panel) panel.hidden = true;
    $('pasteThemeJsonBtn')?.setAttribute('aria-expanded', 'false');
    if ($('themeJsonInput')) $('themeJsonInput').value = '';
    if ($('themeJsonError')) $('themeJsonError').textContent = '';
}

function applyDashboardTheme(theme, colors = customThemeColors) {
    selectedTheme = THEME_IDS.has(theme) ? theme : 'default';
    clearCustomThemeVars();
    document.documentElement.dataset.theme = selectedTheme;
    let customVars = null;
    if (selectedTheme === 'custom') {
        customThemeColors = sanitizeCustomThemeColors(colors);
        customVars = buildCustomThemeVars(customThemeColors);
        Object.entries(customVars).forEach(([property, value]) => document.documentElement.style.setProperty(property, value));
    }
    updateHighlightTheme(selectedTheme, customVars);
    updateThemeControls();
    applyDashboardBackgroundMedia();
}

function readSavedTheme() {
    try {
        const raw = localStorage.getItem(THEME_STORAGE_KEY);
        if (!raw) return false;
        const saved = JSON.parse(raw);
        customThemeColors = sanitizeCustomThemeColors(saved.colors);
        dashboardFonts = sanitizeDashboardFonts(saved.fonts);
        dashboardBackgroundMedia = sanitizeBackgroundMedia(saved.backgroundMedia);
        selectedTheme = THEME_IDS.has(saved.theme) ? saved.theme : selectedTheme;
        return true;
    } catch {
        customThemeColors = { ...DEFAULT_CUSTOM_THEME };
        dashboardFonts = sanitizeDashboardFonts(null);
        dashboardBackgroundMedia = { ...DEFAULT_BACKGROUND_MEDIA };
        return false;
    }
}

function scheduleCustomThemeDraftSave(delay = 350) {
    const mediaError = backgroundMediaValidationError(customThemeDraftBackgroundMedia);
    if (mediaError) {
        if ($('themeBackgroundMediaError')) $('themeBackgroundMediaError').textContent = mediaError;
        return;
    }
    if ($('themeBackgroundMediaError')) $('themeBackgroundMediaError').textContent = '';
    const payload = dashboardSettingsPayload(
        'custom',
        customThemeDraftColors,
        customThemeDraftFonts,
        customThemeDraftBackgroundMedia
    );
    commitDashboardSettings(payload);
    scheduleSettingsAutoSave('dashboard-theme', async () => {
        try {
            commitDashboardSettings(await persistDashboardSettings(payload));
            if ($('themeSettingsHint')) $('themeSettingsHint').textContent = 'Saved automatically to .roblox-mcp/dashboard-settings.json';
        } catch (error) {
            showToast(error instanceof Error ? error.message : 'Failed to save custom theme', 'error');
        }
    }, delay);
}

function initializeThemeSettings() {
    const hadCachedSettings = readSavedTheme();
    applyDashboardTheme(selectedTheme, customThemeColors);
    applyDashboardFonts();
    updateThemeControls();

    $('themePresetGrid')?.addEventListener('click', event => {
        const option = event.target.closest('[data-theme-option]');
        if (!option) return;
        if (option.dataset.themeOption === 'custom') {
            openCustomThemeModal();
            return;
        }
        applyDashboardTheme(option.dataset.themeOption, customThemeColors);
        scheduleSettingsAutoSave('dashboard-theme', async () => {
            try {
                await persistDashboardSettings(dashboardSettingsPayload());
                if ($('themeSettingsHint')) $('themeSettingsHint').textContent = 'Saved automatically to .roblox-mcp/dashboard-settings.json';
            } catch (error) {
                showToast(error instanceof Error ? error.message : 'Failed to save theme', 'error');
            }
        }, 200);
    });

    document.querySelectorAll('[data-theme-color]').forEach(input => {
        input.addEventListener('input', () => {
            customThemeDraftColors[input.dataset.themeColor] = normalizeThemeHex(input.value, DEFAULT_CUSTOM_THEME[input.dataset.themeColor]);
            const output = input.parentElement?.querySelector('output');
            if (output) output.textContent = customThemeDraftColors[input.dataset.themeColor];
            updateCustomThemePreview();
            scheduleCustomThemeDraftSave();
        });
    });

    $('resetCustomThemeBtn')?.addEventListener('click', () => {
        customThemeDraftColors = { ...DEFAULT_CUSTOM_THEME };
        renderCustomThemeModalControls();
        scheduleCustomThemeDraftSave(100);
    });

    $('themeSansFont')?.addEventListener('change', event => {
        customThemeDraftFonts.sans = event.target.value;
        renderCustomThemeModalControls();
        scheduleCustomThemeDraftSave();
    });

    $('themeMonoFont')?.addEventListener('change', event => {
        customThemeDraftFonts.mono = event.target.value;
        renderCustomThemeModalControls();
        scheduleCustomThemeDraftSave();
    });

    $('themeCustomSans')?.addEventListener('input', event => {
        customThemeDraftFonts.customSans = event.target.value;
        updateCustomThemePreview();
        scheduleCustomThemeDraftSave();
    });

    $('themeCustomMono')?.addEventListener('input', event => {
        customThemeDraftFonts.customMono = event.target.value;
        updateCustomThemePreview();
        scheduleCustomThemeDraftSave();
    });

    $('themeBackgroundType')?.addEventListener('change', event => {
        customThemeDraftBackgroundMedia.type = event.target.value;
        renderCustomThemeModalControls();
        scheduleCustomThemeDraftSave();
    });
    $('themeBackgroundUrl')?.addEventListener('input', event => {
        customThemeDraftBackgroundMedia.url = event.target.value;
        if ($('themeBackgroundMediaError')) $('themeBackgroundMediaError').textContent = '';
        updateCustomThemePreview();
        scheduleCustomThemeDraftSave(600);
    });
    $('themeBackgroundFit')?.addEventListener('change', event => {
        customThemeDraftBackgroundMedia.fit = event.target.value;
        updateCustomThemePreview();
        scheduleCustomThemeDraftSave();
    });
    $('themeBackgroundOpacity')?.addEventListener('input', event => {
        customThemeDraftBackgroundMedia.opacity = Number(event.target.value) / 100;
        if ($('themeBackgroundOpacityValue')) $('themeBackgroundOpacityValue').textContent = `${event.target.value}%`;
        updateCustomThemePreview();
        scheduleCustomThemeDraftSave();
    });

    $('copyThemeJsonBtn')?.addEventListener('click', () => {
        copyText(exportCustomThemeJson(), 'Theme JSON');
    });
    $('pasteThemeJsonBtn')?.addEventListener('click', () => {
        if ($('themeJsonImportPanel')?.hidden === false) closeThemeJsonImport();
        else openThemeJsonImport();
    });
    $('cancelThemeJsonBtn')?.addEventListener('click', closeThemeJsonImport);
    $('importThemeJsonBtn')?.addEventListener('click', () => {
        try {
            const imported = parseImportedThemeJson($('themeJsonInput')?.value || '');
            customThemeDraftColors = imported.colors;
            customThemeDraftFonts = imported.fonts;
            customThemeDraftBackgroundMedia = imported.backgroundMedia;
            renderCustomThemeModalControls();
            closeThemeJsonImport();
            scheduleCustomThemeDraftSave(100);
            showToast('Theme imported', 'success');
        } catch (error) {
            if ($('themeJsonError')) {
                $('themeJsonError').textContent = error instanceof Error ? error.message : 'Invalid theme JSON.';
            }
        }
    });

    $('customThemeCloseBtn')?.addEventListener('click', closeCustomThemeModal);
    $('customThemeCancelBtn')?.addEventListener('click', closeCustomThemeModal);
    $('customThemeModal')?.addEventListener('click', event => {
        if (event.target === $('customThemeModal')) closeCustomThemeModal();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && $('customThemeModal')?.classList.contains('open')) closeCustomThemeModal();
    });

    void syncDashboardSettingsFromServer(hadCachedSettings);
}

return { initialize: initializeThemeSettings };
}
