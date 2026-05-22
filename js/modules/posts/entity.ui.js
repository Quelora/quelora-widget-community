/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/posts/entity.ui.js */
/**
 * @module Modules/InteractionsUi
 * @description Manages Interaction Bars (Like, Share, Comment counts) in the UI.
 * Supports multiple interaction placements per entity and strict DOM positioning.
 * @version 1.6.3
 */
import handleLog from '../../core/logs.js'; 
import UtilsModule from '../../core/utils.js';
import CoreModule from '../../core/core.js';
import EntityModule from './entity.js';
import PostsModule from './posts.js';

const CONSTANTS = {
    CLASSES: {
        ROOT: 'ql-interaction',
        ACTIONS: 'ql-interaction__actions',
        ITEM: 'ql-interaction__item',
        ICON: 'ql-interaction__icon',
        COUNT: 'ql-interaction__count',
        BOOKMARK: 'ql-interaction__bookmark',
        LIVE_DOT: 'ql-interaction__live-dot',
        ACTIVE: 'ql-interaction__icon--active',
        BOOKMARK_ACTIVE: 'ql-interaction__bookmark--active',
        HIDDEN: 'ql-interaction--hidden',
        SKELETON: 'ql-interaction--skeleton'
    },
    ICONS: {
        LIKE: { name: 'favorite_border', active: 'favorite' },
        COMMENT: { name: 'chat_bubble_outline' },
        SHARE: { name: 'share' },
        BOOKMARK: { name: 'bookmark_border', active: 'bookmark' }
    },
    ATTR: {
        ENTITY: 'data-entity-interaction',
        TYPE: 'data-interaction-type',
        LIKED: 'data-liked',
        SHARED: 'data-shared',
        ATTACHED: 'data-attached',
        COUNT: 'data-count',
        READY: 'data-entity-ready'
    }
};

