/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/comments/comments.ui.js */
/**
 * @module Modules/Comments/UI
 * @description Manages UI elements for comments (Headers, Modals, Updates).
 * @version 6.2.0
 */
import handleLog from '../../core/logs.js'; 
import UtilsModule from '../../core/utils.js';
import I18n from '../../core/i18n.js';
import ConfModule from '../../core/conf.js';
import GuardModule from '../../core/guard.js';
import CoreModule from '../../core/core.js';
import CommentsModule from './comments.js';
import UiModule from '../../ui/ui.js';
import { 
    setupModalUI, 
    closeModalUI,
    updateModalFooterUI
} from '../../ui/modal.js';
import ProgressInput from '../../ui/components/progressInput.js';
import { eventBus } from '../../core/event.js';

/** @constant {string} Module log icon — identifies CommentsUI entries in the console. */
const LOG_ICON = '💬';

const SELECTORS = {
    THREAD: 'ql-thread',
    HEADER: 'ql-thread__header',
    BODY: 'ql-thread__body',
    ACTIONS: 'ql-thread__actions',
    LIKE_CONTAINER: 'ql-thread__like',
    LIKE_ICON: 'ql-thread__like-icon',
    LIKE_COUNT: 'ql-thread__like-count',
    REPLIES: 'ql-thread__replies',
    INPUT_BAR: 'ql-comment-bar',
    COMMUNITY_CONTAINER: '.ql-community-threads',
    AVATAR_WRAPPER: '.ql-avatar',
    AVATAR_IMG: '.ql-avatar__image',
    AVATAR_FRAME: '.ql-avatar__frame',
    AUTHOR_NAME: '.ql-thread__author'
};

const CLASSES = {
    SQUARED: 'squared',
    HAS_PICTURE: 'has-picture'
};

