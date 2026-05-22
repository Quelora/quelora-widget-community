/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/utils.js */
/**
 * @module Core/Utils
 * @description Shared utility functions for DOM, Async, Formatting, Network Latency, and P2P Cryptography.
 * @version 1.2.0
 */
import handleLog from './logs.js'; 
import UiModule from '../ui/ui.js';
import CoreModule from './core.js';
import StorageModule from './storage.js';

const postStatsCache = new Map();
const observerRegistry = new Map();

// ==================================================================================
// 1. GEOGRAPHY & LATENCY CONSTANTS
// ==================================================================================

/**
 * Full list of supported countries with native names.
 */
const COUNTRIES = {
    "AF": "افغانستان",
    "AL": "Shqipëri",
    "DZ": "الجزائر",
    "AD": "Andorra",
    "AO": "Angola",
    "AR": "Argentina",
    "AU": "Australia",
    "AT": "Österreich",
    "AZ": "Azərbaycan",
    "BS": "Bahamas",
    "BH": "‏البحرين",
    "BD": "বাংলাদেশ",
    "BY": "Белару́сь",
    "BE": "België",
    "BZ": "Belize",
    "BJ": "Bénin",
    "BT": "འབྲུག་ཡུལ",
    "BO": "Bolivia",
    "BA": "Bosna i Hercegovina",
    "BW": "Botswana",
    "BR": "Brasil",
    "BN": "Brunei Darussalam",
    "BG": "България",
    "BF": "Burkina Faso",
    "BI": "Burundi",
    "KH": "កម្ពុជា",
    "CM": "Cameroon",
    "CA": "Canada",
    "CF": "République centrafricaine",
    "TD": "Tchad",
    "CL": "Chile",
    "CN": "中国",
    "CO": "Colombia",
    "KM": "جزر القمر",
    "CG": "Congo",
    "CR": "Costa Rica",
    "HR": "Hrvatska",
    "CU": "Cuba",
    "CY": "Κύπρος",
    "CZ": "Česká republika",
    "DK": "Danmark",
    "DJ": "Djibouti",
    "DO": "República Dominicana",
    "EC": "Ecuador",
    "EG": "مصر‎",
    "SV": "El Salvador",
    "GQ": "Guinea Ecuatorial",
    "ER": "ኤርትራ",
    "EE": "Eesti",
    "ET": "ኢትዮጵia",
    "FJ": "Fiji",
    "FI": "Suomi",
    "FR": "France",
    "GA": "Gabon",
    "GM": "Gambia",
    "GE": "საქართველო",
    "DE": "Deutschland",
    "GH": "Ghana",
    "GR": "Ελλάδα",
    "GT": "Guatemala",
    "GN": "Guinée",
    "GW": "Guiné-Bissau",
    "GY": "Guyana",
    "HT": "Haïti",
    "HN": "Honduras",
    "HU": "Magyarország",
    "IS": "Ísland",
    "IN": "भारत",
    "ID": "Indonesia",
    "IR": "ایران",
    "IQ": "العراق",
    "IE": "Éire",
    "IL": "יִשְׂרָאֵל",
    "IT": "Italia",
    "JM": "Jamaica",
    "JP": "日本",
    "JO": "الأردن",
    "KZ": "Қазақстан",
    "KE": "Kenya",
    "KW": "الكويت",
    "KG": "Кыргызстан",
    "LA": "ສປປລາວ",
    "LV": "Latvija",
    "LB": "لبنان",
    "LS": "Lesotho",
    "LR": "Liberia",
    "LY": "‏ليبيا",
    "LI": "Liechtenstein",
    "LT": "Lietuva",
    "LU": "Luxembourg",
    "MK": "Северна Македонија",
    "MG": "Madagasikara",
    "MW": "Malawi",
    "MY": "Malaysia",
    "MV": "Maldives",
    "ML": "Mali",
    "MT": "Malta",
    "MR": "موريتانيا",
    "MU": "Mauritius",
    "MX": "México",
    "MD": "Moldova",
    "MC": "Monaco",
    "MN": "Монгол улс",
    "ME": "Crna Gora",
    "MA": "المغرب",
    "MZ": "Moçambique",
    "MM": "မြန်မာ",
    "NA": "Namibia",
    "NP": "नेपाल",
    "NL": "Nederland",
    "NZ": "New Zealand",
    "NI": "Nicaragua",
    "NE": "Niger",
    "NG": "Nigeria",
    "NO": "Norge",
    "OM": "عُمان",
    "PK": "Pakistan",
    "PA": "Panamá",
    "PG": "Papua New Guinea",
    "PY": "Paraguay",
    "PE": "Perú",
    "PH": "Pilipinas",
    "PL": "Polska",
    "PT": "Portugal",
    "QA": "قطر",
    "RO": "România",
    "RU": "Россия",
    "RW": "Rwanda",
    "SA": "المملكة العربية السعودية",
    "SN": "Sénégal",
    "RS": "Србија",
    "SC": "Seychelles",
    "SL": "Sierra Leone",
    "SG": "Singapore",
    "SK": "Slovensko",
    "SI": "Slovenija",
    "SO": "Soomaaliya",
    "ZA": "South Africa",
    "KR": "대한민국",
    "SS": "South Sudan",
    "ES": "España",
    "LK": "śrī laṃkāva",
    "SD": "السودان",
    "SR": "Suriname",
    "SE": "Sverige",
    "CH": "Schweiz",
    "SY": "سوريا",
    "TW": "臺灣",
    "TJ": "Тоҷикистон",
    "TZ": "Tanzania",
    "TH": "ประเทศไทย",
    "TL": "Timor-Leste",
    "TG": "Togo",
    "TN": "تونس",
    "TR": "Türkiye",
    "TM": "Türkmenistan",
    "UG": "Uganda",
    "UA": "Україна",
    "AE": "دولة الإمارات العربية المتحدة",
    "GB": "United Kingdom",
    "US": "United States",
    "UY": "Uruguay",
    "UZ": "O'zbekiston",
    "VE": "Venezuela",
    "VN": "Việt Nam",
    "YE": "اليَمَن",
    "ZM": "Zambia",
    "ZW": "Zimbabwe"
};