const _DomHelper = {
    getTemplate: (entityId, isLive, isSkeleton = false) => {
        const { CLASSES, ICONS, ATTR } = CONSTANTS;
        
        const liveDot = isLive ? `<span class="${CLASSES.LIVE_DOT}"></span>` : '';
        const commentStyle = isLive ? 'padding-left: 12px;' : '';
        const countStyle = isLive ? 'display: none;' : '';
        const animClass = isSkeleton ? ` ${CLASSES.SKELETON}` : '';
        const initValue = '0'; 

        return `
            <div class="${CLASSES.ACTIONS}">
                <div class="${CLASSES.ITEM}" ${ATTR.TYPE}="like">
                    <span class="${CLASSES.ICON} ql-icons-outlined${animClass}" ${ATTR.LIKED}="false">${ICONS.LIKE.name}</span>
                    <span class="${CLASSES.COUNT}${animClass}" ${ATTR.COUNT}="0">${initValue}</span>
                </div>
                <div class="${CLASSES.ITEM}" ${ATTR.TYPE}="comment" style="${commentStyle}">
                    ${liveDot}
                    <span class="${CLASSES.ICON} ql-icons-outlined${animClass}">${ICONS.COMMENT.name}</span>
                    <span class="${CLASSES.COUNT}${animClass}" style="${countStyle}" ${ATTR.COUNT}="0">${initValue}</span>
                </div>
                <div class="${CLASSES.ITEM}" ${ATTR.TYPE}="share">
                    <span class="${CLASSES.ICON} ql-icons-outlined${animClass}" ${ATTR.SHARED}="false">${ICONS.SHARE.name}</span>
                    <span class="${CLASSES.COUNT}${animClass}" ${ATTR.COUNT}="0">${initValue}</span>
                </div>
            </div>
            <span class="${CLASSES.BOOKMARK} ql-icons-outlined${animClass}" ${ATTR.ATTACHED}="false">${ICONS.BOOKMARK.name}</span>
        `;
    },

    updateIconState: (element, isActive, iconSet) => {
        if (!element) return;
        const { CLASSES } = CONSTANTS;
        element.textContent = isActive ? iconSet.active : iconSet.name;
        if (isActive) element.classList.add(CLASSES.ACTIVE);
        else element.classList.remove(CLASSES.ACTIVE);
    },

    updateBookmarkState: (element, isActive) => {
        if (!element) return;
        const { CLASSES, ICONS } = CONSTANTS;
        element.textContent = isActive ? ICONS.BOOKMARK.active : ICONS.BOOKMARK.name;
        if (isActive) element.classList.add(CLASSES.BOOKMARK_ACTIVE);
        else element.classList.remove(CLASSES.BOOKMARK_ACTIVE);
    },

    /**
     * Injects the interaction bar securely using strict DOM positioning APIs.
     *
     * The `deterministic` position is used when the site admin has placed
     * `span.ql-deterministic` markers in their HTML. The bar is inserted
     * immediately before the marker span, and the span is hidden so it
     * remains in the DOM as a permanent anchor for subsequent updates.
     */
    injectBar: (container, barEl, position) => {
        const pos = String(position || 'inside').toLowerCase().trim();

        if (pos === 'deterministic') {
            container.insertAdjacentElement('beforebegin', barEl);
            container.style.display = 'none';
        } else if (pos === 'replace') {
            container.innerHTML = '';
            container.insertAdjacentElement('beforeend', barEl);
        } else if (pos === 'after') {
            container.insertAdjacentElement('afterend', barEl);
        } else if (pos === 'before') {
            container.insertAdjacentElement('beforebegin', barEl);
        } else {
            // inside (default)
            container.insertAdjacentElement('beforeend', barEl);
        }
    },

    /**
     * Resolves the existing interaction bar associated with a specific container.
     * Skips text nodes safely.
     *
     * For `deterministic` position the bar is the immediate previous sibling of
     * the hidden `ql-deterministic` marker span.
     */
    getBarForContainer: (container, entityId, position) => {
        const selector = `.${CONSTANTS.CLASSES.ROOT}[${CONSTANTS.ATTR.ENTITY}="${entityId}"]`;
        const pos = String(position || 'inside').toLowerCase().trim();

        if (pos === 'deterministic') {
            const prev = container.previousElementSibling;
            return (prev && prev.matches(selector)) ? prev : null;
        } else if (pos === 'inside' || pos === 'replace') {
            return container.querySelector(selector);
        } else if (pos === 'after') {
            let next = container.nextElementSibling;
            while (next) {
                if (next.matches(selector)) return next;
                if (next.classList.contains(CONSTANTS.CLASSES.ROOT)) next = next.nextElementSibling;
                else break;
            }
            return null;
        } else if (pos === 'before') {
            let prev = container.previousElementSibling;
            while (prev) {
                if (prev.matches(selector)) return prev;
                if (prev.classList.contains(CONSTANTS.CLASSES.ROOT)) prev = prev.previousElementSibling;
                else break;
            }
            return null;
        }
        return null;
    },
    
    resolveBarElements: (identifier) => {
        if (typeof identifier === 'string') {
            return document.querySelectorAll(`.${CONSTANTS.CLASSES.ROOT}[${CONSTANTS.ATTR.ENTITY}="${identifier}"]`);
        } else if (identifier instanceof Element) {
            return [identifier];
        }
        return [];
    }
};

