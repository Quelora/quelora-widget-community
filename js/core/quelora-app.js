/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/quelora-app.js */
/**
 * @module Core/QueloraApp
 * @description Main application orchestrator. Wires Worker message handlers,
 * loads core UI features, and dynamically injects Enterprise plugins based
 * on the configuration manifest (Plugin Registry Pattern).
 *
 * Plugin Loading Strategy:
 * Iterates through `ConfModule.get('plugins.ui')` and attempts to dynamically
 * import each module. If the file is missing (Community Edition), it degrades
 * gracefully silently. If present, it executes the module's `register(context)`
 * contract to inject dependencies.
 *
 * @version 16.2.0
 */
import handleLog from './logs.js';
import UtilsModule from './utils.js';
import UiModule from '../ui/ui.js';
import EmojiModule from '../ui/components/emoji.js';
import CaptchaModule from '../services/captcha.js';
import PostsModule from '../modules/posts/posts.js';
import CommentsModule from '../modules/comments/comments.js';
import ProfileModule from '../modules/profile/profile.js';
import RegistrationModule from '../modules/registration/registration.js';
import NotificationRouter from '../modules/notifications/notificationRouter.js';
import NotificationModule from '../modules/notifications/notifications.js';
import ToastModule from '../ui/toast.js';
import GifPickerModule from '../ui/components/gif.js';
import { eventBus } from './event.js';

// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================

/** @type {boolean} */
let appInitialized = false;

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Determines whether a dynamic `import()` failure is due to the module file
 * being absent from the bundle (expected in Community Edition) rather than a
 * runtime error inside a present module.
 *
 * @param {unknown} error - The value caught from a dynamic import statement.
 * @returns {boolean} `true` when the module is simply absent; `false` when the
 * error is a runtime fault inside a module that is present.
 */
function _isModuleAbsent(error) {
    if (error instanceof TypeError) return true;
    if (typeof error?.message !== 'string') return false;
    const msg = error.message.toLowerCase();
    return (
        msg.includes('failed to fetch') ||
        msg.includes('error loading dynamically imported module') ||
        msg.includes('importing a module script failed') ||
        msg.includes('cannot find module') ||
        msg.includes('load failed')
    );
}

// =============================================================================
// PLUGIN REGISTRY ORCHESTRATOR
// =============================================================================

/**
 * Iterates through the UI plugins defined in the configuration manifest,
 * dynamically imports them, and invokes their standard `register()` interface.
 * Gracefully ignores absent files to support Community Edition deployments.
 *
 * @param {Object} context - The dependency context injected into every plugin.
 * @returns {Promise<void>}
 */
async function loadPlugins(context) {
    const plugins = context.ConfModule.get('plugins.ui', []);

    if (!Array.isArray(plugins) || plugins.length === 0) {
        handleLog('No UI plugins defined in configuration manifest.', 'QueloraApp', 'info', '🏠');
        return;
    }

    for (const plugin of plugins) {
        if (!plugin.name || !plugin.path) continue;

        try {
            const module = await import(plugin.path);

            if (typeof module.register === 'function') {
                await module.register(context);
                handleLog(`Plugin [${plugin.name}] loaded and registered successfully.`, 'QueloraApp', 'log', '🏠');
            } else if (typeof module.init === 'function') {
                // Legacy support for modules that haven't updated to the `register` contract yet.
                await module.init(context.worker, context);
                handleLog(`Plugin [${plugin.name}] loaded via legacy init().`, 'QueloraApp', 'warn', '🏠');
            } else {
                handleLog(`Plugin [${plugin.name}] loaded but lacks a register() entry point.`, 'QueloraApp', 'warn', '🏠');
            }

        } catch (error) {
            if (_isModuleAbsent(error)) {
                handleLog(`Plugin [${plugin.name}] not present (Community Edition fallback).`, 'QueloraApp', 'info', '🏠');
            } else {
                handleLog(error, `QueloraApp.loadPlugins:${plugin.name}`, 'error', '🏠');
            }
        }
    }
}

// =============================================================================
// EMOJI PICKER INITIALISATION
// =============================================================================