/**
 * Mapping from Country Code to Macro Region.
 */
const COUNTRY_TO_REGION = {
    AR: 'LATAM_SOUTH',
    UY: 'LATAM_SOUTH',
    CL: 'LATAM_SOUTH',
    PY: 'LATAM_SOUTH',
    BO: 'LATAM_SOUTH',
    BR: 'LATAM_SOUTH',
    CO: 'LATAM_NORTH',
    PE: 'LATAM_NORTH',
    EC: 'LATAM_NORTH',
    VE: 'LATAM_NORTH',
    MX: 'LATAM_NORTH',
    CR: 'LATAM_NORTH',
    PA: 'LATAM_NORTH',
    GT: 'LATAM_NORTH',
    SV: 'LATAM_NORTH',
    HN: 'LATAM_NORTH',
    NI: 'LATAM_NORTH',
    DO: 'LATAM_NORTH',
    PR: 'LATAM_NORTH',
    CU: 'LATAM_NORTH',
    HT: 'LATAM_NORTH',
    US: 'NORTH_AMERICA',
    CA: 'NORTH_AMERICA',
    GB: 'EUROPE_WEST',
    FR: 'EUROPE_WEST',
    DE: 'EUROPE_WEST',
    NL: 'EUROPE_WEST',
    BE: 'EUROPE_WEST',
    CH: 'EUROPE_WEST',
    ES: 'EUROPE_WEST',
    IT: 'EUROPE_WEST',
    PT: 'EUROPE_WEST',
    IE: 'EUROPE_WEST',
    SE: 'EUROPE_EAST',
    NO: 'EUROPE_EAST',
    DK: 'EUROPE_EAST',
    FI: 'EUROPE_EAST',
    PL: 'EUROPE_EAST',
    CZ: 'EUROPE_EAST',
    RO: 'EUROPE_EAST',
    HU: 'EUROPE_EAST',
    UA: 'EUROPE_EAST',
    BG: 'EUROPE_EAST',
    HR: 'EUROPE_EAST',
    SI: 'EUROPE_EAST',
    SK: 'EUROPE_EAST',
    LT: 'EUROPE_EAST',
    LV: 'EUROPE_EAST',
    EE: 'EUROPE_EAST',
    IL: 'MIDDLE_EAST',
    TR: 'MIDDLE_EAST',
    SA: 'MIDDLE_EAST',
    AE: 'MIDDLE_EAST',
    QA: 'MIDDLE_EAST',
    IR: 'MIDDLE_EAST',
    ZA: 'AFRICA',
    NG: 'AFRICA',
    KE: 'AFRICA',
    EG: 'AFRICA',
    MA: 'AFRICA',
    TN: 'AFRICA',
    JP: 'ASIA_EAST',
    KR: 'ASIA_EAST',
    CN: 'ASIA_EAST',
    TW: 'ASIA_EAST',
    HK: 'ASIA_EAST',
    IN: 'ASIA_SOUTH',
    PK: 'ASIA_SOUTH',
    BD: 'ASIA_SOUTH',
    ID: 'ASIA_SOUTH',
    SG: 'ASIA_SOUTH',
    MY: 'ASIA_SOUTH',
    TH: 'ASIA_SOUTH',
    VN: 'ASIA_SOUTH',
    PH: 'ASIA_SOUTH',
    AU: 'OCEANIA',
    NZ: 'OCEANIA'
};

/**
 * Mapping from Region to Physical Data Center Hub.
 */
const REGION_HUB = {
    LATAM_SOUTH: 'MIAMI',
    LATAM_NORTH: 'MIAMI',
    NORTH_AMERICA: 'ASHBURN',
    EUROPE_WEST: 'FRANKFURT',
    EUROPE_EAST: 'FRANKFURT',
    MIDDLE_EAST: 'FRANKFURT',
    AFRICA: 'FRANKFURT',
    ASIA_EAST: 'TOKYO',
    ASIA_SOUTH: 'SINGAPORE',
    OCEANIA: 'SINGAPORE',
    OTHER: 'UNKNOWN'
};

/**
 * Latency matrix between Hubs (Multiplier factor).
 * 1.0 = Local, >3.0 = High Latency.
 */
