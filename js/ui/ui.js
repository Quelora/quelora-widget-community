/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/ui/ui.js */
/**
 * @module UI/Main
 * @description Central UI Controller.
 * Refactored to comply with strict modal encapsulation boundaries.
 * Version 6.1.0: Implemented Granular Offline Placeholder rendering, strict DOM injection, and Mention/Gif Orchestration.
 */

import UtilsModule from '../core/utils.js';
import ProgressInput from './components/progressInput.js';
import I18n from '../core/i18n.js';
import StorageModule from '../core/storage.js';
import ProfileModule from '../modules/profile/profile.js'; 
import CoreModule from '../core/core.js';
import * as Drawers from './drawers.js';
import { eventBus } from '../core/event.js';
import { 
    setupModalUI, 
    closeModalUI, 
    resetModalUI, 
    renderReportedUI,
    updateModalBodyUI,
    updateModalFooterUI
} from './modal.js';

// --- SUB-MODULES ---
import * as AudioPlayerUI from '../modules/features/audio.ui.js';
import InteractionUI from '../modules/posts/entity.ui.js'; 
import CommentsUiModule from '../modules/comments/comments.ui.js';
import * as NotificationUI from '../modules/notifications/notifications.ui.js';
import ProfileUiModule from '../modules/profile/profile.ui.js';
import handleLog from '../core/logs.js'; 

let cachedCommunityUI = null;
let cachedCommunityThreadsUI = null;
let cachedCommentInputUI = null;
let cachedLikesListUI = null;
let cachedPickerContainerUI = null;
let cachedSendButtonUI = null;
let cachedShareButtonUI = null;

let _ensureAppIsInitialized = () => Promise.resolve();

// =========================================
// 1. GENERIC UI HELPERS (Loaders, Spinners)
// =========================================

/**
 * Appends a standardized loading message or skeleton to a container.
 * @param {HTMLElement} container - Target container.
 * @param {Object} options - Configuration for the loader (type, position, empty, count).
 */
function addLoadingMessageUI(container, { type = 'message', position = 'after', empty = false, count = 1 } = {}) {
    if (!container) return handleLog('Container not found', 'UiModule.addLoadingMessageUI');
    if (empty) container.innerHTML = '';

    const skeletonLine = (w, h, m) => `<div class="ql-skeleton ql-skeleton-line" style="width:${w};height:${h};${m ? `margin-left:${m}` : ''}"></div>`;
    
    const templates = {
        message: `<div class="ql-loader"></div>{{loadingMessage}}`,
        profile: Array(count).fill(`
            <div class="ql-skeleton-message ql-thread">
                <div class="ql-thread__header" style="justify-content:left">
                    <div class="ql-avatar__image ql-skeleton ql-skeleton-avatar"></div>
                    ${skeletonLine('200px', '14px')}
                </div>
            </div>
        `).join(''),
        skeleton: Array(count).fill(`
            <div class="ql-skeleton-message ql-thread">
                <div class="ql-thread__header" style="justify-content:left">
                    <div class="ql-avatar__image ql-skeleton ql-skeleton-avatar"></div>
                    ${skeletonLine('200px', '14px')}
                </div>
                ${skeletonLine('32px', '16px', '47px')}
                ${skeletonLine('140px', '12px', '47px')}
            </div>
        `).join('')
    };

    const wrapper = document.createElement('div');
    wrapper.className = `ql-loading-message${type === 'message' ? ' t' : ''}`;
    wrapper.innerHTML = templates[type] || templates.message;

    if (position === 'before') {
        const firstChild = container.firstElementChild;
        if (firstChild && firstChild.classList.contains('ql-native-ad')) {
            container.insertBefore(wrapper, firstChild.nextElementSibling);
        } else {
            container.prepend(wrapper);
        }
    } else {
        container.append(wrapper);
    }
}

/**
 * Adds a full-screen spinner to the body. Used during critical async operations.
 */
