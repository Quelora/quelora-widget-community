/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/notifications/notificationRouter.js */
/**
 * @module Modules/Notifications/Router
 * @description Central routing and normalization logic for system notifications.
 * Handles payload normalization from multiple sources (SSE, REST, DB) and dispatching to UI.
 * UPDATE: Added 'missed_call' type definition.
 * @version 6.3.1
 */
import handleLog from '../../core/logs.js'; 
import ToastModule from '../../ui/toast.js';
import UiModule from '../../ui/ui.js';
import I18n from '../../core/i18n.js';

const CONFIG = {
    LOG_ICON: '🔀'
};

const interceptors = new Set();

const NOTIFICATION_TYPES = {
    'follow_approved': {
        key: 'acceptedFollowRequest',
        defaultText: 'Accepted your follow request',
        action: 'U',
        isProfile: true
    },
    'follower': {
        key: 'isFollow',
        defaultText: 'Started following you',
        action: 'U',
        isProfile: true
    },
    'follow': {
        key: 'isFollow',
        defaultText: 'Started following you',
        action: 'U',
        isProfile: true
    },
    'comment': {
        key: 'commentedOnPost',
        defaultText: 'Commented on a post',
        action: 'Q'
    },
    'reply': {
        key: 'repliedToYourComment',
        defaultText: 'Replied to your comment',
        action: 'Q'
    },
    'like': {
        key: 'likedPost',
        defaultText: 'Liked the post',
        action: 'Q',
        dynamicKey: (linkData) => (linkData?.commentId || linkData?.replyId) ? 'likedYourComment' : 'likedPost'
    },
    'share': {
        key: 'sharedPost',
        defaultText: 'Shared a post',
        action: 'Q'
    },
    'mention': {
        key: 'mentionedYou',
        defaultText: 'Mentioned you',
        action: 'Q'
    },
    'missed_call': {
        key: 'missedVideoCall',
        defaultText: 'Missed video call',
        action: 'chat', // Custom handler logic in Router or generic link
        icon: 'videocam_off'
    },
    'gamification_summary': {
        key: 'gamificationUpdate',
        defaultText: 'Gamification Update',
        action: null,
        isSystem: true
    },
    'system': {
        key: 'systemNotification',
        defaultText: 'System Notification',
        action: null,
        isSystem: true
    }
};