const HUB_LATENCY = {
    MIAMI: {
        MIAMI: 1.0,
        ASHBURN: 1.2,
        FRANKFURT: 1.8,
        SINGAPORE: 3.2,
        TOKYO: 3.5
    },
    ASHBURN: {
        ASHBURN: 1.0,
        FRANKFURT: 1.4,
        MIAMI: 1.2,
        TOKYO: 2.8,
        SINGAPORE: 3.0
    },
    FRANKFURT: {
        FRANKFURT: 1.0,
        ASHBURN: 1.4,
        MIAMI: 1.8,
        SINGAPORE: 2.6,
        TOKYO: 2.9
    },
    SINGAPORE: {
        SINGAPORE: 1.0,
        TOKYO: 1.3,
        FRANKFURT: 2.6,
        ASHBURN: 3.0,
        MIAMI: 3.2
    },
    TOKYO: {
        TOKYO: 1.0,
        SINGAPORE: 1.3,
        ASHBURN: 2.8,
        FRANKFURT: 2.9,
        MIAMI: 3.5
    }
};

// ==================================================================================
// 2. CORE UTILITY FUNCTIONS
// ==================================================================================

/**
 * Calculates a latency factor based on geographical distance between User and Server.
 * Used to optimize batch sizes and pre-fetching in comments.js.
 * @param {string} originCC - User Country Code (e.g., 'AR').
 * @param {string} targetCC - Server Country Code (e.g., 'US').
 * @returns {number} A factor (1.0 = local, >1.0 = remote).
 */
function getGeoLatencyFactor(originCC, targetCC) {
    if (!originCC || !targetCC) return 1.2;
    const o = originCC.toUpperCase();
    const t = targetCC.toUpperCase();
    if (o === t) return 1.0;
    
    const regionO = COUNTRY_TO_REGION[o] || 'OTHER';
    const regionT = COUNTRY_TO_REGION[t] || 'OTHER';
    
    if (regionO === regionT && regionO !== 'OTHER') return 1.05;
    
    const hubO = REGION_HUB[regionO] || 'UNKNOWN';
    const hubT = REGION_HUB[regionT] || 'UNKNOWN';
    
    if (hubO === 'UNKNOWN' || hubT === 'UNKNOWN') return 3.0;
    
    let factor = HUB_LATENCY[hubO]?.[hubT] ?? HUB_LATENCY[hubT]?.[hubO];
    
    if (!factor) return 3.2;
    
    if (regionO !== 'NORTH_AMERICA' && hubO === 'ASHBURN') factor += 0.1;
    if (regionT !== 'NORTH_AMERICA' && hubT === 'ASHBURN') factor += 0.1;
    
    return Number(factor.toFixed(2));
}

// ==================================================================================
// 3. OBSERVER & DOM MANAGEMENT
// ==================================================================================

function registerObserver(observer, element, type, callback) {
    try {
        if (!observer || !element || !element.isConnected) {
            handleLog('Invalid observer or disconnected element', 'Utils', 'warn', '🏠');
            return false;
        }
        const key = `${type}_${Math.random().toString(36).slice(2)}`;
        observerRegistry.set(key, { observer, element, type, callback });
        return key;
    } catch (error) {
        handleLog(error, 'Utils', 'error', '🏠');
        return false;
    }
}

function unregisterObserver(key) {
    try {
        if (observerRegistry.has(key)) {
            const { observer, element } = observerRegistry.get(key);
            observer.unobserve?.(element);
            observer.disconnect?.();
            observerRegistry.delete(key);
        }
    } catch (error) {
        handleLog(error, 'Utils', 'error', '🏠');
    }
}

function pauseObservers(type) {
    try {
        for (const [key, { observer, element, type: obsType }] of observerRegistry) {
            if (!type || type === obsType) observer.unobserve?.(element);
        }
    } catch (error) {
        handleLog(error, 'Utils', 'error', '🏠');
    }
}

function resumeObservers(type) {
    try {
        for (const [key, { observer, element, type: obsType }] of observerRegistry) {
            if (!type || type === obsType) {
                if (obsType === 'mutation') observer.observe(element, { childList: true, subtree: true });
                else if (obsType === 'intersection') observer.observe(element);
            }
        }
    } catch (error) {
        handleLog(error, 'Utils', 'error', '🏠');
    }
}

function getRegisteredObservers() { return observerRegistry; }

function observeDomChanges(selector, callback) {
    try {
        if (!selector || typeof callback !== 'function') return null;
        const observer = new MutationObserver((mutations) => {
            let shouldTrigger = false;
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    if (node.matches(selector) || node.querySelector(selector)) {
                        shouldTrigger = true; break;
                    }
                }
                if (shouldTrigger) break;
            }
            if (shouldTrigger) callback();
        });
        observer.observe(document.body, { childList: true, subtree: true });
        return registerObserver(observer, document.body, 'mutation', null);
    } catch (error) {
        handleLog(error, 'Utils', 'error', '🏠');
        return null;
    }
}

// ==================================================================================
// 4. FORMATTING & HELPERS
// ==================================================================================

function formatDate(dateString) {
    try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        const options = { year: 'numeric', month: 'short', day: 'numeric' };
        return new Intl.DateTimeFormat(navigator.language || 'es-ES', options).format(date);
    } catch (error) {
        handleLog(error, 'Utils:Date', 'error', '🏠');
        return '';
    }
}