/**
 * Conditionally loads and configures the emoji picker.
 * Hides emoji trigger buttons on mobile or when the picker is disabled.
 *
 * @param {boolean} enable       - Whether the emoji picker is enabled.
 * @param {Object}  EmojiModule  - The emoji module instance.
 * @param {Object}  UtilsModule  - The utils module instance.
 * @returns {Promise<void>}
 */
async function initializeEmojiPicker(enable, EmojiModule, UtilsModule) {
    if (enable && !UtilsModule.isMobile) {
        try {
            await EmojiModule.loadEmojiMartScript();
            EmojiModule.setupEmojiPicker();
        } catch (error) {
            handleLog(error, 'QueloraApp.initializeEmojiPicker', 'error', '🏠');
        }
    } else {
        document.querySelectorAll('.emoji-button').forEach(btn => { btn.style.display = 'none'; });
    }
}

// =============================================================================
// MAIN INIT
// =============================================================================

/**
 * Initialises the full application after the lazy bundle has been loaded.
 * Wires Core Worker message handlers, dynamically loads Enterprise plugins,
 * and establishes the initial session state.
 *
 * @param {Worker} worker        - The shared Quelora Worker instance.
 * @param {Object} sharedModules - Modules and config values provided by the entry point.
 * @returns {Promise<void>}
 */
