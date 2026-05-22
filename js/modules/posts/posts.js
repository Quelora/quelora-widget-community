/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/posts/posts.js */
/**
 * @module Modules/Posts
 * @description Manages Post Interactions (Like, Share, Stats) and Orchestration.
 * Refactored to comply with the new Dynamic Plugin Registry architecture and
 * support multiple interaction placements per entity.
 * @version 10.7.0
 */
import handleLog from '../../core/logs.js';
import UtilsModule from '../../core/utils.js';
import CommentsModule from '../comments/comments.js';
import CoreModule from '../../core/core.js';
import UiModule from '../../ui/ui.js';
import InteractionsUi from './entity.ui.js';
import EntityModule from './entity.js';
import ToastModule from '../../ui/toast.js';
import I18n from '../../core/i18n.js';
import Anchor from '../../ui/anchor.js';
import GuardModule from '../../core/guard.js';
import ProfileModule from '../profile/profile.js';

import { eventBus } from '../../core/event.js';

const CONSTANTS = {
    SELECTORS: {
        ROOT: '.ql-interaction',
        LIKE_ITEM: '[data-interaction-type="like"]',
        COMMENT_ITEM: '[data-interaction-type="comment"]',
        SHARE_ITEM: '[data-interaction-type="share"]',
        LIKE_ICON: '.ql-interaction__icon',
        SHARE_COUNT: '.ql-interaction__count',
        BOOKMARK: '.ql-interaction__bookmark',
        TOAST: '.ql-toast',
        DRAWER_CONTENT: '.drawer-content',
        LIVE_STATS: 'ql-live-stats-bar',
        INTERACTION: 'data-entity-interaction'
    },
    ATTRS: {
        LIKED: 'data-liked',
        ATTACHED: 'data-attached',
        ENTITY_ID: 'data-threads-entity',
        INTERACTION_ENTITY: 'data-entity-interaction',
        READY: 'data-entity-ready'
    },
    TIMEOUTS: {
        LONG_PRESS: 300
    }
};

const _state = {
    timeoutId: null,
    isLongPress: false,
    isPeersActive: false,
    isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    ensureAppInit: () => Promise.resolve()
};

const _DomHelper = {
    getElements: (entityId) => {
        const nodes = document.querySelectorAll(`${CONSTANTS.SELECTORS.ROOT}[${CONSTANTS.ATTRS.INTERACTION_ENTITY}="${entityId}"]`);
        return Array.from(nodes);
    },

    getShareUrl: (entityId) => {
        const base = _resolveShareBaseUrl(entityId);
        const hash = Anchor.generateLink({ type: 'entity', ids: { entity: entityId } });
        return `${base}${hash}`;
    },

    safeClassOp: (element, method, className) => {
        if (element && className) element.classList[method](className);
    }
};

const _WorkerService = {
    post: async (action, payload) => {
        await CoreModule.getTokenIfNeeded();
        CoreModule.postWorkerMessage({ action, payload });
    },

    fetchStats: async (entities, mapping = {}) => {
        if (!entities.length) return;
        CoreModule.postWorkerMessage({
            action: 'fetchStats',
            payload: { entities, ...(Object.keys(mapping).length && { mapping }) }
        });
    }
};

const _InteractionLogic = {
    setLike: async (entityId, liked) => {
        try {
            const roots = _DomHelper.getElements(entityId);
            if (!roots.length) throw new Error(`Interaction bar for ${entityId} not found`);

            roots.forEach(root => InteractionsUi.updateEntityLikeUI(root, liked));
            await _WorkerService.post('setLike', { entityId, liked });
        } catch (error) {
            handleLog(error, 'PostsModule.setLike', 'error', '📰');
        }
    },

    setShare: async (entityId) => {
        try {
            await _WorkerService.post('setShare', { entityId });
        } catch (error) {
            handleLog(error, 'PostsModule.setShare', 'error', '📰');
        }
    },

    toggleBookmark: async (entityId, attached) => {
        try {
            await _WorkerService.post('toggleBookmark', { entityId, attached });
        } catch (error) {
            handleLog(error, 'PostsModule.toggleBookmark', 'error', '📰');
        }
    },

    updateShareCount: (entityId) => {
        const roots = _DomHelper.getElements(entityId);
        roots.forEach(root => {
            const countEl = root.querySelector(`${CONSTANTS.SELECTORS.SHARE_ITEM} ${CONSTANTS.SELECTORS.SHARE_COUNT}`);
            if (countEl) {
                const count = parseInt(countEl.textContent, 10) || 0;
                countEl.textContent = count + 1;
            }
        });
    }
};