function addGlobalSpinner() {
    if (document.getElementById('ql-global-spinner')) return;
    const spinner = createElementUI({
        tag: 'div',
        attributes: { id: 'ql-global-spinner' },
        innerHTML: '<div class="ql-loader"></div>'
    });
    (document.getElementById('ql-theme-root') || document.body).appendChild(spinner);
}

/**
 * Removes the global spinner if it exists.
 */
function removeGlobalSpinner() {
    const spinner = document.getElementById('ql-global-spinner');
    if (spinner) spinner.remove();
}

/**
 * Renders a temporary error message at the top of the threads container.
 * @param {string} message - The error message text.
 */
function renderErrorMessageUI(message) {
    const threadsContainer = getCommunityThreadsUI();
    if (!threadsContainer) return;

    threadsContainer.querySelector('.ql-loading-message')?.remove();
    
    const errorElement = createElementUI({
        tag: 'div',
        classes: 'comment-error-message',
        content: message,
        styles: { opacity: '0', transition: 'opacity 0.5s ease' }
    });
    
    threadsContainer.prepend(errorElement);
    requestAnimationFrame(() => errorElement.style.opacity = '1');
    
    UtilsModule.startTimeout(() => {
        errorElement.style.opacity = '0';
        errorElement.addEventListener('transitionend', () => errorElement.remove(), { once: true });
    }, 5000);
}

/**
 * Renders the Offline State (Cloud Icon).
 * If a targetId is provided, renders a granular, non-destructive placeholder in the replies container.
 * Otherwise, replaces the entire main threads container.
 * @param {string|null} [targetId=null] - The ID of the comment to target its replies container.
 */
function renderOfflinePlaceholder(targetId = null) {
    let container;
    let isGranular = false;

    if (targetId) {
        container = getCommentRepliesUI(targetId);
        isGranular = true;
    } else {
        container = getCommunityThreadsUI();
    }

    if (!container) return;

    container.innerHTML = '';

    const placeholder = document.createElement('div');
    
    if (isGranular) {
        placeholder.style.cssText = `
            display: flex; 
            flex-direction: row; 
            align-items: center; 
            justify-content: flex-start; 
            padding: 10px 15px;
            margin-top: 10px;
            border-radius: 8px;
            background-color: var(--ql-background-alt, rgba(128, 128, 128, 0.05));
            color: var(--ql-medium-gray-color);
            opacity: 0.9;
            font-size: 13px;
        `;
        placeholder.innerHTML = `
            <span class="ql-icons-outlined" style="font-size: 18px; margin-right: 8px;">cloud_off</span>
            <span class="t">{{contentUnavailableOffline}}</span>
        `;
    } else {
        placeholder.style.cssText = `
            display: flex; 
            flex-direction: column; 
            align-items: center; 
            justify-content: center; 
            height: 60vh; 
            width: 100%; 
            color: var(--ql-medium-gray-color);
            opacity: 0.7;
        `;

        placeholder.innerHTML = `
            <span class="ql-icons-outlined" style="font-size: 100px; width: 100px; height: 100px; display: flex; align-items: center; justify-content: center; margin-bottom: 10px;">cloud_off</span>
            <span class="t" style="font-size: 16px; text-align: center;">{{contentUnavailableOffline}}</span>
        `;
    }

    container.appendChild(placeholder);
    
    if (I18n && I18n.translateElement) {
        I18n.translateElement(placeholder);
    }
}

/**
 * Utility to create DOM elements with attributes, classes, and listeners in one go.
 */
function createElementUI({ tag, classes = [], attributes = {}, styles = {}, content = '', listeners = {}, children = [], translate = false, innerHTML }) {
    try {
        if (!tag || typeof tag !== 'string') return null;

        const element = document.createElement(tag);

        if (classes) {
            const classList = Array.isArray(classes) ? classes : classes.split(/\s+/).filter(Boolean);
            classList.forEach(cls => element.classList.add(cls));
            if (translate) element.classList.add('t');
        }

        Object.entries(attributes).forEach(([key, value]) => {
            if (value != null) element.setAttribute(key, value);
        });

        Object.assign(element.style, styles);

        if (innerHTML) {
            element.innerHTML = translate ? `{{${innerHTML}}}` : innerHTML;
        } else if (content) {
            if (Array.isArray(content)) {
                content.forEach(item => {
                    element.appendChild(item instanceof Node ? item : document.createTextNode(item));
                });
            } else {
                element.appendChild(content instanceof Node ? content : document.createTextNode(content));
            }
        }

        children.forEach(child => {
            if (child instanceof Node) element.appendChild(child);
        });

        Object.entries(listeners).forEach(([event, handler]) => {
            if (typeof handler === 'function') element.addEventListener(event, handler);
        });

        return element;
    } catch (error) {
        handleLog(error, `UiModule.createElementUI: ${tag}`);
        return null;
    }
}

