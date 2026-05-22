/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/profile/profile.js */
/**
 * @module Modules/Profile
 * @description Manages User Profile Data, Encryption, State, and Business Logic.
 * REFACTOR V5.7.3: Added USER_UNBLOCKED event emission for cross-module reactivity.
 * @version 5.7.3
 */
import handleLog from '../../core/logs.js'; 
import CoreModule from '../../core/core.js';
import UtilsModule from '../../core/utils.js';
import I18n from '../../core/i18n.js';
import SessionModule from '../../core/session.js';
import StorageModule from '../../core/storage.js';
import SecurityModule from '../../core/security.js';
import ProfileUiModule from './profile.ui.js'; 
import ToastModule from '../../ui/toast.js';
import { eventBus } from '../../core/event.js';

const CONSTANTS = {
    CACHE_KEYS: {
        PROFILE: 'ql_profile',
        BLOCKED: 'ql_blocked_users',
        LAST_ACTIVITY: 'ql_notifications_last_activity_time'
    },
    PAGINATION_EVENT: 'PROFILE_PAGINATION_RESULT',
    EVENTS: {
        UPDATED: 'USER_PROFILE_UPDATED',
        REFRESH: 'USER_PROFILE_REFRESH',
        BLOCKED: 'USER_BLOCKED',
        UNBLOCKED: 'USER_UNBLOCKED'
    },
    LOG_ICON: '👤'
};

const STATE = {
    userProfile: null,
    fetchLock: null,
    blockedUsersSSOT: new Set(),
    memberProfiles: new Map(),
    cursors: new Map() 
};

// ============================================================
// CIRCUIT BREAKER: HYDRATION
// ============================================================

/**
 * Hydrates the Single Source of Truth (SSOT) from Local Storage.
 * Ensures the blocked users list is available immediately on cold boot.
 */
const hydrateBlockedUsers = () => {
    try {
        const stored = StorageModule.getLocalItem(CONSTANTS.CACHE_KEYS.BLOCKED);
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed)) {
                STATE.blockedUsersSSOT = new Set(parsed.map(String));
            }
        }
    } catch (error) {
        STATE.blockedUsersSSOT = new Set();
    }
};

hydrateBlockedUsers();

// ============================================================
// EVENT BUS LISTENERS
// ============================================================

eventBus.on(CONSTANTS.EVENTS.UPDATED, (profile) => {
    if (!profile || !profile.author) return;
    if (STATE.userProfile && STATE.userProfile.author === profile.author) {
        STATE.userProfile = { ...STATE.userProfile, ...profile };
    }
    ProfileUiModule.updateProfileUI(profile);
});

eventBus.on(CONSTANTS.EVENTS.REFRESH, async () => {
   await ProfileModule.getOwnProfile(true); 
});

eventBus.on('SESSION_ESTABLISHED', async ({ isNewLogin }) => {
    try {
        await ProfileModule.updateProfileOptionUI();
        const forceFetch = isNewLogin === true;
        
        if (forceFetch) {
            handleLog('New Session detected. Forcing strict profile fetch.', 'Profile', 'info', CONSTANTS.LOG_ICON);
        }
    
        const profile = await ProfileModule.getOwnProfile(forceFetch); 
        
        if (profile) {
            ProfileModule.runHeavyProfileTasks();
        }
        
        if (isNewLogin && profile) {
            const { default: UiModule } = await import('../../ui/ui.js');
            if (UiModule.generalSettingsDrawerUI) UiModule.generalSettingsDrawerUI.close();
        }
    } catch (error) {
        handleLog(error, 'Profile.SessionEstablished', 'error', CONSTANTS.LOG_ICON);
    }
});

