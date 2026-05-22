/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/**
 * @fileoverview Live Interaction UI Controller.
 * Manages DOM manipulation for live statistics and reactions.
 */

import I18n from '../../core/i18n.js';
import UtilsModule from '../../core/utils.js';
import GuardModule from '../../core/guard.js';

/**
 * Creates a DOM element with specified properties.
 * @param {Object} params - Element creation parameters.
 * @param {string} params.tag - HTML tag name.
 * @param {string|string[]} [params.classes] - CSS classes.
 * @param {Object} [params.attributes] - Element attributes.
 * @param {string} [params.innerHTML] - Inner HTML content.
 * @returns {HTMLElement}
 */
function createEl({ tag, classes = [], attributes = {}, innerHTML }) {
    const element = document.createElement(tag);
    if (classes) {
        const classList = Array.isArray(classes) ? classes : classes.split(/\s+/).filter(Boolean);
        classList.forEach(cls => element.classList.add(cls));
    }
    Object.entries(attributes).forEach(([key, value]) => {
        if (value != null) element.setAttribute(key, value);
    });
    if (innerHTML) element.innerHTML = innerHTML;
    return element;
}

/**
 * Updates the UI state for live mode activation.
 * @param {boolean} isLiveActive - Current live status.
 * @param {string} entityId - Target entity identifier.
 */
export function setLiveModeUI(isLiveActive, entityId) {
    const dotElement = document.querySelector(`[data-entity-interaction="${entityId}"] .ql-live-indicator-dot`);
    if (!dotElement) return;

    dotElement.classList.toggle('active', isLiveActive);
        
    const actions = document.querySelectorAll('#ql-comments .comment-actions .reply-text, #ql-comments .comment-actions .edit-text, #ql-comments .comment-actions .quote-text');
    actions.forEach(btn => btn.classList.toggle('ql-hidden', isLiveActive));
}

/**
 * Renders the live statistics bar (watchers and typing users).
 * @param {Object} stats - Statistics data.
 * @param {number} stats.watchers - Number of active watchers.
 * @param {Array} stats.typingUsers - List of users currently typing.
 */
export function renderLiveStats({ watchers, typingUsers }) {
    let liveContainer = document.getElementById('ql-live-stats-bar');
    const threadsContainer = document.querySelector('#ql-comments .community-threads');

    if (!liveContainer) {
        if (!threadsContainer) return; 
        liveContainer = createEl({
            tag: 'div',
            attributes: { id: 'ql-live-stats-bar' },
            classes: 'live-stats-container'
        });
        threadsContainer.parentNode.insertBefore(liveContainer, threadsContainer);
    }

    const watchersText = watchers === 1 
        ? I18n.getTranslation('oneWatcherActive') 
        : `${watchers} ${I18n.getTranslation('watchersActive')}`;
    
    let content = `
        <span class="ql-live-indicator-dot active"></span>
        <span class="ql-icons-outlined">visibility</span>
        <span class="watchers-count">${watchersText}</span>
    `;
    
    if (typingUsers.length > 0) {
        const names = typingUsers.map(u => u.name).join(', ');
        const msg = typingUsers.length === 1 
            ? `${names} ${I18n.getTranslation('isTyping')}` 
            : `${names} ${I18n.getTranslation('areTyping')}`;
        content += `<span class="typing-indicator"> - ${msg}...</span>`;
    }

    liveContainer.innerHTML = content;
    
    const commentBar = document.querySelector('#ql-comments .comment-bar-container');
    if (commentBar) commentBar.classList.add('ql-display-flex');
}

/**
 * Creates the reaction bar for live interactions.
 * @param {string} entityId - Target entity identifier.
 * @param {Function} onReaction - Callback for reaction click.
 */
export function createLiveReactionBar(entityId, onReaction) {
    if (document.getElementById('ql-live-reaction-bar')) return;

    const reactionContainer = createEl({
        tag: 'div',
        attributes: { id: 'ql-live-reaction-bar' },
        classes: 'live-reaction-container'
    });

    const reactions = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
    reactions.forEach(emoji => {
        const button = createEl({
            tag: 'button',
            classes: 'ql-live-reaction-button',
            innerHTML: emoji
        });

        button.onclick = () => {
            GuardModule.protect(() => {
                if (typeof onReaction === 'function') {
                    onReaction(emoji);
                }
                showReactionAnimation(emoji);
            });
        };
        
        reactionContainer.appendChild(button);
    });

    const commentBarContainer = document.querySelector('.ql-comment-bar');
    if (commentBarContainer) {
        reactionContainer.classList.add('ui-header');
        const inputContainer = commentBarContainer.querySelector('.ql-comment-bar__input-container');
        if (inputContainer) {
            commentBarContainer.insertBefore(reactionContainer, inputContainer);
        } else {
            commentBarContainer.appendChild(reactionContainer);
        }
    }
}

/**
 * Removes the live reaction bar from DOM.
 */
export function removeLiveReactionBar() {
    const bar = document.getElementById('ql-live-reaction-bar');
    if (bar) bar.remove();
}

/**
 * Triggers the visual animation for a reaction.
 * @param {string} emoji - The emoji to animate.
 */
export function showReactionAnimation(emoji) {
    const animationContainer = document.querySelector('#ql-comments .ql-live-animation-container');
    if (!animationContainer) return;

    const EMIT_COUNT = 12;
    for (let i = 0; i < EMIT_COUNT; i++) {
        UtilsModule.startTimeout(() => {
            const randomOffset = (Math.random() * 2 - 1) * 200;
            const emojiEl = createEl({
                tag: 'span',
                classes: 'live-reaction-animation',
                innerHTML: emoji
            });
            
            emojiEl.style.left = `calc(50% - 14px + ${randomOffset}px)`;
            
            animationContainer.appendChild(emojiEl);
            UtilsModule.startTimeout(() => emojiEl.remove(), 3000);
        }, i * (1000 / EMIT_COUNT));
    }
}