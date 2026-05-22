/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/ui/components/emoji.js */
/**
 * @module UI/Components/Emoji
 * @description Emoji picker controller with full WordPress compatibility.
 *
 * WordPress compatibility strategy:
 * `wp-emoji-release.min.js` uses a MutationObserver on `document.body` to intercept
 * any Unicode emoji character inserted into the DOM and replace the surrounding text
 * node with an `<img class="emoji" alt="..." src="...">` element. This breaks two
 * independent flows that this module addresses:
 *
 * 1. Static picker bar (`ql-emoji-picker-container`): WP converts button inner-text
 *    emojis to `<img>` tags, making `textContent` return an empty string on click.
 *    Fix: store the emoji character in a `data-emoji` attribute and read that instead
 *    of `textContent`. Attributes are never touched by WP's observer.
 *
 * 2. EmojiMart full picker (`ql-picker-container`): after `insertEmojiIntoTarget`
 *    inserts a Unicode text node into a `contenteditable`, WP's observer immediately
 *    replaces it with `<img class="emoji" alt="🔥" ...>`. When the comment is later
 *    serialised for the network request the `<img>` is present instead of the Unicode
 *    character and the server either rejects it or stores garbage.
 *    Fix: after insertion, run `_extractTextFromNode` on the input which walks the
 *    DOM, converts every `img.emoji[alt]` back to its `alt` value (the original Unicode
 *    character), and rebuilds a clean Unicode text node — keeping WP visually happy
 *    (it will re-apply its transforms on the next mutation) while ensuring the data
 *    layer always operates on plain Unicode strings.
 *
 * The public helper `getCleanText(element)` is exported so that the comment-send path
 * can call it right before reading the input value, independently of this module's
 * internal insertion logic.
 *
 * @version 5.0.0
 */
import UiModule from '../ui.js';

// =============================================================================
// MODULE STATE
// =============================================================================

/** @type {HTMLElement|null} Container element for the EmojiMart full picker. */
let pickerContainer = null;

/**
 * Cached cursor range restored after focus moves to the picker's Shadow DOM.
 * @type {Range|null}
 */
let savedRange = null;

/**
 * Whether the current page includes `wp-emoji-release.min.js`.
 * Detected once at module load so every hot path avoids repeated DOM queries.
 * @type {boolean}
 */
const _isWordPress = (() => {
    try {
        return Array.from(document.querySelectorAll('script[src]')).some(
            (s) => s.src.includes('wp-emoji-release')
        );
    } catch {
        return false;
    }
})();

// =============================================================================
// PRIVATE — SELECTION TRACKING
// =============================================================================

/**
 * Persists the active cursor range whenever the selection changes inside a valid
 * editable element. Selections inside the picker itself are deliberately ignored
 * so that opening the picker does not overwrite the last known caret position.
 */
document.addEventListener('selectionchange', () => {
    try {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;

        const range = selection.getRangeAt(0);
        const container = range.commonAncestorContainer;
        const element =
            container.nodeType === Node.TEXT_NODE ? container.parentNode : container;

        if (
            element.closest('.ql-emoji-picker-container') ||
            element.closest('.emoji-mart') ||
            element.closest('.emoji-button')
        ) {
            return;
        }

        const activeEl = document.activeElement;
        if (
            activeEl &&
            (activeEl.isContentEditable ||
                activeEl.tagName === 'INPUT' ||
                activeEl.tagName === 'TEXTAREA')
        ) {
            savedRange = range.cloneRange();
        }
    } catch {
        // Selection APIs can throw in cross-origin frames — silently ignore.
    }
});

// =============================================================================
// PRIVATE — WORDPRESS SANITISATION
// =============================================================================

/**
 * Walks the child nodes of `element` and rebuilds a plain Unicode string by
 * converting any `<img class="emoji" alt="…">` element back to its `alt` value.
 *
 * WordPress replaces Unicode emoji characters with `<img>` tags via its
 * MutationObserver. The `alt` attribute always contains the original Unicode
 * character(s), making it the authoritative source for round-tripping the text.
 *
 * This function is intentionally non-destructive: it reads the DOM without
 * mutating it, so WordPress's visual representation is preserved.
 *
 * @param {HTMLElement} element - The editable element to extract text from.
 * @returns {string} Plain Unicode text with emoji characters restored.
 */