eventBus.on('SESSION_CLEARED', async () => {
    handleLog('Clearing local state and session storage...', 'Profile', 'log', CONSTANTS.LOG_ICON);
    
    STATE.userProfile = null;
    STATE.fetchLock = null;
    STATE.blockedUsersSSOT.clear();
    STATE.cursors.clear();
    _PrivateServices.ProfileStorage.clear();

    StorageModule.clearSession();
    StorageModule.removeLocalItem(CONSTANTS.CACHE_KEYS.BLOCKED);

    ProfileUiModule.resetCommentLikeIconsUI();
    import('../notifications/notifications.js').then(m => m.default.stopService()).catch(err => handleLog(err, 'Profile.StopNotifications', 'warn', CONSTANTS.LOG_ICON));

    try {
        const { default: UiModule } = await import('../../ui/ui.js');
        const ui = UiModule.getCommunityUI();
        if (ui) {
            const genSettings = ui.querySelector('.general-settings');
            const profSettings = ui.querySelector('.profile-settings');
            if (genSettings) genSettings.style.display = 'inline-block';
            if (profSettings) profSettings.style.display = 'none';
            
            const profileBtn = ui.querySelector('.profile-settings');
            if (profileBtn) {
                profileBtn.style.backgroundImage = '';
                profileBtn.classList.add('ql-icons-outlined');
                profileBtn.innerHTML = '<span class="ql-icons-outlined">settings</span>';
            }
        }
        
        if (UiModule.commentsDrawerUI) UiModule.commentsDrawerUI.swipeGroup = 'guest';
        if (UiModule.profileDrawerUI) UiModule.profileDrawerUI.close();
        if (UiModule.notificationDrawerUI) UiModule.notificationDrawerUI.close();
    } catch (error) {
        handleLog(error, 'Profile.SessionCleared', 'error', CONSTANTS.LOG_ICON);
    }
});


// ============================================================
// PRIVATE SERVICES
// ============================================================

const _PrivateServices = {
    
    ProfileStorage: {
        get: (key) => STATE.memberProfiles.get(key) || null,
        set: (key, value) => { if (value?.author) STATE.memberProfiles.set(key, value); },
        getAll: () => Array.from(STATE.memberProfiles.values()),
        delete: (key) => STATE.memberProfiles.delete(key),
        clear: () => STATE.memberProfiles.clear(),
        
        async getSessionProfile() {
            const cached = StorageModule.getSessionItem(CONSTANTS.CACHE_KEYS.PROFILE);
            if (!cached) return null;
            
            const token = SessionModule.getTokenIfAvailable();
            if (!token) return null;

            try {
                const decrypted = await SecurityModule.decrypt(cached, token);
                if (!decrypted) throw new Error('Decryption returned empty.');
                return JSON.parse(decrypted);
            } catch (error) {
                handleLog('Cache decryption failed. Purging stale profile.', 'Profile', 'warn', CONSTANTS.LOG_ICON);
                StorageModule.removeSessionItem(CONSTANTS.CACHE_KEYS.PROFILE);
                return null;
            }
        },
        
        async saveSessionProfile(profile) {
            try {
                const token = SessionModule.getTokenIfAvailable();
                if (!token) {
                    handleLog('Cannot save profile: No session token available for encryption.', 'Profile', 'warn', CONSTANTS.LOG_ICON);
                    return;
                }

                const encrypted = await SecurityModule.encrypt(JSON.stringify(profile), token);
                if (encrypted) {
                    StorageModule.setSessionItem(CONSTANTS.CACHE_KEYS.PROFILE, encrypted);
                    this.set(profile.author, profile);
                }
            } catch (error) {
                handleLog(error, 'ProfileStorage.saveSessionProfile', 'error', CONSTANTS.LOG_ICON);
            }
        }
    },

    ApiService: {
        post(action, payload = {}) {
            CoreModule.postWorkerMessage({ action, payload });
        },
        async fetchOwn() { this.post('getMyProfile'); },
        async updateField(name, value) { this.post('updateProfile', { name, value }); },
        async updateFields(fields) { this.post('updateMultipleProfileFields', { fields }); },
        async followActions(action, memberId) {
            const map = { follow: 'followUser', unfollow: 'unfollowUser', cancel: 'cancelFollowRequest' };
            this.post(map[action], { memberId });
        },
        async searchProfileData(memberId, searchType, query) {
            this.post('searchProfileData', { memberId, searchType, query });
        },
        async fetchPagedData(memberId, searchType, query, lastId) {
            const params = new URLSearchParams({ type: searchType, query: query || '' });
            if (lastId) params.append('lastId', lastId);

            this.post('fetchProxy', {
                endpoint: `/profile/${memberId}/search?${params.toString()}`,
                method: 'GET',
                responseAction: `profilePaginationResult`,
                isPaginationRequest: true,
                searchType,
                memberId
            });
        },
        updateSetting(key, value) {
            CoreModule.postWorkerMessage({ action: 'updateSettings', payload: { key, value } });
        },
        parseMarkdown(text, id) {
            CoreModule.postWorkerMessage({ action: 'parseMarkdown', payload: { text, id } });
        },
        uploadProfileImage(fieldName, file) {
            CoreModule.postWorkerMessage({ action: 'uploadProfileImage', payload: { fieldName, file } });
        }
    }
};

