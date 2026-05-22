/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/worker/endpointsWorker.js */
/**
 * @module Worker/Endpoints
 * @description API endpoint definitions mapped to Redux/App actions.
 * @version 7.4.0 (Added pagination offset to searchGif and trendingGif)
 */


export const ApiEndpoints = {
    // --- System & Realtime ---
    initSSE: (ctx, payload) => ctx.sse.init(payload),
    closeSSE: (ctx) => ctx.sse.close(),
    recoverNetwork: (ctx) => ctx.recoverNetwork(),
    
    /**
     * Fetches an ephemeral ticket for SSE authentication.
     * Response action: 'sseTicketFetched'
     */
    getSSETicket: (ctx, payload) => {
        ctx.fetch(
            'getSSETicket', 
            `${ctx.apiUrl}/notifications/sse/ticket`, 
            { method: "GET" }, 
            'sseTicketFetched', 
            null, 
            payload
        );
    },

    checkHealth: (ctx, payload) => {
        const safePayload = { ...payload, skipRetries: true };
        
        return ctx.fetch(
            'checkHealth', 
            `${ctx.apiUrl}/health`, 
            { method: "GET" }, 
            'healthCheckPassed', 
            (res) => res, 
            safePayload
        );
    },

    // --- Data Fetching (Stats & Proxy) ---
    
    fetchStats: (ctx, payload) => {
        // Batch request logic
        const params = new URLSearchParams({ entities: JSON.stringify(payload.entities) });
        if (payload.mapping) params.append('mapping', JSON.stringify(payload.mapping));
        
        ctx.fetch(
            'fetchStats', 
            `${ctx.apiUrl}/posts/stats?${params}`, 
            { method: "GET" }, 
            'statsFetched', 
            null, 
            payload
        );
    },

    fetchProxy: (ctx, payload) => {
        const isAbsolute = payload.endpoint.startsWith('http');
        const url = isAbsolute
            ? payload.endpoint
            : `${ctx.apiUrl}${payload.endpoint.startsWith('/') ? '' : '/'}${payload.endpoint}`;

        if (isAbsolute && !url.startsWith(ctx.apiUrl)) {
            handleLog(
                `fetchProxy blocked request to disallowed origin: ${url}`,
                'Worker/Endpoints',
                'error',
                '🛡️'
            );

            if (payload.responseAction) {
                ctx.postMessage({
                    action: payload.responseAction,
                    payload: { error: true, message: 'Request blocked: origin not whitelisted.' }
                });
            }
            return;
        }

        ctx.fetch('fetchProxy', url, {
            method: payload.method || 'GET',
            body: payload.body
        }, payload.responseAction, null, payload);
    },

    // --- GIF Search (Giphy proxy — API key lives server-side only) ---

    /**
     * Searches for GIFs via the server-side Giphy proxy.
     *
     * The Giphy API key is **never exposed to the client**. The backend endpoint
     * `/giphy/search` injects the key and forwards the sanitised response.
     *
     * The `_seq` field from the original payload is preserved in `originalPayload`
     * and forwarded back to the main thread so that `GifPickerModule` can detect
     * and discard stale responses when the user has already typed a new query.
     *
     * @param {{ query: string, _seq: number, offset: number }} payload - Search term, sequence token and pagination offset.
     *
     * Backend contract:
     * ```
     * GET /giphy/search?q=<query>&offset=<offset>
     * → { gifs: [{ id, url, title }], hasMore: boolean }
     * ```
     *
     * Response action: 'gifResults'
     */
    searchGif: (ctx, payload) => {
        const params = new URLSearchParams({ 
            q: payload.query || '',
            offset: payload.offset || 0 
        });

        ctx.fetch(
            'searchGif',
            `${ctx.apiUrl}/giphy/search?${params}`,
            { method: 'GET' },
            'gifResults',
            null,
            payload
        );
    },

    /**
     * Fetches trending GIFs via the server-side Giphy proxy.
     *
     * Called when the GIF picker opens without a search term so the panel is
     * never empty on first display.  Shares the same backend proxy and response
     * shape as `searchGif`.
     *
     * The `_seq` field from the original payload is preserved in `originalPayload`
     * and forwarded back to the main thread alongside the result data so that
     * `GifPickerModule` can discard responses superseded by a subsequent request.
     *
     * Backend contract:
     * ```
     * GET /giphy/trending?offset=<offset>
     * → { gifs: [{ id, url, title }], hasMore: boolean }
     * ```
     *
     * Response action: 'gifResults'
     */
    trendingGif: (ctx, payload) => {
        const params = new URLSearchParams({ 
            offset: payload.offset || 0 
        });

        ctx.fetch(
            'trendingGif',
            `${ctx.apiUrl}/giphy/trending?${params}`,
            { method: 'GET' },
            'gifResults',
            null,
            payload
        );
    },
    
    // --- Comments & Interactions ---

    createComment: (ctx, payload) => {
        const url = payload.replyId 
            ? `${ctx.apiUrl}/comments/${payload.entityId}/comment/${payload.replyId}/reply` 
            : `${ctx.apiUrl}/comments/${payload.entityId}/comment`;
        
        ctx.fetch('createComment', url, { 
            method: "POST", 
            body: { text: payload.comment, audio: payload?.audioBase64, hash: payload?.audioHash } 
        }, 'commentCreated', ctx.handlers.commentResponse, payload);
    },

    editComment: (ctx, payload) => {
        payload.isEdit = true;
        ctx.fetch('editComment', `${ctx.apiUrl}/comments/${payload.entityId}/comment/${payload.commentId}/edit`, { 
            method: "PATCH", 
            body: { text: payload.editComment } 
        }, 'commentCreated', ctx.handlers.commentResponse, payload);
    },
    
    getComments: (ctx, payload) => {
        const url = new URL(`${ctx.apiUrl}/posts/${payload.entityId}/thread`);
        if (payload.lastCommentId) url.searchParams.append('lastCommentId', payload.lastCommentId);
        if (payload.includeLast) url.searchParams.append('includeLast', payload.includeLast);
        
        ctx.fetch('getComments', url.toString(), { method: "GET" }, 'commentThread', null, payload);
    },

    getReplies: (ctx, payload) => {
        const url = new URL(`${ctx.apiUrl}/posts/${payload.entityId}/replies/${payload.commentId}`);
        if (payload.lastCommentId) url.searchParams.append('lastCommentId', payload.lastCommentId);
        ctx.fetch('getReplies', url.toString(), { method: "GET" }, 'repliesThread', null, payload);
    },

    getNested: (ctx, payload) => {
        const url = new URL(`${ctx.apiUrl}/posts/${payload.entityId}/nested`);
        if (payload.commentId) url.searchParams.append('commentId', payload.commentId);
        if (payload.replyId) url.searchParams.append('replyId', payload.replyId);
        ctx.fetch('getNested', url.toString(), { method: "GET" }, 'commentNested', null, payload);
    },

    delComment: (ctx, payload) => {
        ctx.fetch('delComment', `${ctx.apiUrl}/comments/${payload.entityId}/comment/${payload.commentId}/delete`, { method: "DELETE" }, 'delComment', null, payload);
    },

    reportComment: (ctx, payload) => {
        const body = {
            reason: payload.type || payload.reason,
            observation: payload.observation || '',
            blockUser: Boolean(payload.blockUser),
            source: payload.source || 'community'
        };
        ctx.fetch('reportComment', `${ctx.apiUrl}/comments/${payload.entityId}/comment/${payload.commentId}/report`, { 
            method: "POST", 
            body 
        }, 'reportedResponse', null, payload);
    },

    reportContact: (ctx, payload) => {
        const body = {
            reason: payload.reason,
            observation: payload.observation || '',
            blockUser: Boolean(payload.blockUser),
            source: payload.source || 'chat'
        };
        ctx.fetch('reportContact', `${ctx.apiUrl}/profile/${payload.contactId}/report`, { 
            method: "POST", 
            body 
        }, 'reportedResponse', null, payload);
    },

    translateComment: (ctx, payload) => {
        ctx.fetch('translateComment', `${ctx.apiUrl}/comments/${payload.entityId}/comment/${payload.commentId}/translate`, { method: "GET" }, 'translatedComment', null, payload);
    },

    getCommentAudio: (ctx, payload) => {
        ctx.fetch('getCommentAudio', `${ctx.apiUrl}/comments/audio/${payload.commentId}`, { method: "GET" }, 'returnAudio', null, payload);
    },

    // --- Likes & Social Actions ---

    fetchCommentLikes: (ctx, payload) => {
        const params = new URLSearchParams({ commentIds: JSON.stringify(payload.commentIds) });
        ctx.fetch('fetchCommentLikes', `${ctx.apiUrl}/comments/likes/${payload.entityId}?${params}`, { method: "GET" }, 'commentLikesFetched', null, payload);
    },

    getCommentLikes: (ctx, payload) => {
        ctx.fetch('getCommentLikes', `${ctx.apiUrl}/comments/likes/${payload.entityId}/comments/${payload.commentId}`, { method: "GET" }, 'getCommentLikesUpdated', null, payload);
    },

    getLikes: (ctx, payload) => {
        let url = `${ctx.apiUrl}/posts/likes/${payload.entityId}`;
        if (payload.commentId) url += `/comments/${payload.commentId}`;
        ctx.fetch('getLikes', url, { method: "GET" }, 'getLikeUpdated', null, payload);
    },

    setLike: (ctx, payload) => {
        ctx.fetch('setLike', `${ctx.apiUrl}/posts/${payload.entityId}/like`, { method: "PUT" }, 'likeUpdated', null, payload);
    },

    setLikeComment: (ctx, payload) => {
        ctx.fetch('setLikeComment', `${ctx.apiUrl}/comments/${payload.entityId}/comment/${payload.commentId}/like`, { method: "PUT" }, 'likeCommentUpdated', null, payload);
    },

    setShare: (ctx, payload) => {
        ctx.fetch('setShare', `${ctx.apiUrl}/posts/${payload.entityId}/share`, { method: "PUT" }, 'shareUpdated', null, payload);
    },

    toggleBookmark: (ctx, payload) => {
        ctx.fetch('toggleBookmark', `${ctx.apiUrl}/profile/${payload.entityId}/bookmark`, { method: "POST" }, 'bookmarkUpdated', null, payload);
    },

    // --- Profile & User Management ---

    getMyProfile: (ctx, payload) => ctx.fetch('getMyProfile', `${ctx.apiUrl}/profile/get`, { method: "GET" }, 'returnMyProfile', null, payload),
    
    getProfile: (ctx, payload) => ctx.fetch('getProfile', `${ctx.apiUrl}/profile/${payload.author}/get`, { method: "GET" }, 'returnProfile', null, payload),
    
    getMention: (ctx, payload) => ctx.fetch('getMention', `${ctx.apiUrl}/profile/${payload.mention}/mention`, { method: "GET" }, 'returnMention', null, payload),

    // --- Relationships (Follow/Block) ---

    followUser: (ctx, payload) => ctx.fetch('followUser', `${ctx.apiUrl}/profile/${payload.memberId}/follow`, { method: 'POST' }, 'userFollowed', null, payload),

    unfollowUser: (ctx, payload) => ctx.fetch('unfollowUser', `${ctx.apiUrl}/profile/${payload.memberId}/follow`, { method: 'DELETE' }, 'userUnfollowed', null, payload),

    cancelFollowRequest: (ctx, payload) => ctx.fetch('cancelFollowRequest', `${ctx.apiUrl}/profile/${payload.memberId}/cancel-follow`, { method: 'DELETE' }, 'userUnfollowed', null, payload),

    approveFollowUser: (ctx, payload) => ctx.fetch('approveFollowUser', `${ctx.apiUrl}/profile/${payload.memberId}/follow/approve`, { method: 'PATCH', body: { approve: payload.approve } }, 'userApprovefollowed', null, payload),

    blockUser: (ctx, payload) => ctx.fetch('blockUser', `${ctx.apiUrl}/profile/${payload.memberId}/block`, { method: 'POST' }, 'memberBlockStatus', null, payload),

    unblockUser: (ctx, payload) => ctx.fetch('unblockUser', `${ctx.apiUrl}/profile/${payload.memberId}/cancel-block`, { method: 'DELETE' }, 'memberBlockStatus', null, payload),

    getBlocked: (ctx, payload) => ctx.fetch('getBlocked', `${ctx.apiUrl}/profile/blocked`, { method: "GET" }, 'returnBlocked', null, payload),

    // --- Profile Editing & Search ---

    uploadProfileImage: (ctx, payload) => {
        const formData = new FormData();
        formData.append(payload.fieldName, payload.file, 'image.webp');
        
        ctx.fetch('uploadProfileImage', `${ctx.apiUrl}/profile/update-media`, { 
            method: 'POST', 
            body: formData,
            isFormData: true 
        }, 'updatedProfile', null, payload);
    },

    updateMultipleProfileFields: (ctx, payload) => {
        ctx.fetch('updateMultipleProfileFields', `${ctx.apiUrl}/profile/update-fields`, { method: 'PATCH', body: payload.fields }, 'updatedProfileFields', null, payload);
    },

    updateSettings: (ctx, payload) => {
        ctx.fetch('updateSettings', `${ctx.apiUrl}/profile/settings`, { method: 'PATCH', body: { key: payload.key, value: payload.value } }, 'updatedSettingsProfile', null, payload);
    },

    searchProfileData: (ctx, payload) => {
        const params = new URLSearchParams({ type: payload.searchType, query: payload.query });
        ctx.fetch('searchProfileData', `${ctx.apiUrl}/profile/${payload.memberId}/search?${params}`, { method: 'GET' }, 'searchProfileResults', null, payload);
    },

    getFollowingActivities: (ctx, payload) => {
        const url = new URL(`${ctx.apiUrl}/profile/following/activities`);
        if (payload.lastActivityTime) url.searchParams.append('since', payload.lastActivityTime);
        ctx.fetch('getFollowingActivities', url.toString(), { method: 'GET' }, 'followingActivities', null, payload);
    },

    searchMention: (ctx, payload) => {
        const params = new URLSearchParams({ query: payload.query });
        ctx.fetch('searchMention', `${ctx.apiUrl}/profile/search-followers?${params}`, { method: 'GET' }, 'searchMentionResults', null, payload);
    },

    searchAccounts: (ctx, payload) => {
        const params = new URLSearchParams({ query: payload.query });
        ctx.fetch('searchAccounts', `${ctx.apiUrl}/profile/search-followers?${params}`, { method: "GET" }, 'searchAccountsResults', null, payload);
    },

    removeSuggestion: (ctx, payload) => {
        ctx.fetch('removeSuggestion', `${ctx.apiUrl}/profile/${payload.memberId}/suggestion`, { method: "DELETE" }, 'suggestionRemoved', null, payload);
    },

    // --- Notifications ---

    subscribePush: (ctx, payload) => {
        payload.errorAction = 'pushSubscriptionFailed';
        ctx.fetch('subscribePush', `${ctx.apiUrl}/notifications/subscribe`, { method: 'POST', body: payload.subscriptionData }, 'pushSubscriptionConfirmed', null, payload);
    },

    unsubscribePush: (ctx, payload) => {
        payload.errorAction = 'pushSubscriptionFailed';
        ctx.fetch('unsubscribePush', `${ctx.apiUrl}/notifications/unsubscribe`, { method: 'POST', body: { subscriptionId: payload.subscriptionId } }, 'pushUnsubscriptionConfirmed', null, payload);
    }
};