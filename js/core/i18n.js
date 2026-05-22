/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: quelora/js/core/i18n.js */
/**
 * @module Core/I18N
 * @description Internationalisation engine with lazy namespace loading,
 * MutationObserver-based auto-translation, RTL support and speech-variant resolution.
 *
 * Design decisions:
 * - Namespaces are loaded on demand and cached in localStorage with a 24-hour TTL.
 * - The MutationObserver targets only `#ql-root` (not `document.body`) to avoid
 *   imposing overhead on the host page when the module is used as an embedded widget.
 * - DOM updates are spread across animation frames in chunks to prevent long tasks.
 * - A re-entrancy guard on each element prevents double-translation during
 *   concurrent language switches.
 *
 * @version 2.5.0
 */
import handleLog from './logs.js';
import StorageModule from './storage.js';
import CoreModule from './core.js';

/** Number of DOM elements translated per animation frame to avoid long tasks. */
const I18N_UPDATE_CHUNK_SIZE = 50;

/**
 * @typedef {Object} TranslationConfig
 * @property {string}      className - CSS class that marks translatable elements.
 * @property {string|null} attribute - HTML attribute to translate, or null for text content.
 */

/**
 * Module-private state container.
 *
 * @type {{
 *   basePath:            string,
 *   currentLang:         string,
 *   loadedNamespaces:    Set<string>,
 *   isChangingLanguage:  boolean,
 *   translations:        Record<string, string>,
 *   observer:            MutationObserver|null,
 *   speechVariants:      Record<string, string>,
 *   langNames:           Record<string, string>,
 *   translationConfig:   TranslationConfig[]
 * }}
 */
const state = {
    basePath: '',
    currentLang: 'en',
    loadedNamespaces: new Set(),
    isChangingLanguage: false,
    translations: {},
    observer: null,
    speechVariants: {
        'ar': 'ar-SA', 'de': 'de-DE', 'en': 'en-US', 'es': 'es-ES',
        'fr': 'fr-FR', 'he': 'he-IL', 'hi': 'hi-IN', 'it': 'it-IT',
        'ja': 'ja-JP', 'pt': 'pt-PT', 'ru': 'ru-RU', 'zh': 'zh-CN'
    },
    langNames: {
        'ar': '{{arabic}}',    'de': '{{german}}',     'en': '{{english}}',
        'es': '{{spanish}}',   'fr': '{{french}}',     'he': '{{hebrew}}',
        'hi': '{{hindi}}',     'it': '{{italian}}',    'ja': '{{japanese}}',
        'pt': '{{portuguese}}','ru': '{{russian}}',    'zh': '{{chinese}}'
    },
    translationConfig: []
};

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Recursively replaces `{{key}}` placeholder tokens within a string
 * using the currently loaded translations.
 *
 * @param {string} text - Raw string that may contain placeholder tokens.
 * @returns {string} String with all resolvable tokens substituted.
 */
const _replaceKeys = (text) =>
    text.replace(/{{(\w+)}}/g, (_, key) => getTranslation(key));

/**
 * Persists the Web Speech API locale string for the current language.
 *
 * @param {string} lang - BCP-47 language code.
 */
const _setSpeechVariant = (lang) => {
    const variant = state.speechVariants[lang] || 'en-US';
    StorageModule.setLocalItem('ql_i18n_transcription', variant, 86400 * 1000);
};

/**
 * Applies the correct `dir` and `lang` attributes to the widget theme root (`#ql-theme-root`),
 * enabling RTL layout for Arabic and Hebrew without touching the host page's `<html>`.
 *
 * @param {string} lang - BCP-47 language code.
 */
const _applyTextDirection = (lang) => {
    const root = document.getElementById('ql-theme-root');
    if (!root) return;
    root.lang = lang;
    root.dir = ['ar', 'he'].includes(lang) ? 'rtl' : 'ltr';
};

/**
 * Applies every entry in `state.translationConfig` across the current document.
 */
const _applyTranslationConfig = () => {
    state.translationConfig.forEach(cfg => translateByClass(cfg.className, cfg.attribute));
};

// =============================================================================
// DOM TRANSLATION ENGINE
// =============================================================================

