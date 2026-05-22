/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/guard.js */
/**
 * @module Core/Guard
 * @description Route and Action Guard.
 * Protectors for authenticated actions and network availability.
 * Resilience-mode aware: intercepts actions based on operational mode
 * received from the backend bootstrap payload.
 *
 * ## Resilience mode contract
 *
 * HYBRID      - Unauthenticated users may attempt login; normal flow applies.
 * PASSIVE     - System is read-only for new users. New login flows are blocked
 *               with user feedback. Existing authenticated sessions are unaffected.
 * SERVER_ONLY - Server operates in strict read-only fallback. ONLY interaction
 *               endpoints (fetchStats, getComments, getNested, getReplies) are allowed.
 *               ALL protected actions are blocked for both logged-in and anonymous users.
 * P2P_ONLY    - Server is reserved for authenticated users. Unauthenticated users
 *               cannot establish new sessions via the server. Uses NOSTR/TORRENT
 *               for signaling.
 *
 * ## External session mode (`login.queloraSession = false`)
 *
 * When the Quelora SDK is configured to delegate authentication to an external
 * provider (e.g. WordPress SSO), `protect()` bypasses the internal login modal
 * and instead redirects the browser to `login.loginUrl` with a `redirect_to`
 * query parameter pointing to the current page — including the URL hash anchor —
 * so the user is returned to the exact same location after authenticating.
 *
 * The `redirect_to` value is built from `window.location.href` at call-time
 * (not from a static config value) because the hash anchor that identifies the
 * specific comment or entity is only known in the browser at the moment of the
 * interaction.
 *
 * @version 4.1.0
 */
import handleLog from './logs.js';
import SessionModule from './session.js';
import ToastModule from '../ui/toast.js';
import I18n from './i18n.js';
import ConfModule from './conf.js';
import Anchor from '../ui/anchor.js';
import { eventBus } from './event.js';

/**
 * Optional context object that callers may pass to {@link GuardModule.protect}
 * to supply an explicit deep-link anchor for the external-login redirect.
 * When omitted, the Guard auto-detects the anchor from the active drawer state.
 *
 * @typedef  {Object}      RedirectContext
 * @property {Object}      anchor                 - Anchor descriptor forwarded to {@link Anchor.generateLink}.
 * @property {string}      anchor.type            - Link type: 'entity' | 'comment' | 'reply' | 'follower' | 'mention'.
 * @property {Object}      anchor.ids             - ID bag matching the chosen type.
 * @property {string}      [anchor.ids.entity]    - Entity ID.
 * @property {string}      [anchor.ids.commentId] - Comment ID.
 * @property {string}      [anchor.ids.replyId]   - Reply ID.
 * @property {string}      [anchor.ids.follow]    - Member ID for follower / profile links.
 * @property {string}      [anchor.ids.mention]   - Member ID for mention links.
 */

/** @constant {string} Module log icon — identifies Guard entries in the console. */
const LOG_ICON = '🛡️';

/**
 * Module-level cache for the current resilience mode.
 * Updated reactively whenever the Worker emits a RESILIENCE_MODE_CHANGED signal.
 * Defaults to HYBRID so no requests are blocked before bootstrap completes.
 *
 * @type {'HYBRID'|'PASSIVE'|'SERVER_ONLY'|'P2P_ONLY'}
 */
let _resilienceMode = 'HYBRID';

eventBus.on( 'RESILIENCE_MODE_CHANGED', ( payload ) => {
    const incoming = payload?.mode;
    if ( incoming && incoming !== _resilienceMode ) {
        _resilienceMode = incoming;
        handleLog( `Guard mode updated to: ${_resilienceMode}`, 'GuardModule', 'info', LOG_ICON );
    }
} );

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Displays a standardized toast for resilience-mode related blocks.
 *
 * @param {string} iconName - System icon name (ql-icons-outlined).
 * @param {string} titleKey - I18n key for the toast title.
 * @param {string} bodyKey  - I18n key for the toast body.
 * @returns {void}
 */
function _showModeToast( iconName, titleKey, bodyKey ) {
    ToastModule.show(
        `<span class="ql-icons-outlined">${iconName}</span>`,
        I18n.getTranslation( titleKey ),
        I18n.getTranslation( bodyKey ),
        null,
        3000,
        'warning'
    );
}

