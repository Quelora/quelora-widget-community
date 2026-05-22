/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/profile/profile.ui.js */
/**
 * @fileoverview Profile UI Controller
 * @module Modules/Profile/UI
 * @description Manages DOM events, Infinite Scroll, View orchestration, and User Settings interactions.
 * Updated: Implemented pure Event-Driven state machine for Reversible Block Toggle and Anti-Double-Click.
 * Refactored to comply with strict modal encapsulation boundaries and Plugin Registry pattern.
 * Includes Mention lifecycle events for DOM orchestration.
 * @version 1.6.0
 */

import UtilsModule from '../../core/utils.js';
import I18n from '../../core/i18n.js';
import ConfModule from '../../core/conf.js';
import UiModule from '../../ui/ui.js'; 
import ImageCropper from '../../ui/components/cropper.js';
import GuardModule from '../../core/guard.js';
import CommentsUiModule from '../comments/comments.ui.js';
import NotificationModule from '../notifications/notifications.js';
import IconsModule from '../../ui/icons.js';
import StorageModule from '../../core/storage.js';
import AnchorModule from '../../ui/anchor.js'; 
import { ProfileTemplates } from './profile.templates.js'; 
import { eventBus } from '../../core/event.js';
import { setupModalUI, closeModalUI, updateModalFooterUI } from '../../ui/modal.js';
import handleLog from '../../core/logs.js';

/**
 * Dynamic import helper to avoid circular dependencies.
 * @returns {Promise<Object>} The Profile module instance.
 */
const getProfileModule = async () => (await import('./profile.js')).default;

const CONSTANTS = {
    BATCH_SIZE: 50,
    SELECTORS: {
        PROFILE_CONTAINER: '#ql-profile',
        MEMBER_CONTAINER: '#ql-member-profile-container',
        DROPUP: '.ql-profile-dropup',
        AVATAR: '.ql-profile__avatar',
        AVATAR_BOX: '.ql-profile__avatar-box',
        HEADER: '.ql-profile__header',
        SEARCH_INPUT: '.ql-search__input',
        NAV_PROFILE_BTN: '.profile-settings',
        SUGGESTIONS_LIST: '.ql-account-request-list ul',
        SENTINEL: '.ql-profile-sentinel',
        LIST_AVATAR: '.ql-profile__list-avatar',
        LIST_FRAME: '.ql-profile__list-frame',
        LIST_WRAPPER: '.ql-profile__list-avatar-wrapper',
        LIST_NAME: '.ql-profile__list-name',
        INPUT_CONTAINER: '.ql-comment-bar__input-container',
        GENERAL_SETTINGS_BTN: '.general-settings'
    },
    CLASSES: {
        ACTIVE_TAB: 'ql-profile__tab--active',
        ACTIVE_CONTENT: 'ql-profile__content--active',
        AVATAR_INITIALS: 'avatar-initials',
        PROCESSING: 'ql-is-processing',
        SQUARED: 'ql-profile__avatar--squared', 
        SQUARED_FRAME: 'squared', 
        LIST_SQUARED: 'squared',
        BTN_ACTIVE: 'ql-settings__btn--active',
        THEME_ACTIVE: 'ql-settings__theme-btn--active',
        DROPUP_VISIBLE: 'ql-profile-dropup--visible'
    },
    AVATAR_SIZE: 192,
    BANNER_W: 430,
    BANNER_H:160
};

const _GlobalHandlers = {
    clickBound: false,

    /**
     * Closes every visible `.ql-profile-dropup` whose trigger element (direct
     * parent) was not the click target, supporting multiple simultaneous dropup
     * instances (e.g. community navbar + auth-widget).
     *
     * @param {MouseEvent} e
     */
    handleDocumentClick: (e) => {
        document.querySelectorAll(CONSTANTS.SELECTORS.DROPUP).forEach(dropup => {
            if (!dropup.classList.contains(CONSTANTS.CLASSES.DROPUP_VISIBLE)) return;

            const trigger = dropup.parentElement;

            if (!dropup.contains(e.target) && (!trigger || !trigger.contains(e.target))) {
                requestAnimationFrame(() => {
                    dropup.classList.remove(CONSTANTS.CLASSES.DROPUP_VISIBLE);
                    setTimeout(() => {
                        if (!dropup.classList.contains(CONSTANTS.CLASSES.DROPUP_VISIBLE)) {
                            dropup.style.display = 'none';
                        }
                    }, 200);
                });
            }
        });
    }
};

// ============================================================
// CIRCUIT BREAKER: SYNCHRONOUS SSOT REPLICA
// ============================================================
const _blockedSSOT = new Set();

const _hydrateBlockedSSOT = () => {
    try {
        const stored = StorageModule.getLocalItem('ql_blocked_users');
        if (stored) {
            JSON.parse(stored).forEach(id => _blockedSSOT.add(String(id)));
        }
    } catch(e) {}
};

_hydrateBlockedSSOT();

eventBus.on('USER_BLOCKED', ({ memberId }) => {
    if (memberId) {
        _blockedSSOT.add(String(memberId));
        ProfileUiModule.destroyElementsByUI(memberId);
    }
});

eventBus.on('USER_UNBLOCKED', ({ memberId }) => {
    if (memberId) {
        _blockedSSOT.delete(String(memberId));
    }
});

eventBus.on('SESSION_CLEARED', () => {
    _blockedSSOT.clear();
});