const CommentsUiModule = {
    
    updateUserVisuals: (profile) => {
        if (!profile || !profile.author) return;

        const container = document.querySelector(SELECTORS.COMMUNITY_CONTAINER);
        if (!container) return;

        const assetBaseUrl = ConfModule.get('assetBaseUrl');
        const rnd = `?${Math.random().toString(36).substring(7)}`; 
        const isSquared = profile.avatarFrameType === 'SQUARED';
        const authorSelector = `[data-author-id="${profile.author}"]`;

        const wrappers = container.querySelectorAll(`${SELECTORS.AVATAR_WRAPPER}${authorSelector}`);
        
        wrappers.forEach(wrapper => {
            const imgEl = wrapper.querySelector(SELECTORS.AVATAR_IMG);
            if (imgEl) {
                if (profile.picture) {
                    imgEl.style.backgroundImage = `url('${profile.picture}${rnd}')`;
                    imgEl.textContent = '';
                    imgEl.classList.add(CLASSES.HAS_PICTURE);
                } else {
                    const initials = (profile.name || '').split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
                    imgEl.style.backgroundImage = '';
                    imgEl.textContent = initials;
                    imgEl.classList.remove(CLASSES.HAS_PICTURE);
                }

                if (isSquared) imgEl.classList.add(CLASSES.SQUARED);
                else imgEl.classList.remove(CLASSES.SQUARED);
            }

            let frameEl = wrapper.querySelector(SELECTORS.AVATAR_FRAME);
            
            if (profile.avatarFrameUrl) {
                if (!frameEl) {
                    frameEl = document.createElement('div');
                    frameEl.className = 'ql-avatar__frame'; 
                    wrapper.insertBefore(frameEl, wrapper.firstChild); 
                }
                frameEl.style.backgroundImage = `url('${assetBaseUrl}/${profile.avatarFrameUrl}')`;
                if (isSquared) frameEl.classList.add(CLASSES.SQUARED);
                else frameEl.classList.remove(CLASSES.SQUARED);
            } else if (frameEl) {
                frameEl.remove();
            }
        });

        const nameSelector = `${SELECTORS.AUTHOR_NAME}[data-author-user="${profile.author}"]`;
        container.querySelectorAll(nameSelector).forEach(el => {
            el.textContent = profile.name || I18n.getTranslation('user');
        });
    },

    updateCommentLikeUI: (element, isLiked) => {
        if (!element) return;

        let iconEl = null;
        if (element.classList.contains(SELECTORS.LIKE_ICON)) {
            iconEl = element;
        } else {
            iconEl = element.querySelector(`.${SELECTORS.LIKE_ICON}`);
        }

        if (iconEl) {
            iconEl.setAttribute('data-liked', isLiked);
            iconEl.textContent = isLiked ? 'favorite' : 'favorite_border';
            if (isLiked) iconEl.classList.add('active');
            else iconEl.classList.remove('active');
        }
    },

    updateCommentCounterUI: (element, count, isLiked) => {
        if (!element) return;

        let countEl = element.querySelector(`.${SELECTORS.LIKE_COUNT}`);
        if (countEl) {
            if (count === undefined) {
                let current = parseInt(countEl.textContent, 10) || 0;
                count = isLiked ? current + 1 : Math.max(0, current - 1);
            }
            countEl.textContent = UtilsModule.formatNumberAbbreviated(count);
        }
        CommentsUiModule.updateCommentLikeUI(element, isLiked);
    },

    resetCommentLikeIconsUI: () => {
        document.querySelectorAll(`.${SELECTORS.LIKE_ICON}`).forEach(likeIcon => {
            likeIcon.classList.remove('active');
            likeIcon.setAttribute('data-liked', 'false');
            likeIcon.textContent = 'favorite_border';
        });
    },

    /**
     * Opens the edit/report modal for a comment thread element.
     *
     * When `comments.allowGif` is `true` in the SDK configuration, the editable
     * input is instrumented with GIF-insertion support via
     * {@link UtilsModule.makeEditableDivInput}. Any GIFs present at submit time
     * must be extracted by the caller via {@link UtilsModule.extractGifsFromEditable}
     * before sending the comment payload to the server.
     *
     * @param {HTMLElement} commentElement - The `.ql-thread` element to edit or report.
     * @returns {Promise<void>}
     */
    showEditCommentUI: async (commentElement) => {
        try {
            const commentHeader = commentElement.querySelector(`.${SELECTORS.HEADER}`);
            if (!commentHeader) return;

            const threadContainer = commentElement.closest('.ql-community-threads');
            const currentEntity = threadContainer?.getAttribute('data-threads-entity');
            
            const config = UtilsModule.getConfig(currentEntity) || {};
            const { limits = {}, editing = {} } = config;
            const { commentId, canEdit, canDelete, isReply, owner: isOwner } = commentHeader.dataset;

            const { default: ProfileModule } = await import('../profile/profile.js');
            const ownProfile = await ProfileModule.getOwnProfile(false); 
            const authorId = commentElement.getAttribute('data-author-id');
            const isSessionAuthor = ownProfile && ownProfile.author === authorId;

            const bodyContent = document.createElement('div');
            bodyContent.className = 'ql-to-work';

            const clonedCommentElement = commentElement.cloneNode(true);
            [`.${SELECTORS.THREAD}`, `.${SELECTORS.ACTIONS}`, `.${SELECTORS.LIKE_CONTAINER}`, `.${SELECTORS.REPLIES}`].forEach(selector => {
                clonedCommentElement.querySelector(selector)?.remove();
            });
            clonedCommentElement.querySelectorAll('[id^="ql-content-"]').forEach(el => el.removeAttribute('id'));
            bodyContent.appendChild(clonedCommentElement);

            let editInput = null;
            if (canEdit === 'true') {
                const tpl = document.createElement('template');
                tpl.innerHTML = `
                    <div class="edit-container">
                        <div class="input-container">
                            <div contenteditable="true" class="ql-comment-input" id="ql-input-edit"
                                 placeholder="{{addcomment}}" enterkeyhint="send"
                                 data-maxlength="${isReply === 'true' ? limits.reply_text || 200 : limits.comment_text || 200}"></div>
                            <div class="progress-bar" id="ql-input-edit-bar"></div>
                            ${!UtilsModule.isMobile ? '<span class="ql-icons-outlined emoji-button" data-target-id="ql-input-edit">add_reaction</span>' : ''}
                        </div>
                    </div>
                `;
                bodyContent.appendChild(tpl.content);
            }

            // Read the raw text from the in-memory store rather than the DOM.
            // The rendered body contains WASM-processed HTML (markdown, emoji <img> nodes)
            // so textContent / getCleanInputText both produce unreliable results.
            // storedComments holds comment.text exactly as received from the server.
            const originalText = CommentsModule.storedComments.get(commentId)?.text || '';
            editInput = bodyContent.querySelector('#ql-input-edit');
            if (editInput) {
                // Strip any Giphy notation from the text loaded into the editable area
                // and replace it with a compact chip. The edit modal has limited vertical
                // space — rendering a full animated GIF alongside the editor is too tall.
                // The chip carries `data-giphy-notation` so `getCleanInputText({ forSubmit: true })`
                // reconstructs the notation correctly when the edit is saved, identical to
                // the new-comment submit path.
                const GIPHY_CHIP_REGEX = /!\[GIF\]\(giphy\|([a-zA-Z0-9]+)(?:\|[^)]*)?\)/g;
                const strippedText = originalText.replace(GIPHY_CHIP_REGEX, '').trim();
                editInput.textContent = strippedText;

                const allowGif = Boolean(ConfModule.get('comments.allowGif', false));
                if (allowGif) {
                    // Re-run the regex on the original text to find GIF notations.
                    GIPHY_CHIP_REGEX.lastIndex = 0;
                    let gifMatch;
                    while ((gifMatch = GIPHY_CHIP_REGEX.exec(originalText)) !== null) {
                        const notation = gifMatch[0];
                        const gifId    = gifMatch[1];

                        const chip = document.createElement('span');
                        chip.className = 'ql-gif-chip';
                        chip.setAttribute('contenteditable', 'false');
                        chip.setAttribute('data-giphy-id', gifId);
                        chip.setAttribute('data-giphy-notation', notation);
                        chip.innerHTML = `<span class="ql-icons-outlined" style="font-size:14px;vertical-align:middle;margin-right:4px;">gif_box</span><span style="font-size:12px;vertical-align:middle;">GIF</span><button type="button" class="ql-gif-chip__remove" aria-label="${I18n.getTranslation('remove') || 'Remove'}" style="background:none;border:none;cursor:pointer;padding:0 0 0 6px;line-height:1;"><span class="ql-icons-outlined" style="font-size:12px;vertical-align:middle;">close</span></button>`;

                        chip.querySelector('.ql-gif-chip__remove').addEventListener('click', (e) => {
                            e.stopPropagation();
                            chip.remove();
                        });

                        // Prepend the chip so it appears above the text, matching the
                        // WhatsApp convention of image-first layout in edit view.
                        editInput.insertBefore(chip, editInput.firstChild);
                        break; // At most one GIF per message — stop after first match.
                    }
                }
            }

            setupModalUI(bodyContent, '.ql-community-threads');

            const showReportButton = isOwner !== 'true' && !isSessionAuthor;
            
            const isOffline = CoreModule.isSystemOffline();
            const saveDisabled = isOffline ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : '';
            const deleteDisabled = isOffline ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : '';
            const saveTitle = isOffline ? 'title="Offline"' : '';

            const footerContainer = document.createElement('div');
            footerContainer.innerHTML = `
                ${canEdit === 'true' ? `<button class="ql-btn save-button" ${saveDisabled} ${saveTitle}><span class="ql-icons-outlined">send</span><span class="t">{{send}}</span></button>` : ''}
                <button class="ql-btn close-button"><span class="ql-icons-outlined">close</span><span class="t">{{close}}</span></button>
                ${showReportButton ? `<button class="ql-btn report-button"><span class="ql-icons-outlined">flag</span><span class="t">{{report}}</span></button>` : ''}
                ${(editing.allow_delete && canDelete === 'true') ? `<button class="ql-btn delete-button" ${deleteDisabled}><span class="ql-icons-outlined">delete</span><span class="t">{{delete}}</span></button>` : ''}
            `;

            const saveBtn = footerContainer.querySelector('.save-button');
            const closeBtn = footerContainer.querySelector('.close-button');
            const reportBtn = footerContainer.querySelector('.report-button');
            const deleteBtn = footerContainer.querySelector('.delete-button');

            const handleConfirmEdit = (event) => {
                event.preventDefault();
                if (!editInput || isOffline) return;
                
                const editComment = UtilsModule.getCleanInputText(editInput, { forSubmit: true });
                const pickerContainer = document.getElementById('ql-picker-container');
                if (pickerContainer) pickerContainer.style.display = 'none';
                
                CommentsModule.fetchEditComment(currentEntity, commentId, editComment);
                closeModalUI();
            };

            if (saveBtn) saveBtn.onclick = handleConfirmEdit;
            if (closeBtn) closeBtn.onclick = closeModalUI;
            if (reportBtn) reportBtn.onclick = () => GuardModule.protect(() => CommentsUiModule.showReportCommentUI(commentElement));

            if (canEdit === 'true' && editInput) {
                const allowGif = Boolean(ConfModule.get('comments.allowGif', false));

                requestAnimationFrame(() => {
                    UtilsModule.makeEditableDivInput(editInput, { allowGif });
                    ProgressInput('ql-input-edit', 'ql-input-edit-bar');
                });

                editInput.onkeydown = (event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        handleConfirmEdit(event);
                    }
                };
            }

            let deleteBtnHandler = null;
            if (deleteBtn && !isOffline) {
                deleteBtnHandler = function() {
                    GuardModule.protect(() => {
                        const btn = this;
                        const currentState = btn.getAttribute('data-state') || 'delete';

                        if (currentState === 'cancel') {
                            if (btn.deleteTimeout) clearTimeout(btn.deleteTimeout);
                            if (btn.countdownInterval) clearInterval(btn.countdownInterval);
                            btn.innerHTML = `<span class="ql-icons-outlined">delete</span> ${I18n.getTranslation('delete')}`;
                            btn.classList.remove('counting');
                            btn.setAttribute('data-state', 'delete');
                            return;
                        }

                        let deleteCountdown = 5;
                        btn.textContent = `${I18n.getTranslation('cancel')} (${deleteCountdown})`;
                        btn.classList.add('counting');
                        btn.setAttribute('data-state', 'cancel');

                        btn.deleteTimeout = UtilsModule.startTimeout(() => {
                            closeModalUI();
                            CommentsModule.fetchDelComment(currentEntity, commentId);
                        }, 5000);

                        btn.countdownInterval = setInterval(() => {
                            deleteCountdown--;
                            if (deleteCountdown > 0) {
                                btn.textContent = `${I18n.getTranslation('cancel')} (${deleteCountdown})`;
                            } else {
                                clearInterval(btn.countdownInterval);
                                btn.classList.remove('counting');
                                btn.setAttribute('data-state', 'delete');
                            }
                        }, 1000);
                    });
                };
                deleteBtn.onclick = function(e) { deleteBtnHandler.call(this, e); };
            }

            updateModalFooterUI(footerContainer);

        } catch (error) {
            handleLog(error, 'CommentsUiModule.showEditCommentUI', 'error', LOG_ICON);
        }
    },

    showReportCommentUI: (commentElement) => {
        try {
            const threadContainer = commentElement.closest('.ql-community-threads') || document.querySelector('.ql-community-threads');
            if (!threadContainer) return;

            const currentEntity = threadContainer.getAttribute('data-threads-entity');
            const header = commentElement?.querySelector(`.${SELECTORS.HEADER}`);
            if (!header) return;

            const { commentId } = header.dataset;
            const authorId = header.parentElement.getAttribute('data-author-id');

            UiModule.showReportModalUI({
                onConfirm: ({ reason, observation, blockUser }) => {
                    CommentsModule.fetchReportComment(currentEntity, commentId, reason, observation, blockUser);

                    if (blockUser && authorId) {
                        import('../profile/profile.js').then(({default: ProfileModule}) => {
                             ProfileModule.addHiddenAuthor(authorId);
                             CommentsUiModule.destroyElementsByUI(authorId);
                        });
                    }
                }
            });

        } catch (error) {
            handleLog(error, 'CommentsUiModule.showReportCommentUI', 'error', LOG_ICON);
        }
    },

    addReplyHeaderUI: (commentHeader) => {
        try {
            const commentBarContainer = document.querySelector(`.${SELECTORS.INPUT_BAR}`);
            if (!commentBarContainer) return;

            commentBarContainer.querySelector('.ql-reply-header')?.remove();

            const replyHeader = document.createElement('div');
            replyHeader.classList.add('ql-reply-header');

            const clonedHeader = commentHeader.cloneNode(true);
            clonedHeader.querySelector(`.${SELECTORS.LIKE_CONTAINER}`)?.remove();
            
            clonedHeader.querySelectorAll('*').forEach(el => {
                el.style.pointerEvents = 'none';
                el.style.opacity = '0.8';
            });

            const closeButton = document.createElement('span');
            closeButton.className = 'ql-icons-outlined ql-reply-close';
            closeButton.textContent = 'close';
            closeButton.style.cssText = 'cursor: pointer; float: right;';
            closeButton.onclick = () => {
                CommentsUiModule.removeHeaderUI();
                const input = document.getElementById('ql-input');
                if (input) {
                    input.removeAttribute('data-reply-id');
                    input.value = '';
                    input.focus();
                    ProgressInput("ql-input", "ql-input-bar");
                }
            };

            const commentText = commentHeader.closest(`.${SELECTORS.THREAD}`).querySelector(`.${SELECTORS.BODY}`).cloneNode(true);

            replyHeader.append(closeButton, clonedHeader, commentText);
            CommentsUiModule.addElementHeaderUI(replyHeader);
        } catch (error) {
            handleLog(error, 'CommentsUiModule.addReplyHeaderUI', 'error', LOG_ICON);
        }
    },

    removeHeaderUI: () => {
        const header = document.querySelector('.ql-comment-bar .ui-header');
        if (header) header.remove();
    },

    addElementHeaderUI: (element, anchor = false) => {
        try {
            const commentBarContainer = document.querySelector(`.${SELECTORS.INPUT_BAR}`);
            if (!commentBarContainer) return;

            if (!anchor) element.classList.add('ui-header');

            const inputContainer = commentBarContainer.querySelector('.ql-comment-bar__input-container');
            if (inputContainer) {
                commentBarContainer.insertBefore(element, inputContainer);
            } else {
                commentBarContainer.appendChild(element);
            }
        } catch (error) {
            handleLog(error, 'CommentsUiModule.addElementHeaderUI', 'error', LOG_ICON);
        }
    },

    updateCommentUI: (entityId, { replyId, isEdit, comment }) => {
        try {
            let targetContainer = document.querySelector('.ql-community-threads');
            
            if (isEdit) {
                targetContainer = targetContainer.querySelector(`.${SELECTORS.THREAD}[data-comment-id="${comment._id}"]`);
            } else if (replyId) {
                targetContainer = targetContainer.querySelector(`.${SELECTORS.REPLIES}[data-reply-id="${replyId}"]`);
            }

            if (!targetContainer) return;

            targetContainer.querySelector('.ql-loading-message')?.remove();

            const commentElement = CommentsModule.createCommentElement(comment, entityId, Boolean(replyId));
            
            if (!commentElement) return;

            if (isEdit) {
                targetContainer.replaceWith(commentElement);
            } else {
                if (replyId) {
                    targetContainer.appendChild(commentElement);
                } else {
                    const firstChild = targetContainer.firstElementChild;
                    if (firstChild && firstChild.classList.contains('ql-native-ad')) {
                        targetContainer.insertBefore(commentElement, firstChild.nextElementSibling);
                    } else {
                        targetContainer.insertBefore(commentElement, targetContainer.firstChild);
                    }
                }
            }

            commentElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            
        } catch (error) {
            handleLog(error, 'CommentsUiModule.updateCommentUI', 'error', LOG_ICON);
        }
    },

    destroyElementsByUI: (id) => {
        const selectors = [`[data-author-id="${id}"]`, `[data-member-id="${id}"]`];
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                const thread = el.closest(`.${SELECTORS.THREAD}`);
                if (thread) thread.remove();
            });
        });
    }
};

// ============================================================
// CIRCUIT BREAKER: REACTIVE DOM PURGE
// ============================================================
eventBus.on('USER_BLOCKED', ({ memberId }) => {
    if (memberId) {
        CommentsUiModule.destroyElementsByUI(String(memberId));
    }
});

export default CommentsUiModule;