/**
 * Resolves the most contextually precise redirect URL for the current widget state.
 *
 * Evaluates a priority chain so the external login provider can return the
 * user to the exact point of interaction rather than to a generic page URL:
 *
 * 1. **Explicit anchor context** — the caller supplied an `anchor` descriptor
 *    via the `context` argument to {@link GuardModule.protect}. This is the
 *    highest-fidelity signal and always wins when present.
 * 2. **Active comments drawer** — queries the open drawer for an element
 *    carrying `data-threads-entity`. When found, generates a
 *    `#QUELORA-E-{entityId}` anchor so the widget reopens the thread.
 * 3. **Active profile drawer** — queries the open drawer for an element
 *    carrying `data-member-id`. When found, generates a
 *    `#QUELORA-U-{memberId}` anchor so the widget reopens that profile.
 * 4. **Existing QUELORA hash** — when the page URL already carries a
 *    `#QUELORA-*` anchor from a previous navigation, it is preserved as-is.
 * 5. **Raw fallback** — `window.location.href` (original behaviour).
 *
 * @param {RedirectContext|null} context - Optional context supplied by the caller.
 * @returns {string} The fully-qualified URL to use as `redirect_to`.
 */
function _resolveRedirectUrl( context ) {
    const baseUrl = window.location.href.split( '#' )[ 0 ];

    // ── Priority 1: explicit anchor from the caller ────────────────────────
    if ( context?.anchor ) {
        const hash = Anchor.generateLink( context.anchor );
        if ( hash && hash !== '#' ) {
            return baseUrl + hash;
        }
    }

    // ── Priority 2 & 3: inspect the currently open drawer ─────────────────
    const activeDrawerEl = document.querySelector( '.drawer.active' );
    if ( activeDrawerEl ) {

        // Comments drawer: the threads container carries data-threads-entity.
        const threadsEl = activeDrawerEl.querySelector( '[data-threads-entity]' );
        if ( threadsEl ) {
            const entityId = threadsEl.getAttribute( 'data-threads-entity' );
            if ( entityId ) {
                return baseUrl + Anchor.generateLink( { type: 'entity', ids: { entity: entityId } } );
            }
        }

        // Profile / member-profile drawer: the rendered profile card carries data-member-id.
        const memberEl = activeDrawerEl.querySelector( '[data-member-id]' );
        if ( memberEl ) {
            const memberId = memberEl.getAttribute( 'data-member-id' );
            if ( memberId ) {
                return baseUrl + Anchor.generateLink( { type: 'follower', ids: { follow: memberId } } );
            }
        }
    }

    // ── Priority 4: preserve an existing QUELORA anchor ───────────────────
    const currentHash = window.location.hash;
    if ( currentHash.startsWith( '#QUELORA-' ) ) {
        return baseUrl + currentHash;
    }

    // ── Priority 5: raw fallback ───────────────────────────────────────────
    return window.location.href;
}

/**
 * Redirects the browser to the external login page configured in
 * `login.loginUrl`, appending the most contextually precise URL available
 * as the `redirect_to` query parameter.
 *
 * The redirect target is resolved via {@link _resolveRedirectUrl}, which
 * inspects an explicit anchor context, the active drawer state, and finally
 * the raw `window.location.href` as a fallback — in that priority order.
 *
 * No-ops with an error log when `login.loginUrl` is not configured.
 *
 * @param {RedirectContext|null} [context=null] - Optional anchor context supplied by the caller.
 * @returns {void}
 */
function _redirectToExternalLogin( context = null ) {
    const loginUrl = /** @type {string} */ ( ConfModule.get( 'login.loginUrl', '' ) );

    if ( ! loginUrl ) {
        handleLog(
            'External session mode is active but login.loginUrl is not configured. Redirect aborted.',
            'GuardModule',
            'error',
            LOG_ICON
        );
        return;
    }

    const redirectTo  = encodeURIComponent( _resolveRedirectUrl( context ) );
    const separator   = loginUrl.includes( '?' ) ? '&' : '?';
    const destination = `${ loginUrl }${ separator }redirect_to=${ redirectTo }`;

    handleLog( `Redirecting to external login: ${ destination }`, 'GuardModule', 'info', LOG_ICON );

    window.location.href = destination;
}