function getTimeAgo(timestamp) {
    try {
        const now = new Date();
        const commentDate = new Date(timestamp);
        if (isNaN(commentDate.getTime())) return '{{justNow}}';
        const diff = now - commentDate;
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        if (minutes < 1) return '{{justNow}}';
        if (minutes < 60) return `${minutes} {{minutesAgo}}`;
        if (hours < 24) return `${hours} {{hoursAgo}}`;
        return `${days} ${days === 1 ? '{{dayAgo}}' : '{{daysAgo}}'}`;
    } catch (error) {
        handleLog(error, 'Utils:Time', 'error', '🏠');
        return '{{justNow}}';
    }
}

function startTimeout(callback, time) {
    try {
        return setTimeout(() => {
            try { callback(); } catch (error) { handleLog(error, 'Utils:Timeout', 'error', '🏠'); }
        }, time);
    } catch (error) {
        handleLog(error, 'Utils:Timeout', 'error', '🏠');
        return null;
    }
}

function cancelTimeout(timeoutId) {
    try { if (timeoutId) clearTimeout(timeoutId); } catch (error) { handleLog(error, 'Utils:Timeout', 'error', '🏠'); }
}

function debounce(func, delay, immediate = false) {
    let timeoutId;
    return function(...args) {
        const context = this;
        const later = function() {
            timeoutId = null;
            if (!immediate) func.apply(context, args);
        };
        const callNow = immediate && !timeoutId;
        clearTimeout(timeoutId);
        timeoutId = setTimeout(later, delay);
        if (callNow) func.apply(context, args);
    };
}

function setStatsCache(stat) {
    try { if (stat && stat.entity) postStatsCache.set(stat.entity, stat.config); } catch (error) { handleLog(error, 'Utils:Cache', 'error', '🏠'); }
}

function getConfig(entityId) {
    try { return postStatsCache.get(entityId) || null; } catch (error) { handleLog(error, 'Utils:Cache', 'error', '🏠'); return null; }
}

function setInputLimit(limits = null) {
    try {
        const inputElement = UiModule.getCommentInputUI();
        if (inputElement) {
            let baseLimit = limits;
            if (!baseLimit) {
                const entityId = inputElement.closest('[data-threads-entity]')?.getAttribute('data-threads-entity');
                if (entityId) {
                    const config = getConfig(entityId);
                    baseLimit = config?.limits?.comment_text || 200;
                } else {
                    baseLimit = 200;
                }
            }
            const finalLimit = CoreModule.applyModifiers('comment_text_limit', baseLimit);
            inputElement.setAttribute('maxlength', finalLimit);
        }
    } catch (error) {
        handleLog(error, 'Utils:Limit', 'error', '🏠');
    }
}