const InteractionsUiModule = {

    renderPlaceholders: (entities) => {
        if (!Array.isArray(entities)) return;
        const { CLASSES, ATTR } = CONSTANTS;
        
        // Safety fetch position
        let position = 'inside';
        if (typeof EntityModule.getInteractionPosition === 'function') {
            position = EntityModule.getInteractionPosition();
        }

        entities.forEach(entityId => {
            const containers = EntityModule.getInteractionPlacementsByEntity(entityId);
            if (!containers || containers.length === 0) return;

            containers.forEach(container => {
                let barEl = _DomHelper.getBarForContainer(container, entityId, position);
                
                if (barEl && !barEl.querySelector(`.${CLASSES.SKELETON}`)) return;

                if (!barEl) {
                    barEl = document.createElement('div');
                    barEl.className = CLASSES.ROOT;
                    barEl.setAttribute(ATTR.ENTITY, entityId);
                    _DomHelper.injectBar(container, barEl, position);
                }

                barEl.innerHTML = _DomHelper.getTemplate(entityId, false, true);
            });
        });
    },

    renderStatsUI: async (stats) => {
        if (!Array.isArray(stats)) return;
        
        try {
            const canSupportLive = await CoreModule.checkLiveCapability();
            const { CLASSES, ATTR } = CONSTANTS;
            
            let position = 'inside';
            if (typeof EntityModule.getInteractionPosition === 'function') {
                position = EntityModule.getInteractionPosition();
            }

            for (const stat of stats) {
                if (!stat?.entity) continue;

                UtilsModule.setStatsCache(stat);

                const containers = EntityModule.getInteractionPlacementsByEntity(stat.entity);
                if (!containers || containers.length === 0) continue;

                const isLiveActive = (stat.config?.liveMode?.isLiveActive || false) && canSupportLive;

                containers.forEach(container => {
                    let barEl = _DomHelper.getBarForContainer(container, stat.entity, position);
                    let isNewOrSkeleton = false;

                    if (!barEl) {
                        barEl = document.createElement('div');
                        barEl.className = CLASSES.ROOT;
                        barEl.setAttribute(ATTR.ENTITY, stat.entity);
                        _DomHelper.injectBar(container, barEl, position);
                        isNewOrSkeleton = true;
                    } else if (barEl.querySelector(`.${CLASSES.SKELETON}`) || barEl.innerHTML.trim() === '') {
                        isNewOrSkeleton = true;
                    }

                    if (isNewOrSkeleton) {
                        barEl.innerHTML = _DomHelper.getTemplate(stat.entity, isLiveActive, false);
                    }
                    
                    if (UtilsModule.getConfig(stat.entity)?.visibility !== 'public') {
                        barEl.classList.add(CLASSES.HIDDEN);
                    }

                    InteractionsUiModule.updateInteractionCounts(barEl, stat, canSupportLive);
                    InteractionsUiModule.updateEntityLikeUI(barEl, stat.authorLiked);
                    InteractionsUiModule.updateEntityBookmarkUI(barEl, stat.authorBookmarked);
                });

                PostsModule.attachEventListeners(stat.entity);
                
                const readyEl = document.querySelector(`[${ATTR.ENTITY}="${stat.entity}"]`);
                if (readyEl) {
                    const parent = readyEl.closest('[data-entity]');
                    if (parent) parent.setAttribute(ATTR.READY, "true");
                }
            }
        } catch (error) {
            handleLog(error, 'InteractionsUiModule.renderStatsUI', 'error', '📰');
        }
    },

    updateInteractionCounts: (barElement, stat, canSupportLive = true) => {
        if (!barElement) return;
        const { CLASSES, ATTR } = CONSTANTS;
        const entityId = barElement.getAttribute(ATTR.ENTITY);
        const config = UtilsModule.getConfig(entityId)?.interaction;
        const liveConfig = UtilsModule.getConfig(entityId)?.liveMode || {};
        const isLiveActive = (liveConfig.isLiveActive || false) && canSupportLive;

        const updateItem = (type, flag, countKey) => {
            const itemEl = barElement.querySelector(`[${ATTR.TYPE}="${type}"]`);
            if (!itemEl) return;

            const isAllowed = config ? config[flag] : true;

            if (!isAllowed) {
                itemEl.style.display = 'none';
                return;
            }

            itemEl.style.display = '';
            const countEl = itemEl.querySelector(`.${CLASSES.COUNT}`);
            if (countEl) {
                if (type === 'comment' && isLiveActive) {
                    countEl.style.display = 'none';
                } else {
                    countEl.style.display = '';
                    const rawCount = stat[countKey] || 0;
                    countEl.textContent = UtilsModule.formatNumberAbbreviated(rawCount);
                    countEl.setAttribute(ATTR.COUNT, rawCount);
                }
            }

            if (type === 'comment') {
                const existingDot = itemEl.querySelector(`.${CLASSES.LIVE_DOT}`);
                if (isLiveActive) {
                    itemEl.style.paddingLeft = '12px';
                    if (!existingDot) {
                        const dot = document.createElement('span');
                        dot.className = CLASSES.LIVE_DOT;
                        itemEl.prepend(dot);
                    }
                } else {
                    itemEl.style.paddingLeft = '';
                    if (existingDot) existingDot.remove();
                }
            }
        };

        updateItem('like', 'allow_likes', 'likesCount');
        updateItem('share', 'allow_shares', 'sharesCount');
        updateItem('comment', 'allow_comments', 'commentsCount');

        const bookmarkEl = barElement.querySelector(`.${CLASSES.BOOKMARK}`);
        const allowBookmarks = config ? config.allow_bookmarks : true;
        
        if (bookmarkEl && !allowBookmarks) {
            bookmarkEl.style.display = 'none';
        } else if (bookmarkEl) {
            bookmarkEl.style.display = '';
        }
    },

    updateEntityLikeUI: (identifier, isLiked) => {
        const barEls = _DomHelper.resolveBarElements(identifier);
        barEls.forEach(barElement => {
            const icon = barElement.querySelector(`[${CONSTANTS.ATTR.TYPE}="like"] .${CONSTANTS.CLASSES.ICON}`);
            if (icon) {
                icon.setAttribute(CONSTANTS.ATTR.LIKED, isLiked);
                _DomHelper.updateIconState(icon, isLiked, CONSTANTS.ICONS.LIKE);
            }
        });
    },

    updateEntityBookmarkUI: (identifier, isAttached) => {
        const barEls = _DomHelper.resolveBarElements(identifier);
        barEls.forEach(barElement => {
            const icon = barElement.querySelector(`.${CONSTANTS.CLASSES.BOOKMARK}`);
            if (icon) {
                icon.setAttribute(CONSTANTS.ATTR.ATTACHED, isAttached);
                _DomHelper.updateBookmarkState(icon, isAttached);
            }
        });
    },

    updateEntityCounterUI: (identifier, count, isActionAdded) => {
        const barEls = _DomHelper.resolveBarElements(identifier);
        barEls.forEach(barElement => {
            const { CLASSES, ATTR, ICONS } = CONSTANTS;
            
            const likeIcon = barElement.querySelector(`[${ATTR.TYPE}="like"] .${CLASSES.ICON}`);
            if (likeIcon) {
                 likeIcon.setAttribute(ATTR.LIKED, isActionAdded);
                _DomHelper.updateIconState(likeIcon, isActionAdded, ICONS.LIKE);
            }

            const countEl = barElement.querySelector(`[${ATTR.TYPE}="like"] .${CLASSES.COUNT}`);
            if (!countEl) return;

            let current = parseInt(countEl.getAttribute(ATTR.COUNT), 10);
            if (isNaN(current)) current = parseInt(countEl.textContent, 10) || 0;
            
            if (count !== undefined && count >= 1000) {
                 countEl.textContent = UtilsModule.formatNumberAbbreviated(count);
                 countEl.setAttribute(ATTR.COUNT, count);
            } else {
                 current = isActionAdded ? current + 1 : Math.max(0, current - 1);
                 countEl.textContent = UtilsModule.formatNumberAbbreviated(current);
                 countEl.setAttribute(ATTR.COUNT, current);
            }
        });
    },

    updateCommentCountUI: (entityId, isAdded) => {
        const { CLASSES, ATTR } = CONSTANTS;
        const barEls = document.querySelectorAll(`.${CLASSES.ROOT}[${ATTR.ENTITY}="${entityId}"]`);
        
        barEls.forEach(barEl => {
            const countEl = barEl.querySelector(`[${ATTR.TYPE}="comment"] .${CLASSES.COUNT}`);
            if (!countEl) return;

            let current = parseInt(countEl.getAttribute(ATTR.COUNT), 10);
            if (isNaN(current)) current = parseInt(countEl.textContent, 10) || 0;

            current = isAdded ? current + 1 : Math.max(0, current - 1);
            
            countEl.textContent = UtilsModule.formatNumberAbbreviated(current);
            countEl.setAttribute(ATTR.COUNT, current);
        });
    },
    
    getEntityInteractionUI: (entityId) => {
        const { CLASSES, ATTR } = CONSTANTS;
        if (entityId) {
            return document.querySelectorAll(`.${CLASSES.ROOT}[${ATTR.ENTITY}="${entityId}"]`);
        }
        return document.querySelectorAll(`.${CLASSES.ROOT}`);
    },

    getCounterFromDOMUI: (entityId, type) => {
        const { CLASSES, ATTR } = CONSTANTS;
        const barEl = document.querySelector(`.${CLASSES.ROOT}[${ATTR.ENTITY}="${entityId}"]`);
        if (!barEl) return 0;

        const map = {
            likes: `[${ATTR.TYPE}="like"]`,
            shares: `[${ATTR.TYPE}="share"]`,
            comments: `[${ATTR.TYPE}="comment"]`
        };

        const selector = map[type];
        if (!selector) return 0;

        const countEl = barEl.querySelector(`${selector} .${CLASSES.COUNT}`);
        if (countEl && countEl.hasAttribute(ATTR.COUNT)) {
            return parseInt(countEl.getAttribute(ATTR.COUNT), 10) || 0;
        }
        
        const val = parseInt(countEl?.textContent, 10);
        return isNaN(val) ? 0 : val;
    }
};

export default InteractionsUiModule;