function getCleanText(element) {
    if (!element) return '';

    if (!_isWordPress) {
        return element.isContentEditable
            ? (element.innerText ?? element.textContent ?? '')
            : element.value ?? '';
    }

    if (!element.isContentEditable) {
        return element.value ?? '';
    }

    let result = '';
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
            return;
        }
        if (
            node.nodeType === Node.ELEMENT_NODE &&
            node.tagName === 'IMG' &&
            node.classList.contains('emoji') &&
            node.alt
        ) {
            result += node.alt;
            return;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
            const display = window.getComputedStyle(node).display;
            const isBlock = display === 'block' || display === 'flex' || display === 'grid';
            node.childNodes.forEach(walk);
            if (isBlock && result.length > 0 && !result.endsWith('\n')) {
                result += '\n';
            }
        }
    };

    element.childNodes.forEach(walk);
    return result.trim();
}

// =============================================================================
// PRIVATE — EMOJI INSERTION
// =============================================================================

/**
 * Inserts a Unicode emoji character into the target editable element.
 *
 * For `contenteditable` elements the function restores the cached Range before
 * inserting so the caret position survives the focus transfer to the picker.
 *
 * After insertion on WordPress, the inserted text node will be immediately
 * replaced by WP's MutationObserver with an `<img class="emoji">` element.
 * This is acceptable for the visual layer; `getCleanText` reverses the
 * transformation when the value is read for network transmission.
 *
 * @param {string} emojiChar - The Unicode emoji character to insert (e.g. `"😀"`).
 */
function _insertEmojiIntoTarget(emojiChar) {
    const inputId = pickerContainer?.dataset?.targetInputId;
    if (!inputId) return;

    const input = document.getElementById(inputId);
    if (!input) return;

    if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value =
            input.value.slice(0, start) + emojiChar + input.value.slice(end);
        const next = start + emojiChar.length;
        input.setSelectionRange(next, next);
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }

    if (input.isContentEditable) {
        input.focus();
        const selection = window.getSelection();
        if (!selection) return;

        selection.removeAllRanges();
        if (savedRange) {
            selection.addRange(savedRange);
        }

        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            range.deleteContents();
            const textNode = document.createTextNode(emojiChar);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.setEndAfter(textNode);
            selection.removeAllRanges();
            selection.addRange(range);
            savedRange = range.cloneRange();
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            input.textContent += emojiChar;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
}

// =============================================================================
// PRIVATE — PICKER LIFECYCLE
// =============================================================================

/**
 * Dynamically loads the Emoji Mart browser bundle from the jsDelivr CDN.
 * Resolves once the global `EmojiMart` object is confirmed present.
 * On failure, hides all emoji trigger buttons so the UI remains consistent.
 *
 * @returns {Promise<void>}
 */
