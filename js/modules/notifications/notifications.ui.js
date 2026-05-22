/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/notifications/notifications.ui.js */
/**
 * @module Modules/Notifications/UI
 * @description Handles the rendering of the Notification Drawer.
 * UPDATE: Added 'missed_call' icon mapping and Circuit Breaker implementation.
 * @version 5.0.0
 */

import UtilsModule from '../../core/utils.js';
import AnchorModule from '../../ui/anchor.js';
import UiModule from '../../ui/ui.js';
import ConfModule from '../../core/conf.js';
import I18n from '../../core/i18n.js';
import * as Drawers from '../../ui/drawers.js';
import ProfileModule from '../profile/profile.js';
import { eventBus } from '../../core/event.js';

const CONSTANTS = {
    SELECTORS: {
        LIST: '#community-ql-notification-list',
        EMPTY: '.ql-empty-container',
        ITEM: '.ql-notification-item',
        AVATAR: '.ql-avatar__image'
    },
    CLASSES: {
        ITEM: 'ql-notification-item',
        CONTENT: 'ql-notification__content',
        HEADER: 'ql-notification__header',
        PREVIEW: 'ql-notification__preview',
        META: 'ql-notification__meta',
        ASIDE: 'ql-notification__aside',
        TYPE_ICON: 'ql-notification__type-icon',
        AVATAR_WRAPPER: 'ql-avatar',
        AVATAR_FRAME: 'ql-avatar__frame',
        AVATAR_IMG: 'ql-avatar__image',
        SQUARED: 'squared',
        UNREAD: 'ql-notification--unread',
        SYSTEM: 'ql-notification--system'
    }
};

const _normalizeAuthor = (activity) => {
    // Priority 1: System/Virtual Actors (Gamification)
    if (activity.actor && (activity.actor.isVirtual || activity.category === 'system' || activity.type === 'gamification_summary')) {
        return {
            author: activity.actor.author || 'system',
            author_username: activity.actor.name || activity.actor.username || 'System',
            isVirtual: true,
            avatarConfig: activity.actor.avatarConfig || { 
                color: 'var(--ql-primary-color)', 
                bgColor: 'var(--ql-bg-secondary)', 
                iconName: 'grade' 
            }
        };
    }

    // Priority 2: Standard User Actors
    if (activity.actor && (activity.actor.name || activity.actor.username)) {
        return {
            author: activity.actor.author || activity.actor.id,
            author_username: activity.actor.name || activity.actor.username,
            picture: activity.actor.picture,
            isVirtual: false,
            avatarFrameUrl: activity.actor.avatarFrameUrl,
            avatarFrameType: activity.actor.avatarFrameType
        };
    }

    // Fallback
    return activity.author || { author_username: 'Unknown' };
};