/**
 * Translates a single DOM element in-place.
 *
 * The translation key is resolved from the following sources (in priority order):
 * 1. `data-i18n-original` attribute — stored original token from a previous render.
 * 2. A configured HTML attribute (e.g. `placeholder`).
 * 3. The element's own text content when it matches the `{{key}}` pattern.
 * 4. `data-i18n-key` attribute.
 *
 * A re-entrancy guard (`data-i18n-processing`) prevents double-translation
 * caused by recursive MutationObserver callbacks.
 *
 * @param {Element}     element           - The DOM element to translate.
 * @param {string|null} [attribute=null]  - HTML attribute to translate instead of text content.
 * @param {string}      [className='t']   - Originating CSS class (stored for re-translation).
 */
const _translateNode = (element, attribute = null, className = 't') => {
    if (!element?.isConnected || element.dataset.i18nProcessing === 'true') return;

    try {
        element.dataset.i18nProcessing = 'true';

        let key = null;

        if (element.dataset.i18nOriginal) {
            const match = element.dataset.i18nOriginal.match(/^{{(.*?)}}$/);
            if (match) key = match[1].trim();
        }

        if (!key) {
            key = attribute
                ? element.getAttribute(attribute)?.replace(/^{{|}}$/g, '')
                : (element.textContent.trim().match(/^{{(.*?)}}$/)?.[1]?.trim() ?? null);
        }

        if (!key && element.dataset.i18nKey) {
            key = element.dataset.i18nKey.replace(/{{|}}/g, '');
        }

        if (!element.dataset.i18nOriginal) {
            element.dataset.i18nOriginal = attribute
                ? (element.getAttribute(attribute) || '')
                : element.textContent;
        }

        element.dataset.i18nKey       = key || '';
        element.dataset.i18nAttribute = attribute || '';
        element.dataset.i18nClass     = className;

        const translation = key
            ? getTranslation(key).replace(/{{|}}/g, '')
            : _replaceKeys(element.dataset.i18nOriginal).replace(/{{|}}/g, '');

        if (attribute) {
            element.setAttribute(attribute, translation);
        } else {
            const textNodes = Array.from(element.childNodes).filter(
                n => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
            );

            if (textNodes.length > 0) {
                textNodes.forEach(n => {
                    if (n.textContent.includes('{{') || key) n.textContent = translation;
                });
            } else if (element.dataset.i18nOriginal.includes('{{') || key) {
                element.textContent = translation;
            }
        }
    } catch {
        // Silently absorb per-element translation errors to avoid
        // breaking the host page when encountering unexpected DOM states.
    } finally {
        element.dataset.i18nProcessing = 'false';
    }
};

/**
 * Iterates all translatable elements in the document and applies the current translations.
 *
 * Processing is split across animation frames in chunks of {@link I18N_UPDATE_CHUNK_SIZE}
 * to prevent blocking the main thread during large DOM updates.
 *
 * @returns {Promise<void>} Resolves when every element has been processed.
 */
const _updateDOM = () => new Promise(resolve => {
    const elements = [
        ...document.querySelectorAll('[data-i18n-key]'),
        ...document.querySelectorAll('.t')
    ];

    state.translationConfig.forEach(cfg => {
        elements.push(...document.querySelectorAll(`.${cfg.className}`));
    });

    let i = 0;

    const process = () => {
        const end = Math.min(i + I18N_UPDATE_CHUNK_SIZE, elements.length);

        for (; i < end; i++) {
            const el  = elements[i];
            const cfg = state.translationConfig.find(c => el.classList.contains(c.className));
            _translateNode(
                el,
                el.dataset.i18nAttribute || cfg?.attribute || null,
                el.dataset.i18nClass     || 't'
            );
        }

        if (i < elements.length) requestAnimationFrame(process);
        else resolve();
    };

    requestAnimationFrame(process);
});

/**
 * Installs a `MutationObserver` on the widget root (`#ql-root`) to automatically
 * translate newly added element subtrees without requiring explicit calls.
 *
 * Observing only `#ql-root` (rather than `document.body`) avoids imposing
 * unnecessary overhead on the host page's own DOM mutations when the module
 * is used as an embedded widget.
 *
 * A pre-existing observer is always disconnected before a new one is attached
 * to prevent listener accumulation across language switches.
 */