function formatNumberAbbreviated(number) {
    if (number >= 1000000) return (number / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    else if (number >= 1000) return (number / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    else return number.toString();
}

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getCurrentScriptPath() {
    try {
        if (document.currentScript && document.currentScript.src) {
            const src = document.currentScript.src;
            return src.substring(0, src.lastIndexOf('/') + 1);
        }

        const scripts = document.getElementsByTagName('script');
        for (let i = scripts.length - 1; i >= 0; i--) {
            const script = scripts[i];
            if (!script.src) continue;
            
            const cleanSrc = script.src.split('?')[0];
            if (cleanSrc.endsWith('quelora.js') || cleanSrc.endsWith('quelora.min.js')) {
                return script.src.substring(0, script.src.lastIndexOf('/') + 1);
            }
        }
        return '';
    } catch (error) {
        handleLog(error, 'Utils:Path', 'error', '🏠');
        return '';
    }
}

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// ==================================================================================
// 5. EDITABLE DIV & INPUT LOGIC
// ==================================================================================

/**
 * Module-level registry that maps a GIF ID (UUID string) to the original {@link File}
 * object delivered by the browser's `beforeinput` event. Entries are created inside
 * {@link makeEditableDivInput} when `allowGif` is `true` and are removed — and their
 * corresponding Object URLs revoked — by {@link extractGifsFromEditable}.
 *
 * Using a module-level Map (rather than a WeakMap keyed on the element) allows
 * {@link extractGifsFromEditable} to be called from any context without holding a
 * reference to the editable element itself.
 *
 * @type {Map<string, File>}
 */
const _gifRegistry = new Map();

/**
 * Instruments a `contenteditable` element to behave like a capped `<input>`,
 * with full compatibility for WordPress environments where
 * `wp-emoji-release.min.js` replaces Unicode emoji characters with
 * `<img class="emoji" alt="\u2026">` nodes via a MutationObserver,
 * and with opt-in support for animated GIF insertion from Gboard and system keyboards.
 *
 * ## WordPress emoji compatibility (FIX 1 & FIX 2 — unchanged)
 *
 * FIX 1 — cursor positioning after emoji insertion (`setCaret`):
 *   Walks child nodes treating Text nodes character-by-character and Element nodes
 *   (WP emoji `<img>`) as one logical character each, placing the caret correctly
 *   regardless of node type.
 *
 * FIX 2 — emoji loss on max-length enforcement (`input` listener):
 *   Length is measured via `getCleanInputText`, which converts WP emoji `<img>` nodes
 *   back to their Unicode characters before counting. GIF preview nodes are stripped
 *   entirely and count as zero characters.
 *
 * ## Gboard GIF support (`options.allowGif = true`)
 *
 * When enabled, the element listens for `beforeinput` events with
 * `inputType === 'insertContent'`. Gboard (and other mobile keyboards) deliver
 * animated GIFs through this path, placing a `File` object of type `image/gif` or
 * `image/webp` in `e.dataTransfer.items`.
 *
 * On detection the default browser behaviour is cancelled and the GIF is:
 *   1. Registered in `_gifRegistry` under a UUID key.
 *   2. Rendered as an `<img class="ql-gif-preview" data-gif-id="<uuid>">` element
 *      inserted at the current caret position with `contenteditable="false"` to
 *      prevent the browser from treating it as editable text.
 *   3. Displayed via an Object URL that is revoked when
 *      {@link extractGifsFromEditable} is called (typically at submit time).
 *
 * GIF nodes are **transparent to the character counter**: `getCleanInputText`
 * strips all `[data-gif-id]` images before measuring, so inserting a GIF never
 * consumes any of the `maxlength` budget. The `setCaret` and `getCaretLogicalPos`
 * helpers also skip GIF nodes so that text-caret navigation remains accurate.
 *
 * When a text clamp is required while GIF nodes are present, the GIF nodes are
 * preserved and re-appended after the text reset, ensuring that animated images
 * survive the enforcement cycle.
 *
 * @param {HTMLElement|string} editable - The `contenteditable` element or its `id`.
 * @param {Object}             [options={}]          - Optional configuration.
 * @param {boolean}            [options.allowGif=false] - When `true`, intercepts
 *   Gboard `beforeinput` events and inserts GIFs as preview nodes that are excluded
 *   from the character count. Call {@link extractGifsFromEditable} at submit time
 *   to retrieve the `File` objects and revoke their Object URLs.
 */
const makeEditableDivInput = (editable, options = {}) => {
    if (typeof editable === 'string') editable = document.getElementById(editable);
    if (!editable) return;
    if (!editable.style.whiteSpace) editable.style.whiteSpace = 'pre-wrap';

    const { allowGif = false } = options;

    /** @returns {number} Hard character cap, or -1 when uncapped. */
    const getMaxLength = () => {
        const max = parseInt(editable.getAttribute('maxlength'));
        return isNaN(max) ? -1 : max;
    };

    /**
     * Returns `true` when `node` is a GIF preview element inserted by this module.
     * GIF nodes are excluded from all logical-character measurements and caret math.
     *
     * @param {Node} node - Any child node of the editable element.
     * @returns {boolean}
     */
    const isGifNode = (node) =>
        node.nodeType !== Node.TEXT_NODE &&
        /** @type {Element} */ (node).getAttribute?.('data-gif-id') != null;

    /**
     * Returns the logical character length of the editable's current content.
     * WP emoji `<img>` nodes each count as one character (their `alt` value).
     * GIF preview nodes count as zero characters.
     *
     * @returns {number}
     */
    const getLogicalLength = () => getCleanInputText(editable).length;

    /**
     * Positions the caret at logical character offset `pos` inside the editable.
     *
     * Walks child nodes treating Text nodes character-by-character, WP emoji
     * `<img>` elements as one logical character each, and GIF preview nodes as
     * zero characters (transparent). The caret always lands to the RIGHT of the
     * last inserted character regardless of node type.
     *
     * @param {number} pos - Logical character index (0-based).
     */
    const setCaret = (pos) => {
        const sel = window.getSelection();
        if (!sel) return;

        const range = document.createRange();
        let remaining = Math.max(0, pos);
        let placed = false;

        for (const node of Array.from(editable.childNodes)) {
            if (placed) break;
            if (isGifNode(node)) continue;

            if (node.nodeType === Node.TEXT_NODE) {
                const len = node.textContent.length;
                if (remaining <= len) {
                    range.setStart(node, remaining);
                    range.collapse(true);
                    placed = true;
                } else {
                    remaining -= len;
                }
            } else {
                if (remaining === 0) {
                    range.setStartBefore(node);
                    range.collapse(true);
                    placed = true;
                } else {
                    remaining -= 1;
                }
            }
        }

        if (!placed) {
            range.selectNodeContents(editable);
            range.collapse(false);
        }

        sel.removeAllRanges();
        sel.addRange(range);
    };

    /**
     * Returns the logical caret position within the editable.
     * WP emoji `<img>` nodes count as one character each.
     * GIF preview nodes are skipped and contribute zero to the offset.
     *
     * @returns {number}
     */
    const getCaretLogicalPos = () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return getLogicalLength();

        const range = sel.getRangeAt(0);
        let pos = 0;

        for (const node of Array.from(editable.childNodes)) {
            if (isGifNode(node)) continue;

            if (node === range.startContainer) {
                pos += range.startOffset;
                break;
            }
            if (node.contains && node.contains(range.startContainer)) {
                pos += range.startOffset;
                break;
            }
            pos += node.nodeType === Node.TEXT_NODE ? node.textContent.length : 1;
        }

        return pos;
    };

    editable.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain') || '';
        const maxLength = getMaxLength();
        const currentLen = getLogicalLength();
        const allowed = maxLength >= 0 ? text.substring(0, maxLength - currentLen) : text;
        if (!allowed) return;

        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(document.createTextNode(allowed));
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
        } else {
            editable.textContent += allowed;
        }
        editable.dispatchEvent(new Event('input', { bubbles: true }));
    });

    editable.addEventListener('input', () => {
        const maxLength = getMaxLength();
        if (maxLength < 0) return;

        const logicalText = getCleanInputText(editable);
        if (logicalText.length <= maxLength) return;

        const caretBefore = getCaretLogicalPos();
        const clamped = logicalText.substring(0, maxLength);

        if (allowGif) {
            // Preserve GIF preview nodes across the text reset so that animated
            // images inserted by the user survive a character-limit enforcement cycle.
            const gifNodes = Array.from(editable.querySelectorAll('img[data-gif-id]'))
                .map(n => n.cloneNode(true));
            editable.textContent = clamped;
            gifNodes.forEach(n => editable.appendChild(n));
        } else {
            editable.textContent = clamped;
        }

        setCaret(Math.min(caretBefore, clamped.length));
    });

    if (allowGif) {
        editable.addEventListener('beforeinput', (e) => {
            if (e.inputType !== 'insertContent' || !e.dataTransfer) return;

            const items = Array.from(e.dataTransfer.items || []);
            const gifItem = items.find(
                item => item.kind === 'file' &&
                        (item.type === 'image/gif' || item.type === 'image/webp')
            );

            if (!gifItem) return;
            e.preventDefault();

            const file = gifItem.getAsFile();
            if (!file) return;

            const gifId = generateUUID();
            const objectUrl = URL.createObjectURL(file);
            _gifRegistry.set(gifId, file);

            const img = document.createElement('img');
            img.className = 'ql-gif-preview';
            img.setAttribute('data-gif-id', gifId);
            img.setAttribute('contenteditable', 'false');
            img.src = objectUrl;

            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                range.deleteContents();
                range.insertNode(img);
                range.setStartAfter(img);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            } else {
                editable.appendChild(img);
            }

            editable.dispatchEvent(new Event('input', { bubbles: true }));

            handleLog(
                `GIF inserted: id=${gifId} type=${file.type} size=${file.size}`,
                'Utils:GIF',
                'log',
                '🏠'
            );
        });
    }
};