const NotificationRouter = {
    /**
     * Registers an interceptor module to react to or consume notifications.
     * @param {Object} interceptor - Object implementing handleNotification.
     */
    register(interceptor) {
        if (typeof interceptor.handleNotification === 'function') {
            interceptors.add(interceptor);
        } else {
            handleLog('Invalid interceptor registered', 'NotificationRouter', 'warn', CONFIG.LOG_ICON);
        }
    },

    /**
     * Entry point for incoming notifications.
     * @param {Object} rawData - Original message data.
     * @param {string} source - Origin of the data (sse, polling, storage).
     * @returns {boolean}
     */
    dispatch(rawData, source = 'sse') {
        try {
            const normalized = this.normalize(rawData, source);
            if (!normalized) return false;

            let handled = false;
            
            for (const module of interceptors) {
                try {
                    if (module.handleNotification(normalized, source)) {
                        handled = true;
                        break;
                    }
                } catch (error) {
                    handleLog(`Interceptor error: ${error.message}`, 'NotificationRouter', 'warn', CONFIG.LOG_ICON);
                }
            }

            if (handled) return true;

            if (source === 'sse') {
                setTimeout(() => {
                    requestAnimationFrame(() => {
                        this.showDefaultToast(normalized);
                    });
                }, 0);
                return true;
            }

            return false;
        } catch (e) {
            handleLog(`Critical Dispatch Error: ${e.message}`, 'NotificationRouter', 'error', CONFIG.LOG_ICON);
            return false;
        }
    },

    /**
     * Normalizes multiple data schemas into a single Activity object.
     * Handles SSE payloads (nested in payload) and DB payloads (flat).
     */
    normalize(data, source) {
        if (!data) return null;

        // DB returns flat object (decrypted), SSE returns { payload: ... }
        const payload = data.payload || data;

        if (payload.type === 'resilience_handshake' || payload.type === 'keepalive') return null;

        const now = new Date().toISOString();
        const timestamp = payload.created_at || payload.createdAt || now;

        let uniqueId = payload._id || payload.id;
        if (!uniqueId) {
            const seed = (payload.entityId || payload.type || 'msg') + timestamp;
            uniqueId = `gen-${seed.replace(/[^a-zA-Z0-9]/g, '').substring(0, 32)}`;
        }

        // --- 1. Gamification / System Events ---
        if (payload.type === 'gamification_summary' || (payload.raw?.type === 'gamification_summary')) {
            const innerData = payload.data || payload; 
            
            return {
                _id: uniqueId,
                type: 'gamification_summary',
                category: 'system',
                created_at: timestamp,
                actor: { 
                    author: 'system', 
                    name: 'Quelora', 
                    username: 'Quelora',
                    isVirtual: true, 
                    avatarConfig: { 
                        color: 'var(--ql-primary-color)', 
                        bgColor: 'var(--ql-bg-secondary)', 
                        iconName: 'grade' 
                    } 
                },
                preview: innerData?.summary || innerData?.preview || payload.preview || 'Gamification Update',
                linkData: null,
                raw: payload
            };
        }

        // --- 2. REST API / Storage Activities (action_type pattern) ---
        if (payload.action_type) {
            return {
                _id: uniqueId,
                type: payload.action_type,
                category: 'social',
                created_at: timestamp,
                actor: {
                    author: payload.author?.author || payload.author?.id,
                    username: payload.author?.author_username || payload.author?.name || 'User',
                    name: payload.author?.name || payload.author?.author_username || 'User',
                    picture: payload.author?.picture,
                    avatarFrameUrl: payload.author?.avatarFrameUrl,
                    avatarFrameType: payload.author?.avatarFrameType,
                    isVirtual: false
                },
                preview: payload.entity?.preview || payload.preview,
                linkData: {
                    entity: payload.references?.entity || payload.entityId,
                    commentId: payload.references?.commentId,
                    replyId: payload.references?.replyId,
                    profileId: payload.references?.profileId
                },
                raw: payload
            };
        }

        // --- 3. SSE & Generic Notifications (actor + extra pattern) ---
        // Handles "activity" type by mapping actionType to type if present
        if (payload.isNotification || (payload.actor && (payload.type || payload.actionType))) {
            let type = payload.actionType || payload.type || 'unknown';
            
            // Map generic 'activity' to specific action if available
            if (type === 'activity' && payload.actionType) {
                type = payload.actionType;
            }

            const linkData = payload.extra || payload.linkData || payload.references || {};

            return {
                _id: uniqueId,
                type: type,
                category: 'social',
                created_at: timestamp,
                actor: {
                    author: payload.actor?.author || payload.actor?.id,
                    username: payload.actor?.username || payload.actor?.name || 'User',
                    name: payload.actor?.name || payload.actor?.username || 'User',
                    picture: payload.actor?.picture,
                    avatarFrameUrl: payload.actor?.avatarFrameUrl,
                    avatarFrameType: payload.actor?.avatarFrameType,
                    isVirtual: !!payload.actor?.isVirtual,
                    avatarConfig: payload.actor?.avatarConfig
                },
                preview: payload.preview || '',
                linkData: {
                    entity: linkData.entity || linkData.entityId || payload.entityId,
                    commentId: linkData.commentId,
                    replyId: linkData.replyId,
                    follow: linkData.follow || payload.actor?.author,
                    type: linkData.type // Preserves subtype like 'chat'
                },
                raw: payload
            };
        }

        // --- 4. Pass-through for already normalized data (Internal/DB Loop) ---
        if (payload.category && payload.actor && payload.type && payload._id) {
            return payload;
        }

        return null;
    },

    /**
     * Translates notification types to human-readable text.
     */
    getActionText(type, linkData) {
        const config = NOTIFICATION_TYPES[type];
        if (!config) {
            return I18n.getTranslation('performedAnAction') || 'Performed an action';
        }

        let key = config.key;
        if (config.dynamicKey) {
            key = config.dynamicKey(linkData);
        }

        return I18n.getTranslation(key) || config.defaultText;
    },

    /**
     * Renders a Toast notification and handles deep-link navigation.
     */
    showDefaultToast(data) {
        try {
            let iconContent = '<span class="ql-icons-outlined">notifications</span>';
            const actorName = data.actor?.name || data.actor?.username || 'Quelora';

            if (data.actor?.picture && !data.actor.isVirtual) {
                const _isSafeImageUrl = (url) => {
                    try {
                        const { protocol } = new URL(url);
                        return protocol === 'https:' || protocol === 'data:';
                    } catch {
                        return false;
                    }
                };

                if (data.actor?.picture && !data.actor.isVirtual && _isSafeImageUrl(data.actor.picture)) {
                    iconContent = `<img src="${data.actor.picture}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover; display: block;" alt="${actorName}" />`;
                }
             } else if (data.actor?.isVirtual) {
                const icon = data.actor.avatarConfig?.iconName || 'notifications';
                const color = data.actor.avatarConfig?.color || 'var(--ql-primary-color)';
                iconContent = `<span class="ql-icons-outlined" style="color: ${color}">${icon}</span>`;
            }

            const actionText = this.getActionText(data.type, data.linkData);
            let bodyContent = actionText;
            
            if (data.type === 'missed_call') {
                 // Specific body for calls
                 bodyContent = `<span style="color:var(--ql-error-color)">${actionText}</span>`;
            } else if (data.preview && !NOTIFICATION_TYPES[data.type]?.isProfile && !NOTIFICATION_TYPES[data.type]?.isSystem) {
                const cleanPreview = String(data.preview).replace(/<[^>]*>/g, '').substring(0, 60);
                bodyContent = `${actionText}: <span style="opacity: 0.85; font-style: italic;">"${cleanPreview}..."</span>`;
            } else if (data.type === 'gamification_summary') {
                bodyContent = data.preview;
            }

            const toastType = data.type === 'gamification_summary' ? 'success' : (data.type === 'missed_call' ? 'error' : 'info');

            ToastModule.show(
                iconContent, 
                actorName, 
                bodyContent,
                () => {
                    if (window.QueloraApp) {
                        const config = NOTIFICATION_TYPES[data.type];
                        if (config?.isSystem) {
                             if (window.QueloraApp.Modules.GamificationModule) {
                                window.QueloraApp.Modules.GamificationModule.open();
                             }
                        } else if (config?.isProfile) {
                            if (data.actor?.author) {
                                window.QueloraApp.handleAnchor('U', [data.actor.author]);
                            }
                        } else if (config?.action === 'chat' || data.linkData?.type === 'chat') {
                             if (window.QueloraApp.Modules.ChatModule) {
                                 window.QueloraApp.Modules.ChatModule.setActiveConversation(data.actor.author);
                                 window.QueloraApp.Modules.UiModule.chatConversationDrawerUI.open();
                             }
                        } else if (data.linkData?.entity) {
                            window.QueloraApp.handleAnchor('Q', [
                                data.linkData.entity,
                                data.linkData.commentId,
                                data.linkData.replyId
                            ]);
                        }
                    }
                },
                0,
                toastType
            );

            const ui = (window.QueloraApp?.Modules?.UiModule) || UiModule;
            if (ui && typeof ui.toggleActivityMenuItem === 'function') {
                ui.toggleActivityMenuItem(true);
            }
            
        } catch (renderError) {
            handleLog(`Toast Render Error: ${renderError.message}`, 'NotificationRouter', 'error', CONFIG.LOG_ICON);
        }
    }
};

export default NotificationRouter;