// =========================================
// 2. LIST & SEARCH HELPERS
// =========================================

function filterListItemsUI(inputId, listSelector) {
    try {
        const searchInput = document.getElementById(inputId);
        const list = document.querySelector(listSelector);
        
        if (!searchInput || !list) return;
        if (searchInput.dataset.listenerAttached === 'true') return;
        
        searchInput.dataset.listenerAttached = 'true';

        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase();
            list.querySelectorAll('li').forEach(item => {
                const text = item.querySelector('.user-info')?.textContent.toLowerCase() || '';
                item.style.display = text.includes(searchTerm) ? '' : 'none';
            });
        });
    } catch (error) {
        handleLog(error, 'UiModule.filterListItemsUI');
    }
}

function filterListAccountUI() {
    try {
        const searchInput = document.getElementById('accounts-search');
        if (!searchInput || searchInput.dataset.listenerAttached === 'true') return;

        searchInput.dataset.listenerAttached = 'true';

        const handleSearch = async (e) => {
            const query = e.target.value.trim();
            const container = document.querySelector('.ql-account-request-list');
            if (!container) return;
            
            const ul = container.querySelector('ul');
            container.querySelector('.ql-empty-container')?.remove();

            if (query.length === 0) {
                await ProfileModule.renderSuggestions();
                return;
            }

            if (query.length > 0 && query.length < 4) {
                ul.innerHTML = '';
                ul.appendChild(createElementUI({ tag: 'div', classes: 'ql-empty-container t', content: '{{search_min_chars}}' }));
                return;
            }

            if (query.length >= 4) {
                addLoadingMessageUI(ul, { type: 'message', position: 'after', empty: true });
                await ProfileModule.fetchAccounts(query);
            }
        };

        const debouncedSearch = UtilsModule.debounce(handleSearch, 1000);
        searchInput.addEventListener('input', debouncedSearch);

        return () => {
            searchInput.removeEventListener('input', debouncedSearch);
            searchInput.dataset.listenerAttached = 'false';
        };
    } catch (error) {
        handleLog(error, 'UiModule.filterListAccountUI');
    }
}

// =========================================
// 3. INPUT & EMOJI
// =========================================

function createEmojiPickerBarUI() {
    if (document.querySelector('.ql-emoji-picker-container')) return;

    const container = createElementUI({
        tag: 'div',
        classes: 'ql-emoji-picker-container',
        attributes: { id: 'ql-emoji-picker-container' }
    });

    const emojis = ['😀','😂','😎','🥺','🔥','💯','👍','👎','❤️','😡','😱'];
    container.innerHTML = emojis.map(emoji => `<button class="ql-emoji-option" type="button" tabindex="-1" data-emoji="${emoji}">${emoji}</button>`).join('');

    const setupPicker = () => {
        container.addEventListener('pointerdown', (e) => {
            const btn = e.target.closest('.ql-emoji-option');
            if (!btn) return;

            e.preventDefault();
            e.stopImmediatePropagation();

            const emoji = btn.dataset.emoji;
            if (!emoji) return;

            const input = getCommentInputUI();
            const scrollY = window.scrollY;

            insertAtCursor(input, emoji);
            input.focus();

            setTimeout(() => window.scrollTo(0, scrollY), 0);
        });
    };

    UtilsModule.startTimeout(setupPicker, 50);
    CommentsUiModule.addElementHeaderUI(container, true);
}