// ==================================================================================
// 5b. GIF EXTRACTION
// ==================================================================================

/**
 * Extracts all GIF preview nodes from a `contenteditable` element, revokes their
 * Object URLs, clears their entries from the internal registry, and returns the
 * original `File` objects to the caller.
 *
 * Intended to be called at **submit time** — immediately before the comment payload
 * is sent — so the caller can upload the GIF files independently and attach the
 * resulting URLs to the comment body. After this call, all Object URLs previously
 * used by preview `<img>` nodes are invalid.
 *
 * If `allowGif` was `false` when the element was instrumented, no `[data-gif-id]`
 * nodes will be present and this function returns an empty array without side-effects.
 *
 * @param {HTMLElement} element - The instrumented `contenteditable` element.
 * @returns {Array<{id: string, file: File|null, objectUrl: string}>} An array where
 *   each entry describes one GIF that was embedded in the editable:
 *   - `id`        — The UUID assigned at insertion time.
 *   - `file`      — The original `File` object from the keyboard event, or `null`
 *                   if the registry entry was already removed.
 *   - `objectUrl` — The revoked Object URL (kept for reference / logging only).
 */
function extractGifsFromEditable(element) {
    if (!element) return [];

    const imgs = Array.from(element.querySelectorAll('img[data-gif-id]'));

    return imgs.map(img => {
        const id        = img.getAttribute('data-gif-id');
        const objectUrl = img.src;
        const file      = _gifRegistry.get(id) || null;

        URL.revokeObjectURL(objectUrl);
        _gifRegistry.delete(id);
        img.remove();

        return { id, file, objectUrl };
    });
}

function getCountryOptions(currentCountry = '') {
    let options = `<option value="" class="t">{{selectCountry}}</option>`;
    for (const code in COUNTRIES) {
        const name = COUNTRIES[code];
        options += `<option value="${code}" ${code === currentCountry ? 'selected' : ''}>${name}</option>`;
    }
    return options;
}

function validatePasswordStrength(password) {
    const checks = {
        length: password.length >= 8,
        lower: /[a-z]/.test(password),
        upper: /[A-Z]/.test(password),
        special: /[^a-zA-Z0-9\s]/.test(password)
    };
    const strength = Object.values(checks).filter(Boolean).length;
    const isValid = strength === 4;
    return { isValid, strength, checks };
}

function getOrInitGuestId(hasToken) {
    if (hasToken) return null;
    let guestId = StorageModule.getLocalItem('ql_guest_id');
    if (!guestId) {
        guestId = crypto.randomUUID();
        StorageModule.setLocalItem('ql_guest_id', guestId);
    }
    return guestId;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
    return bytes.buffer;
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    
    return outputArray;
}

// ==================================================================================
// 6. P2P & SWARM SEGMENTATION
// ==================================================================================

/**
 * Determines the P2P Swarm Group based on User Country and Language.
 * Increases cache HIT rate by grouping culturally similar peers.
 * Strategy: LANGUAGE_REGION (e.g. "ES_LATAM", "EN_NA").
 * Uses COUNTRY_TO_REGION constants restored above.
 */
function getPeerGroup(countryCode, language) {
    try {
        const cc = (countryCode || 'XX').toUpperCase();
        const lang = (language || 'en').split('-')[0].toUpperCase();

        let region = COUNTRY_TO_REGION[cc] || 'GLOBAL';
        
        if (region.startsWith('LATAM')) region = 'LATAM';
        else if (region.startsWith('EUROPE')) region = 'EU';
        else if (region.startsWith('ASIA')) region = 'ASIA';
        else if (region === 'NORTH_AMERICA') region = 'NA';

        if (lang === 'ES') {
            if (region === 'LATAM') return 'ES_LATAM';
            if (region === 'EU') return 'ES_EU';
            return 'ES_GLOBAL';
        }

        if (lang === 'PT' && region === 'LATAM') return 'PT_LATAM';

        return `${lang}_${region}`;

    } catch (e) {
        return 'GLOBAL_FALLBACK';
    }
}

