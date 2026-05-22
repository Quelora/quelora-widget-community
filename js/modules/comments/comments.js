/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/comments/comments.js */
/**
 * @module Modules/Comments
 * @description Manages Thread rendering, Interactions, and Virtualization.
 * Version 10.12.0: Integrated GifPickerModule into the comment input lifecycle.
 * Circuit Breaker for synchronous blocking interception & strict modal encapsulation boundaries.
 * Share URLs now resolve the entity's canonical base URL via PostsModule.resolveShareBaseUrl
 * when goTo is active, so comment and reply links point to the entity's own page.
 */
import handleLog from '../../core/logs.js';
import ConfModule from '../../core/conf.js';
import CoreModule from '../../core/core.js';
import GuardModule from '../../core/guard.js';
import UtilsModule from '../../core/utils.js';
import StorageModule from '../../core/storage.js';
import ProgressInput from '../../ui/components/progressInput.js';
import UiModule from '../../ui/ui.js';
import ProfileModule from '../profile/profile.js';
import I18n from '../../core/i18n.js';
import MentionModule from '../features/mention.js';
import AnchorModule from '../../ui/anchor.js';
import CaptchaModule from '../../services/captcha.js';
import ToastModule from '../../ui/toast.js';
import GifPickerModule from '../../ui/components/gif.js';
import { QuoteSelector } from "../features/quote.js";
import { eventBus } from '../../core/event.js';

const CONSTANTS = {
    SELECTORS: {
        ROOT: '#ql-root',
        CONTAINER: '.ql-community-threads',
        THREAD: '.ql-thread',
        HEADER: '.ql-thread__header',
        BODY: '.ql-thread__body',
        REPLIES: '.ql-thread__replies',
        LOAD_MORE: '.ql-thread__load-more',
        INPUT: '#ql-input',
        LIVE_STATS: '#ql-live-stats-bar'
    },
    CLASSES: {
        THREAD: 'ql-thread',
        HEADER: 'ql-thread__header',
        AVATAR_WRAPPER: 'ql-avatar',
        AVATAR_FRAME: 'ql-avatar__frame',
        AVATAR_IMG: 'ql-avatar__image',
        INFO: 'ql-thread__info',
        AUTHOR: 'ql-thread__author',
        DATE: 'ql-thread__date',
        BODY: 'ql-thread__body',
        ACTIONS: 'ql-thread__actions',
        REPLIES: 'ql-thread__replies',
        LIKE_CONTAINER: 'ql-thread__like',
        LIKE_ICON: 'ql-thread__like-icon',
        LIKE_COUNT: 'ql-thread__like-count',
        ACTION_ICON: 'ql-thread__action-icon',
        NATIVE_AD: 'ql-native-ad',
        SHAKE: 'ql-anim--shake',
        LOAD_MORE: 'ql-thread__load-more',
        SQUARED: 'squared',
        HAS_PICTURE: 'has-picture'
    },
    CONFIG: {
        SCROLL_THRESHOLD: 10,
        LONG_PRESS_DURATION: 300,
        MAX_RENDER_ATTEMPTS: 3,
        MAX_RENDERED_COMMENTS: 300,
        RENDER_ATTEMPT_INTERVAL: 300,
        DEFAULT_COMMENT_LIMIT: 15,
        OBSERVER_ROOT_MARGIN: '1200px',
        BUFFER_SIZE: 50,
        BATCH_SIZE: 50,
        DEBOUNCE_TIME: 600,
        ANIMATION_DURATION: 2500,
        LATENCY: {
            HIGH: { THRESHOLD: 2.5, MARGIN: 3700, MULTIPLIER: 2 },
            MEDIUM: { THRESHOLD: 1.15, MARGIN: 2200, MULTIPLIER: 1 },
            LOW: { MARGIN: 1200, MULTIPLIER: 1 }
        }
    },
    LEVELS: ["ql-level-0", "ql-level-1", "ql-level-2", "ql-level-3", "ql-level-4", "ql-level-5", "ql-level-6", "ql-level-7", "ql-level-8", "ql-level-9"]
};

const _state = {
    isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
    isPeersActive: false,
    worker: null,
    activeCommentEl: null,
    pressTimer: null,
    useCaptcha: false,
    visibilityObservers: null,
    activeAction: null,
    touchStartX: 0,
    touchStartY: 0,
    storedComments: new Map(),
    storedRenderedComments: new Map(),
    isScrolling: false,
    scrollTimeout: null,
    isTyping: false,
    typingDebounceTimeout: null,
    currentLiveInputHandler: null,
    isLongPressTriggered: false,
    latencyMultiplier: 1
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

const _propagateMetadata = (payload, items) => {
    if (!items || !Array.isArray(items)) return;
    if (payload._is_offline || payload._gen_ts) {
        items.forEach(item => {
            if (payload._is_offline && item._is_offline === undefined) item._is_offline = true;
            if (payload._gen_ts && item._gen_ts === undefined) item._gen_ts = payload._gen_ts;
        });
    }
};

const _DomHelper = {
    safeClass: (...classes) => classes.flat().filter(c => c && typeof c === 'string' && c.trim() !== ''),

    getContainer: () => UiModule.getCommunityThreadsUI(),

    getEntityId: () => _DomHelper.getContainer()?.getAttribute('data-threads-entity'),

    findClosest: (element, selector) => element?.closest(selector),

    countRepliesAbove: (element) => {
        try {
            let count = 0;
            let current = element;
            while (current) {
                if (current.classList.contains(CONSTANTS.CLASSES.REPLIES)) count++;
                current = current.parentElement;
            }
            return count;
        } catch (error) {
            handleLog(error, 'Comments._DomHelper.countRepliesAbove', 'error', '💬');
            return 0;
        }
    },

    scrollToElement: (element) => {
        if (!element) return;
        const top = element.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: top - 100, behavior: 'smooth' });
    }
};