function removeEmojiPickerBarUI(){
    const picker = document.getElementById('ql-emoji-picker-container');
    if (picker) picker.remove();
}

/**
 * Inserts `text` at the current caret position inside `inputElement`.
 *
 * WordPress compatibility — cursor positioning after emoji insertion:
 *
 * The naive approach (setStartAfter the inserted textNode) fails in WordPress
 * because `wp-emoji-release.min.js` runs a MutationObserver on document.body
 * that immediately replaces any Unicode emoji text-node with
 * `<img class="emoji" alt="...">`. This destroys the node our Range was
 * anchored to, and the browser repositions the caret BEFORE the new <img>.
 *
 * Fix: before inserting, register a short-lived MutationObserver on the
 * editable element itself. It fires synchronously after WP's observer runs,
 * detects the added <img class="emoji"> node, and calls setStartAfter(img)
 * to move the caret to the RIGHT of the image. The observer disconnects
 * itself immediately after the first matching mutation so it has zero ongoing
 * cost. On non-WordPress environments no <img class="emoji"> is ever added, the
 * observer fires on the text-node insertion, finds nothing to act on, and
 * disconnects — leaving the caret in the position set by setStartAfter(textNode).
 *
 * @param {HTMLElement} inputElement - The target editable element.
 * @param {string}      text        - The text to insert (typically a single emoji).
 */