/**
 * Generates a SHA-1 InfoHash for P2P connection.
 * Combines the Trusted Key with the Swarm Group to segregate the network.
 *
 * @param {string} inputKey    - The base key for hash generation.
 * @param {string} groupSuffix - Optional suffix to namespace the hash by swarm group.
 * @returns {Promise<string|null>} The hex-encoded SHA-1 hash, or `null` on failure.
 */
async function generateInfoHash(inputKey, groupSuffix = '') {
    handleLog(`Generating InfoHash for: ${inputKey?.substring(0, 10)}... Group: ${groupSuffix}`, 'Utils:P2P', 'log', '🔐');
    if (!inputKey) return null;
    
    const str = groupSuffix ? `${inputKey}_${groupSuffix}` : String(inputKey);
    
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    handleLog(`InfoHash generated: ${hashHex}`, 'Utils:P2P', 'log', '🔐');
    return hashHex.toLowerCase();
}

// ==================================================================================
// 7. TEXT SANITIZATION & EXTRACTION
// ==================================================================================

/**
 * Detects and reverts WordPress emoji image tags back to their native Unicode characters.
 * This ensures that when the text is sent to the WASM parser, it doesn't get
 * purged as "Raw HTML".
 *
 * @param {string} html - The raw HTML from a contenteditable or input.
 * @returns {string} Clean text with native unicode emojis.
 */
function sanitizeWordPressEmojis(html) {
    if (!html) return '';
    return html.replace(/<img[^>]*class="[^"]*emoji[^"]*"[^>]*alt="([^"]+)"[^>]*>/g, '$1');
}

/**
 * Extracts clean, measurable text from an element, handling both standard inputs
 * and `contenteditable` divs while neutralizing WordPress emoji interference and
 * managing Quelora GIF preview nodes according to the call context.
 *
 * ## GIF preview node handling
 *
 * GIF preview nodes are `<img>` elements inserted by `GifPickerModule` when the
 * user selects a GIF from the picker panel.  They carry two data attributes:
 *
 * - `data-gif-id`       — UUID assigned to Gboard-sourced GIFs (legacy path).
 * - `data-giphy-id`     — Giphy ID for picker-sourced GIFs (new path).
 * - `data-giphy-notation` — the full `![GIF](giphy|<id>)` markdown string,
 *                           precomputed at insertion time.
 *
 * The `forSubmit` option controls how these nodes are resolved:
 *
 * - **`forSubmit: false`** (default) — both node types are stripped entirely so
 *   they contribute zero characters to the length count used by `ProgressInput`
 *   and the `maxlength` enforcement logic inside `makeEditableDivInput`.
 *
 * - **`forSubmit: true`** — Giphy picker nodes (`data-giphy-notation`) are
 *   replaced by their stored markdown notation so the WASM parser receives the
 *   `![GIF](giphy|<id>)` string it expects.  Gboard GIF nodes (`data-gif-id`
 *   without `data-giphy-notation`) are still stripped because their binary data
 *   is handled separately via `extractGifsFromEditable`.
 *
 * ## Processing order
 *
 *  1. Read raw content (`innerHTML` for contenteditable, `value` for inputs).
 *  2. Resolve or strip GIF nodes according to `forSubmit`.
 *  3. Convert WP emoji images (`<img class="emoji" alt="…">`) to their Unicode values.
 *  4. For contenteditable elements, resolve the resulting HTML to visible text via a
 *     temporary detached element so that `<br>` and block elements produce newlines.
 *
 * @param {HTMLElement}  element               - The input or contenteditable div element.
 * @param {Object}       [options={}]           - Optional configuration.
 * @param {boolean}      [options.forSubmit=false] - When `true`, Giphy preview nodes are
 *   replaced by their markdown notation instead of being stripped.
 * @returns {string} The processed plain text, suitable for length measurement or submission.
 */
function getCleanInputText(element, options = {}) {
    if (!element) return '';

    const { forSubmit = false } = options;

    let rawContent = element.isContentEditable ? element.innerHTML : element.value;

    if (forSubmit) {
        // Replace Giphy picker preview nodes with their stored markdown notation.
        // The notation is stored in `data-giphy-notation` at insertion time so no
        // string building is required here.
        rawContent = rawContent.replace(
            /<img[^>]*data-giphy-notation="([^"]*)"[^>]*>/g,
            (_, notation) => notation
        );
    }

    // Strip all remaining GIF preview nodes — Gboard-sourced ones (data-gif-id only)
    // are always excluded from logical text, and in forSubmit=false mode, Giphy nodes
    // that were not caught above are also removed.
    rawContent = rawContent.replace(/<img[^>]*data-gif-id="[^"]*"[^>]*>/g, '');
    rawContent = rawContent.replace(/<img[^>]*data-giphy-id="[^"]*"[^>]*>/g, '');

    let cleanContent = sanitizeWordPressEmojis(rawContent);

    if (element.isContentEditable) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = cleanContent;
        return tempDiv.innerText || tempDiv.textContent || '';
    }

    return cleanContent;
}