const _HTML = {
    avatar: (authorData) => {
        const author = authorData || {};
        
        if (author.isVirtual && author.avatarConfig) {
            const { color, bgColor, iconName } = author.avatarConfig;
            return `
                <div class="${CONSTANTS.CLASSES.AVATAR_WRAPPER}" style="
                    display: flex; align-items: center; justify-content: center;
                    background: ${bgColor}; 
                    border: 1px solid ${color}40; 
                    border-radius: 50%; 
                    width: 40px; height: 40px;
                    box-shadow: 0 2px 5px ${color}20;
                ">
                    <span class="ql-icons-outlined" style="font-size: 20px; color: ${color};">${iconName}</span>
                </div>`;
        }

        const assetBaseUrl = ConfModule.get('assetBaseUrl') || '';
        const initials = author.author_username ? author.author_username.charAt(0).toUpperCase() : '?';
        const style = author.picture ? `background-image: url('${author.picture}');` : '';
        const isSquared = author.avatarFrameType === 'SQUARED';
        const frameUrl = author.avatarFrameUrl;
        
        let frameHTML = '';
        if (frameUrl) {
            frameHTML = `<div class="${CONSTANTS.CLASSES.AVATAR_FRAME} ${isSquared ? CONSTANTS.CLASSES.SQUARED : ''}" style="background-image: url('${assetBaseUrl}/${frameUrl}')"></div>`;
        }

        const imgClass = `${CONSTANTS.CLASSES.AVATAR_IMG} ${isSquared ? CONSTANTS.CLASSES.SQUARED : ''}`;

        return `
            <div class="${CONSTANTS.CLASSES.AVATAR_WRAPPER}" data-author-id="${author.author}">
                ${frameHTML}
                <div class="${imgClass}" style="${style}">${author.picture ? '' : initials}</div>
            </div>`;
    },

    headerText: (activity, author) => {
        if (activity.meta && activity.meta.actionText) {
            const colorStyle = activity.meta.highlightColor ? `style="color:${activity.meta.highlightColor}"` : '';
            return `<span class="ql-notification__actor" ${colorStyle}>${activity.meta.actionText}</span>`;
        }

        if (activity.type === 'gamification_summary') {
            const summary = activity.preview || activity.payload?.summary || I18n.getTranslation('gamificationUpdate');
            return `<span class="ql-notification__actor">${summary}</span>`;
        }

        const type = activity.type || activity.action_type || activity.actionType;
        const name = author.author_username || 'User';
        const actorHtml = `<span class="ql-notification__actor">${name}</span>`;
        
        const map = {
            follow: 'startedFollowing',
            follower: 'startedFollowing',
            follow_approved: 'acceptedFollowRequest',
            like: 'likedPost',
            comment: 'commentedOnPost',
            reply: 'repliedToYourComment',
            share: 'sharedPost',
            mention: 'mentionedYou',
            system: 'systemNotification',
            missed_call: 'missedVideoCall'
        };
        
        const key = map[type] || 'performedAnAction';
        return `${actorHtml} <span class="t">{{${key}}}</span>`; 
    },

    preview: (activity) => {
        if (activity.type === 'gamification_summary' || activity.type === 'missed_call') return '';

        const previewText = activity.preview || activity.entity?.preview;
        if (!previewText) return '';
        
        const text = String(previewText).replace(/<[^>]*>?/gm, '').substring(0, 90);
        
        let style = '';
        if (activity.entity && activity.entity.isHighlight && activity.entity.color) {
            style = `style="border-left-color: ${activity.entity.color}; background-color: ${activity.entity.color}10;"`;
        }

        return `<div class="${CONSTANTS.CLASSES.PREVIEW}" ${style}><p>${text}</p></div>`;
    },

    typeIcon: (type) => {
        const icons = {
            like: 'favorite',
            comment: 'chat_bubble_outline',
            reply: 'chat_bubble_outline',
            share: 'share',
            follow: 'person_add',
            follower: 'person_add',
            follow_approved: 'check_circle',
            system_reward: 'star',
            gamification_summary: 'emoji_events',
            mention: 'alternate_email',
            missed_call: 'videocam_off'
        };
        return icons[type] || 'notifications';
    }
};

const _Handlers = {
    attachListeners: (element) => {
        element.onclick = (e) => {
            const item = e.target.closest('.ql-notification-item');
            
            if (item && item.dataset.virtual === "true") {
                if (item.dataset.type === 'gamification_summary') {
                     if (window.QueloraApp && window.QueloraApp.Modules && window.QueloraApp.Modules.GamificationModule) {
                        window.QueloraApp.Modules.GamificationModule.open();
                     }
                }
                return;
            }

            const avatar = e.target.closest(`.${CONSTANTS.CLASSES.AVATAR_WRAPPER}`);
            const link = item?.dataset.link;
            const type = item?.dataset.type;
            
            if (avatar) {
                e.stopPropagation();
                const authorId = avatar.dataset.authorId;
                if (authorId && window.QueloraApp) {
                    window.QueloraApp.handleAnchor('U', [authorId]);
                }
                return;
            }

            if (type === 'missed_call') {
                 const authorId = item.querySelector(`.${CONSTANTS.CLASSES.AVATAR_WRAPPER}`)?.dataset.authorId;
                 if (authorId && window.QueloraApp && window.QueloraApp.Modules.ChatModule) {
                     window.QueloraApp.Modules.ChatModule.setActiveConversation(authorId);
                     window.QueloraApp.Modules.UiModule.chatConversationDrawerUI.open();
                     if (UiModule.notificationDrawerUI) UiModule.notificationDrawerUI.close();
                 }
                 return;
            }

            if (link && link !== 'null' && link !== 'undefined') {
                if (link.startsWith('U-')) {
                     const uid = link.substring(2);
                     window.QueloraApp.handleAnchor('U', [uid]);
                } else {
                     window.location.href = link;
                }
                
                if (UiModule.notificationDrawerUI) {
                    UiModule.notificationDrawerUI.close();
                }
            }
        };
    }
};