function insertAtCursor(inputElement, text) {
    if (!inputElement) return;

    if (
        typeof inputElement.selectionStart === 'number' &&
        typeof inputElement.selectionEnd === 'number'
    ) {
        const start = inputElement.selectionStart;
        const end   = inputElement.selectionEnd;
        inputElement.value =
            inputElement.value.substring(0, start) +
            text +
            inputElement.value.substring(end);
        inputElement.selectionStart = inputElement.selectionEnd = start + text.length;
        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
        return;
    }

    if (inputElement.isContentEditable) {
        inputElement.focus();
        const selection = window.getSelection();
        if (!selection) return;

        let range;
        if (selection.rangeCount > 0) {
            range = selection.getRangeAt(0);
            range.deleteContents();
        } else {
            range = document.createRange();
            range.selectNodeContents(inputElement);
            range.collapse(false);
        }

        // Register a one-shot MutationObserver BEFORE inserting.
        // When WordPress's MutationObserver replaces our text-node with
        // <img class="emoji">, this observer fires next and moves the caret
        // to the right of the <img>. Disconnects immediately after one run.
        const caretObserver = new MutationObserver((mutations) => {
            caretObserver.disconnect();

            for (const mutation of mutations) {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (
                        node.nodeType === Node.ELEMENT_NODE &&
                        node.tagName === 'IMG' &&
                        node.classList.contains('emoji')
                    ) {
                        const r = document.createRange();
                        const sel = window.getSelection();
                        r.setStartAfter(node);
                        r.collapse(true);
                        sel.removeAllRanges();
                        sel.addRange(r);
                        return;
                    }
                }
            }
        });

        caretObserver.observe(inputElement, { childList: true, subtree: true });

        const textNode = document.createTextNode(text);
        range.insertNode(textNode);

        // Position caret after the text-node for non-WP environments.
        // In WP this will be overridden by the caretObserver above.
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

function insertTextIntoCommentInputUI(textToSend) {
    try {
        const commentInput = getCommentInputUI(); 
        if (!commentInput) return false;
        
        if (commentInput.isContentEditable) {
            commentInput.textContent = textToSend;
        } else {
            commentInput.value = textToSend;
        }
        
        ProgressInput("ql-input", "ql-input-bar");
        commentInput.focus();
        return true;
    } catch (error) {
        handleLog(error, 'UiModule.insertTextIntoCommentInputUI');
        return false;
    }
}

// =========================================
// 4. MAIN SHELL & SETTINGS UI
// =========================================

async function addProfileOptionUI() {
    try {
        const communityUI = getCommunityUI();
        if (!communityUI) return; 

        const profileButton = communityUI.querySelector('.general-settings');
        if (!profileButton) return;
        
        profileButton.classList.add('profile-button');
        profileButton.innerHTML = '<span class="ql-icons-outlined">settings</span>';
        profileButton.addEventListener('click', () => {
            import('../modules/profile/profile.js').then(m => {
                if (!m.default.isLogin()) {
                    Drawers.generalSettingsDrawerUI.open();
                }
            });
        });
    } catch (error) {
        handleLog(error, 'UiModule.addProfileOptionUI');
    }
}

async function setupSettingsOptions() {
    try {
        const { default: SessionModule } = await import('../core/session.js');
        SessionModule.mountDrawerLogin('#ql-settings-login-container');

        const settingsContainers = document.querySelectorAll('#ql-community-settings, #ql-community-general-settings');
        if (!settingsContainers.length) return;

        const applyTheme = (theme) => {
            const qlThemeRoot = document.getElementById('ql-theme-root');
            let actualTheme = theme;
            if (theme === 'system') {
                qlThemeRoot?.removeAttribute('data-theme');
                actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
            } else {
                qlThemeRoot?.setAttribute('data-theme', actualTheme);
            }
            StorageModule.setLocalItem('ql_theme', theme);

            settingsContainers.forEach(cnt => {
                const btns = {
                    light: cnt.querySelector('[data-theme="light"]'),
                    dark: cnt.querySelector('[data-theme="dark"]'),
                    system: cnt.querySelector('[data-theme="system"]')
                };
                Object.values(btns).forEach(btn => btn?.classList.remove('active'));
                btns[theme]?.classList.add('active');
            });
        };

        settingsContainers.forEach(settingsMenu => {
            const themeButtons = {
                light: settingsMenu.querySelector('[data-theme="light"]'),
                dark: settingsMenu.querySelector('[data-theme="dark"]'),
                system: settingsMenu.querySelector('[data-theme="system"]')
            };

            if (themeButtons.light && themeButtons.dark && themeButtons.system) {
                Object.keys(themeButtons).forEach(key => {
                    if (!themeButtons[key].dataset.listenerAttached) {
                        themeButtons[key].addEventListener('click', () => {
                            applyTheme(key);
                            if (ProfileModule.isLogin()) {
                                ProfileModule.updateSetting('settings.interface.defaultTheme', key);
                            }
                        });
                        themeButtons[key].dataset.listenerAttached = "true";
                    }
                });
            }

            const languageSelect = settingsMenu.querySelector('select[data-setting-action="language-change"]');
            if (languageSelect && !languageSelect.dataset.listenerAttached) {
                languageSelect.addEventListener('change', async () => {
                    const lang = languageSelect.value;
                    StorageModule.setLocalItem('ql_language', lang);
                    await I18n.changeLanguage(lang);
                    settingsContainers.forEach(menu => {
                        const select = menu.querySelector('select[data-setting-action="language-change"]');
                        if (select) select.value = lang;
                    });
                });
                languageSelect.dataset.listenerAttached = "true";
                
                const savedLanguage = StorageModule.getLocalItem('ql_language');
                if (savedLanguage) languageSelect.value = savedLanguage;
            }
        });

        const currentTheme = StorageModule.getLocalItem('ql_theme') || 'system';
        applyTheme(currentTheme);

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (StorageModule.getLocalItem('ql_theme') === 'system') applyTheme('system');
        });

    } catch (error) {
        handleLog(error, 'UiModule.setupSettingsOptions');
    }
}

// =========================================
// 5. CACHED GETTERS
// =========================================

const getCommunityUI = () => {
    if (!cachedCommunityUI) {
        cachedCommunityUI = Drawers.commentsDrawerUI?.element || document.querySelector('#ql-comments');
    }
    return cachedCommunityUI || document.querySelector('#ql-comments');
}

const getCommunityThreadsUI = () => {
    if (!cachedCommunityThreadsUI) {
        const ui = getCommunityUI();
        cachedCommunityThreadsUI = ui?.querySelector('.ql-community-threads');
    }
    return cachedCommunityThreadsUI || document.querySelector('#ql-comments .ql-community-threads');
}