async function init(worker, sharedModules) {
    if (appInitialized) return;

    const {
        CoreModule,
        I18n,
        SessionModule,
        StorageModule,
        ConfModule,
        IconsModule,
        systemIdentity,
        currentScriptPath
    } = sharedModules;

    // =========================================================================
    // CORE WORKER MESSAGE HANDLERS
    // =========================================================================

    const workerMessageHandlers = {
        busSignal: (payload) => {
            const { type, data } = payload;
            eventBus.emit(type, data);

            if (type === 'OFFLINE_MODE') CoreModule.setSystemOfflineState(true);
            if (type === 'ONLINE_MODE')  CoreModule.setSystemOfflineState(false);
        },

        sseTicketFetched: (payload) => {
            eventBus.emit('sseTicketFetched', payload || {});
        },

        commentNested: (payload, originalPayload) =>
            CommentsModule.renderNestedComments(payload, originalPayload.replyId || originalPayload.commentId),

        commentThread: (payload, originalPayload) => CommentsModule.renderComments(payload, originalPayload),

        repliesThread: (payload, originalPayload) => CommentsModule.renderComments(payload, originalPayload),

        commentCreated: (payload) => {
            UiModule.updateCommentUI(payload.entityId, payload);
            UiModule.updateCommentCountUI(payload.entityId, true);
        },

        commentBlocked: (payload) => UiModule.renderErrorMessageUI(payload.message),

        userFollowed: (payload, originalPayload) => {
            ProfileModule.saveMyProfile(payload.profile);
            ProfileModule.updateFollowState(originalPayload.memberId, 'userFollowed', payload?.requiresApproval || false);
        },

        userUnfollowed: (payload, originalPayload) => {
            ProfileModule.saveMyProfile(payload.profile);
            ProfileModule.updateFollowState(originalPayload.memberId, 'userUnfollowed', payload?.requiresApproval || false);
        },

        userApprovefollowed: (payload, originalPayload) => {
            ProfileModule.saveMyProfile(payload.profile);
            ProfileModule.updateFollowState(originalPayload.memberId, 'userApprovefollowed', payload);
        },

        followingActivities: (payload) => NotificationModule.handleActivitiesFetched(payload),

        activitiesReturned: (payload) => NotificationModule.handleActivitiesFromWorker(payload),

        pushSubscriptionConfirmed: (payload) => NotificationModule.pushSubscriptionConfirmed(payload),

        likeUpdated: (payload, originalPayload) => {
            const el = UiModule.getEntityInteractionUI(originalPayload.entityId);
            UiModule.updateEntityCounterUI(el, payload.likesCount, payload.liked);
        },

        likeCommentUpdated: (payload, originalPayload) => {
            const headerEl = UiModule.getCommentHeaderUI(originalPayload.commentId, false);
            if (headerEl) {
                UiModule.updateCommentCounterUI(headerEl, payload.likesCount, payload.liked);
            }
        },

        bookmarkUpdated: (payload, originalPayload) => {
            const el = document.querySelector(`[data-entity-interaction="${originalPayload.entityId}"]`);
            UiModule.updateEntityBookmarkUI(el, payload.attach);
        },

        commentLikesFetched: (payload) => {
            payload.forEach(stat => {
                const el = UiModule.getCommentHeaderUI(stat.commentId, false);
                if (el) {
                    UiModule.updateCommentCounterUI(el, stat.likesCount, stat.authorLiked);
                }
            });
        },

        getCommentLikesUpdated: (payload) =>
            UiModule.addLoadingMessageUI(UiModule.getLikesListUI(), { type: 'profile', position: 'after', empty: true, count: 0 }) ||
            ProfileModule.renderProfileListLikes(payload),

        internalError: (payload) => UiModule.renderErrorMessageUI(payload.message),

        error: (payload, originalPayload) => {
            const isCommentAction = ['getReplies', 'getComments', 'getNested'].includes(payload?.action);

            let displayMessage = payload?.message || 'Unknown error occurred.';

            try {
                if (typeof displayMessage === 'string' && displayMessage.trim().startsWith('{')) {
                    const parsed = JSON.parse(displayMessage);
                    if (parsed.details?.data) {
                        displayMessage = Object.values(parsed.details.data).join(' - ');
                    } else if (parsed.message) {
                        displayMessage = parsed.message;
                    } else if (parsed.statusText) {
                        displayMessage = parsed.statusText;
                    }
                }
            } catch {
                // JSON.parse failed — displayMessage already holds the raw string fallback.
            }

            if (displayMessage === 'OfflineModeActive' || displayMessage.includes('OfflineModeActive')) {
                if (isCommentAction) {
                    CommentsModule.handleFetchError(payload.action, displayMessage, originalPayload);
                } else {
                    UiModule.renderOfflinePlaceholder();
                }
                return;
            }

            if (isCommentAction) {
                CommentsModule.handleFetchError(payload.action, displayMessage, originalPayload);
            } else {
                UiModule.renderErrorMessageUI(displayMessage);
            }

            if (ToastModule && typeof ToastModule.error === 'function') {
                ToastModule.error(null, 'Error', displayMessage);
            }
        },

        getLikeUpdated: (payload) => ProfileModule.renderProfileListLikes(payload),

        shareUpdated: (payload) => UiModule.updateCommentCountUI(payload.entityId, false),

        delComment: (payload) => UiModule.updateCommentCountUI(payload.entityId, false),

        returnProfile: (payload) => ProfileModule.renderProfile(payload.profile),

        reportedResponse: (payload) => UiModule.renderReportedUI(payload),

        translatedComment: (payload, originalPayload) =>
            CommentsModule.renderTranslate(originalPayload.commentId, payload.translation),

        updatedProfile: (payload) => {
            if (payload.profile) {
                ProfileModule.saveMyProfile(payload.profile);
                eventBus.emit('USER_PROFILE_UPDATED', payload.profile);
            }
        },

        updatedProfileFields: (payload) => {
            if (payload.success && payload.profile) {
                ProfileModule.saveMyProfile(payload.profile);
                eventBus.emit('USER_PROFILE_UPDATED', payload.profile);
            }
            ProfileModule.handleProfileUpdateResult(payload);
        },

        returnMyProfile: (payload) => {
            ProfileModule.saveMyProfile(payload.profile);
            eventBus.emit('USER_PROFILE_UPDATED', payload.profile);
        },

        profilePaginationResult: (payload, originalPayload) => {
            ProfileModule.profilePaginationResult({ payload, originalPayload });
        },

        searchProfileResults: (payload, op) =>
            ProfileModule.handleSearchResults(op.searchType, payload.result, op.memberId),

        returnAudio: (payload) => UiModule.handleAudioResponseUI(payload.commentId, payload.audio),

        updatedSettingsProfile: (payload) => ProfileModule.handleSettingsUpdated(payload),

        returnMention: (payload) => ProfileModule.renderProfile(payload.profile),

        searchMentionResults: (payload) => ProfileModule.renderMentionResults(payload.result),

        searchAccountsResults: (payload) => ProfileModule.renderSearchAccountsResults(payload.result),

        returnBlocked: (payload) => ProfileModule.renderBlockedUsers(payload.result),

        memberBlockStatus: (payload) => ProfileModule.memberBlockStatus(payload),

        avatarProcessed: (payload) => { ProfileModule.handleProcessedImage(payload.blob, payload.imageType); },

        markdownParsed: (payload) => { CommentsModule.updateCommentHTML(payload.id, payload.html); },

        pushSubscriptionFailed: () => {
            handleLog('Push subscription failed on server side.', 'Notification', 'error');
            StorageModule.removeLocalItem('ql_subscription_id');
        },

        pushUnsubscriptionConfirmed: () => handleLog('Push unsubscription confirmed by server.', 'Notification', 'info'),

        pushSubscriptionStatus: (payload) => NotificationModule.handleServerStatus(payload),

        /**
         * Routes GIF search and trending results from the Worker to the active
         * GifPickerModule panel via the event bus.
         *
         * The Worker echoes `originalPayload._seq` inside `payload` so that
         * {@link GifPickerModule} can silently discard responses that have been
         * superseded by a more recent request (race-condition guard).
         *
         * Registered by: `endpointsWorker.js` — actions `searchGif` / `trendingGif`.
         * Response shape: `{ gifs: Array<{id, url, title}>, _seq: number }`.
         *
         * @param {{ gifs: Array<{id: string, url: string, title: string}>, _seq: number }} payload
         * @returns {void}
         */
        gifResults: (payload) => GifPickerModule.handleResults(payload),
    };

    // =========================================================================
    // WORKER MESSAGE DISPATCHER
    // =========================================================================

    worker.addEventListener('message', (e) => {
        const { action, payload, originalPayload, originalAction } = e.data;

        if (action === 'SSE_MESSAGE') {
            eventBus.emit('SSE_MESSAGE', payload);
            return;
        }

        const handler = workerMessageHandlers[action];

        if (handler) {
            handler(payload, originalPayload, originalAction);
        } else {
            const allowedUnhandled = [
                'statsFetched', 'returnMyProfile', 'offline', 'updateServerInfo',
                'updateGeolocation', 'invalidToken', 'error',
                'gamificationLeaderboardReceived', 'gamificationStatusReceived',
                'gamificationPublicStatsReceived', 'surveyFetched', 'adsFetched',
                'chatListReturned', 'chatHistoryReturned', 'chatMessageReceived', 'chatMessageSent',
                'p2pSendBinary', 'p2pSendNotFound', 'p2pFindArtifact', 'trackerBroadcastRequest',
                'trackerSendArtifact', 'identityReady', 'resilienceStatusResponse', 'hotLinkPeers',
                'cachedPeersForP2P'
            ];
            if (!allowedUnhandled.includes(action) && !appInitialized) {
                handleLog(`Unknown worker action: ${action}`, 'QueloraApp', 'warn', '🏠');
            }
        }
    });

    /**
     * Registers a dynamic Worker message handler at runtime.
     * Injected into the plugin context so external modules can listen to the Worker.
     *
     * @param {string}   action  - Worker action string to handle.
     * @param {Function} handler - Handler function `(payload, originalPayload, originalAction) => void`.
     * @returns {void}
     */
    const registerWorkerHandler = (action, handler) => {
        workerMessageHandlers[action] = handler;
    };

    // =========================================================================
    // PLUGIN INJECTION (THE REGISTRY PATTERN)
    // =========================================================================

    const pluginContext = {
        ...sharedModules,
        worker,
        registerHandler: registerWorkerHandler,
        eventBus,
        vendorsPath: currentScriptPath + 'vendors/',
        systemIdentity
    };

    await loadPlugins(pluginContext);

    // =========================================================================
    // CORE INITIALISATION
    // =========================================================================

    try {
        if (RegistrationModule && typeof RegistrationModule.init === 'function') {
            RegistrationModule.init(worker, { registerHandler: registerWorkerHandler });
            await I18n.loadModuleTranslations('notifications');
        }

        UiModule.initializeUI();
        CommentsModule.init(worker);
        await initializeEmojiPicker(true, EmojiModule, UtilsModule);

        eventBus.on('SHOW_TOAST', (payload) => {
            const title = payload.title || 'Notification';
            if (ToastModule && typeof ToastModule.info === 'function') {
                ToastModule.info(null, title, payload.body);
            } else if (ToastModule && typeof ToastModule.success === 'function') {
                ToastModule.success(null, title, payload.body);
            } else {
                handleLog(`SW Toast: ${title} — ${payload.body}`, 'QueloraApp', 'info', '🏠');
            }
        });

        /**
         * Lazily loads the module translation namespace for a drawer and re-translates
         * its element after the strings have been merged into the active locale.
         *
         * @param {Object|null} drawerInstance - Drawer instance with an optional `.element` property.
         * @param {string}      moduleName     - I18n namespace identifier.
         * @returns {Promise<void>}
         */
        const loadAndTranslateDrawer = async (drawerInstance, moduleName) => {
            if (!drawerInstance) return;
            try {
                await I18n.loadModuleTranslations(moduleName);
                if (drawerInstance.element) {
                    I18n.translateElement(drawerInstance.element);
                }
            } catch (e) {
                handleLog(`Error translating drawer ${moduleName}: ${e.message}`, 'QueloraApp', 'error', '🏠');
            }
        };

        const drawers = [
            { ui: UiModule.settingsDrawerUI, module: 'profile' },
            { ui: UiModule.generalSettingsDrawerUI, module: 'profile' },
            { ui: UiModule.profileDrawerUI, module: 'profile' },
            { ui: UiModule.notificationDrawerUI, module: 'notifications' }
        ];

        drawers.forEach(({ ui, module }) => {
            if (ui) ui.on('open', () => loadAndTranslateDrawer(ui, module));
        });

        if (ConfModule.get('captcha.enabled')) {
            const captchaConfig = {
                type: ConfModule.get('captcha.provider'),
                siteKey: ConfModule.get('captcha.siteKey'),
                options: ConfModule.get('captcha.options', {}),
            };
            await CaptchaModule.initialize(captchaConfig.type, captchaConfig.siteKey, captchaConfig.options);
        }

        appInitialized = true;
        handleLog('App Initialized (Registry Mode).', 'Quelora', 'log', '🏠');

        if (ProfileModule.isLogin()) {
            await Promise.all([
                I18n.loadModuleTranslations('profile'),
                I18n.loadModuleTranslations('notifications')
            ]);

            eventBus.emit('SESSION_ESTABLISHED', {
                token: SessionModule.getTokenIfAvailable(),
                isNewLogin: false,
                profile: await ProfileModule.getOwnProfile()
            });
        }

    } catch (error) {
        handleLog(error, 'QueloraApp.init', 'error', '🏠');
    }
}