// ============================================================
// PUBLIC API
// ============================================================

const ProfileModule = {
    memberProfiles: _PrivateServices.ProfileStorage,
    
    profilePaginationResult: async ({ payload, originalPayload }) => {
        if (!originalPayload || !originalPayload.isPaginationRequest) return;
        
        const { memberId, searchType } = originalPayload;
        const { result, has_more, last_id } = payload;
        
        const cursorKey = `${memberId}:${searchType}`;
        const currentCursor = STATE.cursors.get(cursorKey) || {};

        STATE.cursors.set(cursorKey, {
            lastId: last_id || currentCursor.lastId,
            hasMore: has_more,
            isLoading: false
        });

        ProfileModule.handlePagedResults(searchType, result, memberId, has_more);
    },

    isLogin: () => !!SessionModule.getTokenIfAvailable(),
    
    logout: async () => {
        SessionModule.logout();
    },

    getCurrentProfile: () => STATE.userProfile,

    getOwnProfile: async (forceFetch = false, maxAttempts = 5) => {
        if (!ProfileModule.isLogin()) return null;

        if (!forceFetch) {
            if (STATE.userProfile) return STATE.userProfile;
            const cached = await _PrivateServices.ProfileStorage.getSessionProfile();
            if (cached) {
                STATE.userProfile = cached;
                import('../../ui/ui.js').then(({default: Ui}) => {
                    if (Ui.commentsDrawerUI) Ui.commentsDrawerUI.swipeGroup = 'main';
                }).catch(err => handleLog(err, 'Profile.UI.Import', 'error', CONSTANTS.LOG_ICON));
                return STATE.userProfile;
            }
        } else {
            STATE.userProfile = null;
        }

        if (STATE.fetchLock) return STATE.fetchLock;

        STATE.fetchLock = (async () => {
            try {
                _PrivateServices.ApiService.fetchOwn();
                let attempt = 0;
                while (attempt < maxAttempts) {
                    await UtilsModule.wait(400);
                    const profile = await _PrivateServices.ProfileStorage.getSessionProfile();
                    if (profile) {
                        STATE.userProfile = profile;
                        import('../../ui/ui.js').then(({default: Ui}) => {
                            if (Ui.commentsDrawerUI) Ui.commentsDrawerUI.swipeGroup = 'main';
                        }).catch(err => handleLog(err, 'Profile.UI.Import', 'error', CONSTANTS.LOG_ICON));
                        return profile;
                    }
                    attempt++;
                }
                return null;
            } catch(e) {
                handleLog(e, 'Profile.getOwnProfile', 'error', CONSTANTS.LOG_ICON);
                return null;
            } finally {
                STATE.fetchLock = null;
            }
        })();

        return STATE.fetchLock;
    },

    saveMyProfile: async (profile, path) => {
        if (!profile?.author) return;
        let profileToSave = profile;
        if (path) {
            const current = await _PrivateServices.ProfileStorage.getSessionProfile() || {};
            profileToSave = { ...current, [path]: profile[path] };
        }
        await _PrivateServices.ProfileStorage.saveSessionProfile(profileToSave);
        STATE.userProfile = profileToSave;
        if (!path) _PrivateServices.ProfileStorage.set(profile.author, profile);
        
    },

    getOwnLanguage: async () => (await ProfileModule.getOwnProfile())?.settings?.interface?.defaultLanguage,
    
    getMyProfile: async () => { 
        const p = await ProfileModule.getOwnProfile(); 
        if(p) ProfileModule.getProfile(p.author); 
    },

    fetchMemberProfile: (member) => {
        const targetId = typeof member === 'object' ? member.author : member;
        STATE.cursors.forEach((v, k) => {
            if (k.startsWith(`${targetId}:`)) STATE.cursors.delete(k);
        });
        
        _PrivateServices.ApiService.post('getProfile', { author: member });
    },

    getProfile: async (member) => {
        try {
            document.querySelectorAll('.ql-profile .ql-search__input').forEach(i => i.value = '');
            await I18n.loadModuleTranslations('profile');

            const own = await ProfileModule.getOwnProfile();
            const targetId = typeof member === 'object' ? member.author : member;
            const isOwn = own?.author === targetId;

            const { default: UiModule } = await import('../../ui/ui.js');
            
            ProfileUiModule.addProfileSkeletonUI(!isOwn);
            
            if (isOwn) {
                UiModule.profileDrawerUI.open();
            } else {
                UiModule.memberDrawerUI.open();
            }
            
            ProfileModule.fetchMemberProfile(member);
        } catch (error) {
            handleLog(error, 'Profile.getProfile', 'error', CONSTANTS.LOG_ICON);
        }
    },

    getMention: async (mention) => {
        try {
            const own = await ProfileModule.getOwnProfile();
            const mentionText = mention.replace('@', '').trim(); 
            const isOwn = own && (own.name === mentionText);
            
            const { default: UiModule } = await import('../../ui/ui.js');
            ProfileUiModule.addProfileSkeletonUI(!isOwn);

            if (isOwn) {
                UiModule.profileDrawerUI.open();
            } else {
                UiModule.memberDrawerUI.open();
            }

            UtilsModule.startTimeout(() => _PrivateServices.ApiService.post('getMention', { mention }), 300);
        } catch (error) {
            handleLog(error, 'Profile.getMention', 'error', CONSTANTS.LOG_ICON);
        }
    },

    loadMoreActivity: async (memberId, type) => {
        const cursorKey = `${memberId}:${type}`;
        let cursor = STATE.cursors.get(cursorKey);

        if (!cursor) {
            cursor = { lastId: null, hasMore: true, isLoading: false };
            STATE.cursors.set(cursorKey, cursor);
        }

        if (cursor.isLoading || cursor.hasMore === false) return;

        STATE.cursors.set(cursorKey, { ...cursor, isLoading: true });
        
        const searchInput = document.querySelector(`[data-profile-member-id="${memberId}"] .ql-profile__content.${type} .ql-search__input`);
        const query = searchInput ? searchInput.value.trim() : '';

        await _PrivateServices.ApiService.fetchPagedData(memberId, type, query, cursor.lastId);
    },

    updateCommentHTML: (id, html, containerId) => {
        import('../../ui/ui.js').then(({default: Ui}) => {
             const targetId = containerId || `ql-profile-content-${id}`;
             const el = document.getElementById(targetId);
             if (el) requestAnimationFrame(() => el.innerHTML = html);
        }).catch(err => handleLog(err, 'Profile.updateCommentHTML', 'error', CONSTANTS.LOG_ICON));
    },

    runHeavyProfileTasks: async () => {
        try {
            const p = await ProfileModule.getOwnProfile();
            if (!p) return;
            
            if (p.settings?.interface?.defaultLanguage && p.settings.interface.defaultLanguage !== 'auto') {
                I18n.changeLanguage(p.settings.interface.defaultLanguage);
            }
            if (p.settings?.interface?.defaultTheme && p.settings.interface.defaultTheme !== 'system') {
                document.getElementById('ql-theme-root')?.setAttribute('data-theme', p.settings.interface.defaultTheme);
            }
            
            const webNotificationsEnabled = p.settings?.notifications?.web !== false;
            
            if (webNotificationsEnabled) {
                import('../notifications/notifications.js').then(m => m.default.startService());
            } else {
                import('../notifications/notifications.js').then(m => m.default.stopService());
            }

            import('../../ui/ui.js').then(({ default: Ui }) => {
                if (typeof Ui.toggleActivityMenuItem === 'function') {
                    Ui.toggleActivityMenuItem(webNotificationsEnabled);
                }
            }).catch(err => handleLog(err, 'Profile.HeavyTasks.UI', 'error', CONSTANTS.LOG_ICON));
        } catch (error) {
            handleLog(error, 'Profile.HeavyTasks', 'error', CONSTANTS.LOG_ICON);
        }
    },

    fetchFollowingActivities: async (isPolling = false) => {
        const time = isPolling ? StorageModule.getSessionItem(CONSTANTS.CACHE_KEYS.LAST_ACTIVITY) : null;
        _PrivateServices.ApiService.post('getFollowingActivities', { lastActivityTime: time });
    },

    isBlockedAuthor: (author) => {
        if (!author) return false;
        return STATE.blockedUsersSSOT.has(String(author));
    },
    
    refreshBlockedAuthors: () => { 
        hydrateBlockedUsers(); 
    },

    updateProfileOptionUI: async () => {
        const profile = await ProfileModule.getOwnProfile();
        let uiData = { profile: profile, generatedAvatar: null };
        
        if (profile && !profile.picture) {
            const initials = (profile.name || '').split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
            const canvas = document.createElement('canvas');
            canvas.width = 100; canvas.height = 100;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = ["#ef5350", "#ab47bc", "#26a69a", "#ff7043", "#5c6bc0", "#7e57c2"][initials.charCodeAt(0) % 6];
            ctx.fillRect(0, 0, 100, 100);
            ctx.fillStyle = '#fff'; ctx.font = 'bold 50px Arial';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(initials, 50, 50);
            uiData.generatedAvatar = canvas.toDataURL();
        }

        if (profile?.settings?.session?.rememberSession) SessionModule.rememberSession();
        if (profile?.followRequests?.length > 0) ToastModule.info("person_add", I18n.getTranslation("followRequest"), I18n.getTranslation("pendingRequest"), ProfileModule.renderFollowRequests);

        ProfileUiModule.updateNavbarAvatarUI(uiData);
    },

    updateProfileSettingsUI: async () => {
        const profile = await ProfileModule.getOwnProfile(true); 
        if(!profile) return;
        ProfileUiModule.updateSettingsUI(profile);
    },

    updateSetting: (key, value) => {
        _PrivateServices.ApiService.updateSetting(key, value);
    },

    handleProfileUpdateResult: (response) => {
        if (response.success && response.profile) {
            ProfileModule.saveMyProfile(response.profile);
            eventBus.emit(CONSTANTS.EVENTS.UPDATED, response.profile); 
        }
        if (ProfileUiModule && typeof ProfileUiModule.handleProfileUpdateResult === 'function') {
            ProfileUiModule.handleProfileUpdateResult(response);
        }
    },

    updateFollowState: (memberId, action, requiresApproval = false) => {
        const isFollowing = action === 'userFollowed' || action === 'followRequestCreated' || action === 'followRequestSent';
        let state = 'not-following';
        if (isFollowing) {
            state = requiresApproval ? 'pending' : 'following';
        }
        const text = state === 'pending' ? 'pending' : (state === 'following' ? 'following' : 'follow');
        const iconName = state === 'pending' ? 'schedule_send' : (state === 'following' ? 'people' : 'person_add');
        ProfileUiModule.updateFollowButtonStateUI(memberId, state, iconName, text);
    },

    renderProfile: async (userProfile) => {
        if (!userProfile) return ToastModule.error('error', I18n.getTranslation('profileNotFound'));
        
        const ownProfile = await ProfileModule.getOwnProfile();
        const isOwn = ownProfile?.author === userProfile.author;
        
        if (isOwn) ProfileModule.saveMyProfile(userProfile);
        _PrivateServices.ProfileStorage.set(userProfile.author, userProfile);

        await ProfileUiModule.renderProfileUI(userProfile, ownProfile);

        const container = ProfileUiModule.getProfileContainerUI(!isOwn);
        if (container) {
            const sections = [
                { data: userProfile.activity?.comments, type: 'comments' },
                { data: userProfile.activity?.likes, type: 'likes' },
                { data: userProfile.activity?.shares, type: 'shares' },
                { data: userProfile.bookmarks, type: 'bookmarks' },
                { data: userProfile.followers, type: 'follower' },
                { data: userProfile.following, type: 'followed' }
            ];

            sections.forEach(s => {
                const subContainer = container.querySelector(`.ql-profile__content.${s.type} ul`);
                if (!subContainer) return;
                
                let hasMoreItems = s.data && s.data.length >= 5;
                let lastId = null;

                if (hasMoreItems) {
                    const lastItem = s.data[s.data.length - 1];
                    lastId = lastItem._id || lastItem.rel_id || lastItem.author;
                    
                    if ((s.type === 'follower' || s.type === 'followed') && !lastItem.rel_id) {
                        lastId = null; 
                        hasMoreItems = false;
                    }
                }

                if (lastId) {
                    STATE.cursors.set(`${userProfile.author}:${s.type}`, {
                        lastId,
                        hasMore: true,
                        isLoading: false
                    });
                } else {
                    STATE.cursors.delete(`${userProfile.author}:${s.type}`);
                }

                ProfileUiModule.renderProfileSectionUI(s.data, subContainer, s.type, ownProfile, {
                    isBlocked: false,
                    isAppend: false, 
                    hasMore: hasMoreItems
                });
            });
            
            if(userProfile.blocked && isOwn) {
                 const subContainer = container.querySelector(`.ql-profile__content.blocked ul`);
                 if (subContainer) {
                     ProfileUiModule.renderProfileSectionUI(userProfile.blocked, subContainer, 'blocked', ownProfile, {
                         isBlocked: true,
                         isAppend: false
                     });
                 }
            }
        }
    },
 
    handleImageProcessed: (file, cropData, type) => {
        const reader = new FileReader();
        reader.onload = function() {
            const arrayBuffer = this.result;
            const uint8Array = new Uint8Array(arrayBuffer);
            CoreModule.postWorkerMessage({
                action: 'processAvatar',
                payload: { fileBytes: uint8Array, cropData: cropData, imageType: type }
            });
        };
        reader.readAsArrayBuffer(file);
    },

    handleProcessedImage: (blob, type) => {
        ProfileUiModule.handleProcessedImage(blob, type);
        const fieldName = type === 'avatar' ? 'picture' : type;
        _PrivateServices.ApiService.uploadProfileImage(fieldName, blob);
    },
    
    showEditProfileModal: async () => {
        const own = await ProfileModule.getOwnProfile();
        if (!own) return ToastModule.error('error', I18n.getTranslation('notLoggedIn'));
        ProfileUiModule.showEditProfileModalUI(own, async (updates) => {
            await _PrivateServices.ApiService.updateFields(updates);
        });
    },

    handleSearchResults: async (type, results, memberId) => {
        const container = document.querySelector(`[data-profile-member-id="${memberId}"] .ql-profile__content.${type} ul`);
        container?.querySelector('.ql-loading-message')?.remove();
        const ownProfile = await ProfileModule.getOwnProfile();
        ProfileUiModule.renderProfileSectionUI(results, container, type, ownProfile, { isAppend: false }); 
    },

    handlePagedResults: async (type, results, memberId, hasMore) => {
        const container = document.querySelector(`[data-profile-member-id="${memberId}"] .ql-profile__content.${type} ul`);
        const ownProfile = await ProfileModule.getOwnProfile();
        
        ProfileUiModule.renderProfileSectionUI(results, container, type, ownProfile, { 
            isAppend: true,
            hasMore: hasMore
        });
    },

    renderFollowRequests: async () => {
        const reqs = (await ProfileModule.getOwnProfile())?.followRequests || [];
        ProfileUiModule.renderFollowRequestsUI(reqs); 
    },

    renderSuggestions: async (force = false) => {
        const own = await ProfileModule.getOwnProfile();
        const suggestions = own?.suggestions || [];
        ProfileUiModule.renderSuggestionsUI(suggestions, own);
    },

    findMention: async (input, query) => {
        await import('../../core/guard.js').then(m => m.default.protect(async () => {
            const own = await ProfileModule.getOwnProfile(true);
            if (!own) return; 
            const local = (own.following || []).filter(p => [p.name, p.given_name, p.family_name].some(n => n?.toLowerCase().includes(query?.toLowerCase())));
            if (local.length <= 5) {
                _PrivateServices.ApiService.post('searchMention', { query });
            } else {
                ProfileModule.renderMentionResults(local.slice(0, 10));
            }
        }));
    },

    renderMentionResults: async (payload) => {
        await import('../../core/guard.js').then(m => m.default.protect(async () => {
            const results = Array.isArray(payload) ? payload : payload.result;
            const validProfiles = results.filter(p => !ProfileModule.isBlockedAuthor(p.author));
            
            const handleSelection = (selectedProfileId, inputRef) => {
                const selectedProfile = validProfiles.find(p => p.author === selectedProfileId);
                if (!selectedProfile) return;
                const inputElement = inputRef || document.querySelector('.comment-input') || document.getElementById('ql-input');
                if (inputElement) {
                    import('../features/mention.js').then(m => {
                        const mentionHandler = new m.default(inputElement, null);
                        mentionHandler.replaceMention(selectedProfile.name);
                    });
                    _PrivateServices.ProfileStorage.set(selectedProfile.author, selectedProfile);
                }
            };
            ProfileUiModule.renderMentionResultsUI(validProfiles, handleSelection);
        }));
    },

    renderSearchAccountsResults: async (payload) => {
        const profiles = Array.isArray(payload) ? payload : (payload.result || []);
        const filteredProfiles = profiles.filter(p => !ProfileModule.isBlockedAuthor(p.author));
        const ownProfile = await ProfileModule.getOwnProfile();
        ProfileUiModule.renderSearchAccountsResultsUI(filteredProfiles, ownProfile);
    },

    removeSuggestion: async (memberId) => {
        const profile = await ProfileModule.getOwnProfile();
        if (profile?.suggestions) {
            profile.suggestions = profile.suggestions.filter(s => s.author !== memberId);
            await ProfileModule.saveMyProfile(profile);
        }
        _PrivateServices.ApiService.post('removeSuggestion', { memberId });
    },
    
    fetchUpdateProfile: (name, value) => _PrivateServices.ApiService.updateField(name, value),
    fetchUpdateProfileFields: (fields) => _PrivateServices.ApiService.updateFields(fields),
    fetchAccounts: (query) => _PrivateServices.ApiService.post('searchAccounts', { query }),
    preloadProfileUI: async () => { if (await ProfileModule.getOwnProfile(false)) ProfileModule.renderProfile(STATE.userProfile); },
    saveMemberProfile: (p) => _PrivateServices.ProfileStorage.set(p.author, p),
    handleFollowClick: (memberId, state) => {
        const action = state === 'following' ? 'unfollow' : state === 'pending' ? 'cancel' : 'follow';
        _PrivateServices.ApiService.followActions(action, memberId);
    },
    handleUnblockClick: (memberId) => _PrivateServices.ApiService.post('unblockUser', { memberId }),
    parseMarkdown: _PrivateServices.ApiService.parseMarkdown.bind(_PrivateServices.ApiService),
    searchProfileData: _PrivateServices.ApiService.searchProfileData.bind(_PrivateServices.ApiService),
    
    /**
     * Registers an author as blocked in the SSOT and local storage, then purges their
     * content from the UI. After persisting the block, forces a fresh profile fetch
     * from the server and re-renders the own profile so the blocked-users list stays
     * in sync without requiring a manual page reload.
     * @param {string|number} authorId - The author identifier to block.
     */
    addHiddenAuthor: async (authorId) => {
        const idStr = String(authorId);
        if (!STATE.blockedUsersSSOT.has(idStr)) {
            STATE.blockedUsersSSOT.add(idStr);
            StorageModule.setLocalItem(CONSTANTS.CACHE_KEYS.BLOCKED, JSON.stringify(Array.from(STATE.blockedUsersSSOT)));
            eventBus.emit(CONSTANTS.EVENTS.BLOCKED, { memberId: idStr });
        }
        if (ProfileUiModule && typeof ProfileUiModule.destroyElementsByUI === 'function') {
            ProfileUiModule.destroyElementsByUI(idStr);
        }
        try {
            const updatedProfile = await ProfileModule.getOwnProfile(true);
            if (updatedProfile) {
                await ProfileModule.renderProfile(updatedProfile);
            }
        } catch (error) {
            handleLog(error, 'Profile.addHiddenAuthor.rerender', 'error', CONSTANTS.LOG_ICON);
        }
    },
    
    renderProfileListLikes: (payload) => {
        import('./profile.js').then(m => m.default.getOwnProfile().then(own => ProfileUiModule.renderLikesDrawerUI(payload, own)));
    },
    handleSettingsUpdated: (payload) => ProfileModule.saveMyProfile(payload?.profile),
    
    /**
     * Intercepts block mutations from the API to update SSOT cleanly.
     * On unblock: removes the author from the SSOT and delegates to the UI for
     * deferred DOM removal (5-second grace window for accidental unblocks).
     * On block: delegates to addHiddenAuthor which also triggers a full profile re-render.
     * Forces a background profile sync in both cases to keep arrays consistent.
     * @param {Object} payload - The API response payload for blocking/unblocking.
     * @param {string|number} payload.memberId - The affected member's identifier.
     * @param {boolean} [payload.block] - False when the action is an unblock.
     * @param {string} [payload.status] - 'unblocked' when the action is an unblock.
     */
    memberBlockStatus: async (payload) => {
        const idStr = String(payload.memberId);
        const isUnblocked = payload.block === false || payload.status === 'unblocked';

        if (isUnblocked) {
            STATE.blockedUsersSSOT.delete(idStr);
            StorageModule.setLocalItem(CONSTANTS.CACHE_KEYS.BLOCKED, JSON.stringify(Array.from(STATE.blockedUsersSSOT)));
            
            eventBus.emit(CONSTANTS.EVENTS.UNBLOCKED, { memberId: idStr });
            
            if (typeof ProfileUiModule.scheduleBlockedUserRemovalUI === 'function') {
                ProfileUiModule.scheduleBlockedUserRemovalUI(payload.memberId);
            }
        } else {
            ProfileModule.addHiddenAuthor(idStr);
        }

        await ProfileModule.getOwnProfile(true);
    },

    handleRequestAction: (requestId, memberId, approve) => {
        if (STATE.userProfile && STATE.userProfile.followRequests) {
            STATE.userProfile.followRequests = STATE.userProfile.followRequests.filter(r => r._id !== requestId);
        }
        _PrivateServices.ApiService.post('approveFollowUser', { requestId, memberId, approve });
        ProfileModule.saveMyProfile(STATE.userProfile);
    }
};

export default ProfileModule;