const getCommentInputUI = () => {
    if (!cachedCommentInputUI) {
        const ui = getCommunityUI();
        cachedCommentInputUI = ui?.querySelector('#ql-input') || document.getElementById('ql-input');
    }
    return cachedCommentInputUI || document.getElementById('ql-input');
}

const getCommentRepliesUI = (replyId) => {
    return document.querySelector(`#ql-comments .ql-thread__replies[data-reply-id="${replyId}"]`);
}

const getLikesListUI = () => {
    if (!cachedLikesListUI) {
        cachedLikesListUI = Drawers.likesDrawerUI?.element?.querySelector('#ql-likes-list') || document.getElementById('ql-likes-list');
    }
    return cachedLikesListUI || document.getElementById('ql-likes-list');
}

const getPickerContainerUI = () => {
    if (!cachedPickerContainerUI) cachedPickerContainerUI = document.getElementById('ql-picker-container');
    return cachedPickerContainerUI || document.getElementById('ql-picker-container');
}

const getSendButtonUI = () => {
    if (!cachedSendButtonUI) {
        const ui = getCommunityUI();
        cachedSendButtonUI = ui?.querySelector('#ql-send') || document.getElementById('ql-send');
    }
    return cachedSendButtonUI;
}

const getShareButtonUI = () => {
    if (!cachedShareButtonUI) cachedShareButtonUI = document.getElementById('ql-share');
    return cachedShareButtonUI;
}

// =========================================
// 6. UNIFIED REPORT & BLOCK MODAL
// =========================================

/**
 * Shows the unified modal for reporting/blocking users.
 * Uses strict modal API boundaries without accessing internal structural caches.
 * @param {Object} options 
 * @param {Function} options.onConfirm - Callback executed with { reason, observation, blockUser }.
 */
function showReportModalUI({ onConfirm }) {
    const isOffline = CoreModule.isSystemOffline();
    const div = document.createElement('div');
    
    if (isOffline) {
        div.innerHTML = `
            <div class="report-content">
                <div class="ql-empty-container" style="color: var(--ql-warning-color); padding: 20px; text-align: center;">
                    <span class="ql-icons-outlined">cloud_off</span>
                    <span class="t">{{actionUnavailableOffline}}</span>
                </div>
            </div>`;
        setupModalUI(div.firstElementChild, '.ql-community-threads');
        
        const footerDiv = document.createElement('div');
        const closeBtn = document.createElement('button');
        closeBtn.className = 'ql-btn close-button';
        closeBtn.innerHTML = '<span class="ql-icons-outlined">close</span><span class="t">{{close}}</span>';
        closeBtn.onclick = () => closeModalUI();
        footerDiv.appendChild(closeBtn);
        updateModalFooterUI(footerDiv);
        return;
    }

    div.innerHTML = `
        <div class="report-content">
            <p class="t">{{reportReasonQuestion}}</p>
            <div class="adv t">{{anonymousReportWarning}}</div>
            
            <div class="report-options-list">
                ${['spam', 'abuse', 'offensive', 'political', 'other'].map(t => `<label class="report-option"><input type="radio" name="report_reason" value="${t}" style="display:none;" /><span class="t">{{${t}}}</span></label>`).join('')}
            </div>
            
            <div id="report-observation-container" style="display:none; position:relative; width: 100%; margin-bottom: 15px;">
                <textarea id="report-observation" class="comment-input report-observation" maxlength="300" style="display:block; margin-bottom: 0; min-height: 80px; width: 100%; box-sizing: border-box;"></textarea>
                <div id="report-observation-bar" class="progress-bar"></div>
            </div>
            
            <div class="block-user-container">
                <label for="block-user-checkbox" class="block-user-label">
                    <input type="checkbox" id="block-user-checkbox" />
                    <span class="t">{{hideAuthorContent}}</span>
                </label>
            </div>
        </div>`;
    
    const contentNode = div.firstElementChild;
    setupModalUI(contentNode, '.ql-community-threads', { closeOnBackdropClick: false });

    const options = contentNode.querySelectorAll('.report-option');
    const observationContainer = contentNode.querySelector('#report-observation-container');
    const textarea = contentNode.querySelector('#report-observation');
    
    ProgressInput('report-observation', 'report-observation-bar');

    const footerDiv = document.createElement('div');

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ql-btn close-button';
    cancelBtn.innerHTML = '<span class="ql-icons-outlined">close</span><span class="t">{{cancel}}</span>';
    cancelBtn.onclick = () => closeModalUI();

    const submitBtn = document.createElement('button');
    submitBtn.className = 'ql-btn report-button';
    submitBtn.innerHTML = '<span class="ql-icons-outlined">send</span><span class="t">{{send}}</span>';
    submitBtn.disabled = true;

    options.forEach(label => {
        label.addEventListener('click', (e) => {
            const radio = label.querySelector('input[type="radio"]');
            if (!radio) return;
            
            radio.checked = true;

            options.forEach(opt => opt.classList.remove('selected'));
            label.classList.add('selected');

            if (radio.value === 'other') {
                observationContainer.style.display = 'block';
                textarea.focus();
            } else {
                observationContainer.style.display = 'none';
                textarea.value = '';
                textarea.dispatchEvent(new Event('input'));
            }
            
            submitBtn.disabled = false;
        });
    });

    submitBtn.onclick = () => {
        const selectedRadio = contentNode.querySelector('input[name="report_reason"]:checked');
        if (!selectedRadio) return; 
        
        const selectedReason = selectedRadio.value;
        const observation = textarea.value.trim();
        const blockUser = contentNode.querySelector('#block-user-checkbox').checked;

        onConfirm({ reason: selectedReason, observation, blockUser });
        
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="ql-spinner ql-spinner--small"></span><span class="t">{{sending}}</span>';
        if (I18n && I18n.translateElement) {
            I18n.translateElement(submitBtn);
        }
    };

    footerDiv.appendChild(submitBtn);
    footerDiv.appendChild(cancelBtn);
    updateModalFooterUI(footerDiv);
}