const _initMutationObserver = () => {
    if (state.observer) state.observer.disconnect();

    const observationRoot = document.getElementById('ql-root') || document.body;

    state.observer = new MutationObserver(mutations => {
        if (document.body.dataset.changingLanguage === 'true') return;

        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    translateElement(/** @type {Element} */ (node));
                }
            });
        });
    });

    state.observer.observe(observationRoot, { childList: true, subtree: true });
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Initialises the I18N module for a given language and set of namespaces.
 *
 * Always pre-loads the `common` and `profile` namespaces eagerly to
 * minimise first-paint translation gaps. All other namespaces are loaded
 * on demand via {@link loadModuleTranslations}.
 *
 * @param {string}             [lang='en']           - BCP-47 language code.
 * @param {string}             [basePath='']         - Base URL path to locale JSON files (no trailing slash).
 * @param {TranslationConfig[]}[translationConfig=[]]- Additional element-class mappings for custom components.
 * @returns {Promise<void>}
 */
const initializeI18N = async (lang = 'en', basePath = '', translationConfig = []) => {
    try {
        state.currentLang       = lang;
        state.basePath          = basePath.endsWith('/') ? basePath : `${basePath}/`;
        state.translationConfig = Array.isArray(translationConfig) ? translationConfig : [];

        state.loadedNamespaces.clear();
        state.translations = {};

        await loadModuleTranslations('common');
        await loadModuleTranslations('profile');

        _applyTextDirection(lang);
        _setSpeechVariant(lang);
        _initMutationObserver();
        _applyTranslationConfig();
    } catch (error) {
        handleLog(error, 'I18N.initializeI18N');
    }
};

/**
 * Lazily fetches and caches a translation namespace JSON file.
 *
 * Results are stored in `localStorage` with a 24-hour TTL to reduce network
 * requests on subsequent page loads. If the namespace is already loaded in
 * the current session the call is a no-op and resolves immediately.
 *
 * @param {string} namespace - Locale namespace identifier (e.g. `'chat'`, `'profile'`).
 * @returns {Promise<boolean>} `true` if the namespace was loaded successfully.
 */