const _checkOfflineCircuitBreaker = () => {
    if (CoreModule.isSystemOffline()) {
        ToastModule.show(
            '<span class="ql-icons-outlined">cloud_off</span>',
            I18n.getTranslation('offline') || 'Offline',
            I18n.getTranslation('actionUnavailableOffline') || 'This action is unavailable in offline mode.',
            null,
            3000,
            'warning'
        );
        return true;
    }
    return false;
};

/**
 * Resolves the canonical base URL for share links of a given entity.
 *
 * When `goTo` is enabled the share URL must point to the entity's own page so
 * the recipient lands on its canonical URL (with the `#QUELORA-E-{id}` anchor)
 * rather than on whatever page is currently hosting the widget.
 *
 * Resolution order:
 * 1. `goTo` is `false` → returns `window.location.href` stripped of any existing
 *    hash (current page, default behaviour).
 * 2. **Deterministic mode** + `goTo` is `true` → reads `data-href` from the
 *    `ql-deterministic` marker via {@link EntityModule.getDeterministicHref}.
 *    Falls back to the current page URL if `data-href` is absent.
 * 3. **Standard mode** + `goTo` is `true` → locates the entity element in the
 *    DOM, resolves the link according to `hrefAttribute` (or the first
 *    `<a href>` descendant), strips any existing `#QUELORA-*` anchor, and
 *    returns the clean base URL. Falls back to the current page URL if no
 *    link element is found.
 *
 * @param {string} entityId - The 24-character entity identifier.
 * @returns {string} The base URL (no trailing `#`) to prepend to the anchor hash.
 */
function _resolveShareBaseUrl(entityId) {
    const fallback = window.location.href.split('#')[0];
    const config   = EntityModule.getConfig();

    if (!config.goTo) return fallback;

    if (config.interaction.deterministic) {
        const href = EntityModule.getDeterministicHref(entityId);
        return href ? href.split('#')[0] : fallback;
    }

    const entityEl = document.querySelector(`[data-entity="${entityId}"]`);
    if (!entityEl) return fallback;

    let linkEl = null;
    const attr   = config.hrefAttribute || 'href';
    const isSel  = !/^[\w-]+$/.test(attr);

    if (isSel) {
        linkEl = entityEl.querySelector(attr);
    } else {
        if (attr !== 'href') {
            linkEl = entityEl.querySelector(`[${attr}]`);
            if (!linkEl && entityEl.hasAttribute(attr)) linkEl = entityEl;
        }
        if (!linkEl) linkEl = entityEl.querySelector('a[href]');
    }

    if (!linkEl) return fallback;

    const raw = (isSel ? null : linkEl.getAttribute(attr)) || linkEl.getAttribute('href') || '';
    return raw.split('#')[0] || fallback;
}

