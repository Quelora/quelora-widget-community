/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/profile/profile.templates.js */
/**
 * @module Modules/Profile/Templates
 * @description Pure HTML generation functions for Profile UI.
 * Updated: Added "Start Chat" button logic for online users.
 * @version 1.1.0
 */

import ConfModule from '../../core/conf.js';
import UtilsModule from '../../core/utils.js';
import I18n from '../../core/i18n.js';
import IconsModule from '../../ui/icons.js';

const _escapeHtml = (text) => {
    if (!text) return '';
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
};

export const ProfileTemplates = {
    
    avatar: (user, isList = false) => {
        const style = user.picture ? `background-image: url('${user.picture}')` : '';
        const content = user.picture ? '' : (user.name?.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) || '');
        const assetBaseUrl = ConfModule.get('assetBaseUrl') || '';
        const isSquared = user.avatarFrameType === 'SQUARED';
        const shapeClass = isSquared ? 'squared' : '';
        
        if (isList) {
            // Inline styles used to ensure layout stability without external CSS dependencies for the wrapper
            const frameUrl = user.avatarFrameUrl ? `${assetBaseUrl}/${user.avatarFrameUrl}` : null;
            const frameStyle = frameUrl 
                ? `background-image: url('${frameUrl}'); display: block;` 
                : 'display: none;';
            
            return `
                <div class="ql-profile__list-avatar-wrapper">
                    <div class="ql-profile__list-avatar ${shapeClass}" 
                         style="${style}; width: 100%; height: 100%; margin: 0;" 
                         data-member-id="${user.author}">
                         ${content}
                    </div>
                    <div class="ql-profile__list-frame ${shapeClass}" 
                         style="${frameStyle}">
                    </div>
                </div>`;
        }

        return `
            <div class="avatar-wrapper" data-member-id="${user.author}">
                ${user.avatarFrameUrl ? `<div class="avatar-frame ${shapeClass}" style="background-image: url('${assetBaseUrl}/${user.avatarFrameUrl}')"></div>` : ''}
                <div class="comment-avatar ${shapeClass}" style="${style}">${content}</div>
            </div>`;
    },

    userInfo: (user) => `
        <div class="ql-profile__list-info">
            <span class="ql-profile__list-name" data-member-id="${user.author}">${user.name || I18n.getTranslation('user')}</span>
            <span class="ql-profile__list-sub">${`${user.given_name || ''} ${user.family_name || ''}`.trim() || '' }</span>
        </div>`,

    followButton: (user, isOwnProfile) => {
        if (isOwnProfile) return '<span class="follow-placeholder"></span>';
        
        const isFollowing = user.isFollowing;
        const isPending = user.isFollowRequestSent;
        const state = isPending ? 'pending' : (isFollowing ? 'following' : 'not-following');
        const icon = isPending ? 'schedule_send' : (isFollowing ? 'people' : 'person_add');
        const textKey = isPending ? 'pending' : (isFollowing ? 'following' : 'follow');
        const approvalData = user.followerApproval ?? false;

        let stateClass = '';
        if (state === 'following' || state === 'pending') stateClass += ' ql-btn--active';
        if (state === 'pending') stateClass += ' ql-btn--pending';

        const iconHTML = IconsModule.getIconSvg(icon) || `<span class="ql-icons-outlined">${icon}</span>`;
        const iconClasses = IconsModule.getIconSvg(icon) ? 'ql-icons-outlined ql-svg-icon' : 'ql-icons-outlined';

        return `
            <button class="ql-btn ql-btn--md follow-button ${stateClass}" 
                    data-member-id="${user.author}" 
                    data-follow-state="${state}" 
                    data-member-approval="${approvalData}">
                <span class="${iconClasses}">${iconHTML}</span>
                <span class="legend t" data-i18n-key="${textKey}" data-i18n-original="{{${textKey}}}">{{${textKey}}}</span>
            </button>
        `;
    },

    unblockButton: (user) => {
        const iconHTML = IconsModule.getIconSvg('unlock') || `<span class="ql-icons-outlined">unlock</span>`;
        const iconClasses = IconsModule.getIconSvg('unlock') ? 'ql-icons-outlined ql-svg-icon' : 'ql-icons-outlined';
        
        return `
            <button class="ql-btn ql-btn--md unblock-button" data-member-id="${user.author}">
                <span class="${iconClasses}">${iconHTML}</span>
                <span class="legend t" data-i18n-key="unblock" data-i18n-original="{{unblock}}">{{unblock}}</span>
            </button>
        `;
    },

    mainContainer: (userProfile, isOwn) => {
        const assetBaseUrl = ConfModule.get('assetBaseUrl') || '';
        const avatarStyle = userProfile.picture ? `background-image: url('${userProfile.picture}')` : '';
        const avatarContent = userProfile.picture ? '' : (userProfile.name?.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) || '');
        const coverStyle = userProfile.background ? `background-image: url('${userProfile.background}')` : '';
        const isSquared = userProfile.avatarFrameType === 'SQUARED';
        const squaredClass = isSquared ? 'ql-profile__avatar--squared' : '';

        const statusIndicator = !isOwn 
            ? `<span class="ql-profile__status ${userProfile.online ? 'ql-profile__status--online' : ''}"></span>` 
            : '';

        // NEW: Chat Button Logic
        let chatButton = '';
        if (!isOwn && userProfile.online) {
            chatButton = `
                <button class="ql-btn ql-btn--md start-chat-button" data-member-id="${userProfile.author}">
                    <span class="ql-icons-outlined">chat_bubble_outline</span>
                    <span class="legend t" data-i18n-key="chat">{{newChat}}</span>
                </button>
            `;
        }

        return `
            <div class="ql-profile__header" style="${coverStyle}">
                ${isOwn ? `<button class="ql-profile__header-edit"><span class="ql-icons-outlined">photo</span></button>` : ''}
                
                <div class="ql-profile__avatar-box">
                    <div class="ql-profile__avatar ${squaredClass}" style="${avatarStyle}">
                         ${avatarContent}
                    </div>
                    ${isOwn ? `<button class="ql-profile__avatar-edit"><span class="ql-icons-outlined">photo</span></button>` : ''}
                    
                    ${userProfile.avatarFrameUrl ? `<div class="ql-profile__frame ${squaredClass}" style="background-image: url('${assetBaseUrl}/${userProfile.avatarFrameUrl}')"></div>` : ''}
                    
                    ${statusIndicator}
                </div>
                <div class="ql-profile__info-container">
                    <div class="ql-profile__meta">
                        <div class="ql-profile__identity">
                            <h3 class="ql-profile__name">
                                ${userProfile.name || I18n.getTranslation('user')}
                                ${isOwn ? `<button class="ql-profile__name-edit" id="ql-profile-edit-trigger"><span class="ql-icons-outlined">edit</span></button>` : ''}
                            </h3>
                            <span class="ql-profile__username">${userProfile.given_name || ''} ${userProfile.family_name || ''}</span>
                        </div>
                        <div class="ql-profile__actions">
                            ${!isOwn ? ProfileTemplates.followButton(userProfile, false) : ''}
                            ${chatButton}
                        </div>
                    </div>
                </div>
            </div>

            <div class="ql-profile__tabs">
                ${ProfileTemplates._tabItem('comments', 'comment', userProfile.counts?.comments, true)}
                ${ProfileTemplates._tabItem('likes', 'favorite', userProfile.counts?.likes)}
                ${ProfileTemplates._tabItem('shares', 'share', userProfile.counts?.shares)}
                ${ProfileTemplates._tabItem('bookmarks', 'bookmark', userProfile.counts?.bookmarks)}
                
                <div class="ql-profile__tab ql-profile__tab--dropdown" data-tab="follow">
                    <span class="ql-icons-outlined ql-profile__tab-icon">people</span>
                    <span class="ql-icons-outlined">expand_more</span>
                    <div class="ql-profile__dropdown-menu">
                        ${ProfileTemplates._dropdownItem('follower', 'people', 'followers', userProfile.counts?.followers)}
                        ${ProfileTemplates._dropdownItem('followed', 'person', 'following', userProfile.counts?.following)}
                        ${ProfileTemplates._dropdownItem('blocked', 'userbloked', 'blocked', userProfile.blocked?.length)}
                    </div>
                </div>
            </div>

            <div class="ql-profile__content comments ql-profile__content--active">
                <div class="ql-profile__search">
                    <span class="ql-icons-outlined">search</span>
                    <input class="ql-search__input" placeholder="{{search-comments}}">
                </div>
                <ul class="ql-profile__list"></ul>
            </div>
            
            ${['likes', 'shares', 'bookmarks', 'follower', 'followed', 'blocked'].map(type => `
            <div class="ql-profile__content ${type}">
                ${type !== 'blocked' ? `
                <div class="ql-profile__search">
                    <span class="ql-icons-outlined">search</span>
                    <input class="ql-search__input" placeholder="{{search-${type}}}">
                </div>` : ''}
                <ul class="ql-profile__list"></ul>
            </div>`).join('')}
        `;
    },

    _tabItem: (id, icon, count, isActive = false) => `
        <div class="ql-profile__tab ${isActive ? 'ql-profile__tab--active' : ''}" data-tab="${id}">
            <span class="ql-icons-outlined ql-profile__tab-icon">${icon}</span>
            <span class="ql-profile__tab-count">${UtilsModule.formatNumberAbbreviated(count || 0)}</span>
        </div>`,

    _dropdownItem: (id, icon, textKey, count) => `
        <div class="ql-profile__dropdown-item" data-tab="${id}">
            <span><span class="ql-icons-outlined">${icon}</span> <span class="t">{{${textKey}}}</span></span>
            <span class="ql-profile__dropdown-badge">${UtilsModule.formatNumberAbbreviated(count || 0)}</span>
        </div>`,

    suggestionItem: (u, ownProfile) => {
        const btn = ProfileTemplates.followButton(u, ownProfile?.author === u.author);
        const common = u.common_connections || 0;
        const connectionText = common > 0 
            ? `${common} ${I18n.getTranslation(common === 1 ? 'mutual_connection' : 'mutual_connections')}`
            : (u.reason === 'social' ? I18n.getTranslation('common_connections') : I18n.getTranslation('suggested_for_you'));

        return `
            <li class="ql-profile__user-card suggestion-item" tabindex="-1" data-member-id="${u.author}">
                ${ProfileTemplates.avatar(u, true)}
                <div class="ql-profile__list-info">
                    <span class="ql-profile__list-name" data-member-id="${u.author}">${u.name || I18n.getTranslation('user')}</span>
                    <span class="ql-profile__list-sub t">${connectionText}</span>
                </div>
                <div class="ql-profile__actions">
                    ${btn}
                    <button class="ql-btn remove-suggestion" data-member-id="${u.author}">
                        <span class="ql-icons-outlined">delete</span>
                    </button>
                </div>
            </li>`;
    },

    editProfileForm: (profile) => {
        const formHTML = document.createElement('div');
        formHTML.className = 'ql-registration-drawer ql-profile-edit-form';
        
        const createPlainInput = (id, labelKey, value, autocomplete, required = false) => `
            <div class="ql-form-group floating-label-group ${value ? 'active' : ''}" data-field-id="${id}">
                <div class="ql-input-wrapper ql-input-wrapper--plain">
                    <input type="text" id="${id}" ${required ? 'required' : ''} value="${value || ''}" autocomplete="${autocomplete}" class="ql-input-field" style="padding-left: 15px;">
                    <label for="${id}" class="t" style="left: 15px;">{{${labelKey}}}</label>
                </div>
                <div class="ql-field-error t"></div>
            </div>`;

        formHTML.innerHTML = `
            <div class="ql-form-step step-1 active">
                
                <div id="ql-form-status" class="ql-form-status t" style="display:none;"></div>

                <div class="ql-form-section">
                    <h4 class="ql-form-title t">{{personalInfo}}</h4>
                    
                    ${createPlainInput('edit-name', 'userName', profile.name, 'username', true)}
                    
                    <div class="ql-form-row two-col">
                        ${createPlainInput('edit-given-name', 'firstName', profile.given_name, 'given-name', true)}
                        ${createPlainInput('edit-family-name', 'lastName', profile.family_name, 'family-name')}
                    </div>
                </div>

                <div class="ql-form-section">
                    <button id="ql-toggle-password-btn" class="ql-btn-toggle-password">
                        <span class="ql-icons-outlined">lock_reset</span>
                        <span class="t">{{changePassword}}</span>
                        <span class="ql-icons-outlined arrow">chevron_right</span>
                    </button>
                    
                    <div id="ql-password-fields-container" class="ql-password-container" style="display: none;">
                        <h4 class="ql-form-title t">{{security}}</h4>
                        
                        <div class="ql-form-group floating-label-group" data-field-id="edit-password-original">
                            <div class="ql-input-wrapper">
                                <div class="ql-input-icon"><span class="ql-icons-outlined">lock</span></div>
                                <input type="password" id="edit-password-original" autocomplete="current-password" class="ql-input-field">
                                <label for="edit-password-original" class="t">{{currentPassword}}</label>
                            </div>
                            <div class="ql-field-error t"></div>
                        </div>
                        
                        <div class="ql-form-group floating-label-group" data-field-id="edit-password">
                            <div class="ql-input-wrapper">
                                <div class="ql-input-icon"><span class="ql-icons-outlined">lock</span></div>
                                <input type="password" id="edit-password" autocomplete="new-password" class="ql-input-field">
                                <label for="edit-password" class="t">{{newPassword}}</label>
                            </div>
                            <div id="password-strength-meter" class="password-strength-meter">
                                <div class="strength-bar-container">
                                    <div class="strength-bar"></div>
                                </div>
                                <span class="strength-text"></span>
                            </div>
                            <div class="ql-field-error t"></div>
                        </div>
                        
                        <div class="ql-form-group floating-label-group" data-field-id="edit-password-verify">
                            <div class="ql-input-wrapper">
                                <div class="ql-input-icon"><span class="ql-icons-outlined">lock</span></div>
                                <input type="password" id="edit-password-verify" autocomplete="new-password" class="ql-input-field">
                                <label for="edit-password-verify" class="t">{{passwordVerify}}</label>
                            </div>
                            <div class="ql-field-error t"></div>
                        </div>
                    </div>
                </div>
            </div>`;

        const toggleBtn = formHTML.querySelector('#ql-toggle-password-btn');
        const container = formHTML.querySelector('#ql-password-fields-container');
        
        if (toggleBtn && container) {
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                toggleBtn.classList.add('hidden');
                container.style.display = 'block';
                container.getBoundingClientRect(); 
                container.classList.add('visible');
            });
        }
        return formHTML;
    },

    skeleton: () => {
        const skLine = (w, h, m = '0') => `<div class="ql-skeleton ql-skeleton-line" style="width:${w};height:${h};margin:${m}"></div>`;
        return `
            <div class="ql-profile__header" style="background: var(--ql-secondary-color);">
                <div class="ql-profile__avatar-box">
                    <div class="ql-skeleton ql-skeleton-avatar" style="width: 100px; height: 100px; border: 4px solid var(--ql-secondary-color);"></div>
                </div>
                <div class="ql-profile__info-container" style="justify-content: flex-end; padding-bottom: 15px; height: 100%; width: 100%;">
                    <div class="ql-profile__meta" style="width: 100%; align-items: flex-start;">
                        <div class="ql-profile__identity" style="width: 60%;">
                            ${skLine('80%', '24px', '0 0 8px 0')}
                            ${skLine('50%', '16px')}
                        </div>
                    </div>
                </div>
            </div>
            <div class="ql-profile__tabs" style="pointer-events: none;">
                ${Array(4).fill('<div class="ql-profile__tab"><div class="ql-skeleton ql-skeleton-icon"></div></div>').join('')}
            </div>
            <div class="ql-profile__content ql-profile__content--active" style="padding: 0;">
                 <div style="padding: 20px; display: flex; flex-direction: column; gap: 20px;">
                    ${Array(10).fill(`
                        <div class="ql-skeleton-message ql-thread" style="width: 100%;">
                            <div class="ql-thread__header" style="display: flex; gap: 10px; margin-bottom: 10px;">
                                <div class="ql-skeleton ql-skeleton-avatar"></div>
                                <div style="display: flex; flex-direction: column; gap: 5px; justify-content: center;">
                                    ${skLine('300px', '10px')}
                                    ${skLine('300px', '10px')}
                                </div>
                            </div>
                        </div>
                    `).join('')}
                 </div>
            </div>`;
    },

    commentItem: (item) => {
        const date = `<span class="t">${UtilsModule.formatDate(item.created_at)}</span>`;
        const link = `<a class="ql-profile__item-link" href="#" data-bypass="true">${item.referer?.title || I18n.getTranslation('noDescription')}</a>`;
        const context = `<div class="ql-profile__item-context">${date} | ${link}</div>`;
        return `
            <div style="display: flex; gap: 10px; width: 100%;">
                ${ProfileTemplates.avatar(item.author, true)}
                <div style="flex: 1; display: flex; flex-direction: column;">
                    ${context}
                    <div id="ql-content-${item._id}" class="ql-profile__comment-preview ql-markdown-body">${_escapeHtml(item.text)}</div>
                </div>
            </div>`;
    },

    likeItem: (item) => {
        const date = `<span class="t">${UtilsModule.formatDate(item.created_at)}</span>`;
        const titleText = item.referer?.title || item.title;
        const title = `<a class="ql-profile__item-link" href="#" data-bypass="true">${titleText}</a>`;
        const context = `<div class="ql-profile__item-context"><span class="ql-icons-outlined" style="font-size:14px">favorite</span> ${date} | ${title}</div>`;
        
        if (item.fk_type === 'comment' && item.text) {
             return `
                <div style="display: flex; gap: 10px; width: 100%;">
                    ${ProfileTemplates.avatar(item.author || item.referer?.author, true)}
                    <div style="flex: 1; display: flex; flex-direction: column;">
                        ${context}
                        <div class="ql-profile__comment-preview">${_escapeHtml(item.text)}</div>
                    </div>
                </div>`;
        }
        return context;
    },

    simpleItem: (item, type) => {
        const data = type === 'shares' ? { date: item.madeAt, title: item.entity?.title } : { date: item.created_at, title: item.post?.title };
        const date = `<span class="t">${UtilsModule.formatDate(data.date)}</span>`;
        const title = `<span class="ql-profile__item-link">${data.title}</span>`;
        const icon = type === 'shares' ? 'share' : 'bookmark';
        return `<div class="ql-profile__item-context"><span class="ql-icons-outlined" style="font-size:14px">${icon}</span> ${date} | ${title}</div>`;
    }
};