export const renderActivitiesUI = (activities) => {
    const list = document.querySelector(CONSTANTS.SELECTORS.LIST);
    if (!list) return;

    // Handle incoming data structure flexibility (array vs object wrapper)
    const rawData = (activities && activities.activities) ? activities.activities : (Array.isArray(activities) ? activities : []);
    
    // Filter invalid entries and sort by newest
    const data = rawData.filter(Boolean).sort((a, b) => {
        return new Date(b.created_at || b.createdAt || 0) - new Date(a.created_at || a.createdAt || 0);
    });

    // 1. CLEAR STATE: Remove any existing loaders or skeletons
    const loaders = list.querySelectorAll('.ql-loading-message');
    loaders.forEach(el => el.remove());

    // 2. EMPTY STATE
    if (data.length === 0) {
        // Only render empty state if we don't have existing items (prevent flashing empty on partial updates)
        if (list.children.length === 0 || list.querySelector('.ql-empty-container')) {
             list.innerHTML = `<div class="ql-empty-container t">{{emptyActivity}}</div>`;
             I18n.translateElement(list);
        }
        return;
    }

    // 3. CLEANUP: Remove empty container if data arrived
    list.querySelector('.ql-empty-container')?.remove();

    let ul = list.querySelector('.ql-notification-list');
    if (!ul) {
        ul = document.createElement('ul');
        ul.className = 'ql-notification-list';
        list.innerHTML = '';
        list.appendChild(ul);
    }

    const fragment = document.createDocumentFragment();

    data.forEach(activity => {
        const author = _normalizeAuthor(activity);
        
        // CIRCUIT BREAKER: Synchronous intercepion
        if (!author.isVirtual && ProfileModule.isBlockedAuthor(author.author)) {
            return; 
        }

        const activityId = activity._id || `act-${activity.created_at}`;
        
        // Prevent duplicates
        const existing = ul.querySelector(`li[data-activity-id="${activityId}"]`);
        if (existing) {
            existing.remove(); 
        }

        const li = document.createElement('li');
        li.className = CONSTANTS.CLASSES.ITEM;
        li.dataset.activityId = activityId;
        li.classList.add(CONSTANTS.CLASSES.UNREAD);
        li.dataset.type = activity.type;

        if (author.isVirtual) {
            li.dataset.virtual = "true";
            li.classList.add(CONSTANTS.CLASSES.SYSTEM);
        }

        const type = activity.type || activity.action_type || activity.actionType || 'unknown';
        const typeIcon = _HTML.typeIcon(type);
        
        let link = activity.link;
        
        if (!link || link === 'null') {
             const extra = activity.linkData || activity.extra || activity.references || {};
             const ids = {
                entity: extra.entity || extra.entityId || activity.entityId,
                commentId: extra.commentId,
                replyId: extra.replyId,
                follow: author.author
            };

            if (type === 'follow' || type === 'follower' || type === 'follow_approved') {
                 link = `U-${author.author}`;
            } else if (type === 'gamification_summary') {
                 link = 'javascript:void(0)';
            } else if (type === 'missed_call') {
                 link = 'javascript:void(0)';
            } else {
                 link = AnchorModule.generateLink({ type, ids });
            }
        }
        li.dataset.link = link;

        li.innerHTML = `
            <div class="${CONSTANTS.CLASSES.ASIDE}">
                ${_HTML.avatar(author)}
                <div class="${CONSTANTS.CLASSES.TYPE_ICON} ${CONSTANTS.CLASSES.TYPE_ICON}--${type}">
                    <span class="ql-icons-outlined ql-svg-icon" style="font-size: 12px;">${typeIcon}</span>
                </div>
            </div>
            
            <div class="${CONSTANTS.CLASSES.CONTENT}">
                <div class="${CONSTANTS.CLASSES.HEADER}">
                    ${_HTML.headerText(activity, author)}
                </div>
                ${_HTML.preview(activity)}
                <div class="${CONSTANTS.CLASSES.META}">
                    <span class="ql-icons-outlined ql-svg-icon" style="font-size: 12px;">schedule</span>
                    <span class="t">${UtilsModule.getTimeAgo(activity.created_at || activity.createdAt)}</span>
                </div>
            </div>
        `;

        _Handlers.attachListeners(li);
        I18n.translateElement(li);
        fragment.appendChild(li);
    });

    if (fragment.children.length > 0) {
        if (ul.firstChild) {
            ul.insertBefore(fragment, ul.firstChild);
        } else {
            ul.appendChild(fragment);
        }
    }
};