const _TextHelper = {
    escapeHtml: (text) => {
        if (!text) return '';
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
};

const _WorkerService = {
    send: (action, payload = {}) => {
        UtilsModule.startTimeout(() => {
            CoreModule.postWorkerMessage({ action, payload });
        }, 0);
    },

    async getTokenAndSend(action, payload, requiresCaptcha = false) {
        await CoreModule.getTokenIfNeeded();
        if (requiresCaptcha && _state.useCaptcha && !payload.captchaToken) {
            payload.captchaToken = await CaptchaModule.getToken();
        }
        _WorkerService.send(action, payload);
    },

    fetchComments: (entityId, lastCommentId = null, includeLast = false, forceRefresh = false) => {
        const container = _DomHelper.getContainer();
        if (!lastCommentId && container) {
            _state.storedComments.clear();
            _state.storedRenderedComments.clear();
            _Virtualization.cleanup();
            _Virtualization.setup();
            container.replaceChildren();
        }

        let total = 0;
        const interactionCountEl = document.querySelector(`.ql-interaction[data-entity-interaction="${entityId}"] [data-interaction-type="comment"] .ql-interaction__count`);

        if (interactionCountEl && interactionCountEl.hasAttribute('data-count')) {
            total = parseInt(interactionCountEl.getAttribute('data-count'), 10) || 0;
        } else {
            const rawTotal = UiModule.getCounterFromDOMUI(entityId, 'comments');
            if (typeof rawTotal === 'string') {
                const lowerVal = rawTotal.toLowerCase();
                let multiplier = 1;
                if (lowerVal.includes('k')) multiplier = 1000;
                else if (lowerVal.includes('m')) multiplier = 1000000;
                const numericPart = parseFloat(lowerVal.replace(/[^\d.]/g, ''));
                total = (isNaN(numericPart) ? 0 : numericPart) * multiplier;
            } else {
                total = Number(rawTotal) || 1;
            }
        }

        const limit = CONSTANTS.CONFIG.DEFAULT_COMMENT_LIMIT * (_state.latencyMultiplier || 1);
        const count = lastCommentId ? limit : Math.min(Math.ceil(total) || limit, limit);

        UiModule.addLoadingMessageUI(container, { type: 'skeleton', position: 'after', empty: false, count });

        UtilsModule.startTimeout(() => {
            _WorkerService.send('getComments', {
                entityId,
                limit,
                ...(lastCommentId && { lastCommentId }),
                ...(includeLast && { includeLast }),
                ...(forceRefresh && { forceRefresh })
            });
        }, 300);
    },

    report: (entityId, commentId, type, observation, blockUser) => {
        if (_checkOfflineCircuitBreaker()) return;
        _WorkerService.getTokenAndSend('reportComment', {
            entityId,
            commentId,
            type,
            observation,
            blockUser,
            source: 'community'
        });
    },

    delete: (entityId, commentId) => {
        if (_checkOfflineCircuitBreaker()) return;
        UiModule.getCommentHeaderUI(commentId, true)?.remove();
        _WorkerService.getTokenAndSend('delComment', { entityId, commentId });
    },

    edit: (entityId, commentId, editComment) => {
        if (_checkOfflineCircuitBreaker()) return;
        const el = UiModule.getCommentHeaderUI(commentId, true);
        _state.storedRenderedComments.delete(commentId);
        _state.storedComments.delete(commentId);
        if (el) {
            el.setAttribute('data-comment-id', commentId);
            UiModule.addLoadingMessageUI(el, { type: 'message', position: 'before', empty: true });
        }
        _WorkerService.getTokenAndSend('editComment', { entityId, commentId, editComment });
    },

    translate: (entityId, commentId) => {
        const el = UiModule.getCommentHeaderUI(commentId, true);
        const txt = el.querySelector(CONSTANTS.SELECTORS.BODY);

        UiModule.addLoadingMessageUI(txt, { type: 'message', position: 'before', empty: true });
        _WorkerService.getTokenAndSend('translateComment', { entityId, commentId });
    }
};

const _Virtualization = {
    setup: () => {
        const container = _DomHelper.getContainer();
        if (!container) return;

        _Virtualization.cleanup();

        const LATENCY_CONFIG = CONSTANTS.CONFIG.LATENCY;
        let marginPx = LATENCY_CONFIG.LOW.MARGIN;
        _state.latencyMultiplier = LATENCY_CONFIG.LOW.MULTIPLIER;

        try {
            const locItemRaw = StorageModule.getLocalItem('quelora_user_location') || StorageModule.getLocalItem('ql_user_location');
            const serverCC = StorageModule.getLocalItem('ql_last_server_country');
            let userCC = null;

            if (locItemRaw) {
                try {
                    let parsedData;
                    try { parsedData = JSON.parse(locItemRaw); } catch(e) { parsedData = locItemRaw; }
                    const innerJsonStr = (parsedData && parsedData.value) ? parsedData.value : locItemRaw;
                    const geoData = (typeof innerJsonStr === 'string') ? JSON.parse(innerJsonStr) : innerJsonStr;
                    if (geoData) userCC = geoData.countryCode || geoData.country_code;
                } catch (e) {}
            }

            const factor = (userCC && serverCC) ? UtilsModule.getGeoLatencyFactor(userCC, serverCC) : 1.2;

            if (factor >= LATENCY_CONFIG.HIGH.THRESHOLD) {
                marginPx = LATENCY_CONFIG.HIGH.MARGIN;
                _state.latencyMultiplier = LATENCY_CONFIG.HIGH.MULTIPLIER;
            } else if (factor >= LATENCY_CONFIG.MEDIUM.THRESHOLD) {
                marginPx = LATENCY_CONFIG.MEDIUM.MARGIN;
            }

        } catch (err) {}

        const handleIntersect = (entries, isLoadMore = false) => {
            if (isLoadMore) {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        entry.target.click();
                        _state.visibilityObservers.loadMore.unobserve(entry.target);
                    }
                });
                return;
            }

            const comments = Array.from(container.querySelectorAll(CONSTANTS.SELECTORS.THREAD));
            entries.forEach(entry => {
                const id = entry.target.getAttribute('data-comment-id') || entry.target.getAttribute('data-comment-dehydrated');
                if (!id) return;

                const isVis = entry.isIntersecting;
                entry.target.setAttribute('data-comment-visible', isVis);

                if (isVis && entry.target.hasAttribute('data-comment-dehydrated')) {
                    _Virtualization.rehydrate(entry.target);
                }
            });

            if (!_state.isScrolling) {
                UtilsModule.startTimeout(() => _Virtualization.manage(comments), 200);
            }
        };

        const obsConfig = { root: container, rootMargin: CONSTANTS.CONFIG.OBSERVER_ROOT_MARGIN, threshold: 0 };
        const loadMoreConfig = {
            root: container,
            rootMargin: `0px 0px ${marginPx}px 0px`,
            threshold: 0
        };

        const commentObserver = new IntersectionObserver(e => handleIntersect(e), obsConfig);
        const loadMoreObserver = new IntersectionObserver(e => handleIntersect(e, true), loadMoreConfig);

        const keys = [
            UtilsModule.registerObserver(commentObserver, container, 'intersection', e => handleIntersect(e)),
            UtilsModule.registerObserver(loadMoreObserver, container, 'intersection', e => handleIntersect(e, true))
        ];

        const mutationObserver = new MutationObserver(() => {
            _Virtualization.observeElements(container, commentObserver, loadMoreObserver);
            if (!_state.isScrolling) {
                UtilsModule.startTimeout(() => _Virtualization.manage(Array.from(container.querySelectorAll(CONSTANTS.SELECTORS.THREAD))), 200);
            }
        });

        mutationObserver.observe(container, { childList: true, subtree: true });
        keys.push(UtilsModule.registerObserver(mutationObserver, container, 'mutation', () => {}));

        container.addEventListener('scroll', () => {
            _state.isScrolling = true;
            if (_state.scrollTimeout) clearTimeout(_state.scrollTimeout);
            _state.scrollTimeout = UtilsModule.startTimeout(() => {
                _state.isScrolling = false;
                UtilsModule.startTimeout(() => _Virtualization.manage(Array.from(container.querySelectorAll(CONSTANTS.SELECTORS.THREAD))), 200);
            }, 150);
        }, { passive: true });

        _Virtualization.observeElements(container, commentObserver, loadMoreObserver);

        _state.visibilityObservers = {
            comment: commentObserver,
            loadMore: loadMoreObserver,
            mutation: mutationObserver,
            keys,
            disconnect: () => {
                keys.forEach(k => UtilsModule.unregisterObserver(k));
                container.querySelectorAll(`${CONSTANTS.SELECTORS.HEADER}[data-comment-id]`).forEach(h => h.removeAttribute('data-comment-visible'));
            }
        };
    },

    observeElements: (container, cObs, lObs) => {
        container.querySelectorAll(`${CONSTANTS.SELECTORS.THREAD}:not([data-observed])`).forEach(el => {
            cObs.observe(el);
            el.dataset.observed = 'true';
            if (!el.hasAttribute('data-comment-id')) {
                const id = el.querySelector(`${CONSTANTS.SELECTORS.HEADER}[data-comment-id]`)?.getAttribute('data-comment-id');
                if (id) el.setAttribute('data-comment-id', id);
            }
        });
        container.querySelectorAll(`${CONSTANTS.SELECTORS.LOAD_MORE}:not([data-load-more-observed])`).forEach(el => {
            lObs.observe(el);
            el.dataset.loadMoreObserved = 'true';
        });
    },

    cleanup: () => {
        if (_state.visibilityObservers) {
            _state.visibilityObservers.disconnect();
            _state.visibilityObservers = null;
        }
    },

    manage: (comments) => {
        if (!comments || !comments.length) {
            const container = _DomHelper.getContainer();
            if (!container) return;
            comments = Array.from(container.querySelectorAll(`${CONSTANTS.SELECTORS.THREAD}:not(.${CONSTANTS.CLASSES.NATIVE_AD})`));
        } else {
            comments = comments.filter(c => !c.classList.contains(CONSTANTS.CLASSES.NATIVE_AD));
        }

        if (!comments.length) return;

        const visibleIdx = comments.reduce((acc, t, i) => t.getAttribute('data-comment-visible') === 'true' ? [...acc, i] : acc, []);
        if (!visibleIdx.length) return;

        const min = Math.min(...visibleIdx);
        const max = Math.max(...visibleIdx);
        const start = Math.max(0, min - CONSTANTS.CONFIG.BUFFER_SIZE);
        const end = Math.min(comments.length - 1, max + CONSTANTS.CONFIG.BUFFER_SIZE);

        if (comments.length < CONSTANTS.CONFIG.BUFFER_SIZE * 3) {
            const rehydrate = comments.filter(t => t.hasAttribute('data-comment-dehydrated'));
            _Virtualization.processBatches(rehydrate, t => _Virtualization.rehydrate(t));
            return;
        }

        const toRehydrate = [];
        const toDehydrate = [];

        comments.forEach((thread, i) => {
            const id = thread.getAttribute('data-comment-id') || thread.getAttribute('data-comment-dehydrated');
            if (!id) return;
            if (i >= start && i <= end) {
                if (thread.hasAttribute('data-comment-dehydrated')) toRehydrate.push(thread);
            } else {
                if (!thread.hasAttribute('data-comment-dehydrated')) toDehydrate.push({ thread, id });
            }
        });

        _Virtualization.processBatches(toDehydrate, ({ thread, id }) => requestIdleCallback(() => _Virtualization.dehydrate(thread, id)));
        _Virtualization.processBatches(toRehydrate, thread => requestIdleCallback(() => _Virtualization.rehydrate(thread)));
    },

    processBatches: (items, action) => {
        let index = 0;
        const next = () => {
            if (index >= items.length) return;
            const chunk = items.slice(index, Math.min(index + CONSTANTS.CONFIG.BATCH_SIZE, items.length));
            requestIdleCallback(() => {
                chunk.forEach(action);
                index += CONSTANTS.CONFIG.BATCH_SIZE;
                if (index < items.length) UtilsModule.startTimeout(next, 100);
            });
        };
        next();
    },

    dehydrate: (el, id) => {
        if (el.classList.contains(CONSTANTS.CLASSES.NATIVE_AD)) return;
        if (el.hasAttribute('data-comment-dehydrated')) return;

        const rect = el.getBoundingClientRect();
        const h = rect.height;
        if (h < 20) return;

        el.setAttribute('data-comment-id', id);
        el.querySelector(CONSTANTS.SELECTORS.REPLIES)?.remove();
        el.replaceChildren();
        el.style.minHeight = `${h}px`;
        el.setAttribute('data-comment-dehydrated', id);
        el.dataset.observed = 'false';
        if (_state.visibilityObservers?.comment) {
            _state.visibilityObservers.comment.observe(el);
        }
    },

    rehydrate: async (el) => {
        if (!el.hasAttribute('data-comment-dehydrated')) return;
        const entity = _DomHelper.getEntityId();
        const id = el.getAttribute('data-comment-dehydrated');
        const data = _state.storedComments.get(id);
        if (!data) return;

        const replies = el.querySelector(CONSTANTS.SELECTORS.REPLIES);
        const children = replies ? Array.from(replies.children) : [];
        const node = _Renderer.create(data, entity);

        if (node) {
            el.replaceChildren(...node.childNodes);
            const newReplies = el.querySelector(CONSTANTS.SELECTORS.REPLIES);
            if (newReplies && children.length) newReplies.append(...children);
            el.removeAttribute('data-comment-dehydrated');
            el.style.minHeight = '';
            el.dataset.observed = 'false';
            if (_state.visibilityObservers?.comment) {
                _state.visibilityObservers.comment.observe(el);
            }
        }
    }
};