const loadModuleTranslations = async (namespace) => {
    if (state.loadedNamespaces.has(namespace)) return true;

    const lang       = state.currentLang;
    const storageKey = `ql_i18n_${lang}_${namespace}`;
    const cached     = StorageModule.getLocalItem(storageKey);

    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            Object.assign(state.translations, parsed);
            state.loadedNamespaces.add(namespace);
            await _updateDOM();
            return true;
        } catch {
            StorageModule.removeLocalItem(storageKey);
        }
    }

    const url = `${state.basePath}${lang}/${namespace}.json`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} loading ${namespace}`);

        const newTranslations = await response.json();
        Object.assign(state.translations, newTranslations);
        state.loadedNamespaces.add(namespace);

        StorageModule.setLocalItem(storageKey, JSON.stringify(newTranslations), 86400 * 1000);
        await _updateDOM();
        return true;
    } catch (error) {
        handleLog(
            `Failed to load translations for namespace "${namespace}": ${error.message}`,
            'I18N.loadModuleTranslations',
            'warn'
        );
        return false;
    }
};

/**
 * Switches the active language, reloads all previously loaded namespaces,
 * updates the DOM direction attribute and the speech variant, and persists
 * the preference to the backend when a session is active.
 *
 * The `data-changing-language` attribute is set on `document.body` throughout
 * the operation so that the MutationObserver can suppress intermediate callbacks.
 *
 * @param {string} lang - Target BCP-47 language code.
 * @returns {Promise<boolean>} `true` if the language was switched successfully.
 */
const changeLanguage = async (lang) => {
    if (state.isChangingLanguage || lang === state.currentLang) return false;

    state.isChangingLanguage = true;
    const oldLang             = state.currentLang;
    const namespacesToReload  = state.loadedNamespaces.size > 0
        ? Array.from(state.loadedNamespaces)
        : ['common'];

    state.currentLang                     = lang;
    document.body.dataset.changingLanguage = 'true';
    state.translations                    = {};
    state.loadedNamespaces.clear();

    try {
        await Promise.all(namespacesToReload.map(ns => loadModuleTranslations(ns)));

        _setSpeechVariant(lang);
        _applyTextDirection(lang);
        await _updateDOM();

        const hasSession =
            StorageModule.getLocalItem('ql_sso_token') ||
            StorageModule.getSessionItem('ql_sso_token');

        if (hasSession) {
            CoreModule.postWorkerMessage({
                action: 'updateSettings',
                payload: { key: 'interface.defaultLanguage', value: lang }
            });
        }

        return true;
    } catch (error) {
        handleLog(error, 'I18N.changeLanguage');
        state.currentLang = oldLang;
        return false;
    } finally {
        state.isChangingLanguage               = false;
        document.body.dataset.changingLanguage = 'false';
    }
};

/**
 * Resolves a translation key to its localised string value.
 *
 * Returns the key wrapped in `{{  }}` when no translation is found,
 * making untranslated tokens visually obvious during development and
 * enabling the MutationObserver to re-translate them once the namespace loads.
 *
 * @param {string} key - Translation key.
 * @returns {string} Translated string, or `{{key}}` when the key is absent.
 */
const getTranslation = (key) => state.translations[key] || `{{${key}}}`;

/**
 * Removes all cached namespace entries for the current language from `localStorage`
 * and resets the in-memory translation state.
 *
 * Call this when deploying a new locale version to force a full re-fetch
 * on the next initialisation.
 */
const clearCache = () => {
    state.loadedNamespaces.forEach(ns => {
        StorageModule.removeLocalItem(`ql_i18n_${state.currentLang}_${ns}`);
    });
    StorageModule.removeLocalItem(`ql_i18n_${state.currentLang}`);

    state.translations = {};
    state.loadedNamespaces.clear();
};

/**
 * Translates all translatable descendants of a given container element.
 * Also checks whether the container itself requires translation.
 *
 * Use this method after injecting dynamic fragments (modals, drawers, server HTML)
 * to avoid depending on the MutationObserver's asynchronous callback timing.
 *
 * @param {Element} container - Root element whose subtree should be translated.
 */
const translateElement = (container) => {
    if (!container) return;

    if (container.matches?.('.t') || container.hasAttribute?.('data-i18n-key')) {
        _translateNode(container);
    }

    container.querySelectorAll('.t, [data-i18n-key]').forEach(el => _translateNode(el));

    state.translationConfig.forEach(cfg => {
        if (container.matches?.(`.${cfg.className}`)) {
            _translateNode(container, cfg.attribute, cfg.className);
        }
        container.querySelectorAll(`.${cfg.className}`).forEach(el => {
            _translateNode(el, cfg.attribute, cfg.className);
        });
    });
};

/**
 * Translates all elements matching a given CSS class name.
 *
 * @param {string}      className          - CSS class to query.
 * @param {string|null} [attribute=null]   - Optional HTML attribute to translate instead of text content.
 */
const translateByClass = (className, attribute = null) => {
    document.querySelectorAll(`.${className}`).forEach(el =>
        _translateNode(el, attribute, className)
    );
};

/**
 * Returns the persisted Web Speech API locale string (e.g. `'es-ES'`).
 * Falls back to `'en-US'` when no value has been stored.
 *
 * @returns {string} BCP-47 speech locale string.
 */
const getSpeechVariant = () =>
    StorageModule.getLocalItem('ql_i18n_transcription') || 'en-US';

/**
 * Returns the list of supported BCP-47 language codes.
 *
 * @returns {string[]}
 */
const getSupportedLanguages = () => Object.keys(state.speechVariants);

/**
 * Returns the map of language codes to their `{{key}}` name tokens.
 * Tokens are resolved through {@link getTranslation} at render time.
 *
 * @returns {Record<string, string>}
 */
const getLanguageNames = () => state.langNames;

// =============================================================================
// MODULE EXPORT
// =============================================================================

const I18n = {
    initializeI18N,
    loadModuleTranslations,
    changeLanguage,
    translateByClass,
    translateElement,
    getTranslation,
    clearCache,
    getSpeechVariant,
    getSupportedLanguages,
    getLanguageNames
};

export default I18n;