// =========================================
// 7. INITIALIZATION
// =========================================

const initializeUILight = async (ensureAppFn) => {
     _ensureAppIsInitialized = ensureAppFn;
     addProfileOptionUI();
     setupSettingsOptions();
     ProfileUiModule.createProfileDropupUI();
     filterListAccountUI();
     filterListItemsUI('likes-search', '#ql-likes-list');
};

const initializeUI = async () => {
    try {
        filterListItemsUI('likes-search', '#ql-likes-list');
        addProfileOptionUI();
        setupSettingsOptions();
        ProfileUiModule.createProfileDropupUI();
        filterListAccountUI();

        // --- MENTION & GIF ORCHESTRATION ---
        eventBus.on('MENTION_OPENED', () => {
            import('./components/gif.js').then(m => {
                if (m.default && m.default.isOpen()) m.default.close();
            }).catch(() => {});
            const emojiPicker = document.getElementById('ql-emoji-picker-container');
            if (emojiPicker) emojiPicker.style.display = 'none';
        });

        eventBus.on('MENTION_CLOSED', () => {
            import('./components/gif.js').then(m => {
                if (!m.default || !m.default.isOpen()) {
                    const emojiPicker = document.getElementById('ql-emoji-picker-container');
                    if (emojiPicker) emojiPicker.style.display = '';
                }
            }).catch(() => {});
        });

        eventBus.on('GIF_PICKER_OPENED', () => {
            const mentionBox = document.querySelector('.mention-suggestions');
            if (mentionBox) {
                mentionBox.remove();
            }
            const emojiPicker = document.getElementById('ql-emoji-picker-container');
            if (emojiPicker) emojiPicker.style.display = 'none';
        });

        eventBus.on('GIF_PICKER_CLOSED', () => {
            const mentionBox = document.querySelector('.mention-suggestions');
            if (!mentionBox) {
                const emojiPicker = document.getElementById('ql-emoji-picker-container');
                if (emojiPicker) emojiPicker.style.display = '';
            }
        });

        // --- PROFILE & SESSION EVENTS ---
        eventBus.on('USER_PROFILE_UPDATED', (profile) => {
            if (!profile) return;
            ProfileUiModule.updateNavbarAvatarUI({ profile });
            ProfileUiModule.updateProfileUI(profile);
        });
        
        eventBus.on('SESSION_CLEARED', () => {
            const profileContainer = document.getElementById('ql-profile');
            if (profileContainer) delete profileContainer.dataset.initialized;
        });

        if (Drawers.settingsDrawerUI) {
            Drawers.settingsDrawerUI.on('open', ProfileModule.updateProfileSettingsUI);
        }
        if (Drawers.generalSettingsDrawerUI) {
            Drawers.generalSettingsDrawerUI.on('open', ProfileModule.updateProfileSettingsUI);
        }
        if (Drawers.searchFollowRequestDrawerUI) {
            Drawers.searchFollowRequestDrawerUI.on('open', () => {
                const searchInput = document.getElementById('accounts-search');
                if (searchInput && searchInput.value.trim() === '') {
                    ProfileModule.renderSuggestions();
                }
            });
        }
        
        if (Drawers.profileDrawerUI) {
            Drawers.profileDrawerUI.on('open', async () => {
                const container = document.getElementById('ql-profile');
                if (!container) return;

                if (container.dataset.initialized === 'true') return;

                const isEmpty = !container.children.length || 
                                container.querySelector('.ql-empty-container') || 
                                container.innerHTML.trim() === '';
                
                if (isEmpty) {
                     container.dataset.initialized = 'true';
                     
                     ProfileUiModule.addProfileSkeletonUI();
                     const ownProfile = await ProfileModule.getOwnProfile(false);
                     
                     if (ownProfile && ownProfile.author) {
                         ProfileModule.getProfile(ownProfile.author);
                     } else {
                         ProfileModule.getOwnProfile(true);
                     }
                }
            });
        }

    } catch (error) {
        handleLog(error, 'UiModule.initializeUI');
    }
};