const _Renderer = {
    create: (comment, entity, isReply) => {
        try {
            if (!comment?._id) return null;
            if (ProfileModule.isBlockedAuthor(comment.author)) return null;

            const cachedHTML = _state.storedRenderedComments.get(comment._id);
            if (cachedHTML) {
                const temp = document.createElement('div');
                temp.innerHTML = cachedHTML;
                return temp.firstElementChild;
            }

            const sessionProfile = ProfileModule.getCurrentProfile();
            const isSessionAuthor = sessionProfile && sessionProfile.author === comment.author;

            if (isSessionAuthor) {
                comment.profile = { ...comment.profile, ...sessionProfile };
            }

            ProfileModule.memberProfiles.set(comment.author, comment?.profile);
            const config = UtilsModule.getConfig(entity) || {};
            const { interaction = {}, language = {}, editing = {} } = config;

            const el = UiModule.createElementUI({
                tag: 'div',
                classes: _DomHelper.safeClass(CONSTANTS.CLASSES.THREAD),
                attributes: { 'data-author-id': comment.author, 'data-comment-id': comment._id, 'data-root-id': comment.root }
            });

            const timeDiff = (Date.now() - new Date(comment.timestamp ?? comment.created_at)) / 60000;
            const canMod = isSessionAuthor && timeDiff < (editing.edit_time_limit || Infinity) && !comment.repliesCount && !comment.hasAudio;

            const header = UiModule.createElementUI({
                tag: 'div',
                classes: _DomHelper.safeClass(CONSTANTS.CLASSES.HEADER),
                attributes: {
                    'data-is-reply': isReply,
                    'data-comment-id': comment._id,
                    'data-can-edit': canMod,
                    'data-can-delete': canMod,
                    'data-comment-language': comment.language,
                    'data-owner': isSessionAuthor
                }
            });

            const avatarWrapper = UiModule.createElementUI({
                tag: 'div',
                classes: _DomHelper.safeClass(CONSTANTS.CLASSES.AVATAR_WRAPPER),
                attributes: { 'data-author-id': comment.author }
            });

            const frameUrl = comment.profile?.avatarFrameUrl || "";
            const isSquared = comment.profile?.avatarFrameType === 'SQUARED';
            const shapeClass = isSquared ? CONSTANTS.CLASSES.SQUARED : '';

            if (frameUrl) {
                const assetBaseUrl = ConfModule.get('assetBaseUrl');
                avatarWrapper.appendChild(UiModule.createElementUI({
                    tag: 'div',
                    classes: _DomHelper.safeClass(CONSTANTS.CLASSES.AVATAR_FRAME, shapeClass),
                    styles: { backgroundImage: `url('${assetBaseUrl}/${frameUrl}')` }
                }));
            }

            const initials = comment.profile?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || '';

            const avatar = UiModule.createElementUI({
                tag: 'div',
                classes: _DomHelper.safeClass(CONSTANTS.CLASSES.AVATAR_IMG, comment.profile?.picture ? CONSTANTS.CLASSES.HAS_PICTURE : '', shapeClass),
                content: comment.profile?.picture ? '' : initials,
                attributes: { 'data-visibility': comment.profile?.visibility }
            });

            if (comment.profile?.picture) avatar.style.backgroundImage = `url('${comment.profile.picture}')`;
            avatarWrapper.appendChild(avatar);

            if (ProfileModule.isLogin() && !isSessionAuthor && comment.profile?.online) {
                const statusDot = UiModule.createElementUI({ tag: 'span', classes: ['ql-status-dot', 'ql-status-dot--online'] });
                statusDot.style.display = 'block';
                avatarWrapper.appendChild(statusDot);
            }

            const info = UiModule.createElementUI({ tag: 'div', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.INFO) });
            info.appendChild(UiModule.createElementUI({
                tag: 'span',
                classes: _DomHelper.safeClass(CONSTANTS.CLASSES.AUTHOR),
                attributes: { 'data-author-user': comment.profile.author },
                content: comment.profile.name || I18n.getTranslation('user'),
                translate: !comment.profile.name
            }));

            const timeEl = UiModule.createElementUI({ tag: 'span', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.DATE) });
            const timeAgo = UtilsModule.getTimeAgo(comment.timestamp ?? comment.created_at);

            if (comment.isEdited) {
                timeEl.append(
                    UiModule.createElementUI({ tag: 'span', content: '{{edited}}', translate: true }),
                    document.createTextNode(' - '),
                    UiModule.createElementUI({ tag: 'span', content: timeAgo, translate: true })
                );
            } else {
                timeEl.appendChild(UiModule.createElementUI({ tag: 'span', classes: ['t'], content: timeAgo, translate: true }));
            }

            const isL3 = comment._is_offline === true;
            const isL2 = _state.isPeersActive;
            let genTs = comment._gen_ts;

            if (genTs && genTs < 10000000000) { genTs = genTs * 1000; }
            const isFresh = genTs ? (Date.now() - genTs) < 60000 : false;

            if (isL3 || (isL2 && genTs && !isFresh)) {
                const indicator = document.createElement('span');
                if (isL3) {
                    indicator.className = `ql-stale-indicator ql-stale-indicator--l3`;
                    indicator.innerHTML = `<span class="ql-icons-outlined">cloud_off</span>`;
                } else if (isL2) {
                    const cacheAge = UtilsModule.getTimeAgo(genTs);
                    indicator.className = `ql-stale-indicator ql-stale-indicator--l2`;
                    indicator.innerHTML = `<span class="ql-icons-outlined" style="font-size:11px; margin-right:3px;">history</span><span class="t">${cacheAge}</span>`;
                }
                if (indicator.className) {
                    timeEl.appendChild(indicator);
                }
            }

            info.appendChild(timeEl);

            const likeDiv = UiModule.createElementUI({ tag: 'div', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.LIKE_CONTAINER) });
            likeDiv.append(
                UiModule.createElementUI({
                    tag: 'span',
                    classes: _DomHelper.safeClass(CONSTANTS.CLASSES.LIKE_ICON, comment.authorLiked ? 'active' : '', 'ql-icons-outlined'),
                    content: comment.authorLiked ? 'favorite' : 'favorite_border'
                }),
                UiModule.createElementUI({
                    tag: 'span',
                    classes: _DomHelper.safeClass(CONSTANTS.CLASSES.LIKE_COUNT),
                    content: comment.likes?.toString() || '0'
                })
            );

            header.append(avatarWrapper, info, likeDiv);

            const textDiv = UiModule.createElementUI({ tag: 'div', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.BODY) });
            const contentId = `ql-content-${comment._id}`;
            const contentDiv = document.createElement('div');
            contentDiv.id = contentId;
            contentDiv.className = 'ql-body-container';

            if (_state.worker) {
                _state.worker.postMessage({
                    action: 'parseMarkdown',
                    payload: { text: comment.text, id: comment._id },
                    originalAction: 'renderCommentHTML'
                });
            } else {
                contentDiv.innerHTML = _TextHelper.escapeHtml(comment.text);
            }

            textDiv.appendChild(contentDiv);
            el.append(header, textDiv);

            if (comment.hasAudio) {
                const audioDiv = UiModule.createElementUI({ tag: 'div', classes: _DomHelper.safeClass('ql-thread__audio') });
                const audioUI = UiModule.audioUI(comment.text, null, comment.audioHash, comment._id);
                if (audioUI) audioDiv.appendChild(audioUI);
                el.appendChild(audioDiv);
            }

            const actions = UiModule.createElementUI({ tag: 'div', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.ACTIONS) });
            actions.appendChild(UiModule.createElementUI({
                tag: 'span',
                classes: _DomHelper.safeClass('ql-icons-outlined', CONSTANTS.CLASSES.ACTION_ICON, 'setting-comment'),
                attributes: { 'data-comment-id': comment._id },
                content: 'settings'
            }));

            if (interaction.allow_replies) actions.appendChild(UiModule.createElementUI({ tag: 'span', classes: _DomHelper.safeClass('ql-action-text', 'reply-text'), attributes: { 'data-reply-id': comment._id }, content: '{{reply}}', translate: true }));
            if (interaction.allow_quotes) actions.appendChild(UiModule.createElementUI({ tag: 'span', classes: _DomHelper.safeClass('ql-action-text', 'quote-text'), attributes: { 'data-comment-id': comment._id }, content: '{{quote}}', translate: true }));

            const qlLang = ProfileModule.isLogin() ? ProfileModule.getOwnLanguage() : navigator.language.substring(0, 2);
            if (language.auto_translate && comment.language !== qlLang) {
                actions.appendChild(UiModule.createElementUI({ tag: 'span', classes: _DomHelper.safeClass('ql-action-text', 'translate-text'), attributes: { 'data-comment-id': comment._id }, content: '{{translate}}', translate: true }));
            }
            if (interaction.allow_shares) actions.appendChild(UiModule.createElementUI({ tag: 'span', classes: _DomHelper.safeClass('ql-action-text', 'share-text'), attributes: { 'data-comment-id': comment._id }, content: '{{share}}', translate: true }));

            if (comment.repliesCount > 0) {
                const viewR = UiModule.createElementUI({
                    tag: 'span',
                    classes: _DomHelper.safeClass('ql-action-text', 'view-replies'),
                    attributes: {
                        'data-comment-id': comment._id,
                        'data-count': comment.repliesCount || 0
                    }
                });
                viewR.append(
                    UiModule.createElementUI({ tag: 'span', content: `{{view}}`, translate: true }),
                    UiModule.createElementUI({ tag: 'span', content: ` ${comment.repliesCount} ` }),
                    UiModule.createElementUI({ tag: 'span', content: comment.repliesCount === 1 ? "{{answer}}" : "{{answers}}", translate: true })
                );
                actions.appendChild(viewR);
            }

            el.append(actions, UiModule.createElementUI({ tag: 'div', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.REPLIES), attributes: { 'data-reply-id': comment._id } }));

            if (!_state.storedComments.has(comment._id)) _state.storedComments.set(comment._id, comment);

            if (!_state.storedRenderedComments.has(comment._id)) {
                _state.storedRenderedComments.set(comment._id, el.outerHTML);
                if (_state.storedRenderedComments.size > CONSTANTS.CONFIG.MAX_RENDERED_COMMENTS) {
                    _state.storedRenderedComments.delete(_state.storedRenderedComments.keys().next().value);
                }
            }
            return el;

        } catch (e) {
            handleLog(e, 'Comments._Renderer.create', 'error', '💬');
            return null;
        }
    },

    list: (entity, comments, container) => {
        const frag = document.createDocumentFragment();
        if (!container.classList.contains(CONSTANTS.CLASSES.REPLIES) && !comments.length && !container.children.length) {
            frag.appendChild(UiModule.createElementUI({
                tag: 'div',
                classes: _DomHelper.safeClass('ql-empty-container'),
                content: '{{emptyComments}}',
                translate: true
            }));
        } else {
            comments.forEach(c => {
                if (ProfileModule.isBlockedAuthor(c.author)) return;
                const level = _DomHelper.countRepliesAbove(container);
                const el = _Renderer.create(c, entity, level !== 0);
                if (el) {
                    el.querySelector(CONSTANTS.SELECTORS.REPLIES)?.classList.add(CONSTANTS.LEVELS[level] || 'ql-level-default');
                    frag.appendChild(el);
                }
            });
        }
        container.appendChild(frag);
    },

    shake: async (id) => {
        const el = UiModule.getCommentHeaderUI(id);
        if (el) {
            _DomHelper.scrollToElement(el);
            el.classList.add(CONSTANTS.CLASSES.SHAKE);
            UtilsModule.startTimeout(() => el.classList.remove(CONSTANTS.CLASSES.SHAKE), CONSTANTS.CONFIG.ANIMATION_DURATION);
        }
    }
};