const _Handlers = {
    handleLike: async (entityId) => {
        if (_checkOfflineCircuitBreaker()) return;

        const roots = _DomHelper.getElements(entityId);
        if (!roots.length) return;

        const btn = roots[0].querySelector(`${CONSTANTS.SELECTORS.LIKE_ITEM} ${CONSTANTS.SELECTORS.LIKE_ICON}`);
        if (!btn) return;

        const isLiked = btn.getAttribute(CONSTANTS.ATTRS.LIKED) === 'true';
        await GuardModule.protect(() => _InteractionLogic.setLike(entityId, !isLiked));
    },

    handleBookmark: async (entityId) => {
        if (_checkOfflineCircuitBreaker()) return;

        const roots = _DomHelper.getElements(entityId);
        if (!roots.length) return;

        const btn = roots[0].querySelector(CONSTANTS.SELECTORS.BOOKMARK);
        if (!btn) return;

        const isAttached = btn.getAttribute(CONSTANTS.ATTRS.ATTACHED) === 'true';
        await GuardModule.protect(() => {
            roots.forEach(root => InteractionsUi.updateEntityBookmarkUI(root, !isAttached));
            return _InteractionLogic.toggleBookmark(entityId, !isAttached);
        });
    },

    /**
     * Handles the share action for an entity interaction bar.
     *
     * Uses {@link _resolveShareBaseUrl} to obtain the correct base URL so that
     * when `goTo` is active the shared link points to the entity's own page
     * (with the `#QUELORA-E-{id}` anchor) rather than to the current host page.
     *
     * @param {string} entityId - The entity identifier.
     * @returns {Promise<void>}
     */
    handleShare: async (entityId) => {
        const base = _resolveShareBaseUrl(entityId);
        const hash = Anchor.generateLink({ type: 'entity', ids: { entity: entityId } });
        const url = `${base}${hash}`;

        const shareData = {
            title: I18n.getTranslation('shareTitle'),
            text: I18n.getTranslation('shareText'),
            url
        };

        if (navigator.share) {
            try {
                await navigator.share(shareData);
                await _InteractionLogic.setShare(entityId);
                _InteractionLogic.updateShareCount(entityId);
            } catch (e) { /* Share cancelled */ }
        } else {
            _Handlers.showCopyToast(url, entityId);
        }
    },

    showCopyToast: (url, entityId) => {
        const copyText = I18n.getTranslation('copy');
        const copiedText = I18n.getTranslation('copied');

        const content = `
            <div style="word-break: break-all; margin-bottom: 10px;">${url}</div>
            <button class="ql-btn active" id="ql-toast-copy-btn">${copyText}</button>
        `;

        ToastModule.info('share', '{{copy}}', content, null, 8000).then(() => {
            const btn = document.getElementById('ql-toast-copy-btn');
            if (btn) {
                btn.onclick = () => {
                    navigator.clipboard.writeText(url)
                        .then(() => {
                            btn.textContent = copiedText;
                            _InteractionLogic.setShare(entityId);
                            _InteractionLogic.updateShareCount(entityId);
                            setTimeout(() => btn.closest(CONSTANTS.SELECTORS.TOAST)?.remove(), 300);
                        });
                };
            }
        });
    },

    openLikesDrawer: async (entityId) => {
        await GuardModule.protect(async () => {
            await _state.ensureAppInit();
            if (UiModule.likesDrawerUI) {
                UiModule.likesDrawerUI.open();
                const container = UiModule.getLikesListUI();
                if (container) {
                    UiModule.addLoadingMessageUI(container, {
                        type: 'profile', position: 'after', empty: true, count: 15
                    });
                }
                CoreModule.postWorkerMessage({ action: 'getLikes', payload: { entityId } });
            }
        });
    },

    handleSurvey: async (config, lastCommentId, entityId) => {
        if (config.hasActiveSurvey && !lastCommentId) {
            try {
                const surveyModule = window.QueloraApp?.Modules?.SurveyModule;
                if (surveyModule && typeof surveyModule.fetchSurvey === 'function') {
                    surveyModule.fetchSurvey(entityId);
                }
            } catch (e) { /* Survey module optional */ }
        }
    }
};

const _EventBinder = {
    bindLikeButton: (entityId, container) => {
        const btn = container.querySelector(`${CONSTANTS.SELECTORS.LIKE_ITEM} ${CONSTANTS.SELECTORS.LIKE_ICON}`);
        if (!btn) return;

        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        const startPress = (e) => {
            e.preventDefault(); e.stopPropagation();
            _state.timeoutId = UtilsModule.startTimeout(async () => {
                _state.isLongPress = true;
                await _Handlers.openLikesDrawer(entityId);
            }, CONSTANTS.TIMEOUTS.LONG_PRESS);
            _state.isLongPress = false;
        };

        const endPress = (e) => {
            e.preventDefault(); e.stopPropagation();
            UtilsModule.cancelTimeout(_state.timeoutId);
            if (!_state.isLongPress) {
                const liked = newBtn.getAttribute(CONSTANTS.ATTRS.LIKED) === 'true';
                GuardModule.protect(() => {
                    if (_checkOfflineCircuitBreaker()) return;
                    _InteractionLogic.setLike(entityId, !liked);
                });
            }
            _state.isLongPress = false;
        };

        ['mousedown', 'touchstart'].forEach(ev => newBtn.addEventListener(ev, startPress));
        ['mouseup', 'touchend'].forEach(ev => newBtn.addEventListener(ev, endPress));
        newBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
    }
};

