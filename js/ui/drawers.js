/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/ui/drawers.js */
import Drawer from './drawer.js';
import I18n from '../core/i18n.js';
import UtilsModule from '../core/utils.js';
import UiModule from './ui.js';
import CommentsModule from '../modules/comments/comments.js';

/**
 * @module UI/Drawers
 * @description Configuration and instantiation of system drawers.
 * Version 18.3.0 (Refactor: Extracted Chat Drawers to Chat Domain)
 */

const CONSTANTS = {
    Z_INDEX: {
        COMMENTS: 9000,
        LIKES: 9001,
        SETTINGS: 9002,
        PROFILE: 9003,
        CHATS_LIST: 9004,
        CHATS_CONVERSATION: 9005,
        NOTIFICATIONS: 9006,
        GENERAL_SETTINGS: 9007,
        FOLLOW_REQUEST: 9008,
        SEARCH_FOLLOW: 9009,
        MEMBER_PROFILE: 9010,
        MESSAGES: 9011
    },
    UI: {
        COMMENTS_EXPANDED_HEIGHT: '70%'
    }
};

const defaultDrawerConfig = {
    height: '100%',
    transitionSpeed: '0.3s',
    position: 'bottom',
    closeOnDrag: true
};

const _HTML = {
    icon: (name, cls = '') => `<span class="ql-icons-outlined ${cls}">${name}</span>`,

    switch: (labelKey, settingKey, checked = false, isSub = false) => `
        <div class="ql-settings__option ${isSub ? 'ql-settings__option--sub' : ''}">
            <span class="ql-settings__label t">{{${labelKey}}}</span>
            <label class="ql-switch">
                <input type="checkbox" class="ql-switch__input" data-setting-key="${settingKey}" ${checked ? 'checked' : ''}>
                <span class="ql-switch__slider"></span>
            </label>
        </div>
    `,

    accordion: (titleKey, contentHTML) => `
        <div class="ql-accordion__item">
            <div class="ql-accordion__header">
                <span class="ql-accordion__title t">{{${titleKey}}}</span>
                ${_HTML.icon('expand_more', 'ql-accordion__icon')}
            </div>
            <div class="ql-accordion__content">
                <div class="ql-accordion__content-inner">
                    ${contentHTML}
                </div>
            </div>
        </div>
    `,
    
    languageSelect: () => {
        const langs = I18n.getSupportedLanguages();
        const names = I18n.getLanguageNames();
        const opts = langs.map(l => `<option value="${l}" class="t">${names[l]}</option>`).join('');
        return `
            <div class="ql-settings__option">
                <div class="ql-settings__select-wrapper">
                    ${_HTML.icon('language')}
                    <select class="ql-settings__select" data-setting-action="language-change">
                        <option value="auto" class="t">{{autoDetectLanguage}}</option>
                        ${opts}
                    </select>
                </div>
            </div>`;
    },

    themeSelector: () => `
        <div class="ql-settings__option ql-settings__option--column">
            <div class="ql-settings__theme-group">
                <button class="ql-settings__theme-btn" data-theme="light">
                    ${_HTML.icon('wb_sunny')}
                    <span class="t">{{lightTheme}}</span>
                </button>
                <button class="ql-settings__theme-btn" data-theme="dark">
                    ${_HTML.icon('nights_stay')}
                    <span class="t">{{darkTheme}}</span>
                </button>
                <button class="ql-settings__theme-btn" data-theme="system">
                    ${_HTML.icon('devices')}
                    <span class="t">{{systemTheme}}</span>
                </button>
            </div>
            <div class="ql-settings__description t" style="text-align:center; width:100%">{{themeSelectionDescription}}</div>
        </div>
    `,

    searchContainer: (placeholder, id = '', name = '') => `
        <div class="ql-profile__search" style="flex-shrink: 0;">
            ${_HTML.icon('search', 'ql-search-icon')}
            <input type="text" ${id ? `id="${id}"` : ''} placeholder="${placeholder}" class="ql-search__input" name="${name || 'search-input'}">
        </div>
    `
};