// ==================================================================================
// 7b. GIPHY PREVIEW HYDRATION
// ==================================================================================

/**
 * Regex that matches the Giphy markdown notation `![GIF](giphy|<id>)` embedded
 * in plain text.  Compiled once at module level to avoid repeated construction.
 *
 * - Group 1 captures the alphanumeric Giphy ID.
 * - The notation is the same format produced by `GifPickerModule` and accepted
 *   by `GIPHY_REGEX` in `lib.rs`.
 *
 * @type {RegExp}
 */
const GIPHY_NOTATION_REGEX = /!\[GIF\]\(giphy\|([a-zA-Z0-9]+)(?:\|[^)]*)?\)/g;

/**
 * Base CDN URL used to build the preview `src` for hydrated Giphy nodes.
 * Matches the URL pattern in `lib.rs::giphy_html`.
 *
 * @constant {string}
 */
const GIPHY_CDN_BASE = 'https://media.giphy.com/media';

/**
 * Converts any `![GIF](giphy|<id>)` notation present in a `contenteditable`
 * element's text content into visual preview nodes identical to those created
 * by `GifPickerModule._insertGifMarkdown`.
 *
 * ## When to call
 *
 * Call this function after loading server-stored text into an editable element
 * so the author sees animated previews rather than raw markdown notation.  The
 * primary consumer is the edit-comment modal in `CommentsUiModule.showEditCommentUI`,
 * where `originalText` is assigned via `editInput.textContent = originalText`.
 *
 * ## How it works
 *
 * 1. Reads `element.textContent` and scans it for `![GIF](giphy|<id>)` matches.
 * 2. Splits the text around each match and rebuilds `element` as a sequence of
 *    `Text` nodes (for surrounding text) and `<img>` preview nodes (for each GIF),
 *    replacing the element's children in a single pass.
 * 3. Each `<img>` node carries the same attributes as those produced by
 *    `GifPickerModule._insertGifMarkdown`:
 *    - `data-giphy-id`       — the alphanumeric Giphy ID
 *    - `data-giphy-notation` — the full `![GIF](giphy|<id>)` string for submit
 *    - `contenteditable="false"` — treated as an atomic non-editable element
 *    - `pointer-events: none` — does not interfere with text cursor
 * 4. `getCleanInputText({ forSubmit: true })` will reconstruct the notation from
 *    the `data-giphy-notation` attribute, so the edit submit path works identically
 *    to the new-comment submit path.
 *
 * If no notation is found the element is left untouched.
 *
 * @param {HTMLElement} element - The `contenteditable` element whose text content
 *   should be hydrated.  Non-contenteditable elements are accepted but the preview
 *   nodes will not be visually meaningful in a plain input/textarea.
 * @returns {void}
 */
function hydrateGiphyPreviews(element) {
    if (!element) return;

    const raw = element.textContent || '';
    if (!raw.includes('![GIF](giphy|')) return;

    // Reset the regex lastIndex before each use (global flag).
    GIPHY_NOTATION_REGEX.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let match;

    GIPHY_NOTATION_REGEX.lastIndex = 0;

    while ((match = GIPHY_NOTATION_REGEX.exec(raw)) !== null) {
        const notation = match[0];
        const gifId    = match[1];
        const matchStart = match.index;

        // Text node for the content before this match.
        if (matchStart > lastIndex) {
            fragment.appendChild(
                document.createTextNode(raw.slice(lastIndex, matchStart))
            );
        }

        // Preview node — mirrors GifPickerModule._insertGifMarkdown exactly.
        const img = document.createElement('img');
        img.src = `${GIPHY_CDN_BASE}/${gifId}/giphy.gif`;
        img.alt = 'GIF';
        img.className = 'ql-gif-preview';
        img.setAttribute('contenteditable', 'false');
        img.setAttribute('data-giphy-id', gifId);
        img.setAttribute('data-giphy-notation', notation);
        img.style.cssText = 'max-width:100%;height:auto;display:block;border-radius:8px;pointer-events:none;';

        fragment.appendChild(img);
        lastIndex = matchStart + notation.length;
    }

    // Remaining text after the last match.
    if (lastIndex < raw.length) {
        fragment.appendChild(document.createTextNode(raw.slice(lastIndex)));
    }

    element.replaceChildren(fragment);
}

// ==================================================================================
// MODULE EXPORT
// ==================================================================================

const UtilsModule = {
    sanitizeWordPressEmojis,
    getCleanInputText,
    hydrateGiphyPreviews,
    extractGifsFromEditable,
    getGeoLatencyFactor,
    getOrInitGuestId,
    getTimeAgo,
    startTimeout,
    arrayBufferToBase64,
    base64ToArrayBuffer,
    urlBase64ToUint8Array,
    cancelTimeout,
    observeDomChanges,
    getConfig,
    setStatsCache,
    setInputLimit,
    formatDate,
    formatNumberAbbreviated,
    wait,
    getCurrentScriptPath,
    debounce,
    isMobile,
    makeEditableDivInput,
    registerObserver,
    unregisterObserver,
    pauseObservers,
    resumeObservers,
    getRegisteredObservers,
    validatePasswordStrength,
    getCountryOptions,
    generateUUID,
    getPeerGroup,
    generateInfoHash
};

export default UtilsModule;