const _EventBinder = {
    setup: () => {
        const container = _DomHelper.getContainer();
        if (!container) return;

        ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(evt => {
            container.removeEventListener(evt, _EventBinder[evt]);
            container.addEventListener(evt, _EventBinder[evt], { passive: evt !== 'touchend' });
        });

        container.removeEventListener('click', _EventBinder.clickDelegate);
        container.addEventListener('click', _EventBinder.clickDelegate);

        container.addEventListener('contextmenu', (e) => {
            if (e.target.closest(`.${CONSTANTS.CLASSES.LIKE_CONTAINER}`)) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
    },

    _openLikes: (entityId, commentId) => {
        GuardModule.protect(() => {
            if (!UiModule.likesDrawerUI) return;
            UiModule.likesDrawerUI.open();
            UiModule.addLoadingMessageUI(UiModule.getLikesListUI(), { type: 'profile', position: 'after', empty: true, count: 10 });
            _WorkerService.getTokenAndSend('getCommentLikes', { entityId, commentId });
        });
    },

    touchstart: (e) => {
        _state.isLongPressTriggered = false;
        const likeBtn = e.target.closest(`.${CONSTANTS.CLASSES.LIKE_CONTAINER}`);
        const content = e.target.closest(CONSTANTS.SELECTORS.BODY);

        if (!likeBtn && !content) return;

        _state.activeCommentEl = e.target.closest(CONSTANTS.SELECTORS.THREAD);
        if (!_state.activeCommentEl) return;

        if (likeBtn) {
            _state.activeAction = 'like';
            e.stopPropagation();
        } else {
            _state.activeAction = 'edit';
        }

        _state.touchStartX = e.touches[0].clientX;
        _state.touchStartY = e.touches[0].clientY;

        if (_state.pressTimer) clearTimeout(_state.pressTimer);

        _state.pressTimer = UtilsModule.startTimeout(() => {
            if (!_state.activeCommentEl) return;
            _state.isLongPressTriggered = true;

            const id = _state.activeCommentEl.getAttribute('data-comment-id');
            const entity = _DomHelper.getEntityId();

            if (_state.activeAction === 'like') {
                if (UtilsModule.isMobile) _EventBinder._openLikes(entity, id);
            } else if (_state.activeAction === 'edit') {
                UiModule.showEditCommentUI(_state.activeCommentEl);
            }
            _state.activeAction = null;
        }, CONSTANTS.CONFIG.LONG_PRESS_DURATION);
    },

    touchmove: (e) => {
        if (!_state.activeCommentEl) return;
        const dx = Math.abs(e.touches[0].clientX - _state.touchStartX);
        const dy = Math.abs(e.touches[0].clientY - _state.touchStartY);

        if (dx > CONSTANTS.CONFIG.SCROLL_THRESHOLD || dy > CONSTANTS.CONFIG.SCROLL_THRESHOLD) {
            if (_state.pressTimer) clearTimeout(_state.pressTimer);
            _state.activeCommentEl = null;
            _state.isLongPressTriggered = false;
        }
    },

    touchend: (e) => {
        if (_state.pressTimer) clearTimeout(_state.pressTimer);
        UtilsModule.startTimeout(() => {
            _state.activeCommentEl = null;
        }, 50);
    },

    clickDelegate: (e) => {
        const target = e.target;
        const thread = _DomHelper.findClosest(target, CONSTANTS.SELECTORS.THREAD);
        const entity = _DomHelper.getEntityId();
        const id = thread?.getAttribute('data-comment-id');

        if (target.closest(CONSTANTS.SELECTORS.LOAD_MORE)) {
            e.preventDefault();
            const btn = target.closest(CONSTANTS.SELECTORS.LOAD_MORE);
            const container = btn.parentElement;
            const last = container.querySelectorAll(`${CONSTANTS.SELECTORS.THREAD} ${CONSTANTS.SELECTORS.HEADER}`);
            const lastId = last[last.length - 1]?.getAttribute('data-comment-id');

            if (container.classList.contains(CONSTANTS.CLASSES.REPLIES)) {
                _WorkerService.send('getReplies', { entityId: entity, commentId: container.getAttribute('data-reply-id'), lastCommentId: lastId });
            } else {
                _WorkerService.fetchComments(entity, lastId);
            }
            btn.remove();
            return;
        }

        if (target.closest('.view-replies')) {
            e.preventDefault();
            const btn = target.closest('.view-replies');
            const count = parseInt(btn.getAttribute('data-count'), 10) || 0;

            UiModule.addLoadingMessageUI(UiModule.getCommentRepliesUI(id), {
                type: 'skeleton',
                count: Math.min(count, 10)
            });

            _WorkerService.send('getReplies', { entityId: entity, commentId: id });
            btn.remove();
            return;
        }

        if (target.closest(`.${CONSTANTS.CLASSES.LIKE_CONTAINER}`)) {
            e.preventDefault();
            e.stopPropagation();
            if (_state.isLongPressTriggered) {
                _state.isLongPressTriggered = false;
                return;
            }
            if (target.closest(`.${CONSTANTS.CLASSES.LIKE_COUNT}`)) {
                if (UtilsModule.isMobile) return;
                _EventBinder._openLikes(entity, id);
                return;
            }
            const likeIcon = target.closest(`.${CONSTANTS.CLASSES.LIKE_ICON}`);
            const isCurrentlyLiked = likeIcon.getAttribute('data-liked') === 'true' || likeIcon.textContent === 'favorite';
            const nextState = !isCurrentlyLiked;

            GuardModule.protect(() => {
                if (_checkOfflineCircuitBreaker()) return;

                UiModule.updateCommentLikeUI(UiModule.getCommentHeaderUI(id, false), nextState);
                _WorkerService.getTokenAndSend('setLikeComment', { entityId: entity, commentId: id, liked: nextState });
            });
            return;
        }

        if (target.closest(`.${CONSTANTS.CLASSES.LIKE_COUNT}`)) {
            e.preventDefault();
            e.stopPropagation();
            if (!UtilsModule.isMobile) _EventBinder._openLikes(entity, id);
            return;
        }

        const avatarWrapper = target.closest(`.${CONSTANTS.CLASSES.AVATAR_WRAPPER}`) || target.closest(`.${CONSTANTS.CLASSES.AVATAR_IMG}`);
        if (avatarWrapper) {
            e.preventDefault();
            const uid = avatarWrapper.getAttribute('data-author-id') || thread.getAttribute('data-author-id');
            GuardModule.protect(() => ProfileModule.getProfile(uid));
            return;
        }

        if (target.closest('.setting-comment')) {
            e.preventDefault();
            UiModule.showEditCommentUI(thread);
            return;
        }

        if (target.closest('.reply-text')) {
            e.preventDefault();
            GuardModule.protect(() => {
                UtilsModule.setInputLimit(UtilsModule.getConfig(entity)?.limits?.reply_text);
                const input = UiModule.getCommentInputUI();
                const replyId = target.closest('.reply-text').getAttribute('data-reply-id');
                if (input) {
                    input.setAttribute('data-reply-id', replyId);
                    UiModule.addReplyHeaderUI(thread.querySelector(CONSTANTS.SELECTORS.HEADER), replyId);
                    input.focus();
                }
            });
            return;
        }

        if (target.closest('.translate-text')) {
            e.preventDefault();
            const headerEl = thread.querySelector(CONSTANTS.SELECTORS.HEADER);
            const txtEl = thread.querySelector(CONSTANTS.SELECTORS.BODY);
            const originalText = headerEl.getAttribute('data-text-original');

            if (originalText) {
                txtEl.textContent = originalText;
                headerEl.removeAttribute('data-text-original');
                target.closest('.translate-text').textContent = I18n.getTranslation('translate');
            } else {
                GuardModule.protect(() => {
                    headerEl.setAttribute('data-text-original', txtEl.textContent);
                    _WorkerService.translate(entity, id);
                });
            }
            return;
        }

        if (target.closest('.share-text')) {
            e.preventDefault();
            const cid  = thread.getAttribute('data-comment-id');
            const orig = thread.getAttribute('data-root-id');
            const postsModule = window.QueloraApp?.Modules?.PostsModule;
            const baseUrl = postsModule?.resolveShareBaseUrl
                ? postsModule.resolveShareBaseUrl(entity)
                : window.location.href.split('#')[0];
            CommentsModule.handleShare(entity, orig || cid, orig ? cid : '', baseUrl);
            return;
        }

        if (target.closest('.quote-text')) {
            e.stopPropagation();
            const txtEl = thread.querySelector(CONSTANTS.SELECTORS.BODY);
            if (txtEl) {
                new QuoteSelector((t, auth) => UiModule.insertTextIntoCommentInputUI(`> ${t} - @${auth}\n\n`)).activateWithElement(txtEl);
            }
        }
    }
};

const _LiveService = {
    connect: async (entityId) => {
        let ws = await CoreModule.wsClient();
        if (!ws) return;

        if (ws.activeEntityId || ws.isConnected) {
            const prev = ws.activeEntityId || entityId;
            handleLog(`Restarting Live for: ${prev}`, 'Comments._LiveService.connect', 'info', '💬');
            await _LiveService.cleanup(prev);
            await CoreModule.disconnectWebSocket();
            ws = await CoreModule.wsClient();
            if (!ws) return;
        }

        if (UiModule.setLiveModeUI) UiModule.setLiveModeUI(true, entityId);
        _DomHelper.getContainer()?.replaceChildren();
        UiModule.getCommunityUI()?.classList.add('live-active');

        let bar = document.querySelector(CONSTANTS.SELECTORS.LIVE_STATS);
        if (!bar) {
            bar = UiModule.createElementUI({
                tag: 'div', attributes: { id: 'ql-live-stats-bar' },
                classes: ['ql-live-stats-container'],
                styles: { position: 'sticky', top: '-2px', zIndex: 1 }
            });
            const container = _DomHelper.getContainer();
            container?.parentNode.insertBefore(bar, container);
        }

        bar.innerHTML = `<span class="t" style="padding: 4px;">{{connectingToLive}}...</span>`;
        bar.style.display = 'flex';

        if (UiModule.createLiveReactionBar) UiModule.createLiveReactionBar(entityId, (emoji) => _LiveService.sendMsg(entityId, emoji));
        if (UiModule.removeEmojiPickerBarUI) UiModule.removeEmojiPickerBarUI();

        _LiveService.attachTyping(entityId);
        ws.subscribe(entityId);

        if (window.QueloraApp?.Modules?.AdsModule) {
            window.QueloraApp.Modules.AdsModule.requestAds(entityId, null, ['thread-overlay-live', 'comment-sponsored-top']);
        }
    },

    cleanup: async (entityId) => {
        document.querySelector(CONSTANTS.SELECTORS.LIVE_STATS)?.remove();
        if (UiModule.setLiveModeUI) UiModule.setLiveModeUI(false, entityId);

        const input = UiModule.getCommentInputUI();
        if (input && _state.currentLiveInputHandler) {
            input.removeEventListener('input', _state.currentLiveInputHandler);
            input.removeAttribute('data-live-typing-listener');
            _state.currentLiveInputHandler = null;
        }

        if (_state.typingDebounceTimeout) clearTimeout(_state.typingDebounceTimeout);
        _state.isTyping = false;

        const ws = await CoreModule.wsClient();
        if (ws) ws.unsubscribe(entityId);

        if (UiModule.removeLiveReactionBar) UiModule.removeLiveReactionBar();
    },

    attachTyping: (entityId) => {
        const input = UiModule.getCommentInputUI();
        if (!input || input.hasAttribute('data-live-typing-listener')) return;

        input.setAttribute('data-live-typing-listener', 'true');
        const handler = () => {
            if (!_state.isTyping) _LiveService.sendTyping(entityId, true);
            if (_state.typingDebounceTimeout) clearTimeout(_state.typingDebounceTimeout);
            _state.typingDebounceTimeout = UtilsModule.startTimeout(() => _LiveService.sendTyping(entityId, false), 3000);
        };

        input.addEventListener('input', handler);
        _state.currentLiveInputHandler = handler;
    },

    sendTyping: async (entityId, status) => {
        if (status === _state.isTyping) return;
        _state.isTyping = status;
        const ws = await CoreModule.wsClient();
        if (ws) ws.sendTypingStatus(entityId, status);
    },

    sendMsg: async (entityId, text) => {
        const ws = await CoreModule.wsClient();
        if (!ws) return;

        const token = await CoreModule.getTokenIfNeeded(null, true);
        if (!token) return UiModule.renderErrorMessageUI(I18n.getTranslation('loginRequiredToSendLiveMessage'));
        if (!ws.isConnected) return UiModule.renderErrorMessageUI(I18n.getTranslation('liveChatUnavailable'));

        if (ws.sendNewMessage(text)) {
            UiModule.getCommentInputUI().value = '';
            _LiveService.sendTyping(entityId, false);
            if (_state.typingDebounceTimeout) clearTimeout(_state.typingDebounceTimeout);
        }
    },

    renderMsg: (data) => {
        if (ProfileModule.isBlockedAuthor(data.author)) return;

        const container = _DomHelper.getContainer();
        if (!container) return;

        const threshold = 300;
        const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        const isUserAtBottom = distanceFromBottom < threshold;

        const el = _Renderer.create(data, _DomHelper.getEntityId(), false);
        if (el) {
            container.appendChild(el);
            if (isUserAtBottom) {
                UtilsModule.startTimeout(() => {
                    container.scrollTop = container.scrollHeight;
                }, 50);
            }
        }
    },
};

const CommentsModule = {
    init: (worker) => {
        _state.worker = worker;

        eventBus.on('OFFLINE_MODE', (payload) => {
            handleLog('System in Offline Mode (L3 Active)', 'CommentModule', 'warn', '💬');
            _state.isOffline = true;
        });

        eventBus.on('ONLINE_MODE', (payload) => {
            handleLog('Recovered System', 'CommentModule', 'log', '💬');
            _state.isOffline = false;
        });

        eventBus.on('P2P_CONNECTION_ESTABLISHED', (payload) => {
            if (!ProfileModule.isLogin() || _state.isOffline) {
                _state.isPeersActive = true;
                handleLog(`P2P Connection Established (${payload.transport}).`, 'CommentModule', 'log', '💬');
            }
        });

        eventBus.on('SESSION_ESTABLISHED', async ({ isNewLogin }) => {
            _state.isPeersActive = false;
        });

        CommentsModule.initializeComments();
    },

    initializeComments: async () => {
        try {
            _state.useCaptcha = ConfModule.get('captcha.enabled') || false;
            MentionModule.registerHandler(ProfileModule.getMention);
            _EventBinder.setup();
            _Virtualization.setup();

            eventBus.on('USER_PROFILE_UPDATED', (profile) => {
                if (!profile || !profile.author) return;

                if (UiModule.updateUserVisuals) {
                    UiModule.updateUserVisuals(profile);
                }

                if (_state.storedComments.size > 0) {
                    _state.storedComments.forEach((comment) => {
                        if (comment.author === profile.author) {
                            comment.profile = { ...comment.profile, ...profile };
                        }
                    });
                }

                if (_state.storedRenderedComments.size > 0) {
                    for (const [id, html] of _state.storedRenderedComments.entries()) {
                        if (html.includes(`data-author-id="${profile.author}"`)) {
                            _state.storedRenderedComments.delete(id);
                        }
                    }
                }
            });

        } catch (error) {
            handleLog(error, 'CommentsModule.initializeComments', 'error', '💬');
        }
    },

    /**
     * Wires all interactive listeners to the comment input element for a given entity.
     *
     * When `comments.allowGif` is enabled in the SDK configuration,
     * {@link GifPickerModule.attach} is called here so the GIF trigger button is
     * injected into the comment bar and the picker is ready for use.
     * The call is guarded by the same `qlListenersAttached` flag that prevents
     * duplicate listener registration, ensuring the button is only injected once
     * per input element lifecycle.
     *
     * @param {string} entityId - The active entity identifier.
     * @returns {Promise<void>}
     */
    attachCommentInputListener: async (entityId) => {
        try {
            const section = UiModule.getCommunityUI();
            const config = UtilsModule.getConfig(entityId) || {};
            const live = config.liveMode?.isLiveActive || false;
            const bar = section?.querySelector('.comment-bar-container');
            const disabled = section?.querySelector('.comment-disable-container');

            if (config?.comment_status === 'closed' && !live) {
                if (disabled) disabled.style.display = 'block';
                if (bar) bar.style.display = 'none';
                return;
            }

            if (disabled) disabled.style.display = 'none';
            if (bar) bar.style.display = '';

            const input = UiModule.getCommentInputUI();
            const send = UiModule.getSendButtonUI();

            if (input && !input.dataset.qlListenersAttached) {
                new MentionModule(input, ProfileModule.findMention, { debounceTime: CONSTANTS.CONFIG.DEBOUNCE_TIME });

                ProgressInput("ql-input", "ql-input-bar");
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        CommentsModule.submitComment();
                    }
                });
                send?.addEventListener('click', (e) => {
                    e.preventDefault();
                    CommentsModule.submitComment();
                    const picker = UiModule.getPickerContainerUI();
                    if (picker) picker.style.display = 'none';
                });
                _DomHelper.getContainer()?.addEventListener('click', () => {
                    if (document.activeElement === input) input.blur();
                });

                import('../features/audio.js').then(({ default: AR }) => AR.addVoiceButton({
                    iconReferenceElement: input, transcriptReferenceElement: input,
                    onResult: CommentsModule.callbackRecord
                })).catch(() => {});

                GifPickerModule.attach(input, { onSubmit: () => CommentsModule.submitComment() });

                input.dataset.qlListenersAttached = 'true';
            }

            if (live) _LiveService.connect(entityId);
        } catch (error) {
            handleLog(error, 'CommentsModule.attachCommentInputListener', 'error', '💬');
        }
    },

    fetchComments: _WorkerService.fetchComments,

    fetchNested: (entityId, commentId, replyId) => {
        UiModule.commentsDrawerUI.open();
        const container = _DomHelper.getContainer();
        if (!commentId) {
            _state.storedComments.clear();
            _Virtualization.setup();
            container.replaceChildren();
        }
        UiModule.addLoadingMessageUI(container, { type: 'message' });
        const payload = { entityId, ...(commentId && { commentId }), ...(replyId && { replyId }) };
        CoreModule.postWorkerMessage({ action: 'getNested', payload });
    },

    fetchAudio: (commentId) => _WorkerService.getTokenAndSend('getCommentAudio', { commentId }),
    fetchReportComment: _WorkerService.report,
    fetchDelComment: _WorkerService.delete,
    fetchEditComment: _WorkerService.edit,
    fetchGetLikes: _WorkerService.fetchGetLikes,

    fetchReplies: (entityId, commentId, lastCommentId, count) => {
        const skeletonCount = Math.min(count || 3, 10);

        UiModule.addLoadingMessageUI(UiModule.getCommentRepliesUI(commentId), {
            type: 'skeleton',
            count: skeletonCount
        });
        _WorkerService.send('getReplies', { entityId, commentId, ...(lastCommentId && { lastCommentId }) });
    },

    createCommentElement: _Renderer.create,

    updateCommentHTML: (id, html) => {
        requestAnimationFrame(() => {
            const elId = `ql-content-${id}`;
            const contentDiv = document.getElementById(elId);

            if (contentDiv) {
                contentDiv.innerHTML = html;
                const threadEl = contentDiv.closest(CONSTANTS.SELECTORS.THREAD);
                if (threadEl && _state.storedRenderedComments.has(id)) {
                    _state.storedRenderedComments.set(id, threadEl.outerHTML);
                }
            } else {
                if (_state.storedRenderedComments.has(id)) {
                    _state.storedRenderedComments.delete(id);
                }
            }
        });
    },

    renderComments: (payload, original) => {
        _propagateMetadata(payload, payload.comments?.list);

        let container = payload.commentId ? UiModule.getCommentRepliesUI(payload.commentId) : _DomHelper.getContainer();
        if (!payload.commentId && container.getAttribute('data-threads-entity') !== payload.entity) {
            container.setAttribute('data-threads-entity', payload.entity);
            container.replaceChildren();
        }

        _DomHelper.getContainer()?.querySelector('.ql-loading-message')?.remove();
        if (payload.commentId) container?.querySelector('.ql-loading-message')?.remove();

        _Renderer.list(payload.entity, payload.comments.list, container);

        if (payload.comments.hasMore) {
            const more = UiModule.createElementUI({
                tag: 'a', attributes: { href: 'javascript:void(0);' },
                content: '{{more}}', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.LOAD_MORE), translate: true
            });
            container.appendChild(more);
        }

        if (window.QueloraApp?.Modules?.AdsModule) {
            const placements = (!payload.commentId && !original?.lastCommentId) ? ['thread-overlay', 'comment-sponsored-top', 'comment-in-feed'] : ['comment-in-feed'];
            window.QueloraApp.Modules.AdsModule.requestAds(payload.entity, original?.lastCommentId || null, placements);
        }
    },

    renderNestedComments: (data, scrollTo) => {
        _propagateMetadata(data, data.list);

        let attempts = 0;
        const render = async () => {
            const root = _DomHelper.getContainer().querySelector(`${CONSTANTS.SELECTORS.THREAD} [data-comment-id="${data.commentId}"]`)?.closest(CONSTANTS.SELECTORS.THREAD);
            if (!root) {
                if (++attempts >= CONSTANTS.CONFIG.MAX_RENDER_ATTEMPTS) return _Renderer.shake(scrollTo);
                return UtilsModule.startTimeout(render, CONSTANTS.CONFIG.RENDER_ATTEMPT_INTERVAL);
            }

            _DomHelper.getContainer()?.querySelector('.ql-loading-message')?.remove();

            _Renderer.list(data.entityId, data.list, root);

            const recurse = (list, parent) => list.forEach(c => {
                const rc = parent.querySelector(`${CONSTANTS.SELECTORS.REPLIES}[data-reply-id="${c._id}"]`);
                if (rc && c.replies?.list?.length) {
                    _propagateMetadata(data, c.replies.list);
                    _Renderer.list(data.entityId, c.replies.list, rc);
                    recurse(c.replies.list, rc);
                }
            });
            recurse(data.list, root);

            root.querySelectorAll(`.view-replies`).forEach(el => el.remove());
            await _Renderer.shake(scrollTo);
        };
        render();
    },

    renderTranslate: (commentId, translation) => {
        const root = UiModule.getCommentHeaderUI(commentId, true);
        if (!root) return;

        const txt = root.querySelector(CONSTANTS.SELECTORS.BODY);
        const header = root.querySelector(CONSTANTS.SELECTORS.HEADER);
        _DomHelper.getContainer()?.querySelector('.ql-loading-message')?.remove();

        if (!header.hasAttribute('data-text-original')) {
            header.setAttribute('data-text-original', txt.textContent);
        }

        if (txt) txt.textContent = translation;

        const link = root.querySelector('.translate-text');
        if (link) link.textContent = I18n.getTranslation('original');
    },

    updateAllCommentLikes: () => {
        const container = _DomHelper.getContainer();
        const entityId = container?.getAttribute('data-threads-entity');
        if (!entityId) return;

        const ids = Array.from(UiModule.getCommentHeaderUI() || []).map(h => h?.getAttribute('data-comment-id')).filter(Boolean);
        if (ids.length && entityId) _WorkerService.send('fetchCommentLikes', { entityId, commentIds: ids });
    },

    /**
     * Builds and dispatches a share action for a comment or reply.
     *
     * Accepts an optional `baseUrl` argument so that callers operating in
     * `goTo` mode can supply the entity's canonical page URL instead of the
     * current `window.location`. This ensures the shared link always points
     * to the entity's own page — with the appropriate `#QUELORA-Q-*` or
     * `#QUELORA-E-*` anchor — rather than to whatever host page happens to be
     * embedding the widget at share time.
     *
     * The `baseUrl` is resolved by {@link PostsModule.resolveShareBaseUrl} in
     * `_EventBinder.clickDelegate` and forwarded here to avoid a circular
     * module dependency between `comments.js` and `posts.js`.
     *
     * When `baseUrl` is omitted (e.g. called programmatically without context)
     * the method falls back to `window.location.href` without hash, preserving
     * the original behaviour for non-goTo deployments.
     *
     * @param {string} entityId   - The 24-character entity identifier.
     * @param {string} commentId  - The comment ID (or root comment ID for replies).
     * @param {string} [replyId]  - The reply ID; empty string when sharing a comment.
     * @param {string} [baseUrl]  - The canonical base URL for the entity's page.
     *   Defaults to `window.location.href` stripped of any existing hash.
     * @returns {Promise<void>}
     */
    handleShare: async (entityId, commentId, replyId = '', baseUrl) => {
        try {
            const resolvedBase = baseUrl || window.location.href.split('#')[0];
            const hash = AnchorModule.generateLink({ type: replyId ? 'reply' : 'comment', ids: { entity: entityId, commentId, replyId } });
            const url = `${resolvedBase}${hash}`;

            if (navigator.share) {
                await navigator.share({ title: I18n.getTranslation('shareTitle'), text: I18n.getTranslation('shareText'), url });
                return;
            }

            ToastModule.info('share', I18n.getTranslation('copy'), `<div class="ql-share-url">${url}</div><button class="ql-btn active" id="ql-share">${I18n.getTranslation('copy')}</button>`, null, 8000);

            UtilsModule.startTimeout(() => {
                const btn = UiModule.getShareButtonUI();
                btn?.addEventListener('click', async () => {
                    await navigator.clipboard.writeText(url);
                    btn.textContent = I18n.getTranslation('copied');
                    UtilsModule.startTimeout(() => btn.closest('.ql-toast')?.remove(), 300);
                });
            }, 100);
        } catch (e) { handleLog(e, 'CommentsModule.handleShare', 'error', '💬'); }
    },

    callbackRecord: async (transcript, audioBase64, audioHash) => {
        const input = UiModule.getCommentInputUI();
        if (!input) return;

        input.textContent = transcript;
        if (ConfModule.get('audio.save_comment_audio', false)) {
            input.setAttribute('ql-audio-data', audioBase64);
            input.setAttribute('ql-audio-hash', audioHash);
        }

        const profile = await ProfileModule.getOwnProfile() || {};
        const assetBaseUrl = ConfModule.get('assetBaseUrl') || '';

        const isSquared = profile.avatarFrameType === 'SQUARED';
        const shapeClass = isSquared ? 'squared' : '';

        const frameStyle = profile.avatarFrameUrl ? `background-image: url('${assetBaseUrl}/${profile.avatarFrameUrl}')` : '';
        const frameHtml = profile.avatarFrameUrl ? `<div class="ql-avatar__frame ${shapeClass}" style="${frameStyle}"></div>` : '';

        const imgStyle = profile.picture ? `background-image: url('${profile.picture}')` : '';
        const imgContent = profile.picture ? '' : (profile.name?.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) || '');
        const imgClass = profile.picture ? 'has-picture' : '';
        const avatarHtml = `<div class="ql-avatar__image ${imgClass} ${shapeClass}" style="${imgStyle}">${imgContent}</div>`;

        const avatarBlock = `<div class="ql-avatar" style="margin: 0 10px 0 0;">${frameHtml}${avatarHtml}</div>`;

        const tpl = document.createElement('template');
        tpl.innerHTML = `
            <div class="edit-comment-container">
                <div class="avatar-row" style="display:flex; align-items:center; margin-bottom:10px;">
                    <div class="ql-avatar-wrapper" style="position:relative; margin-right:10px;">
                         ${avatarBlock}
                    </div>
                    <p class="transcript-text" style="margin:0; font-size:14px;">${transcript}</p>
                </div>
                <div class="audio-container"></div>
            </div>`;

        const body = tpl.content.querySelector('.edit-comment-container');
        body.querySelector('.audio-container').appendChild(UiModule.audioUI(transcript, audioBase64, audioHash));

        UiModule.setupModalUI(body, '#ql-comments');

        const footerWrapper = document.createElement('div');

        const btn = (cls, icon, txt, fn) => {
            const b = document.createElement('button');
            b.className = `ql-btn ${cls}`;
            b.innerHTML = `<span class="ql-icons-outlined">${icon}</span><span class="t">${txt}</span>`;
            b.onclick = fn;
            footerWrapper.appendChild(b);
        };

        btn('send-button', 'send', '{{send}}', () => { CommentsModule.submitComment(); UiModule.closeModalUI(); });
        btn('close-button', 'close', '{{close}}', () => {
            input.textContent = '';
            ['ql-audio-data', 'ql-audio-hash', 'data-reply-id'].forEach(a => input.removeAttribute(a));
            UiModule.closeModalUI();
        });

        UiModule.updateModalFooterUI(footerWrapper);
    },

    /**
     * Reads the current comment input, validates it, and dispatches a
     * `createComment` worker message.
     *
     * After a successful dispatch the GIF picker panel is explicitly closed via
     * {@link GifPickerModule.close} so that it does not remain mounted on screen
     * after the user submits their comment — regardless of whether a GIF was
     * actually inserted into the text.
     *
     * @returns {Promise<void>}
     */
    submitComment: async () => {
        try {
            if (_checkOfflineCircuitBreaker()) return;

            const input = UiModule.getCommentInputUI();
            if (!input) return;

            const val = input.value || UtilsModule.getCleanInputText(input, { forSubmit: true });
            const text = val ? val.trim() : '';

            if (!text) return;

            const entity = _DomHelper.getEntityId();
            if (!entity) throw new Error('No Entity');

            await GuardModule.protect(async () => {
                const live = UtilsModule.getConfig(entity)?.liveMode?.isLiveActive;
                if (live) {
                    await _LiveService.sendMsg(entity, text);
                } else {
                    const replyId = input.getAttribute('data-reply-id');
                    const aBase64 = input.getAttribute('ql-audio-data');
                    const aHash = input.getAttribute('ql-audio-hash');
                    const container = UiModule.getCommunityUI();
                    const threadCont = replyId ? UiModule.getCommentRepliesUI(replyId) : _DomHelper.getContainer();

                    container.querySelector('.ql-empty-container')?.remove();

                    if (threadCont) {
                        UiModule.addLoadingMessageUI(threadCont, {
                            type: 'skeleton',
                            position: replyId ? 'after' : 'before',
                            empty: false,
                            count: 1
                        });
                    }

                    _WorkerService.getTokenAndSend('createComment', {
                        entityId: entity,
                        comment: text,
                        audioBase64: aBase64,
                        audioHash: aHash,
                        ...(replyId && { replyId })
                    }, true);
                }

                if ('value' in input) input.value = '';
                else input.textContent = '';

                ['data-reply-id', 'ql-audio-data', 'ql-audio-hash'].forEach(a => input.removeAttribute(a));
                input.blur();
                UiModule.removeHeaderUI();
                UtilsModule.setInputLimit(UtilsModule.getConfig(entity)?.limits?.comment_text);
                ProgressInput("ql-input", "ql-input-bar");

                const picker = UiModule.getPickerContainerUI();
                if (picker) picker.style.display = 'none';

                GifPickerModule.close();
            });
        } catch (e) { handleLog(e, 'CommentsModule.submitComment', 'error', '💬'); }
    },

    reloadThreadToNormal: (entityId) => {
        _LiveService.cleanup(entityId);
        UiModule.removeLiveReactionBar();
        _DomHelper.getContainer()?.replaceChildren();
        _WorkerService.fetchComments(entityId);
    },

    shakeComment: _Renderer.shake,
    sendLiveMessage: _LiveService.sendMsg,
    renderNewLiveMessage: _LiveService.renderMsg,
    activateLiveModeUI: _LiveService.connect,
    cleanupLiveModeUI: _LiveService.cleanup,
    storedComments: _state.storedComments,
    storedRenderedComments: _state.storedRenderedComments,

    handleFetchError: (action, errorMsg, originalPayload) => {
        const isOffline = errorMsg && (errorMsg.includes('OfflineMode') || errorMsg.includes('Failed to fetch'));

        if (action === 'getReplies') {
            const commentId = originalPayload?.commentId;
            const container = UiModule.getCommentRepliesUI(commentId);
            if (container) container.querySelector('.ql-loading-message')?.remove();

            if (isOffline) {
                UiModule.renderOfflinePlaceholder(commentId);
            } else {
                ToastModule.show('<span class="ql-icons-outlined">error</span>', 'Error', errorMsg, null, 4000, 'error');
            }
        } else if (action === 'getComments') {
            const isPagination = !!originalPayload?.lastCommentId;
            const container = _DomHelper.getContainer();
            if (container) container.querySelector('.ql-loading-message')?.remove();

            if (isPagination) {
                if (isOffline) {
                    ToastModule.show('<span class="ql-icons-outlined">cloud_off</span>', I18n.getTranslation('offline') || 'Offline', I18n.getTranslation('contentUnavailableOffline') || 'Not available locally', null, 4000, 'warning');
                } else {
                    ToastModule.show('<span class="ql-icons-outlined">error</span>', 'Error', errorMsg, null, 4000, 'error');
                }

                if (container && !container.querySelector(`.${CONSTANTS.CLASSES.LOAD_MORE}`)) {
                    const more = UiModule.createElementUI({
                        tag: 'a', attributes: { href: 'javascript:void(0);' },
                        content: '{{more}}', classes: _DomHelper.safeClass(CONSTANTS.CLASSES.LOAD_MORE), translate: true
                    });
                    container.appendChild(more);
                }
            } else {
                if (isOffline) {
                    UiModule.renderOfflinePlaceholder(null);
                } else {
                    UiModule.renderErrorMessageUI(errorMsg);
                }
            }
        } else if (action === 'getNested') {
            if (isOffline) {
                ToastModule.show('<span class="ql-icons-outlined">cloud_off</span>', I18n.getTranslation('offline') || 'Offline', I18n.getTranslation('contentUnavailableOffline') || 'Not available locally', null, 4000, 'warning');
            } else {
                UiModule.renderErrorMessageUI(errorMsg);
            }
        }
    }
};

export default CommentsModule;