const UiModule = {
    createElementUI,
    getCommentHeaderUI: CommentsUiModule.getCommentHeaderUI || ProfileUiModule.getCommentHeaderUI,
    getCommunityThreadsUI,
    getCommunityUI,
    getCommentRepliesUI,
    getCommentInputUI,
    getPickerContainerUI,
    getSendButtonUI,
    getLikesListUI,
    getShareButtonUI,
    
    getEntityInteractionUI: InteractionUI.getEntityInteractionUI,
    getCounterFromDOMUI: InteractionUI.getCounterFromDOMUI, 
    
    addProfileSkeletonUI: ProfileUiModule.addProfileSkeletonUI,
    createProfileDropupUI: ProfileUiModule.createProfileDropupUI,
    updateProfileUI: ProfileUiModule.updateProfileUI,
    getProfileContainerUI: ProfileUiModule.getProfileContainerUI,
    
    addLoadingMessageUI,
    addGlobalSpinner,
    removeGlobalSpinner,
    renderErrorMessageUI,
    renderOfflinePlaceholder,
    setupModalUI,
    closeModalUI,
    resetModalUI,
    renderReportedUI,
    updateModalBodyUI,
    updateModalFooterUI,
    
    filterListItemsUI,
    addProfileOptionUI,
    createEmojiPickerBarUI,
    removeEmojiPickerBarUI,
    insertTextIntoCommentInputUI,
    showReportModalUI,
    
    ...Drawers,
    ...AudioPlayerUI,
    ...InteractionUI,
    ...NotificationUI,
    ...CommentsUiModule,
    ...ProfileUiModule,

    initializeUI,
    initializeUILight
};

UiModule.getCommentHeaderUI = (id, parent) => {
    const SELECTOR_HEADER = 'ql-thread__header'; 
    const selector = id ? `#ql-comments .${SELECTOR_HEADER}[data-comment-id="${id}"]` : `#ql-comments .${SELECTOR_HEADER}`;
    const res = document.querySelectorAll(selector);
    if (!res.length) return null;
    if (res.length === 1) return parent ? res[0].parentElement : res[0];
    return parent ? Array.from(res, el => el.parentElement) : res;
};

export default UiModule;