const _Handlers = {
    initAccordion: (drawerId) => {
        const drawer = document.getElementById(drawerId);
        if (!drawer) return;
        
        drawer.addEventListener('click', (e) => {
            const header = e.target.closest('.ql-accordion__header');
            if (!header) return;
            
            e.stopPropagation();
            const item = header.parentElement;
            const content = item.querySelector('.ql-accordion__content');
            const isActive = item.classList.contains('ql-accordion__item--active');
            
            drawer.querySelectorAll('.ql-accordion__item--active').forEach(other => {
                if (other !== item) {
                    other.classList.remove('ql-accordion__item--active');
                    other.querySelector('.ql-accordion__content').style.maxHeight = null;
                }
            });

            if (isActive) {
                item.classList.remove('ql-accordion__item--active');
                content.style.maxHeight = null;
            } else {
                item.classList.add('ql-accordion__item--active');
                content.style.maxHeight = content.scrollHeight + "px";
            }
        });
        
        const first = drawer.querySelector('.ql-accordion__item');
        if (first) {
            first.classList.add('ql-accordion__item--active');
            const content = first.querySelector('.ql-accordion__content');
            content.style.maxHeight = "1000px"; 
        }
    },

    initCommentsPullToRefresh: (threads) => {
        if (!threads) return;
        let startY = 0;
        let isDragging = false;
        let refreshButton = null;
        let hasTriggered = false;

        const removeButton = () => {
            if (refreshButton) {
                refreshButton.style.transition = 'transform 0.5s ease, opacity 0.5s ease';
                refreshButton.style.transform = 'translateX(-50%) translateY(20px) rotate(-360deg)';
                refreshButton.style.opacity = '0';
                setTimeout(() => {
                    if (refreshButton && refreshButton.parentNode) threads.removeChild(refreshButton);
                    refreshButton = null;
                }, 500);
            }
        };

        threads.addEventListener('touchstart', (e) => {
            startY = e.touches[0].clientY;
            isDragging = threads.scrollTop <= 2;
            hasTriggered = false;
        }, { passive: true });

        threads.addEventListener('touchmove', (e) => {
            if (!isDragging || hasTriggered || threads.parentElement.scrollTop !== 0) return;
            const currentY = e.touches[0].clientY;
            const dragDistance = currentY - startY;

            if (dragDistance > 0) {
                if (!refreshButton) {
                    refreshButton = document.createElement('button');
                    refreshButton.className = 'ql-refresh-button';
                    refreshButton.innerHTML = _HTML.icon('loop');
                    threads.appendChild(refreshButton);
                }
                const opacity = 0.3 + (dragDistance / 180) * 0.7;
                const rotation = Math.min((dragDistance / 180) * 360, 360);
                refreshButton.style.transform = `translateX(-50%) translateY(${dragDistance}px) rotate(${rotation}deg)`;
                refreshButton.style.opacity = `${opacity}`;

                if (dragDistance >= 180) {
                    hasTriggered = true;
                    removeButton();
                    isDragging = false;
                    const threadsContainer = UiModule.getCommunityThreadsUI();
                    if (threadsContainer) {
                        const currentEntity = threadsContainer.getAttribute('data-threads-entity');
                        CommentsModule.fetchComments(currentEntity, false, false, true);
                    }
                }
            }
        }, { passive: true });

        threads.addEventListener('touchend', () => {
            if (!hasTriggered) removeButton();
            isDragging = false;
        });
    }
};