// =============================================================================
// MODULE
// =============================================================================

const GuardModule = {
    /**
     * Returns the currently cached resilience mode.
     * Useful for external modules that need to read the mode without importing CoreModule.
     *
     * @returns {'HYBRID'|'PASSIVE'|'SERVER_ONLY'|'P2P_ONLY'}
     */
    getResilienceMode() {
        return _resilienceMode;
    },

    /**
     * Intercepts an action, ensuring the user is authenticated and that all
     * active guards pass before the callback is executed.
     *
     * ## Check order (fail-fast)
     *
     * 1. **L3 Circuit Breaker**  — System is fully offline; blocks all writes.
     * 2. **SERVER_ONLY mode**    — Strict read-only lockdown; blocks all guarded actions.
     * 3. **External session**    — `login.queloraSession` is `false`:
     *    - If the visitor already has an active external session, the callback
     *      executes immediately — no redirect needed.
     *    - Otherwise, the browser is redirected to `login.loginUrl` with a
     *      `redirect_to` parameter resolved by {@link _resolveRedirectUrl}:
     *      explicit `context.anchor` → active drawer state → existing QUELORA
     *      hash → raw `window.location.href`. The action is not executed; the
     *      user returns to the exact interaction point after authenticating.
     * 4. **PASSIVE mode gate**   — New login flows are blocked; existing sessions pass.
     * 5. **P2P_ONLY mode gate**  — New server-side sessions are blocked; existing pass.
     * 6. **Fast-path auth**      — Token already in memory; callback executes immediately.
     * 7. **Slow-path auth**      — Token refresh / internal login modal.
     *
     * @param {Function}              actionCallback - The function to execute when all guards pass.
     * @param {RedirectContext|null}  [context=null] - Optional anchor context for external-session
     *   redirects. When omitted the Guard auto-detects the anchor from the active drawer state.
     * @returns {Promise<void>}
     */
    async protect( actionCallback, context = null ) {
        if ( typeof actionCallback !== 'function' ) {
            handleLog( 'Guard protect expects a function', 'GuardModule', 'error', LOG_ICON );
            return;
        }

        try {
            const { default: CoreModule } = await import( './core.js' );

            // ── Guard 1: L3 system offline ────────────────────────────────────
            if ( CoreModule.isSystemOffline() ) {
                _showModeToast( 'cloud_off', 'offline', 'actionUnavailableOffline' );
                return;
            }

            // ── Guard 2: SERVER_ONLY strict lockdown ──────────────────────────
            if ( _resilienceMode === 'SERVER_ONLY' ) {
                _showModeToast( 'dns', 'systemLimited', 'actionUnavailableServerOnly' );
                return;
            }

            // ── Guard 3: External session mode ────────────────────────────────
            if ( ConfModule.get( 'login.queloraSession', true ) === false ) {
                if ( SessionModule.getTokenIfAvailable() ) {
                    return actionCallback();
                }
                _redirectToExternalLogin( context );
                return;
            }

            // ── Guard 4: PASSIVE mode — blocks new login flows ─────────────────
            if ( _resilienceMode === 'PASSIVE' && ! SessionModule.getTokenIfAvailable() ) {
                _showModeToast( 'lock', 'systemLimited', 'newSessionsDisabled' );
                return;
            }

            // ── Guard 5: P2P_ONLY mode — blocks new server-side sessions ───────
            if ( _resilienceMode === 'P2P_ONLY' && ! SessionModule.getTokenIfAvailable() ) {
                _showModeToast( 'devices', 'p2pOnlyMode', 'loginUnavailableP2P' );
                return;
            }

            // ── Guard 6: Fast-path — token already in memory ───────────────────
            if ( SessionModule.getTokenIfAvailable() ) {
                return actionCallback();
            }

            // ── Guard 7: Slow-path — token refresh / internal login modal ──────
            const token = await CoreModule.getTokenIfNeeded( null, false );

            if ( token ) {
                return actionCallback();
            }

        } catch ( error ) {
            handleLog( error, 'GuardModule.protect', 'error', LOG_ICON, error );
        }
    }
};

export default GuardModule;