const PostsModule = {

    initialize: (ensureAppInitFn) => {
        _state.ensureAppInit = ensureAppInitFn;

        eventBus.on('OFFLINE_MODE', () => {
            handleLog('System in Offline Mode (L3 Active)', 'PostsModule', 'warn', '📰');
            _state.isOffline = true;
        });

        eventBus.on('ONLINE_MODE', () => {
            handleLog('Recovered System', 'PostsModule', 'log', '📰');
            _state.isOffline = false;
        });

        eventBus.on('P2P_CONNECTION_ESTABLISHED', (payload) => {
            if (!ProfileModule.isLogin() || _state.isOffline) {
                handleLog(`P2P Connection Established (${payload.transport}). Force retrying stats...`, 'PostsModule', 'log', '📰');
                _state.isPeersActive = true;
                document.querySelectorAll(`[${CONSTANTS.ATTRS.READY}="true"]`).forEach(el => {
                    el.removeAttribute(CONSTANTS.ATTRS.READY);
                });
                PostsModule.fetchStats();
            }
        });

        eventBus.on('SESSION_ESTABLISHED', async () => {
            _state.isPeersActive = false;
        });

        /**
         * Reacts to a user logout by resetting all interaction bar DOM nodes to their
         * unauthenticated state.
         *
         * After SESSION_CLEARED, no token is available so the backend would return
         * `authorLiked: false` and `authorBookmarked: false` for every entity.
         * Rather than issuing a network round-trip, we reset the DOM directly —
         * the visual state is deterministic for anonymous visitors.
         *
         * Resets applied per interaction bar:
         *  - Like icon  → `data-liked="false"`, removes active class, restores outline icon.
         *  - Bookmark   → `data-attached="false"`, removes active class, restores outline icon.
         *  - Like count → preserved (total count is server-owned, not user-owned).
         */
        eventBus.on('SESSION_CLEARED', () => {
            document.querySelectorAll(CONSTANTS.SELECTORS.ROOT).forEach(barEl => {
                const likeIcon = barEl.querySelector(
                    `${ CONSTANTS.SELECTORS.LIKE_ITEM } ${ CONSTANTS.SELECTORS.LIKE_ICON }`
                );
                if (likeIcon) {
                    likeIcon.setAttribute(CONSTANTS.ATTRS.LIKED, 'false');
                    likeIcon.classList.remove('ql-interaction__icon--active');
                    likeIcon.textContent = 'favorite_border';
                }

                const bookmarkIcon = barEl.querySelector(CONSTANTS.SELECTORS.BOOKMARK);
                if (bookmarkIcon) {
                    bookmarkIcon.setAttribute(CONSTANTS.ATTRS.ATTACHED, 'false');
                    bookmarkIcon.classList.remove('ql-interaction__bookmark--active');
                    bookmarkIcon.textContent = 'bookmark_border';
                }
            });
        });
    },

    updateAllInteractionBars: async () => {
        try {
            const nodes = Array.from(UiModule.getEntityInteractionUI());
            const entitiesSet = new Set(nodes.map(el => el.getAttribute(CONSTANTS.SELECTORS.INTERACTION)));
            const entities = Array.from(entitiesSet);

            if (entities.length) {
                CoreModule.postWorkerMessage({
                    action: 'fetchStats',
                    payload: { entities, forceRefresh: true }
                });
            }
        } catch (error) {
            handleLog(error, 'PostsModule.updateAllInteractionBars', 'error', '📰');
        }
    },

    fetchStats: async () => {
        try {
            const [entities, mapping] = await EntityModule.findEntities();

            if (entities.length > 0) {
                if (InteractionsUi.renderPlaceholders) {
                    InteractionsUi.renderPlaceholders(entities);
                }
                await _WorkerService.fetchStats(entities, mapping);
            }
        } catch (error) {
            handleLog(error, 'PostsModule.fetchStats', 'error', '📰');
        }
    },

    attachEventListeners: (entityId) => {
        const containers = _DomHelper.getElements(entityId);
        if (!containers.length) return;

        const entityConfig = EntityModule.getConfig();

        containers.forEach(container => {
            _EventBinder.bindLikeButton(entityId, container);

            const bindClick = (selector, handler) => {
                const el = container.querySelector(selector);
                if (el) {
                    const newEl = el.cloneNode(true);
                    el.parentNode.replaceChild(newEl, el);
                    newEl.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (selector !== CONSTANTS.SELECTORS.SHARE_ITEM) await _state.ensureAppInit();
                        handler();
                    });
                }
            };

            bindClick(CONSTANTS.SELECTORS.COMMENT_ITEM, () => {
                if (entityConfig.goTo) {
                    let targetUrl = null;

                    if (entityConfig.interaction.deterministic) {
                        targetUrl = EntityModule.getDeterministicHref(entityId);
                    } else {
                        const mainEl = container.closest(entityConfig.selector) || document.querySelector(`[data-entity="${entityId}"]`);
                        if (mainEl) {
                            targetUrl = mainEl.getAttribute('data-href') || null;
                        }
                    }

                    if (targetUrl) {
                        const baseUrl = targetUrl.split('#')[0];
                        window.location.href = `${baseUrl}#QUELORA-E-${entityId}`;
                    } else {
                        PostsModule.loadThread(entityId);
                    }
                } else {
                    PostsModule.loadThread(entityId);
                }
            });

            bindClick(CONSTANTS.SELECTORS.SHARE_ITEM, () => _Handlers.handleShare(entityId));
            bindClick(CONSTANTS.SELECTORS.BOOKMARK, () => _Handlers.handleBookmark(entityId));
        });
    },

    loadThread: async (entityId, lastCommentId = null, includeLast = false) => {
        try {
            const threadsContainer = UiModule.getCommunityThreadsUI();
            const config = UtilsModule.getConfig(entityId) || {};
            let isLive = config.liveMode?.isLiveActive || false;

            if (isLive) {
                const wsClient = await CoreModule.wsClient();
                if (!wsClient) {
                    isLive = false;
                    handleLog(`Live mode disabled for ${entityId}: wsClient unavailable.`, 'PostsModule', 'warn', '📰');
                }
            }

            if (threadsContainer) {
                threadsContainer.setAttribute(CONSTANTS.ATTRS.ENTITY_ID, entityId);

                if (lastCommentId === null) {
                    threadsContainer.scrollTop = 0;

                    const drawerContent = threadsContainer.closest(CONSTANTS.SELECTORS.DRAWER_CONTENT);
                    if (drawerContent) drawerContent.scrollTop = 0;

                    ['height', 'min-height', 'transform'].forEach(prop => threadsContainer.style.removeProperty(prop));

                    CommentsModule.attachCommentInputListener(entityId);
                    UiModule.resetModalUI();
                    UtilsModule.setInputLimit(config?.limits?.comment_text);

                    if (!isLive) {
                        if (UiModule.removeLiveReactionBar) UiModule.removeLiveReactionBar();
                        if (UiModule.createEmojiPickerBarUI) UiModule.createEmojiPickerBarUI();
                    }
                }
            }

            await _Handlers.handleSurvey(config, lastCommentId, entityId);

            if (UiModule.commentsDrawerUI) UiModule.commentsDrawerUI.open();
            const communityUI = UiModule.getCommunityUI();

            if (isLive) {
                if (UiModule.commentsDrawerUI) {
                    UiModule.commentsDrawerUI.confirmCloseOnDrag = true;
                    UiModule.commentsDrawerUI.confirmCloseMessage = 'confirmExistLiveSession';
                }
                _DomHelper.safeClassOp(communityUI, 'add', 'live-active');
                if (CommentsModule.activateLiveModeUI) {
                    CommentsModule.activateLiveModeUI(entityId);
                }
            } else {
                if (UiModule.commentsDrawerUI) {
                    UiModule.commentsDrawerUI.confirmCloseOnDrag = false;
                    UiModule.commentsDrawerUI.confirmCloseMessage = null;
                }
                _DomHelper.safeClassOp(communityUI, 'remove', 'live-active');
                document.getElementById(CONSTANTS.SELECTORS.LIVE_STATS)?.remove();
                CommentsModule.fetchComments(entityId, lastCommentId, includeLast);
            }

        } catch (error) {
            handleLog(error, 'PostsModule.loadThread', 'error', '📰');
        }
    },

    loadNested: (eId, cId, rId) => CommentsModule.fetchNested(eId, cId, rId),

    updateShareCount: _InteractionLogic.updateShareCount,
    setLike: _InteractionLogic.setLike,
    handleShare: _Handlers.handleShare,
    handleLike: _Handlers.handleLike,
    handleBookmark: _Handlers.handleBookmark,

    /**
     * Resolves the canonical base URL for share links of a given entity.
     *
     * Exposed as a public method so that {@link CommentsModule.handleShare} can
     * use the same resolution logic when building comment or reply share URLs —
     * without requiring `comments.js` to import {@link EntityModule} directly.
     *
     * @param {string} entityId - The 24-character entity identifier.
     * @returns {string} The base URL (no trailing `#`) to prepend to an anchor hash.
     */
    resolveShareBaseUrl: _resolveShareBaseUrl
};

export default PostsModule;

/**
 * Entry point for the new Dynamic Plugin Registry architecture.
 * @param {object} context - The application context injected by the loader.
 */
export async function register(context) {
    const ensureAppInit = context?.ensureAppInit || (() => Promise.resolve());

    PostsModule.initialize(ensureAppInit);

    if (window.QueloraApp && window.QueloraApp.Modules) {
        window.QueloraApp.Modules.PostsModule = PostsModule;
    }
}