export const commentsDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-comments',
    customClass: 'ql-comments',
    title: '{{comments}}',
    height: CONSTANTS.UI.COMMENTS_EXPANDED_HEIGHT,
    content: `
        <div class="ql-live-animation-container"></div>
        <div class="ql-community-threads"></div>
        <div class="ql-comment-bar" id="ql-comment-bar">
            <div class="ql-comment-bar__minimized-icon">${_HTML.icon('edit')}</div>
            <div class="ql-comment-bar__input-container">
                <div class="ql-avatar__image profile-settings" style="display:none; width:30px; height:30px;"></div>
                <div class="ql-icons-outlined general-settings"></div>
                <div class="ql-comment-input" id="ql-input" contenteditable="true" maxlength="200" placeholder="{{addcomment}}"></div>
                <div class="progress-bar" id="ql-input-bar"></div>
                <div id="ql-send" class="ql-send-button">${_HTML.icon('send')}</div>
                <div class="ql-icons-outlined ql-emoji-button emoji-button" data-target-id="ql-input">add_reaction</div>
            </div>
        </div>
        <div class="ql-comment-disabled t">{{comments_disabled}}</div>`,
    zIndex: CONSTANTS.Z_INDEX.COMMENTS,
    swipeGroup: 'guest',
    swipeRank: 0,
    icon: 'chat_bubble_outline',
    afterRender: async function() {
        const drawerElement = document.getElementById('ql-comments');
        const threads = drawerElement?.querySelector('.ql-community-threads');
        const commentBar = document.getElementById('ql-comment-bar');
        const inputElement = document.getElementById('ql-input');
        
        if (!drawerElement || !commentBar) return;
        UtilsModule.makeEditableDivInput('ql-input');
        if (threads) {
            threads.style.position = 'relative';
            _Handlers.initCommentsPullToRefresh(threads);
        }

        let isMinimized = false;
        let isRestoring = false;

        const restoreDrawer = () => {
            if (isRestoring) return;
            isRestoring = true;
            isMinimized = false;
            
            commentBar.classList.remove('ql-comment-bar--minimized');
            
            if (UtilsModule.isMobile && drawerElement.classList.contains('active')) {
                this.setHeight(CONSTANTS.UI.COMMENTS_EXPANDED_HEIGHT);
            }

            if (inputElement) {
                setTimeout(() => inputElement.focus(), 100);
            }
            
            setTimeout(() => { 
                isRestoring = false;
                const rect = drawerElement.getBoundingClientRect();
                if (rect.height > window.innerHeight * 0.5) {
                    commentBar.classList.remove('ql-comment-bar--minimized');
                    isMinimized = false;
                }
            }, 500);
        };

        const evaluateLayout = () => {
            if (isRestoring || !drawerElement.classList.contains('active')) return;

            requestAnimationFrame(() => {
                const rect = drawerElement.getBoundingClientRect();
                const windowHeight = window.innerHeight;
                
                if (rect.height === 0 || drawerElement.classList.contains('no-shadow')) return;
                
                const ratio = rect.height / windowHeight;
                const shouldBeMinimized = ratio <= 0.50;

                if (shouldBeMinimized !== isMinimized) {
                    isMinimized = shouldBeMinimized;
                    if (isMinimized) {
                        commentBar.classList.add('ql-comment-bar--minimized');
                        if (inputElement && document.activeElement === inputElement) inputElement.blur();
                    } else {
                        commentBar.classList.remove('ql-comment-bar--minimized');
                    }
                }
            });
        };

        const layoutObserver = new MutationObserver((mutations) => {
            let shouldEvaluate = false;
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    shouldEvaluate = true;
                    break;
                }
            }
            if (shouldEvaluate) evaluateLayout();
        });
        
        layoutObserver.observe(drawerElement, { attributes: true, attributeFilter: ['style'] });

        commentBar.addEventListener('click', (e) => {
            if (commentBar.classList.contains('ql-comment-bar--minimized')) {
                e.preventDefault(); 
                e.stopPropagation(); 
                restoreDrawer();
            }
        });

        this.on('open', () => {
             isMinimized = false; 
             isRestoring = false;
             commentBar.classList.remove('ql-comment-bar--minimized');
        });
    },
    afterClose: () => {
        const threadsContainer = UiModule.getCommunityThreadsUI();
        const entityId = threadsContainer?.getAttribute('data-threads-entity');
        if (entityId) {
            const config = UtilsModule.getConfig(entityId);
            if (config?.liveMode?.isLiveActive) CommentsModule.cleanupLiveModeUI(entityId);
        }
        
        const commentBar = document.getElementById('ql-comment-bar');
        if (commentBar) commentBar.classList.remove('ql-comment-bar--minimized');
    }
});

// --- NOTIFICATIONS (Rank 1) ---
export const notificationDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-notification-list',
    customClass: 'ql-notification-list',
    title: '{{notifications}}',
    content: `<div class="profile-stats"><div class="ql-notification-list" id="community-ql-notification-list"></div></div>`,
    zIndex: CONSTANTS.Z_INDEX.NOTIFICATIONS,
    swipeGroup: 'main',
    swipeRank: 1,
    icon: 'notifications'
});