// =============================================================================
// ANCHOR HANDLER
// =============================================================================

/**
 * Handles deep-link anchor actions dispatched from the URL hash protocol.
 * Delegates to the appropriate module based on the single-character action code.
 *
 * @param {string}   action - Single-character action code from the anchor protocol.
 * @param {string[]} params - Sanitised parameter array extracted from the hash.
 * @returns {void}
 */
function handleAnchor(action, params) {
    const { PostsModule, ProfileModule } = window.QueloraApp.Modules;
    switch (action) {
        case 'Q':
        case 'L': {
            const [entityId, lastCommentId, replyId = ''] = params;
            UiModule.getCommunityThreadsUI()?.replaceChildren();
            if (lastCommentId && replyId) {
                PostsModule.loadThread(entityId, lastCommentId, true)
                    .then(() => UtilsModule.wait(500))
                    .then(() => PostsModule.loadNested(entityId, lastCommentId, replyId));
            } else {
                PostsModule.loadThread(entityId, lastCommentId, true);
            }
            break;
        }
        case 'U': ProfileModule.getProfile(params[0]); break;
        case 'R': ProfileModule.getMention(params[0]); break;
        case 'E': {
            const [entityId] = params;
            PostsModule.loadThread(entityId);
            break;
        }
        case 'O': case 'A':
            handleLog(`Action: ${action} — Params: ${params}`, 'QueloraApp.handleAnchor', 'log', '🏠');
            break;
    }
}

// =============================================================================
// PUBLIC SURFACE
// =============================================================================

window.QueloraApp = {
    init: init,
    handleAnchor: handleAnchor,
    Modules: {
        PostsModule,
        CommentsModule,
        ProfileModule,
        UiModule,
        RegistrationModule,
        NotificationRouter
    }
};

export { init };