function loadEmojiMartScript() {
    return new Promise((resolve, reject) => {
        if (typeof EmojiMart !== 'undefined') {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src =
            'https://cdn.jsdelivr.net/npm/emoji-mart@latest/dist/browser.js';
        script.async = true;

        script.onload = () => {
            if (typeof EmojiMart !== 'undefined') {
                resolve();
            } else {
                reject(new Error('EmojiMart did not expose a global after load.'));
            }
        };

        script.onerror = () =>
            reject(new Error('Network error loading Emoji Mart script.'));

        document.head.appendChild(script);
    }).catch((error) => {
        _hideEmojiButtons();
        console.error(error.message, 'emoji-mart');
        throw error;
    });
}

/**
 * Hides all emoji trigger buttons in the document.
 * Called when Emoji Mart fails to load so stale buttons are not left visible.
 */
function _hideEmojiButtons() {
    document.querySelectorAll('.emoji-button').forEach((btn) => {
        btn.style.display = 'none';
    });
}

/**
 * Shows all emoji trigger buttons in the document.
 */
function _showEmojiButtons() {
    document.querySelectorAll('.emoji-button').forEach((btn) => {
        btn.style.display = 'block';
    });
}

/**
 * Instantiates a fresh Emoji Mart `Picker` and mounts it inside `pickerContainer`.
 * The theme is derived from the `data-theme` attribute on `<html>`.
 */
function _createPicker() {
    if (typeof EmojiMart === 'undefined') return;

    const theme =
        (document.getElementById('ql-theme-root') || document.documentElement).getAttribute('data-theme') === 'dark'
            ? 'dark'
            : 'light';

    const picker = new EmojiMart.Picker({
        locale: 'es',
        searchPosition: 'none',
        previewPosition: 'none',
        theme,
        onEmojiSelect: (emoji) => _insertEmojiIntoTarget(emoji.native),
    });

    pickerContainer.innerHTML = '';
    pickerContainer.appendChild(picker);
}

/**
 * Repositions `pickerContainer` so it remains fully visible within the viewport,
 * preferring to appear above the trigger button and centering horizontally.
 *
 * Uses `position: fixed` coordinates to avoid issues with scrolled containers or
 * drawers that establish their own stacking context.
 *
 * @param {HTMLElement} button - The emoji trigger button that was activated.
 */
function _adjustPickerPosition(button) {
    const MARGIN = 10;
    const buttonRect = button.getBoundingClientRect();

    pickerContainer.style.position = 'fixed';
    pickerContainer.style.zIndex = '10000';

    const pickerRect = pickerContainer.getBoundingClientRect();

    let top = buttonRect.top - pickerRect.height - MARGIN;

    if (top < MARGIN) {
        const spaceBelow = window.innerHeight - buttonRect.bottom;
        top =
            spaceBelow > buttonRect.top
                ? buttonRect.bottom + MARGIN
                : MARGIN;
    }

    let left =
        buttonRect.left + buttonRect.width / 2 - pickerRect.width / 2;

    if (left + pickerRect.width > window.innerWidth) {
        left = window.innerWidth - pickerRect.width - MARGIN;
    }
    if (left < MARGIN) left = MARGIN;

    pickerContainer.style.top = `${top}px`;
    pickerContainer.style.left = `${left}px`;
}

// =============================================================================
// PUBLIC — SETUP
// =============================================================================

/**
 * Initialises the full Emoji Mart picker flow.
 *
 * Responsibilities:
 * - Retrieves the shared picker container from `UiModule`.
 * - Guards against Emoji Mart being absent (hides buttons gracefully).
 * - Mounts a `MutationObserver` to recreate the picker on theme changes.
 * - Delegates click handling on `.emoji-button` elements to open/close the picker
 *   and continuously tracks its position while open.
 * - Registers global close triggers (outside click, Escape key, window resize).
 *
 * Must be called after `loadEmojiMartScript` resolves.
 */
function setupEmojiPicker() {
    pickerContainer = UiModule.getPickerContainerUI();

    if (typeof EmojiMart === 'undefined') {
        _hideEmojiButtons();
        return;
    }

    _showEmojiButtons();
    _createPicker();

    const themeObserver = new MutationObserver((mutations) => {
        if (mutations.some((m) => m.attributeName === 'data-theme')) {
            _createPicker();
        }
    });
    themeObserver.observe(document.getElementById('ql-theme-root') || document.documentElement, { attributes: true });

    document.addEventListener('click', (event) => {
        const button = event.target.closest('.emoji-button');
        if (!button) return;

        event.preventDefault();
        event.stopPropagation();

        const targetInputId = button.getAttribute('data-target-id');
        const targetInput = document.getElementById(targetInputId);
        if (!targetInputId || !targetInput) return;

        const isAlreadyOpen =
            pickerContainer.style.display === 'block' &&
            pickerContainer.dataset.targetInputId === targetInputId;

        if (isAlreadyOpen) {
            pickerContainer.style.display = 'none';
            return;
        }

        pickerContainer.dataset.targetInputId = targetInputId;
        pickerContainer.style.opacity = '0';
        pickerContainer.style.display = 'block';
        _adjustPickerPosition(button);
        pickerContainer.style.opacity = '1';

        const intervalId = setInterval(() => {
            if (pickerContainer.style.display === 'none') {
                clearInterval(intervalId);
                return;
            }
            if (!document.body.contains(button) || button.offsetParent === null) {
                pickerContainer.style.display = 'none';
                clearInterval(intervalId);
                return;
            }
            _adjustPickerPosition(button);
        }, 100);
    });

    document.addEventListener('click', (event) => {
        if (
            !pickerContainer.contains(event.target) &&
            !event.target.closest('.emoji-button')
        ) {
            pickerContainer.style.display = 'none';
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            pickerContainer.style.display = 'none';
        }
    });

    window.addEventListener('resize', () => {
        if (pickerContainer.style.display === 'block') {
            pickerContainer.style.display = 'none';
        }
    });
}

// =============================================================================
// PUBLIC API
// =============================================================================

const EmojiModule = {
    loadEmojiMartScript,
    setupEmojiPicker,
    /**
     * Extracts clean Unicode text from an editable element, restoring any emoji
     * characters that WordPress may have replaced with `<img class="emoji">` nodes.
     *
     * Must be called by the comment-send path immediately before reading the input
     * value for network transmission.
     *
     * @type {(element: HTMLElement) => string}
     */
    getCleanText,
};

export default EmojiModule;