// --- SEARCH (Rank 2) ---
export const searchFollowRequestDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-search-follow-request',
    customClass: 'ql-follow-request',
    title: '{{searchAccounts}}',
    content: `
        ${_HTML.searchContainer('{{search}}', 'accounts-search')}
        <div class="ql-account-request-list" style="height: calc(100% - 60px); touch-action: pan-y; overscroll-behavior: contain;">
            <ul class="ql-profile"><div class="ql-empty-container t">{{noResultsForQuery}}</div></ul>
        </div>`,
    zIndex: CONSTANTS.Z_INDEX.SEARCH_FOLLOW,
    swipeGroup: 'main',
    swipeRank: 2,
    icon: 'person_search'
});

// --- PROFILE (Rank 3) ---
export const profileDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-community-profile',
    customClass: 'ql-community-profile',
    title: '{{profile}}',
    content: `<div id="ql-profile"></div>`, 
    zIndex: CONSTANTS.Z_INDEX.PROFILE,
    swipeGroup: 'main',
    swipeRank: 3,
    icon: 'person'
});

// --- SETTINGS (Rank 5) ---
export const settingsDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-community-settings',
    customClass: 'ql-settings',
    title: '{{settings}}',
    zIndex: CONSTANTS.Z_INDEX.SETTINGS,
    swipeGroup: 'main',
    swipeRank: 5,
    icon: 'settings',
    afterRender: () => _Handlers.initAccordion('ql-community-settings'),
    content: `
        <div class="ql-settings__section">
            ${_HTML.accordion('privacySettings', `
                <div class="ql-settings__header t" style="font-size:13px; color:var(--ql-light-gray-color)">{{session}}</div>
                ${_HTML.switch('rememberSession', 'session.rememberSession', true)}
                
                <div class="ql-settings__divider"></div>
                
                <div class="ql-settings__option ql-settings__option--column">
                    <div class="ql-settings__label t">{{showActivity}}</div>
                    <div class="ql-settings__btn-group" data-setting-group="privacy" data-setting-key="activityVisibility">
                        <button class="ql-settings__btn" data-value="everyone"><span class="t">{{everyone}}</span></button>
                        <button class="ql-settings__btn" data-value="followers"><span class="t">{{onlyFollowers}}</span></button>
                        <button class="ql-settings__btn" data-value="onlyme"><span class="t">{{onlyMe}}</span></button>
                    </div>
                    <div class="ql-settings__description t">{{showActivityDescription}}</div>
                </div>

                ${_HTML.switch('approveFollowers', 'followerApproval', false)}
                <div class="ql-settings__description t" style="padding:0 10px">{{approveFollowersDescription}}</div>
            `)}

            ${_HTML.accordion('languagePreferences', _HTML.languageSelect())}
            
            ${_HTML.accordion('themePreferences', _HTML.themeSelector())}

            ${_HTML.accordion('notificationSettings', `
                ${_HTML.switch('webNotifications', 'notifications.web', true)}
                ${_HTML.switch('emailNotifications', 'notifications.email', true)}
                ${_HTML.switch('pushNotifications', 'notifications.push', true)}
                
                <div class="ql-settings__divider"></div>
                <div class="ql-settings__label t" style="margin-bottom:10px">{{notificationSuboptions}}</div>
                
                ${_HTML.switch('notifyReplies', 'notifications.types.replies', true, true)}
                ${_HTML.switch('notifyLikes', 'notifications.types.likes', true, true)}
                ${_HTML.switch('notifyNewFollowers', 'notifications.types.newFollowers', true, true)}
                ${_HTML.switch('notifyNewPosts', 'notifications.types.newPosts', true, true)}
            `)}
        </div>`
});

export const memberDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-member-profile-drawer',
    customClass: 'ql-community-profile',
    title: '{{profile}}',
    content: `<div id="ql-member-profile-container"></div>`,
    zIndex: CONSTANTS.Z_INDEX.MEMBER_PROFILE,
    swipeGroup: null,
    swipeRank: -1,
    icon: 'person'
});