const ProfileUiModule = {
    _paginationObservers: new Map(),
    _renderControllers: new WeakMap(),
    /** @type {Map<string, number>} Tracks pending deferred-removal timers keyed by member ID. */
    _unblockRemovalTimers: new Map(),

    closeModalUI: closeModalUI,
    setupModalUI: setupModalUI,
    
    /**
     * Retrieves the profile container based on the view mode.
     * @param {boolean} isMember - Whether to target the member container.
     * @returns {HTMLElement|null} The targeted profile container.
     */
    getProfileContainerUI: (isMember = false) => {
        return document.querySelector(isMember ? CONSTANTS.SELECTORS.MEMBER_CONTAINER : CONSTANTS.SELECTORS.PROFILE_CONTAINER);
    },

    /**
     * Renders the complete profile interface.
     * @param {Object} userProfile - The target profile to render.
     * @param {Object} ownProfile - The current authenticated user's profile.
     * @returns {Promise<void>}
     */
    renderProfileUI: async function(userProfile, ownProfile) {
        const isOwn = ownProfile?.author === userProfile.author;
        const container = this.getProfileContainerUI(!isOwn);
        
        if (!container) return;
        if (!container.classList.contains('ql-profile')) container.classList.add('ql-profile');
        
        if (this._renderControllers.has(container)) {
            this._renderControllers.get(container).abort();
        }
        
        container.dataset.profileMemberId = userProfile.author;
        container.innerHTML = ProfileTemplates.mainContainer(userProfile, isOwn);
        I18n.translateElement(container);

        if (isOwn) {
            this._setupOwnProfileControlsUI(container);
        }
        
        this._updateTabsVisibilityUI(container, userProfile, isOwn);
        this._initializeProfileTabsUI(container);
        this._setupSearchHandlers(container);
        this._setupDelegatedActions(container);
    },

    /**
     * Renders a specific section of the profile (e.g., likes, comments, followers).
     * @param {Array} items - The items to render.
     * @param {HTMLElement} container - The container to append the items to.
     * @param {string} type - The section type.
     * @param {Object} ownProfile - The current authenticated user's profile.
     * @param {Object} callbacks - Configuration options for the rendering (e.g., isAppend).
     */
    renderProfileSectionUI: function(items, container, type, ownProfile, callbacks = {}) {
        if (!container) return;
        if (!callbacks.isAppend) {
            container.innerHTML = '';
            if (this._paginationObservers.has(container)) {
                this._paginationObservers.get(container).disconnect();
                this._paginationObservers.delete(container);
            }
        } else {
            const oldSentinel = container.querySelector(CONSTANTS.SELECTORS.SENTINEL);
            if (oldSentinel) oldSentinel.remove();
        }
        
        if ((!items || items.length === 0) && !callbacks.isAppend) {
            const msgs = { comments: 'noComments', likes: 'noLikes', shares: 'noShares', bookmarks: 'noBookmarks', follower: 'noFollowers', followed: 'noFollowing', blocked: 'noBlocked' };
            container.innerHTML = `<div class="ql-empty-container t" data-i18n-key="${msgs[type] || 'noResults'}">{{${msgs[type] || 'noResults'}}}</div>`;
            return;
        }

        const processedItems = items.filter(item => {
            if (type === 'blocked' || callbacks.isBlocked) return true;
            
            const authorId = item.author || item.targetId || item._id;
            return authorId ? !_blockedSSOT.has(String(authorId)) : true;
        }).map(item => {
            if (type === 'blocked' || callbacks.isBlocked) {
                item.author = item.author || item.blocked_author || item._id;
            }

            if (type === 'comments' || (type === 'likes' && item.fk_type === 'comment')) {
                if (AnchorModule && typeof AnchorModule.generateLink === 'function') {
                    const anchorLink = AnchorModule.generateLink({
                        type: item.replyId ? 'reply' : 'comment',
                        ids: { entity: item.entity, commentId: item._id || item.targetId, replyId: item.replyId ? item._id : undefined }
                    });
                    item.computedLink = anchorLink;
                }
            }
            return item;
        });

        const total = processedItems.length;
        let index = 0;
        
        const renderBatch = () => {
            const batch = processedItems.slice(index, index + CONSTANTS.BATCH_SIZE);
            const fragment = document.createDocumentFragment();

            batch.forEach(item => {
                const li = document.createElement('li');
                li.className = 'ql-profile__list-item'; 

                if (type === 'follower' || type === 'followed' || type === 'blocked') {
                    const actionsHtml = callbacks.isBlocked 
                        ? ProfileTemplates.unblockButton(item)
                        : ProfileTemplates.followButton(item, ownProfile?.author === item.author);
                    
                    li.className = 'ql-profile__user-card';
                    li.dataset.memberId = item.author;
                    li.innerHTML = ProfileTemplates.avatar(item, true) + ProfileTemplates.userInfo(item) + ` <div class="ql-profile__actions">${actionsHtml}</div>`;
                    fragment.appendChild(li);

                } else if (type === 'comments') {
                     li.innerHTML = ProfileTemplates.commentItem(item);
                     if (item.computedLink) {
                         const linkEl = li.querySelector('.ql-profile__item-link');
                         if (linkEl) linkEl.href = item.computedLink;
                     }
                     getProfileModule().then(pm => pm.parseMarkdown(item.text, item._id));
                     fragment.appendChild(li);

                } else if (type === 'likes') {
                    li.innerHTML = ProfileTemplates.likeItem(item);
                    if (item.computedLink) {
                         const linkEl = li.querySelector('.ql-profile__item-link');
                         if (linkEl) linkEl.href = item.computedLink;
                    }
                    fragment.appendChild(li);
                    
                } else if (type === 'shares' || type === 'bookmarks') {
                     li.innerHTML = ProfileTemplates.simpleItem(item, type);
                     fragment.appendChild(li);
                }
            });
        
            container.appendChild(fragment);
            index += CONSTANTS.BATCH_SIZE;
 
            if (index < total) {
                requestAnimationFrame(renderBatch);
            } else {
                if (callbacks.hasMore) {
                    const sentinel = document.createElement('div');
                    sentinel.className = 'ql-profile-sentinel';
                    sentinel.innerHTML = '<div class="ql-loader"></div>';
                    Object.assign(sentinel.style, { padding: '10px', display: 'flex', justifyContent: 'center' });
                    container.appendChild(sentinel);
                    const memberId = container.closest('.ql-profile')?.dataset.profileMemberId;
                    if(memberId) ProfileUiModule._setupPaginationObserver(sentinel, container, type, memberId);
                }
            }
        };

        renderBatch();
    },

    /**
     * Initializes the IntersectionObserver for infinite scrolling pagination.
     * @param {HTMLElement} sentinel - The sentinel element to observe.
     * @param {HTMLElement} container - The container holding the list.
     * @param {string} type - The section type.
     * @param {string} memberId - The target member ID.
     * @private
     */
    _setupPaginationObserver: (sentinel, container, type, memberId) => {
        if (ProfileUiModule._paginationObservers.has(container)) {
            ProfileUiModule._paginationObservers.get(container).disconnect();
        }

        const observer = new IntersectionObserver(async (entries) => {
            if (entries[0].isIntersecting) {
                const ProfileModule = await getProfileModule();
                if (entries[0].intersectionRatio > 0) {
                     ProfileModule.loadMoreActivity(memberId, type);
                }
            }
        }, { root: null, rootMargin: '200px', threshold: 0.1 });

        observer.observe(sentinel);
        ProfileUiModule._paginationObservers.set(container, observer);
    },

    /**
     * Injects a loading skeleton layout into the profile container.
     * @param {boolean} isMember - Whether to target the member container.
     */
    addProfileSkeletonUI: function(isMember = false) {
        const profile = this.getProfileContainerUI(isMember);
        if (!profile) return;
        if (!profile.classList.contains('ql-profile')) profile.classList.add('ql-profile');
        profile.innerHTML = ProfileTemplates.skeleton();
        profile.dataset.profileMemberId = '';
    },

    /**
     * Renders suggested users in the designated list container.
     * @param {Array} suggs - Array of suggested user profiles.
     * @param {Object} ownProfile - The current authenticated user's profile.
     */
    renderSuggestionsUI: function(suggs, ownProfile) {
        const container = document.querySelector(CONSTANTS.SELECTORS.SUGGESTIONS_LIST);
        if (!container) return;
        container.innerHTML = '';
        
        const filteredSuggs = suggs.filter(u => !_blockedSSOT.has(String(u.author)));
        
        if (!filteredSuggs || filteredSuggs.length === 0) {
            container.innerHTML = `<div class="ql-empty-container t" data-i18n-key="noResults">{{noResults}}</div>`;
            return;
        }

        container.appendChild(UiModule.createElementUI({ tag: 'div', classes: 'suggestion-header t', content: '{{suggestions}}', translate: true }));

        const fragment = document.createDocumentFragment();
        filteredSuggs.forEach(u => {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = ProfileTemplates.suggestionItem(u, ownProfile);
            fragment.appendChild(tempDiv.firstElementChild);
        });

        container.appendChild(fragment);
        this._setupDelegatedActions(container); 
    },

    /**
     * Renders search results for account queries.
     * @param {Array} profiles - Array of profile objects returned from the search.
     * @param {Object} ownProfile - The current authenticated user's profile.
     */
    renderSearchAccountsResultsUI: function(profiles, ownProfile) {
        const list = document.querySelector(CONSTANTS.SELECTORS.SUGGESTIONS_LIST);
        if (!list) return;

        list.innerHTML = '';
        const filteredProfiles = profiles.filter(user => !_blockedSSOT.has(String(user.author)));
        
        if (!filteredProfiles || filteredProfiles.length === 0) {
            list.innerHTML = `<div class="ql-empty-container t" data-i18n-key="noResultsForQuery">{{noResultsForQuery}}</div>`;
            I18n.translateElement(list);
            return;
        }

        const fragment = document.createDocumentFragment();
        
        filteredProfiles.forEach(user => {
            const li = document.createElement('li');
            li.className = 'ql-profile__user-card';
            li.dataset.memberId = user.author;
            
            const actionsHtml = ProfileTemplates.followButton(user, ownProfile?.author === user.author);
            li.innerHTML = ProfileTemplates.avatar(user, true) + ProfileTemplates.userInfo(user) + `<div class="ql-profile__actions">${actionsHtml}</div>`;
            
            fragment.appendChild(li);
        });

        list.appendChild(fragment);
        this._setupDelegatedActions(list);
    },

    /**
     * Renders incoming follow requests.
     * @param {Array} requests - Array of follow request objects.
     */
    renderFollowRequestsUI: function(requests) {
        const container = document.querySelector('#ql-follow-request .ql-follow-request-list');
        if (!container) return;

        container.innerHTML = '';

        import('../../ui/ui.js').then(({ default: Ui }) => {
            const filteredRequests = requests.filter(req => req.requester && !_blockedSSOT.has(String(req.requester.author)));
            
            if (!filteredRequests || filteredRequests.length === 0) {
                container.innerHTML = `<div class="ql-empty-container t" data-i18n-key="noFollowRequests">{{noFollowRequests}}</div>`;
                I18n.translateElement(container);
                Ui.followRequestDrawerUI.open();
                return;
            }

            const fragment = document.createDocumentFragment();

            filteredRequests.forEach(req => {
                const user = req.requester;

                const li = document.createElement('li');
                li.className = 'ql-profile__user-card follower-item';
                li.dataset.requestId = req._id;
                li.dataset.memberId = user.author;

                const avatarHtml = ProfileTemplates.avatar(user, true);
                const infoHtml = ProfileTemplates.userInfo(user);

                const actionsHtml = `
                    <div class="ql-profile__actions request-actions">
                        <button class="ql-btn ql-btn--primary accept-request" data-request-id="${req._id}" data-member-id="${user.author}">
                            <span class="ql-icons-outlined">check</span>
                        </button>
                        <button class="ql-btn ql-btn--danger reject-request" data-request-id="${req._id}" data-member-id="${user.author}">
                            <span class="ql-icons-outlined">close</span>
                        </button>
                    </div>`;

                li.innerHTML = avatarHtml + infoHtml + actionsHtml;
                fragment.appendChild(li);
            });

            container.appendChild(fragment);
            this._setupRequestActions(container);
            Ui.followRequestDrawerUI.open();
        });
    },

    /**
     * Attaches delegated event listeners for follow request actions.
     * @param {HTMLElement} container - The container element to attach listeners to.
     * @private
     */
    _setupRequestActions: (container) => {
        if (container.dataset.eventsBound === 'true') return;
        container.dataset.eventsBound = 'true';

        container.addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;

            const isAccept = btn.classList.contains('accept-request');
            const isReject = btn.classList.contains('reject-request');

            if (isAccept || isReject) {
                e.preventDefault(); 
                e.stopPropagation();

                const requestId = btn.dataset.requestId;
                const memberId = btn.dataset.memberId;
                const item = btn.closest('.follower-item');
                
                if (item) {
                    item.style.transition = 'all 0.5s ease';
                    item.style.transform = 'rotateX(-100deg)';
                    item.style.opacity = '0';
                    
                    setTimeout(() => {
                        item.remove();
                        if (container.querySelectorAll('.follower-item').length === 0) {
                            container.innerHTML = `<div class="ql-empty-container t" data-i18n-key="noFollowRequests">{{noFollowRequests}}</div>`;
                            I18n.translateElement(container);
                        }
                    }, 500);
                }

                const ProfileModule = await getProfileModule();
                
                GuardModule.protect(() => {
                    if (ProfileModule.handleRequestAction) {
                        ProfileModule.handleRequestAction(requestId, memberId, isAccept);
                    }
                });
            }
        });
    },

    /**
     * Renders the list of users who liked an entity.
     * @param {Object} payload - The payload containing the likes array.
     * @param {Object} ownProfile - The current authenticated user's profile.
     */
    renderLikesDrawerUI: function(payload, ownProfile) {
        const container = UiModule.getLikesListUI();
        if (!container) return;

        const likes = (payload.likes || []).filter(user => !_blockedSSOT.has(String(user.author)));
        
        container.innerHTML = '';
        if (!likes.length) {
            container.innerHTML = `<div class="ql-empty-container t" data-i18n-key="noLikes">{{noLikes}}</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();
        const list = document.createElement('ul');
        list.className = 'ql-profile__list';

        likes.forEach(user => {
            const li = document.createElement('li');
            li.className = 'ql-profile__user-card';
            li.dataset.memberId = user.author;
            const actionsHtml = ProfileTemplates.followButton(user, ownProfile?.author === user.author);
            li.innerHTML = ProfileTemplates.avatar(user, true) + ProfileTemplates.userInfo(user) + `<div class="ql-profile__actions">${actionsHtml}</div>`;
            list.appendChild(li);
        });

        fragment.appendChild(list);
        container.appendChild(fragment);
        this._setupDelegatedActions(container);
    },

    /**
     * Displays the profile edit modal.
     * @param {Object} profile - The user's current profile data.
     * @param {Function} onSave - Callback to handle save events.
     */
    showEditProfileModalUI: (profile, onSave) => {
        const form = ProfileTemplates.editProfileForm(profile);
        setupModalUI(form, '.ql-profile'); 
        
        const modalBody = document.querySelector('.ql-modal .ql-body');
        
        const saveBtn = UiModule.createElementUI({ tag: 'button', classes: ['ql-btn', 'save-button'], innerHTML: `<span class="ql-icons-outlined">save</span><span class="t">{{saveChanges}}</span>` });
        const closeBtn = UiModule.createElementUI({ tag: 'button', classes: ['ql-btn', 'close-button'], innerHTML: `<span class="ql-icons-outlined">close</span><span class="t">{{close}}</span>` });
        
        closeBtn.onclick = closeModalUI;
        
        const footerContainer = document.createElement('div');
        footerContainer.append(saveBtn, closeBtn);
        updateModalFooterUI(footerContainer);

        const inputs = {
            name: modalBody?.querySelector('#edit-name'), 
            given: modalBody?.querySelector('#edit-given-name'), 
            family: modalBody?.querySelector('#edit-family-name'),
            passOld: modalBody?.querySelector('#edit-password-original'), 
            passNew: modalBody?.querySelector('#edit-password'), 
            passVerify: modalBody?.querySelector('#edit-password-verify')
        };

        if (inputs.name) {
            inputs.name.addEventListener('input', (e) => {
                const rawValue = e.target.value;
                const cleanValue = rawValue.replace(/[^a-zA-Z0-9]/g, '').slice(0, 15);
                if (rawValue !== cleanValue) e.target.value = cleanValue;
            });
        }

        const showFieldError = (fieldId, errorKey) => {
            const wrapper = modalBody?.querySelector(`.ql-form-group[data-field-id="${fieldId}"]`);
            if (wrapper) {
                wrapper.classList.add('has-error');
                const errorEl = wrapper.querySelector('.ql-field-error');
                if (errorEl) errorEl.textContent = I18n.getTranslation(errorKey) || errorKey;
            }
        };

        const clearErrors = () => {
            modalBody?.querySelectorAll('.ql-form-group').forEach(el => el.classList.remove('has-error'));
            modalBody?.querySelectorAll('.ql-field-error').forEach(el => el.textContent = '');
            const statusEl = modalBody?.querySelector('#ql-form-status');
            if (statusEl) statusEl.style.display = 'none';
        };

        if (inputs.passNew) {
            inputs.passNew.addEventListener('input', () => {
                const str = UtilsModule.validatePasswordStrength(inputs.passNew.value).strength;
                const bar = modalBody?.querySelector('.strength-bar');
                if (bar) {
                    bar.style.width = `${str * 25}%`;
                    bar.className = `strength-bar strength-${str}`;
                }
                const txt = modalBody?.querySelector('.strength-text');
                if (txt) txt.textContent = I18n.getTranslation(str < 2 ? 'passwordWeak' : str < 4 ? 'passwordMedium' : 'passwordStrong');
            });
        }

        saveBtn.onclick = async () => {
            clearErrors();
            const updates = {};
            let valid = true;
            
            const username = inputs.name?.value.trim();
            const nameRegex = /^[a-zA-Z0-9]{3,15}$/;
            
            if (inputs.name && !nameRegex.test(username)) { 
                showFieldError('edit-name', 'invalidNameFormat');
                valid = false;
            } else if (inputs.name) { 
                updates.name = username; 
            }
            
            if (inputs.given) updates.given_name = inputs.given.value.trim();
            if (inputs.family) updates.family_name = inputs.family.value.trim();
            
            if (inputs.passNew?.value || inputs.passOld?.value) {
                 if (!inputs.passOld.value) { 
                    showFieldError('edit-password-original', 'passwordOriginalRequired');
                    valid = false;
                } else if (inputs.passNew.value) {
                    const str = UtilsModule.validatePasswordStrength(inputs.passNew.value);
                    if (inputs.passNew.value !== inputs.passVerify.value) { 
                        showFieldError('edit-password-verify', 'passwordsDoNotMatch');
                        valid = false;
                    } else if (!str.isValid) { 
                        showFieldError('edit-password', 'passwordRequirements');
                        valid = false;
                    } else { 
                        updates.password = inputs.passNew.value; 
                        updates.password_original = inputs.passOld.value; 
                    }
                } else { 
                    showFieldError('edit-password', 'newPasswordRequired');
                    valid = false;
                }
            }
            
            if (valid && typeof onSave === 'function') {
                saveBtn.classList.add('loading'); 
                saveBtn.disabled = true;
                await onSave(updates);
                saveBtn.classList.remove('loading'); 
                saveBtn.disabled = false;
            }
        };
    },

    /**
     * Handles the outcome of a profile update operation.
     * @param {Object} response - The API response object.
     */
    handleProfileUpdateResult: function(response) {
        const modal = document.querySelector('.ql-modal');
        const statusEl = modal?.querySelector('#ql-form-status');
        const showToast = (type, title, msg) => import('../../ui/toast.js').then(tm => tm.default.show(type === 'error' ? 'error' : type === 'success' ? 'check' : 'info', title, msg, null, 4000, type));

        if (response.success) {
            if (response.message === 'No changes detected.') {
                if (statusEl) {
                    statusEl.textContent = I18n.getTranslation('noChangesDetected') || 'No changes were made.';
                    statusEl.className = 'ql-form-status info';
                    statusEl.style.display = 'block';
                } else {
                    showToast('info', null, response.message);
                }
                return; 
            }
            
            ProfileUiModule.closeModalUI();
            
            if (response.profile) {
                this.updateProfileUI(response.profile);
            }
            
            showToast('success', null, I18n.getTranslation('changesSaved'));

        } else {
            const msg = response.message || '';
            let fieldMapped = false;
            const mapErrorToField = (keyword, fieldId, translationKey) => {
                if (msg.includes(keyword)) {
                    const wrapper = modal?.querySelector(`.ql-form-group[data-field-id="${fieldId}"]`);
                    if (wrapper) {
                        wrapper.classList.add('has-error');
                        const errEl = wrapper.querySelector('.ql-field-error');
                        if (errEl) errEl.textContent = I18n.getTranslation(translationKey) || msg;
                        fieldMapped = true;
                    }
                }
            };

            mapErrorToField('Username', 'edit-name', 'usernameTaken');
            mapErrorToField('Current password', 'edit-password-original', 'passwordOriginalRequired');
            mapErrorToField('Password too weak', 'edit-password', 'passwordWeak');
            mapErrorToField('Invalid', 'edit-name', 'invalidNameFormat');

            if (!fieldMapped && statusEl) {
                statusEl.textContent = I18n.getTranslation('profileUpdateError') || msg;
                statusEl.className = 'ql-form-status error';
                statusEl.style.display = 'block';
            } else if (!fieldMapped) {
                showToast('error', I18n.getTranslation('error'), msg);
            }
        }
    },

    /**
     * Render the mention suggestion results above the active input, inject manual close control
     * and emit events to orchestrate the visibility of other components.
     * @param {Array} profiles - The matching profile records to suggest.
     * @param {Function} onSelectProfile - Callback executed when a profile is selected.
     * @returns {Promise<void>}
     */
    renderMentionResultsUI: async (profiles, onSelectProfile) => {
        const input = document.querySelector('.comment-input') || document.activeElement;
        if (!input) return;

        let box = document.querySelector('.mention-suggestions');
        
        if (!box) {
            eventBus.emit('MENTION_OPENED');
            
            box = UiModule.createElementUI({ 
                tag: 'div', 
                classes: 'mention-suggestions', 
                innerHTML: '<ul class="ql-profile ql-mention-list"></ul>' 
            });
            document.body.appendChild(box);
            
            const header = document.createElement('div');
            header.className = 'ql-modal-header ql-mention-toolbar';
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.alignItems = 'center';
            header.style.padding = '10px 15px';
            header.style.borderBottom = '1px solid var(--ql-light-border-color, #dbdbdb)';
            
            header.innerHTML = `
                <span class="t" data-i18n-key="suggestions" style="font-weight: 600; font-size: 14px; color: var(--ql-text-color);">Suggestions</span>
                <button class="ql-mention-close-btn" type="button" aria-label="Close" style="background: transparent; border: none; cursor: pointer; color: var(--ql-icon-color, #333); display: flex; align-items: center; padding: 4px;">
                    <span class="ql-icons-outlined">close</span>
                </button>
            `;
            box.prepend(header);

            const closeBtn = header.querySelector('.ql-mention-close-btn');
            closeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (box && box.parentNode) {
                    box.remove();
                    eventBus.emit('MENTION_CLOSED');
                }
            });

            if (typeof UiModule.addElementHeaderUI === 'function') {
                UiModule.addElementHeaderUI(box);
            }
        }
        
        const ul = box.querySelector('ul');
        ul.innerHTML = '';

        if (profiles && profiles.length > 0) {
            const fragment = document.createDocumentFragment();

            profiles.forEach(p => {
                const style = p.picture ? `background-image: url('${p.picture}')` : '';
                const content = p.picture ? '' : (p.name?.substring(0, 2).toUpperCase() || '');

                const li = document.createElement('li');
                li.className = 'ql-profile__user-card';
                li.setAttribute('tabindex', '0');
                li.dataset.memberId = p.author;

                li.innerHTML = `
                    <div class="ql-profile__list-avatar" style="${style}" data-member-id="${p.author}" data-l="1">${content}</div>
                    <div class="ql-profile__list-info">
                        <span class="ql-profile__list-name">${p.name}</span>
                        <span class="ql-profile__list-sub">${p.given_name || ''} ${p.family_name || ''}</span>
                    </div>`;

                li.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (onSelectProfile) onSelectProfile(p.author, input);
                    if (box && box.parentNode) {
                        box.remove();
                        eventBus.emit('MENTION_CLOSED');
                    }
                });

                fragment.appendChild(li);
            });

            ul.appendChild(fragment);
        } else {
            ul.innerHTML = `<li class="ql-empty-container t" data-i18n-key="noResultsForQuery">${I18n.getTranslation('noResultsForQuery') || 'No results found'}</li>`;
        }

        const closeHandler = () => {
            const textUpToCursor = input.value?.slice(0, input.selectionStart);
            const match = textUpToCursor?.match(/@(\w*)$/);
            
            if (!match) {
                if (box && box.parentNode) {
                    box.remove();
                    eventBus.emit('MENTION_CLOSED');
                }
                input.removeEventListener('input', closeHandler);
            }
        };
        input.addEventListener('input', closeHandler);

        I18n.translateElement(box);
    },

    /**
     * Transitions a blocked-list item to an "unblocked" visual state and schedules
     * its automatic removal from the DOM after a 5-second grace period.
     * During the grace period the button label changes to "Block", allowing the user
     * to immediately re-block the member from the same location.
     * If the member is re-blocked before the timer fires the scheduled removal is
     * cancelled and the item is kept in the list (handled by destroyElementsByUI).
     * @param {string|number} memberId - The member whose list item should be removed.
     */
    scheduleBlockedUserRemovalUI: (memberId) => {
        const idStr = String(memberId);
        const container = document.querySelector('.ql-profile__content.blocked ul');
        if (!container) return;

        const item = container.querySelector(`li[data-member-id="${idStr}"]`);
        if (!item) return;

        const btn = item.querySelector('.unblock-button');
        if (!btn || btn.classList.contains('unblocked-state')) return;

        btn.classList.add('unblocked-state');
        btn.disabled = false;

        const iconSpan = btn.querySelector('.ql-icons-outlined');
        if (iconSpan) {
            import('../../ui/icons.js').then(m => {
                const svg = m.default.getIconSvg('lock');
                if (svg) { iconSpan.innerHTML = svg; iconSpan.classList.add('ql-svg-icon'); }
                else { iconSpan.textContent = 'lock'; iconSpan.classList.remove('ql-svg-icon'); }
            });
        }

        const label = btn.querySelector('.legend');
        if (label) {
            label.setAttribute('data-i18n-key', 'block');
            label.textContent = I18n.getTranslation('block') || 'Block';
        }

        const badge = document.querySelector('.ql-profile__dropdown-item[data-tab="blocked"] .ql-profile__dropdown-badge');
        if (badge) badge.textContent = Math.max(0, parseInt(badge.textContent || '0') - 1);

        if (ProfileUiModule._unblockRemovalTimers.has(idStr)) {
            clearTimeout(ProfileUiModule._unblockRemovalTimers.get(idStr));
        }

        const timerId = setTimeout(() => {
            ProfileUiModule._unblockRemovalTimers.delete(idStr);
            const currentItem = container.querySelector(`li[data-member-id="${idStr}"]`);
            if (currentItem) {
                const currentBtn = currentItem.querySelector('.unblock-button');
                if (currentBtn && currentBtn.classList.contains('unblocked-state')) {
                    currentItem.remove();
                }
            }
        }, 5000);

        ProfileUiModule._unblockRemovalTimers.set(idStr, timerId);
    },

    /**
     * Sets up event listeners for file inputs relative to modifying the own profile pictures.
     * @param {HTMLElement} container - Target container.
     * @private
     */
    _setupOwnProfileControlsUI: (container) => {
        const editTrigger = container.querySelector('#ql-profile-edit-trigger');
        if (editTrigger) { 
            editTrigger.onclick = async (e) => { 
                e.preventDefault(); 
                e.stopImmediatePropagation(); 
                const ProfileModule = await getProfileModule(); 
                GuardModule.protect(() => ProfileModule.showEditProfileModal()); 
            }; 
        }
        
        ['avatar', 'background'].forEach(type => {
            const selector = type === 'avatar' ? CONSTANTS.SELECTORS.AVATAR : CONSTANTS.SELECTORS.HEADER; 
            const btnSelector = type === 'avatar' ? '.ql-profile__avatar-edit' : '.ql-profile__header-edit';
            const targetEl = container.querySelector(selector); 
            const btnEl = container.querySelector(btnSelector);
            
            if (!targetEl || !btnEl) return;
            
            const inp = UiModule.createElementUI({ tag: 'input', attributes: { type: 'file', accept: 'image/*' }, styles: { display: 'none' } });
            
            inp.onchange = (e) => {
                const file = e.target.files[0]; if (!file) return; const objectUrl = URL.createObjectURL(file);
                GuardModule.protect(() => {
                    ImageCropper.create({
                        imageSrc: objectUrl, type: type,
                        onConfirm: async (cropData) => { 
                            URL.revokeObjectURL(objectUrl); 
                            const ProfileModule = await getProfileModule(); 
                            targetEl.classList.add(CONSTANTS.CLASSES.PROCESSING);
                            if (type === 'avatar') {
                                cropData.targetWidth = CONSTANTS.AVATAR_SIZE;
                                cropData.targetHeight = CONSTANTS.AVATAR_SIZE;
                            } else {
                                cropData.targetWidth = CONSTANTS.BANNER_W;
                                cropData.targetHeight = CONSTANTS.BANNER_H;
                            }

                            ProfileModule.handleImageProcessed(file, cropData, type); 
                        },
                        onCancel: () => { URL.revokeObjectURL(objectUrl); inp.value = ''; }
                    });
                });
            };

            btnEl.onclick = () => GuardModule.protect(() => {
                inp.value = '';
                inp.click();
            }); 

            if(type === 'avatar') {
                container.querySelector(CONSTANTS.SELECTORS.AVATAR_BOX).appendChild(inp);
            } else {
                targetEl.appendChild(inp);
            }
        });
    },
    
    /**
     * Manages tab visibility depending on the viewed user role and privileges.
     * @param {HTMLElement} container - Interface container.
     * @param {Object} userProfile - Profile being rendered.
     * @param {boolean} isOwn - If it is the authorized user.
     * @private
     */
    _updateTabsVisibilityUI: (container, userProfile, isOwn) => {
        const tabs = container.querySelectorAll('.ql-profile__tab[data-tab]'); const contents = container.querySelectorAll('.ql-profile__content'); const hideActivity = !userProfile.activity && !isOwn;
        ['blocked', 'follow-request', 'bookmarks', 'followers', 'followed'].forEach(k => {
             const item = container.querySelector(`.ql-profile__dropdown-item[data-tab="${k}"]`); if (item) item.style.display = isOwn ? 'flex' : 'none';
             const tab = container.querySelector(`.ql-profile__tab[data-tab="${k}"]`); if (tab) tab.style.display = isOwn ? 'flex' : 'none';
        });
        tabs.forEach(t => { const type = t.dataset.tab; if (['comments', 'likes', 'shares'].includes(type)) { t.style.display = hideActivity ? 'none' : 'flex'; } });
        let activeTab = container.querySelector(`.${CONSTANTS.CLASSES.ACTIVE_TAB}`);
        if (!activeTab || activeTab.style.display === 'none') {
            tabs.forEach(t => t.classList.remove(CONSTANTS.CLASSES.ACTIVE_TAB.split(' ')[0])); contents.forEach(c => c.classList.remove(CONSTANTS.CLASSES.ACTIVE_CONTENT.split(' ')[0]));
            const firstVisible = Array.from(tabs).find(t => t.style.display !== 'none');
            if (firstVisible) {
                firstVisible.classList.add(CONSTANTS.CLASSES.ACTIVE_TAB); const type = firstVisible.dataset.tab; const contentId = type === 'follow' ? 'follower' : type;
                container.querySelector(`.ql-profile__content.${contentId}`)?.classList.add(CONSTANTS.CLASSES.ACTIVE_CONTENT);
            }
        }
    },

    /**
     * Registers click listeners for tab navigation in profile UI.
     * @param {HTMLElement} container - Container with tabbed navigation elements.
     * @private
     */
    _initializeProfileTabsUI: (container) => {
        if (!container || container._tabsInitialized) return; container._tabsInitialized = true;
        container.addEventListener('click', async (e) => {
            const dropdownTab = e.target.closest('.ql-profile__tab--dropdown');
            if (dropdownTab) {
                const menu = dropdownTab.querySelector('.ql-profile__dropdown-menu');
                if (menu && !e.target.closest('.ql-profile__dropdown-item')) { e.stopPropagation(); const isVisible = menu.style.display === 'block'; container.querySelectorAll('.ql-profile__dropdown-menu').forEach(m => m.style.display = 'none'); menu.style.display = isVisible ? 'none' : 'block'; return; }
            } else { container.querySelectorAll('.ql-profile__dropdown-menu').forEach(m => m.style.display = 'none'); }
            const tabTarget = e.target.closest('[data-tab]');
            if (tabTarget && !tabTarget.closest('.ql-profile__content')) {
                if (tabTarget.closest('.ql-profile__dropdown-menu')) { container.querySelectorAll('.ql-profile__dropdown-menu').forEach(m => m.style.display = 'none'); }
                const tabId = tabTarget.dataset.tab;
                if (tabId === 'followers') { import('../../ui/ui.js').then(m => m.default.searchFollowRequestDrawerUI.open()); return; }
                if (tabId && tabId !== 'follow') {
                    container.querySelectorAll('.ql-profile__tab').forEach(t => t.classList.remove(CONSTANTS.CLASSES.ACTIVE_TAB)); container.querySelectorAll('.ql-profile__content').forEach(c => c.classList.remove(CONSTANTS.CLASSES.ACTIVE_CONTENT));
                    let header = tabTarget.closest('.ql-profile__tab'); if (!header) { header = container.querySelector('.ql-profile__tab--dropdown'); } if (header) header.classList.add(CONSTANTS.CLASSES.ACTIVE_TAB);
                    const content = container.querySelector(`.ql-profile__content.${tabId}`); if (content) content.classList.add(CONSTANTS.CLASSES.ACTIVE_CONTENT);
                    if (tabId === 'blocked') { const ul = content.querySelector('ul'); if (!ul.children.length) { import('../../core/core.js').then(c => c.default.postWorkerMessage({ action: 'getBlocked', payload: {} })); } }
                }
            }
        });
    },

    /**
     * Binds real-time search filtering handlers in corresponding input fields.
     * @param {HTMLElement} container - Parent element containing inputs.
     * @private
     */
    _setupSearchHandlers: (container) => {
        const inputs = container.querySelectorAll(CONSTANTS.SELECTORS.SEARCH_INPUT);
        inputs.forEach(input => {
            if (input._handler) input.removeEventListener('input', input._handler);
            const handler = UtilsModule.debounce(async (e) => {
                const term = e.target.value.trim().toLowerCase(); const contentDiv = e.target.closest('.ql-profile__content'); const list = contentDiv.querySelector('ul'); const tabType = Array.from(contentDiv.classList).find(c => !c.includes('ql-profile') && c !== 'active'); const memberId = container.dataset.profileMemberId;
                if (!list._originalItems) { list._originalItems = Array.from(list.children).map(c => c.cloneNode(true)); }
                list.innerHTML = ''; const filtered = list._originalItems.filter(item => item.textContent.toLowerCase().includes(term)); filtered.forEach(item => list.appendChild(item.cloneNode(true)));
                const visibleCount = filtered.length; 
                if (term && visibleCount < 5) { UiModule.addLoadingMessageUI(list, { type: 'profile', position: 'after', empty: visibleCount === 0 }); const ProfileModule = await getProfileModule(); ProfileModule.searchProfileData(memberId, tabType, term); }
            }, 800);
            input._handler = handler; input.addEventListener('input', handler);
        });
    },

    /**
     * Listens for interaction events at the container level to run action handlers based on class matches.
     * @param {HTMLElement} container - Master element wrapping actionable nodes.
     * @private
     */
    _setupDelegatedActions: (container) => {
        if (!container || container.dataset.delegationActive === 'true') return;
        container.dataset.delegationActive = 'true';

        container.addEventListener('click', async (e) => {
            const chatBtn = e.target.closest('.start-chat-button');
            if (chatBtn) {
                e.preventDefault(); e.stopPropagation();
                const memberId = chatBtn.dataset.memberId;
                
                const isMember = !!container.closest(CONSTANTS.SELECTORS.MEMBER_CONTAINER);
                if (isMember && UiModule.memberDrawerUI) UiModule.memberDrawerUI.close();
                else if (UiModule.profileDrawerUI) UiModule.profileDrawerUI.close();

                const ChatModule = window.QueloraApp?.Modules?.ChatModule;
                
                if (ChatModule) {
                    if (UiModule.chatsDrawerUI) UiModule.chatsDrawerUI.open();
                    ChatModule.setActiveConversation(memberId);
                } else {
                    handleLog('Chat module not available (Community Edition fallback).', 'ProfileUI', 'info');
                }
                return;
            }

            const followBtn = e.target.closest('.follow-button');
            if (followBtn) {
                e.preventDefault(); e.stopPropagation();
                if(followBtn.disabled) return;
                
                const memberId = followBtn.dataset.memberId;
                const state = followBtn.dataset.followState;
                const ProfileModule = await getProfileModule();
                
                GuardModule.protect(() => {
                    document.querySelectorAll(`.follow-button[data-member-id="${memberId}"]`).forEach(b => b.disabled = true);
                    ProfileModule.handleFollowClick(memberId, state);
                });
                return;
            }

            const unblockBtn = e.target.closest('.unblock-button');
            if (unblockBtn) {
                e.preventDefault(); e.stopPropagation();

                if (unblockBtn.disabled) return;
                unblockBtn.disabled = true;

                const memberId = unblockBtn.dataset.memberId;
                const isUnblocked = unblockBtn.classList.contains('unblocked-state');

                GuardModule.protect(async () => {
                    if (isUnblocked) {
                        import('../../core/core.js').then(c => {
                            c.default.postWorkerMessage({
                                action: 'blockUser',
                                payload: { memberId: memberId, blocked_author: memberId }
                            });
                        });
                    } else {
                        const ProfileModule = await getProfileModule();
                        ProfileModule.handleUnblockClick(memberId);
                    }
                });
                return;
            }

            const removeSuggBtn = e.target.closest('.remove-suggestion');
            if (removeSuggBtn) {
                e.preventDefault(); e.stopPropagation();
                const memberId = removeSuggBtn.dataset.memberId;
                const ProfileModule = await getProfileModule();
                GuardModule.protect(() => {
                    const item = removeSuggBtn.closest('.suggestion-item');
                    if (item) {
                        item.style.opacity = '0';
                        item.style.transform = 'translateX(-20px)';
                        item.style.transition = 'opacity 0.3s, transform 0.3s';
                        setTimeout(() => {
                            item.remove();
                            if (container.querySelectorAll('.suggestion-item').length === 0) {
                                container.innerHTML = `<div class="ql-empty-container t">{{noResults}}</div>`;
                                I18n.translateElement(container);
                            }
                        }, 300);
                    }
                    ProfileModule.removeSuggestion(memberId);
                });
                return;
            }

            const avatarLink = e.target.closest('.ql-profile__list-avatar[data-member-id]');
            if (avatarLink && !e.target.closest('button')) {
                e.preventDefault(); e.stopPropagation();
                const ProfileModule = await getProfileModule();
                ProfileModule.getProfile(avatarLink.dataset.memberId);
                return;
            }
        });
    },

    /**
     * Alters follow button UI components across view containers reflecting new operational state.
     * @param {string} memberId - Processed Member's unique identifier.
     * @param {string} state - Operation state resolving UI logic structure.
     * @param {string} iconName - Resolved string name used by internal Icon Manager module.
     * @param {string} textKey - Translated text matching required application key reference.
     */
    updateFollowButtonStateUI: (memberId, state, iconName, textKey) => {
        document.querySelectorAll(`.follow-button[data-member-id="${memberId}"]`).forEach(btn => {
            btn.dataset.followState = state;
            btn.disabled = false;
            btn.classList.remove('ql-btn--active', 'ql-btn--pending');
            
            if (state === 'following') btn.classList.add('ql-btn--active');
            if (state === 'pending') btn.classList.add('ql-btn--active', 'ql-btn--pending');

            const iconSpan = btn.querySelector('.ql-icons-outlined');
            if (iconSpan) {
                const svg = IconsModule.getIconSvg(iconName);
                if (svg) {
                    iconSpan.innerHTML = svg;
                    iconSpan.classList.add('ql-svg-icon');
                } else {
                    iconSpan.textContent = iconName;
                    iconSpan.classList.remove('ql-svg-icon');
                }
            }

            const label = btn.querySelector('.legend');
            if (label) {
                label.setAttribute('data-i18n-key', textKey);
                label.textContent = I18n.getTranslation(textKey);
            }
        });
    },

    resetCommentLikeIconsUI: (...args) => CommentsUiModule.resetCommentLikeIconsUI(...args),
    
    /**
     * Removes DOM elements associated with a blocked author from all non-blocked-tab contexts.
     * When the author's card is found inside the blocked tab and carries the `unblocked-state`
     * class, the button is restored to its default unblock appearance — indicating a successful
     * re-block operation confirmed by the backend.
     * @param {string} id - The author ID whose elements should be purged or restored.
     */
    destroyElementsByUI: (id) => {
        const idStr = String(id);
        const selectors = [
            `.suggestion-item[data-member-id="${idStr}"]`,
            `.follower-item[data-member-id="${idStr}"]`
        ];
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => el.remove());
        });

        const listSelectors = [
            `.ql-profile__list-item [data-author-id="${idStr}"]`,
            `.ql-profile__list-item [data-member-id="${idStr}"]`
        ];

        listSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                const thread = el.closest('.ql-profile__list-item');
                if (thread && !thread.closest('.ql-profile__content.blocked')) {
                    thread.remove();
                }
            });
        });

        document.querySelectorAll(`.ql-profile__user-card[data-member-id="${idStr}"]`).forEach(el => {
            if (!el.closest('.ql-profile__content.blocked')) {
                el.remove();
            } else {
                const btn = el.querySelector('.unblock-button');
                if (btn && btn.classList.contains('unblocked-state')) {
                    btn.classList.remove('unblocked-state');
                    btn.disabled = false;

                    const iconSpan = btn.querySelector('.ql-icons-outlined');
                    if (iconSpan) {
                        import('../../ui/icons.js').then(m => {
                            const svg = m.default.getIconSvg('unlock');
                            if (svg) { iconSpan.innerHTML = svg; iconSpan.classList.add('ql-svg-icon'); }
                            else { iconSpan.textContent = 'unlock'; iconSpan.classList.remove('ql-svg-icon'); }
                        });
                    }
                    const label = btn.querySelector('.legend');
                    if (label) {
                        label.setAttribute('data-i18n-key', 'unblock');
                        label.textContent = I18n.getTranslation('unblock') || 'Unblock';
                    }

                    const badge = document.querySelector('.ql-profile__dropdown-item[data-tab="blocked"] .ql-profile__dropdown-badge');
                    if (badge) badge.textContent = parseInt(badge.textContent || '0') + 1;

                    if (ProfileUiModule._unblockRemovalTimers.has(idStr)) {
                        clearTimeout(ProfileUiModule._unblockRemovalTimers.get(idStr));
                        ProfileUiModule._unblockRemovalTimers.delete(idStr);
                    }
                }
            }
        });

        if (CommentsUiModule && typeof CommentsUiModule.destroyElementsByUI === 'function') {
            CommentsUiModule.destroyElementsByUI(id);
        }
    },

    /**
     * Builds and attaches the profile dropup menu to a trigger element.
     *
     * When called without arguments the function resolves the trigger via the
     * community navigation bar (legacy behaviour, unchanged).  When called with
     * an explicit `targetElement` the dropup is attached to that element instead,
     * enabling external callers — such as the auth-widget — to reuse the same
     * menu without coupling to the community UI DOM structure.
     *
     * The function is idempotent: calling it twice on the same element is safe
     * because the dropup is cached on `targetElement._qlDropup` and the click
     * listener is guarded by `data-ql-dropup-initialized`.
     *
     * @param {HTMLElement|null} [targetElement=null] - Explicit trigger element.
     * When null, the community nav `.profile-settings` button is used.
     */
    createProfileDropupUI: (targetElement = null) => {
        let profileButton;
        if (targetElement) {
            profileButton = targetElement;
        } else {
            const communityUI = UiModule.getCommunityUI();
            profileButton = communityUI?.querySelector(CONSTANTS.SELECTORS.NAV_PROFILE_BTN);
        }
        if (!profileButton) return;

        let dropup = profileButton._qlDropup; 
        
        if (!dropup) {
            dropup = document.createElement('div');
            dropup.className = 'ql-profile-dropup';
            dropup.style.display = 'none'; 
            
            const menuItems = [
                { action: 'view-profile', icon: 'person', text: 'myProfile' },
                { action: 'settings', icon: 'settings', text: 'settings' },
                { action: 'activity', icon: 'notifications', text: 'showActivity' },
                { divider: true },
                { action: 'follow-request', icon: 'person_add', text: 'followRequest' },
                { action: 'followers', icon: 'person_search', text: 'searchAccounts' },
                { divider: true },
                { action: 'logout', icon: 'logout', text: 'logout' }
            ];
            
            const list = document.createElement('ul');
            list.className = 'ql-profile-dropup__menu';
            
            menuItems.forEach(item => {
                if (item.divider) {
                    const li = document.createElement('li'); li.className = 'ql-profile-dropup__divider'; list.appendChild(li);
                } else {
                    const li = document.createElement('li'); li.className = 'ql-profile-dropup__item'; li.dataset.action = item.action;
                    li.innerHTML = `<span class="ql-icons-outlined">${item.icon}</span><span class="t">{{${item.text}}}</span>`; list.appendChild(li);
                }
            });
            dropup.appendChild(list);
            
            dropup.querySelectorAll('.ql-profile-dropup__item').forEach(item => {
                item.addEventListener('click', async (e) => {
                    e.stopPropagation(); 
                    const action = item.dataset.action; 
                    
                    dropup.classList.remove(CONSTANTS.CLASSES.DROPUP_VISIBLE);
                    dropup.style.display = 'none';

                    const ProfileModule = await getProfileModule(); 
                    const Drawers = UiModule; 
                    
                    const actions = {
                        'view-profile': () => GuardModule.protect(() => ProfileModule.getMyProfile()),
                        'settings': () => GuardModule.protect(() => { ProfileUiModule.updateSettingsUI(null); Drawers.settingsDrawerUI.open(); }), 
                        'activity': async () => { 
                            const profile = await ProfileModule.getOwnProfile();
                            const webEnabled = profile?.settings?.notifications?.web !== false;
                            
                            if (webEnabled) {
                                Drawers.notificationDrawerUI.open(); 
                                ProfileModule.fetchFollowingActivities(true);
                            } else {
                                import('../../ui/toast.js').then(tm => tm.default.info('notifications_off', I18n.getTranslation('notifications'), I18n.getTranslation('notificationsDisabled')));
                            }
                        },
                        'followers': () => GuardModule.protect(() => Drawers.searchFollowRequestDrawerUI.open()),
                        'follow-request': () => GuardModule.protect(() => { ProfileModule.renderFollowRequests(); Drawers.followRequestDrawerUI.open(); }),
                        'logout': () => ProfileModule.logout()
                    };
                    if (actions[action]) actions[action]();
                });
            });

            profileButton._qlDropup = dropup;
        }

        if (!profileButton.contains(dropup)) {
            profileButton.appendChild(dropup);
        }

        if (profileButton.dataset.qlDropupInitialized === 'true') return;
        profileButton.dataset.qlDropupInitialized = 'true';
        profileButton.onclick = null; 

        profileButton.addEventListener('click', (e) => {
            if (e.target.closest(CONSTANTS.SELECTORS.NAV_PROFILE_BTN)) {
                e.stopPropagation(); 
                
                const currentDropup = profileButton._qlDropup;
                if (!currentDropup) return;

                requestAnimationFrame(() => {
                    const isVisible = currentDropup.classList.contains(CONSTANTS.CLASSES.DROPUP_VISIBLE);
                    
                    if (isVisible) {
                        currentDropup.classList.remove(CONSTANTS.CLASSES.DROPUP_VISIBLE);
                        setTimeout(() => currentDropup.style.display = 'none', 200); 
                    } else {
                        currentDropup.style.display = 'block';
                        void currentDropup.offsetWidth; 
                        currentDropup.classList.add(CONSTANTS.CLASSES.DROPUP_VISIBLE);
                    }
                });
            }
        });

        if (!_GlobalHandlers.clickBound) {
            document.addEventListener('click', _GlobalHandlers.handleDocumentClick);
            _GlobalHandlers.clickBound = true;
        }
    },

    /**
     * Updates navigation bar graphic elements assigned with initialized payload references.
     * @param {Object} data - Profile mapped configurations and auto-generated data schemas.
     */
    updateNavbarAvatarUI: (data) => {
        const communityUI = UiModule.getCommunityUI();
        if (!communityUI) return;

        const inputContainer = communityUI.querySelector(CONSTANTS.SELECTORS.INPUT_CONTAINER);
        if (inputContainer) {
            const settingsBtn = inputContainer.querySelector(CONSTANTS.SELECTORS.GENERAL_SETTINGS_BTN);
            if (settingsBtn) settingsBtn.style.display = 'none';
        } else {
             const generalSettings = communityUI.querySelector(CONSTANTS.SELECTORS.GENERAL_SETTINGS_BTN);
             if (generalSettings) generalSettings.style.display = 'none';
        }

        const profileBtn = communityUI.querySelector(CONSTANTS.SELECTORS.NAV_PROFILE_BTN);
        if (!profileBtn) return;
        
        profileBtn.style.display = 'flex';
        
        const { profile, generatedAvatar } = data;
        
        Array.from(profileBtn.children).forEach(child => {
            if (!child.classList.contains('ql-profile-dropup')) {
                child.remove();
            }
        });
        
        profileBtn.classList.remove('ql-icons-outlined', 'ql-svg-icon');
        
        if (profile && profile.picture) {
            Object.assign(profileBtn.style, { backgroundImage: `url('${profile.picture}')`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' });
            profileBtn.classList.remove(CONSTANTS.CLASSES.AVATAR_INITIALS);
        } else if (generatedAvatar) {
             Object.assign(profileBtn.style, { backgroundImage: `url('${generatedAvatar}')`, backgroundSize: 'cover', backgroundPosition: 'center' });
             profileBtn.classList.add(CONSTANTS.CLASSES.AVATAR_INITIALS);
        }

        ProfileUiModule.createProfileDropupUI();
    },

    /**
     * Updates settings DOM values from targeted application components.
     * @param {Object} profile - Full user profile required.
     */
    updateSettingsUI: (profile) => {
        if (!profile) {
            getProfileModule().then(m => m.getOwnProfile().then(p => { if(p) ProfileUiModule.updateSettingsUI(p); }));
            return;
        }
        const container = document.getElementById('ql-community-settings');
        if (!container) return;

        const getValue = (path, obj) => path.split('.').reduce((acc, k) => acc && acc[k], obj);
        
        const settingPathMap = {
            'notifications.web': 'notifications.web', 
            'notifications.email': 'notifications.email', 
            'notifications.push': 'notifications.push',
            'notifications.types.replies': 'notifications.comments', 
            'notifications.types.likes': 'notifications.postLikes',
            'notifications.types.newFollowers': 'notifications.newFollowers', 
            'notifications.types.newPosts': 'notifications.newPost',
            'session.rememberSession': 'session.rememberSession',
            'followerApproval': 'privacy.followerApproval'
        };

        container.querySelectorAll('input.ql-switch__input[data-setting-key]').forEach(input => {
            const key = input.dataset.settingKey;
            const realPath = settingPathMap[key] || key;
            input.checked = !!getValue(realPath, profile.settings);
        });

        container.querySelectorAll('.ql-settings__btn-group').forEach(group => {
            const key = group.dataset.settingKey; 
            const groupName = group.dataset.settingGroup; 
            
            const realKey = key === 'activityVisibility' ? 'showActivity' : key;
            const val = profile.settings?.[groupName]?.[realKey] || 'everyone';
            
            group.querySelectorAll('.ql-settings__btn').forEach(btn => {
                const isActive = btn.dataset.value === val;
                if (isActive) btn.classList.add(CONSTANTS.CLASSES.BTN_ACTIVE.split(' ')[0]); 
                else btn.classList.remove(CONSTANTS.CLASSES.BTN_ACTIVE.split(' ')[0]);
            });
        });

        const localTheme = StorageModule.getLocalItem('ql_theme');
        const currentTheme = localTheme || profile.settings?.interface?.defaultTheme || 'system';
        
        container.querySelectorAll('.ql-settings__theme-btn').forEach(btn => {
            if (btn.dataset.theme === currentTheme) btn.classList.add(CONSTANTS.CLASSES.THEME_ACTIVE);
            else btn.classList.remove(CONSTANTS.CLASSES.THEME_ACTIVE);
        });

        ProfileUiModule._bindSettingsEvents(container);
    },

    /**
     * Adds event bindings locally to settings UI changes to notify backend automatically.
     * @param {HTMLElement} container - Elements target parent wrapper.
     * @private
     */
    _bindSettingsEvents: (container) => {
        if (container.dataset.eventsBound === "true") return;
        container.dataset.eventsBound = "true";
        
        container.addEventListener('change', async (e) => {
             const target = e.target; const ProfileModule = await getProfileModule();
             if (target.matches('.ql-switch__input')) {
                 const key = target.dataset.settingKey; 
                 const apiPath = key === 'followerApproval' ? 'privacy.followerApproval' : `settings.${key}`;
                 
                 ProfileModule.updateSetting(apiPath, target.checked);
                 
                 if (key === 'notifications.push') { target.checked ? await NotificationModule.subscribeToPushNotifications() : await NotificationModule.unsubscribeFromPushNotifications(); }
                 
                 if (key === 'notifications.web') {
                     import('../../ui/ui.js').then(({ default: Ui }) => {
                         Ui.toggleActivityMenuItem(target.checked);
                         if (!target.checked && Ui.notificationDrawerUI && Ui.notificationDrawerUI.element.classList.contains('active')) {
                             Ui.notificationDrawerUI.close();
                         }
                     });
                 }
             }
             if (target.matches('select[data-setting-action="language-change"]')) {
                 ProfileModule.updateSetting('settings.interface.defaultLanguage', target.value);
                 I18n.changeLanguage(target.value);
             }
        });

        container.addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            
            if (btn.classList.contains('ql-settings__btn')) {
                const group = btn.closest('.ql-settings__btn-group');
                if (!group) return;

                e.preventDefault();
                e.stopPropagation();

                const activeClass = CONSTANTS.CLASSES.BTN_ACTIVE.split(' ')[0];
                group.querySelectorAll('.ql-settings__btn').forEach(b => b.classList.remove(activeClass));
                btn.classList.add(activeClass);

                const key = group.dataset.settingKey;
                const groupName = group.dataset.settingGroup;
                const value = btn.dataset.value;
                const apiPath = `settings.${groupName}.${key}`; 
                
                const ProfileModule = await getProfileModule();
                ProfileModule.updateSetting(apiPath, value);
                return;
            }

            if (btn.classList.contains('ql-settings__theme-btn')) {
                const group = btn.parentElement;
                if (!group) return;
                
                group.querySelectorAll('.ql-settings__theme-btn').forEach(b => b.classList.remove(CONSTANTS.CLASSES.THEME_ACTIVE));
                btn.classList.add(CONSTANTS.CLASSES.THEME_ACTIVE);
            }
        });
    },

    /**
     * Refreshes internal visual nodes tied with member specific assets.
     * @param {Object} ownProfile - The locally authorized member profile.
     */
    updateProfileUI: (ownProfile) => {
        if (!ownProfile) return;
        const rnd = `?${Math.random()}`;
        const assetBaseUrl = ConfModule.get('assetBaseUrl');
        const isSquared = ownProfile.avatarFrameType === 'SQUARED';
        const initials = (ownProfile.name || '').split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
        
        document.querySelectorAll(`.ql-profile .${CONSTANTS.CLASSES.PROCESSING}`).forEach(el => el.classList.remove(CONSTANTS.CLASSES.PROCESSING));

        document.querySelectorAll(`${CONSTANTS.SELECTORS.PROFILE_CONTAINER} ${CONSTANTS.SELECTORS.AVATAR}, ${CONSTANTS.SELECTORS.MEMBER_CONTAINER} ${CONSTANTS.SELECTORS.AVATAR}`).forEach(el => {
            const parentContainer = el.closest('.ql-profile');
            if (parentContainer && parentContainer.dataset.profileMemberId === ownProfile.author) {
                 el.style.backgroundImage = ownProfile.picture ? `url(${ownProfile.picture}${rnd})` : '';
                 el.textContent = ownProfile.picture ? '' : initials;
                 if (isSquared) el.classList.add(CONSTANTS.CLASSES.SQUARED); 
                 else el.classList.remove(CONSTANTS.CLASSES.SQUARED);
            }
        });
        
        document.querySelectorAll(`${CONSTANTS.SELECTORS.PROFILE_CONTAINER} ${CONSTANTS.SELECTORS.HEADER}, ${CONSTANTS.SELECTORS.MEMBER_CONTAINER} ${CONSTANTS.SELECTORS.HEADER}`).forEach(el => { 
             const parentContainer = el.closest('.ql-profile');
             if (parentContainer && parentContainer.dataset.profileMemberId === ownProfile.author) {
                 if (ownProfile.background) el.style.backgroundImage = `url(${ownProfile.background}${rnd})`; 
             }
        });
        
        document.querySelectorAll(`${CONSTANTS.SELECTORS.PROFILE_CONTAINER} .ql-profile__frame, ${CONSTANTS.SELECTORS.MEMBER_CONTAINER} .ql-profile__frame`).forEach(frame => {
             const parentContainer = frame.closest('.ql-profile');
             if (parentContainer && parentContainer.dataset.profileMemberId === ownProfile.author) {
                 if (ownProfile.avatarFrameUrl) { 
                     frame.style.backgroundImage = `url('${assetBaseUrl}/${ownProfile.avatarFrameUrl}')`; 
                     frame.style.display = 'block';
                     if (isSquared) frame.classList.add(CONSTANTS.CLASSES.SQUARED); 
                     else frame.classList.remove(CONSTANTS.CLASSES.SQUARED); 
                 } else { 
                     frame.style.display = 'none'; 
                 }
             }
        });
        
        document.querySelectorAll(`.input-container ${CONSTANTS.SELECTORS.NAV_PROFILE_BTN}`).forEach(el => {
            el.style.backgroundImage = ownProfile.picture ? `url(${ownProfile.picture}${rnd})` : '';
            if (!ownProfile.picture) el.classList.add(CONSTANTS.CLASSES.AVATAR_INITIALS);
            else el.classList.remove(CONSTANTS.CLASSES.AVATAR_INITIALS);
        });

        const listAvatars = document.querySelectorAll(`${CONSTANTS.SELECTORS.LIST_AVATAR}[data-member-id="${ownProfile.author}"]`);
        listAvatars.forEach(avatarEl => {
            avatarEl.style.backgroundImage = ownProfile.picture ? `url('${ownProfile.picture}${rnd})` : '';
            avatarEl.textContent = ownProfile.picture ? '' : initials;

            if (isSquared) avatarEl.classList.add(CONSTANTS.CLASSES.LIST_SQUARED);
            else avatarEl.classList.remove(CONSTANTS.CLASSES.LIST_SQUARED);

            const wrapper = avatarEl.closest(CONSTANTS.SELECTORS.LIST_WRAPPER);
            if (wrapper) {
                const frameEl = wrapper.querySelector(CONSTANTS.SELECTORS.LIST_FRAME);
                if (frameEl) {
                    if (ownProfile.avatarFrameUrl) {
                        frameEl.style.backgroundImage = `url('${assetBaseUrl}/${ownProfile.avatarFrameUrl}')`;
                        frameEl.style.display = 'block';
                        if (isSquared) frameEl.classList.add(CONSTANTS.CLASSES.SQUARED_FRAME);
                        else frameEl.classList.remove(CONSTANTS.CLASSES.SQUARED_FRAME);
                    } else {
                        frameEl.style.display = 'none';
                    }
                }
            }
        });

        const listNames = document.querySelectorAll(`${CONSTANTS.SELECTORS.LIST_NAME}[data-member-id="${ownProfile.author}"]`);
        listNames.forEach(el => {
            el.textContent = ownProfile.name;
        });

        const containers = document.querySelectorAll('.ql-profile');
        containers.forEach(container => {
            if (container.dataset.profileMemberId === ownProfile.author) {
                const nameEl = container.querySelector('.ql-profile__name');
                if (nameEl) {
                     const btn = nameEl.querySelector('button');
                     if (btn) {
                         const textNode = Array.from(nameEl.childNodes).find(n => n.nodeType === Node.TEXT_NODE);
                         if(textNode) textNode.textContent = ownProfile.name + ' ';
                     } else {
                         nameEl.textContent = ownProfile.name;
                     }
                }
            }
        });
    },
    
    /**
     * Resolves the frontend lifecycle hooks when the web worker resolves a background process frame output.
     * @param {Blob} blob - Formatted file instance reference.
     * @param {string} type - Destination configuration type.
     */
    handleProcessedImage: (blob, type) => {
        const objectUrl = URL.createObjectURL(blob);
        const selector = type === 'avatar' ? CONSTANTS.SELECTORS.AVATAR : CONSTANTS.SELECTORS.HEADER;
        const targetEl = document.querySelector(`${CONSTANTS.SELECTORS.PROFILE_CONTAINER} ${selector}`);
        if(targetEl) {
            targetEl.style.backgroundImage = `url(${objectUrl})`;
            targetEl.classList.remove(CONSTANTS.CLASSES.PROCESSING);
        }

        if (type === 'avatar') {
             const communityUI = UiModule.getCommunityUI();
             const profileBtn = communityUI?.querySelector(CONSTANTS.SELECTORS.NAV_PROFILE_BTN);
             if (profileBtn) profileBtn.style.backgroundImage = `url(${objectUrl})`;
        }
    }
};

export default ProfileUiModule;