export const toggleNotificationLoadingUI = (show) => {
    const list = document.querySelector(CONSTANTS.SELECTORS.LIST);
    if (!list) return;

    if (show) {
        if (!list.querySelector('.ql-notification-item') && !list.querySelector('.ql-loading-message')) {
            UiModule.addLoadingMessageUI(list, { type: 'skeleton', count: 5, empty: true });
        }
    } else {
        const loading = list.querySelector('.ql-loading-message');
        if (loading) loading.remove();
    }
};

export const showPermissionModalUI = () => {
    return new Promise((resolve) => {
        const modalHTML = `
            <div class="ql-permission-content">
                <h2 class="ql-permission-title"><span class="t">{{enableNotifications}}</span></h2>
                <p class="ql-permission-message"><span class="t">{{enableNotificationsMessage}}</span></p>
                <div class="ql-permission-buttons">
                    <button class="ql-btn ql-btn--md ql-permission-cancel"><span class="t">{{notNow}}</span></button>
                    <button class="ql-btn ql-btn--md ql-permission-allow"><span class="t">{{allowNotifications}}</span></button>
                </div>
            </div>
        `;

        const modalElement = UiModule.createElementUI({
            tag: 'div',
            classes: ['ql-modal', 'ql-permission-modal'],
            innerHTML: modalHTML,
            styles: { display: 'flex' }
        });

        document.body.appendChild(modalElement);
        I18n.translateElement(modalElement);

        const allowBtn = modalElement.querySelector('.ql-permission-allow');
        const cancelBtn = modalElement.querySelector('.ql-permission-cancel');

        const cleanup = () => {
            modalElement.style.opacity = '0';
            setTimeout(() => modalElement.remove(), 300);
        };

        allowBtn.onclick = () => {
            cleanup();
            resolve(true);
        };

        cancelBtn.onclick = () => {
            cleanup();
            resolve(false);
        };
        requestAnimationFrame(() => modalElement.style.opacity = '1');
    });
};

/**
 * Updates the visibility and activity state of the Notification Drawer.
 */
export const toggleActivityMenuItem = (show) => {
    const item = document.querySelector('.ql-dropup-menu .ql-activity-item');
    if (item) item.style.display = show ? 'block' : 'none';

    const { notificationDrawerUI } = Drawers;
    if (!notificationDrawerUI) return;

    notificationDrawerUI.enabled = show;

    if (notificationDrawerUI.element) {
        notificationDrawerUI.element.style.display = show ? '' : 'none';
    }

    if (!show) {
        const DrawerClass = notificationDrawerUI.constructor;
        if (DrawerClass.activeDrawer === notificationDrawerUI) {
            notificationDrawerUI.close();
        }
    }

    const DrawerClass = notificationDrawerUI.constructor;
    if (DrawerClass.activeDrawer && DrawerClass.activeDrawer.swipeGroup === 'main') {
        DrawerClass.Indicator.renderForActiveDrawer();
    }
};

// ============================================================
// CIRCUIT BREAKER: REACTIVE DOM PURGE
// ============================================================
eventBus.on('USER_BLOCKED', ({ memberId }) => {
    if (!memberId) return;
    const list = document.querySelector(CONSTANTS.SELECTORS.LIST);
    if (!list) return;

    const idStr = String(memberId);
    const items = list.querySelectorAll(`.${CONSTANTS.CLASSES.ITEM}`);
    
    items.forEach(item => {
        const avatarWrapper = item.querySelector(`.${CONSTANTS.CLASSES.AVATAR_WRAPPER}`);
        if (avatarWrapper && avatarWrapper.dataset.authorId === idStr) {
            item.remove();
        }
    });
});

export default {
    renderActivitiesUI,
    toggleNotificationLoadingUI,
    showPermissionModalUI,
    toggleActivityMenuItem
};