export const generalSettingsDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-community-general-settings',
    customClass: 'ql-settings',
    title: '{{settings}}',
    zIndex: CONSTANTS.Z_INDEX.GENERAL_SETTINGS,
    swipeGroup: 'guest',
    swipeRank: 1,
    icon: 'settings',
    content: `
        <div class="ql-settings__section">
            <div id="ql-settings-login-container" class="ql-login-container"></div>
            <div class="ql-settings__divider"></div>
            <div class="ql-settings__header t">{{languagePreferences}}</div>
            ${_HTML.languageSelect()}
            <div class="ql-settings__divider"></div>
            <div class="ql-settings__header t">{{themePreferences}}</div>
            ${_HTML.themeSelector()}
        </div>`
});

export const likesDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'likes-list',
    customClass: 'ql-likes-list',
    title: '{{likes}}',
    zIndex: CONSTANTS.Z_INDEX.LIKES,
    content: ` ${_HTML.searchContainer('{{search}}', 'likes-search')} <div class="ql-likes-list" id="ql-likes-list"></div>`
});

export const followRequestDrawerUI = new Drawer({
    ...defaultDrawerConfig,
    id: 'ql-follow-request',
    customClass: 'ql-follow-request',
    title: '{{followRequest}}',
    content: `<div class="ql-follow-request-list"></div>`,
    zIndex: CONSTANTS.Z_INDEX.FOLLOW_REQUEST
});

export const getEditProfileFormUI = (profile) => {
    const formHTML = document.createElement('div');
    formHTML.className = 'ql-registration-drawer';
    
    const createInput = (id, labelKey, value, autocomplete, required = false) => `
        <div class="ql-form-group floating-label-group ${value ? 'active' : ''}">
            <input type="text" id="${id}" ${required ? 'required' : ''} value="${value || ''}" autocomplete="${autocomplete}">
            <label for="${id}" class="t">{{${labelKey}}}</label>
        </div>`;

    formHTML.innerHTML = `
        <div class="ql-form-step step-1 active">
            <fieldset>
                <legend class="t">{{personalInfo}}</legend>
                ${createInput('edit-name', 'userName', profile.name, 'name', true)}
                ${createInput('edit-given-name', 'firstName', profile.given_name, 'given-name', true)}
                ${createInput('edit-family-name', 'lastName', profile.family_name, 'family-name')}
            </fieldset>
            <fieldset>
                <button id="ql-toggle-password-btn" class="ql-provider-button-submit" style="font-size: 14px; padding: 10px; margin-bottom: 0;">
                    <span class="t">{{changePassword}}</span>
                </button>
                <div id="ql-password-fields-container" style="display: none;">
                    <legend class="t">{{password}}</legend>
                    <div class="ql-form-group floating-label-group" style="margin-top: 20px;">
                        <input type="password" id="edit-password-original" autocomplete="current-password">
                        <label for="edit-password-original" class="t">{{currentPassword}}</label>
                    </div>
                    <div class="ql-form-group floating-label-group">
                        <input type="password" id="edit-password" autocomplete="new-password">
                        <label for="edit-password" class="t">{{newPassword}}</label>
                        <div id="password-strength-meter">
                            <div class="strength-bar"></div>
                            <span class="strength-text"></span>
                        </div>
                    </div>
                    <div class="ql-form-group floating-label-group">
                        <input type="password" id="edit-password-verify" autocomplete="new-password">
                        <label for="edit-password-verify" class="t">{{passwordVerify}}</label>
                    </div>
                </div>
            </fieldset>
            <div class="ql-form-error"></div>
        </div>`;

    const toggleBtn = formHTML.querySelector('#ql-toggle-password-btn');
    const container = formHTML.querySelector('#ql-password-fields-container');
    if (toggleBtn && container) {
        toggleBtn.addEventListener('click', (e) => {
            e.preventDefault();
            toggleBtn.style.display = 'none';
            container.style.display = 'block';
            container.style.opacity = '0';
            container.style.transform = 'translateY(-10px)';
            container.style.transition = 'all 0.3s ease';
            requestAnimationFrame(() => {
                container.style.opacity = '1';
                container.style.transform = 'translateY(0)';
            });
        });
    }

    return formHTML;
};