/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/session.js */
/**
 * @module Core/Session
 * @description Manages user authentication, token storage, and session lifecycle.
 *
 * Supported identity providers: Quelora (email/password), Google, Facebook, Apple.
 * Credentials are AES-GCM encrypted before transit for the Quelora provider.
 * Social providers receive an opaque credential token that the backend exchanges
 * server-side via each provider's token-inspection endpoint.
 *
 * ## External session mode (`login.queloraSession = false`)
 *
 * When the Quelora SDK is configured to delegate authentication to an external
 * provider (e.g. WordPress SSO), the internal authentication circuit is bypassed:
 *
 * - `createModal()` — Becomes a no-op. The Guard module is responsible for
 *   redirecting unauthenticated users to the external login page; the internal
 *   modal must never appear in external-session mode.
 *
 * - `mountDrawerLogin(selector)` — Renders a minimal external-session CTA in
 *   place of the native login form. The CTA contains a single button that
 *   navigates to `login.loginUrl` with `redirect_to=<current href>`, and an
 *   optional `ExternalLink` to `login.logoutUrl` for authenticated users who
 *   want to sign out.
 *
 * - `logout()` — Executes the standard four-phase atomic sequence (token
 *   revocation, Worker L1 purge, storage clearance, EventBus notification) and
 *   then — as a fifth phase — navigates the browser to `login.logoutUrl` so
 *   that the external provider's session cookie is also invalidated.
 *   Falls back to a page reload when `logoutUrl` is not configured, ensuring
 *   the PHP `inject_sso_token` script can clear storage on the next load.
 *
 * ## Logout sequence (atomic, 5 phases in external-session mode)
 *
 *   1. Capture the active token before any state mutation.
 *   2. Signal the backend to revoke the token (fire-and-forget).
 *   3. Signal the Worker to purge the IndexedDB L1 cache.
 *   4. Clear all storage keys and in-memory state.
 *   5. Emit SESSION_CLEARED on the EventBus.
 *  [6. External session only] Navigate to `login.logoutUrl`.
 *
 * @version 2.4.0
 */
import handleLog from './logs.js';
import I18n from './i18n.js';
import StorageModule from './storage.js';
import ConfModule from './conf.js';
import UtilsModule from './utils.js';
import CaptchaModule from '../services/captcha.js';
import UiModule from '../ui/ui.js';
import CoreModule from './core.js';
import { eventBus } from './event.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Configuration values resolved lazily via accessor functions to ensure that
 * any runtime call to ConfModule.updateConfig() is always reflected here.
 * This avoids the frozen-at-import-time anti-pattern.
 *
 * @returns {SessionConstants}
 */
const getConstants = () => ( {
    POLL_INTERVAL: ConfModule.get( 'pollInterval', 2000 ),
    TIMEOUT:       ConfModule.get( 'timeout', 120000 ),
    URLS: {
        BACKEND_LOGIN:   ConfModule.get( 'login.baseUrl', '' ),
        RENEW_TOKEN:     ConfModule.get( 'apiUrl' ) ? `${ ConfModule.get( 'apiUrl' ) }/login/renew-token`  : '',
        REVOKE_TOKEN:    ConfModule.get( 'apiUrl' ) ? `${ ConfModule.get( 'apiUrl' ) }/login/revoke-token` : '',
        REDIRECT_ORIGIN: window.location.origin + '/'
    },
    PROVIDERS: {
        GOOGLE:   ConfModule.get( 'login.providerDetails.Google.clientId',   '' ),
        FACEBOOK: ConfModule.get( 'login.providerDetails.Facebook.appId',    '' ),
        APPLE:    ConfModule.get( 'login.providerDetails.Apple.clientId',    '' ),
        X:        ConfModule.get( 'login.providerDetails.X.clientId',        '' )
    },
    CLIENT_ID: ConfModule.get( 'cid', '' )
} );

// =============================================================================
// MODULE STATE
// =============================================================================

/**
 * @typedef {Object} SessionState
 * @property {HTMLElement|null} modal               - Active login modal element.
 * @property {Function[]}       pendingCallbacks     - Queued resolvers waiting for a token.
 * @property {string|null}      token                - In-memory token cache.
 * @property {boolean}          isModalOpen          - Whether the login modal is mounted.
 * @property {boolean}          isLoggingOut         - Reentrance guard for logout.
 * @property {Object}           scriptsLoaded        - Per-provider SDK load flags.
 * @property {Object}           currentLoginProcess  - Handles for the active timeout/interval.
 * @property {number}           loginAttempts        - Failed attempt counter for rate limiting.
 * @property {number}           loginLockedUntil     - Epoch ms timestamp of lockout expiry.
 */

/** @type {SessionState} */
const STATE = {
    modal:              null,
    pendingCallbacks:   [],
    token:              null,
    isModalOpen:        false,
    isLoggingOut:       false,
    scriptsLoaded: {
        google:   false,
        facebook: false,
        apple:    false
    },
    currentLoginProcess: {
        timeout:  null,
        interval: null
    },
    loginAttempts:   0,
    loginLockedUntil: 0
};

// =============================================================================
// DOM UTILITIES
// =============================================================================

/**
 * @typedef {Object} FormElementIds
 * @property {string} email       - Email input element ID.
 * @property {string} password    - Password input element ID.
 * @property {string} submit      - Submit button element ID.
 * @property {string} googleBtn   - Google sign-in container element ID.
 * @property {string} fbBtn       - Facebook sign-in container element ID.
 * @property {string} appleBtn    - Apple sign-in container element ID.
 * @property {string} xBtn        - X (Twitter) sign-in container element ID.
 * @property {string} signupLink  - Sign-up anchor element ID.
 * @property {string} forgotLink  - Forgot-password anchor element ID.
 */

const DomUtils = {
    /**
     * Returns element IDs for either the modal or drawer login form.
     *
     * @param {boolean} isDrawer - When true, returns drawer-scoped IDs.
     * @returns {FormElementIds}
     */
    getIds: ( isDrawer ) => ( {
        email:      isDrawer ? 'ql-drawer-email-input'    : 'ql-email-input',
        password:   isDrawer ? 'ql-drawer-password-input' : 'ql-password-input',
        submit:     isDrawer ? 'ql-drawer-login-button'   : 'ql-login-button',
        googleBtn:  isDrawer ? 'google-sign-in-drawer'    : 'google-sign-in-button',
        fbBtn:      isDrawer ? 'facebook-sign-in-drawer'  : 'facebook-sign-in-button',
        appleBtn:   isDrawer ? 'apple-sign-in-drawer'     : 'apple-sign-in-button',
        xBtn:       isDrawer ? 'x-sign-in-drawer'         : 'x-sign-in-button',
        signupLink: isDrawer ? 'ql-drawer-signup-link'    : 'ql-signup-link',
        forgotLink: isDrawer ? 'ql-drawer-forgot-link'    : 'ql-forgot-link'
    } ),

    /**
     * Filters a flat list of class tokens, removing any empty or non-string values.
     *
     * @param {...(string|string[])} classes - Class names or nested arrays of class names.
     * @returns {string[]} Sanitized list of non-empty string class tokens.
     */
    safeClass: ( ...classes ) =>
        classes.flat().filter( ( c ) => c && typeof c === 'string' && c.trim() !== '' )
};

// =============================================================================
// CRYPTO SERVICE
// =============================================================================

/**
 * Provides AES-GCM encryption for Quelora-provider credentials and PKCE
 * code-challenge generation for OAuth flows.
 */
const CryptoService = {
    /**
     * Encrypts a credential object with AES-GCM using the configured client ID as
     * the PBKDF2 secret. Salt and IV are prepended to the ciphertext and the whole
     * payload is returned as URL-safe Base64.
     *
     * @param {Object} credentials - Plain-object credential payload.
     * @returns {Promise<string>} URL-safe Base64 encoded ciphertext.
     * @throws {Error} When encryption fails.
     */
    encrypt: async ( credentials ) => {
        try {
            const { CLIENT_ID } = getConstants();
            const encoder       = new TextEncoder();
            const iv            = crypto.getRandomValues( new Uint8Array( 12 ) );
            const salt          = crypto.getRandomValues( new Uint8Array( 16 ) );
            const key           = await CryptoService.deriveKey( CLIENT_ID, salt );

            const encryptedWithTag = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv },
                key,
                encoder.encode( JSON.stringify( credentials ) )
            );

            const combined = new Uint8Array( 16 + 12 + encryptedWithTag.byteLength );
            combined.set( salt, 0 );
            combined.set( iv, 16 );
            combined.set( new Uint8Array( encryptedWithTag ), 28 );

            return btoa( String.fromCharCode( ...combined ) )
                .replace( /\+/g, '-' )
                .replace( /\//g, '_' )
                .replace( /=+$/, '' );
        } catch ( e ) {
            handleLog( e, 'Session:Crypto', 'error', '🏠' );
            throw e;
        }
    },

    /**
     * Derives an AES-GCM CryptoKey from a plain-text secret using PBKDF2
     * (100 000 iterations, SHA-256).
     *
     * @param {string}     text - Key material (the client ID).
     * @param {Uint8Array} salt - Cryptographic salt (16 bytes).
     * @returns {Promise<CryptoKey>}
     */
    deriveKey: async ( text, salt ) => {
        const encoder     = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            encoder.encode( text ),
            { name: 'PBKDF2' },
            false,
            [ 'deriveBits', 'deriveKey' ]
        );

        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            [ 'encrypt', 'decrypt' ]
        );
    },

    /**
     * Generates a PKCE (Proof Key for Code Exchange) code-verifier / challenge pair.
     * The verifier is a 56-character hex string; the challenge is its SHA-256 digest
     * encoded as URL-safe Base64.
     *
     * @returns {Promise<{verifier: string, challenge: string}>}
     */
    generatePKCE: async () => {
        const array    = new Uint32Array( 28 );
        crypto.getRandomValues( array );
        const verifier  = Array.from( array, ( dec ) => ( '0' + dec.toString( 16 ) ).slice( -2 ) ).join( '' );
        const encoder   = new TextEncoder();
        const digest    = await crypto.subtle.digest( 'SHA-256', encoder.encode( verifier ) );
        const challenge = btoa( String.fromCharCode( ...new Uint8Array( digest ) ) )
            .replace( /\+/g, '-' )
            .replace( /\//g, '_' )
            .replace( /=+$/, '' );

        return { verifier, challenge };
    }
};

// =============================================================================
// UI BUILDER
// =============================================================================

/**
 * Constructs login form DOM fragments and error display helpers.
 */
const UiBuilder = {
    /**
     * Builds the full provider form DOM tree for the given context.
     *
     * @param {boolean} isDrawer - When true, renders the drawer-scoped variant.
     * @returns {HTMLElement} Wrapper element containing the form and provider buttons.
     */
    createForm: ( isDrawer ) => {
        const ids                = DomUtils.getIds( isDrawer );
        const wrapper            = document.createElement( 'div' );
        const providersContainer = UiModule.createElementUI( {
            tag:     'div',
            classes: DomUtils.safeClass( 'ql-providers-container' )
        } );

        let availableProviders = ConfModule.get( 'login.providers', [] );
        if ( ! Array.isArray( availableProviders ) ) availableProviders = [];

        if ( availableProviders.includes( 'Quelora' ) ) {
            const form       = UiModule.createElementUI( { tag: 'div', classes: DomUtils.safeClass( 'ql-form-container' ) } );
            const emailGroup = UiModule.createElementUI( { tag: 'div', classes: DomUtils.safeClass( 'ql-form-group' ) } );

            emailGroup.appendChild( UiModule.createElementUI( {
                tag:        'input',
                attributes: { type: 'email', id: ids.email, placeholder: I18n.getTranslation( 'userEmail' ), required: 'true' }
            } ) );

            const passGroup = UiModule.createElementUI( { tag: 'div', classes: DomUtils.safeClass( 'ql-form-group' ) } );

            passGroup.appendChild( UiModule.createElementUI( {
                tag:        'input',
                attributes: { type: 'password', id: ids.password, placeholder: I18n.getTranslation( 'password' ), required: 'true' }
            } ) );

            const forgotContainer = UiModule.createElementUI( { tag: 'div', styles: { textAlign: 'right', marginTop: '8px' } } );
            forgotContainer.appendChild( UiModule.createElementUI( {
                tag:        'a',
                classes:    [ 't' ],
                attributes: { href: '#', id: ids.forgotLink },
                styles:     { fontSize: '12px', color: 'var(--ql-light-gray-color)', textDecoration: 'none' },
                content:    '{{forgotPassword}}'
            } ) );
            passGroup.appendChild( forgotContainer );

            const submitBtn = UiModule.createElementUI( {
                tag:        'button',
                attributes: { id: ids.submit },
                classes:    DomUtils.safeClass( 'ql-provider-button-submit' )
            } );
            submitBtn.appendChild( UiModule.createElementUI( { tag: 'span', classes: [ 't' ], content: '{{login}}' } ) );
            form.append( emailGroup, passGroup, submitBtn );
            providersContainer.appendChild( form );
            providersContainer.appendChild(
                UiModule.createElementUI( { tag: 'div', classes: DomUtils.safeClass( 'ql-separator', 't' ), content: '{{or}}' } )
            );
        }

        if ( availableProviders.includes( 'Google' ) && getConstants().PROVIDERS.GOOGLE ) {
            providersContainer.appendChild( UiModule.createElementUI( {
                tag:        'div',
                attributes: { id: ids.googleBtn },
                classes:    DomUtils.safeClass( 'ql-provider-button', 'google' )
            } ) );
        }

        if ( availableProviders.includes( 'Facebook' ) && getConstants().PROVIDERS.FACEBOOK ) {
            const fbBtn = UiModule.createElementUI( {
                tag:        'div',
                attributes: { id: ids.fbBtn },
                classes:    DomUtils.safeClass( 'ql-provider-button', 'facebook' )
            } );
            fbBtn.innerHTML = `<button class="fb-login-button"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="white" d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z"/></svg><span>Sign in with Facebook</span></button>`;
            providersContainer.appendChild( fbBtn );
        }

        if ( availableProviders.includes( 'Apple' ) && getConstants().PROVIDERS.APPLE ) {
            providersContainer.appendChild( UiModule.createElementUI( {
                tag:        'div',
                attributes: { id: ids.appleBtn },
                classes:    DomUtils.safeClass( 'ql-provider-button', 'apple' )
            } ) );
        }

        const registerContainer = UiModule.createElementUI( {
            tag:     'div',
            classes: DomUtils.safeClass( 'ql-register-link-container' )
        } );
        registerContainer.append(
            UiModule.createElementUI( { tag: 'span', classes: [ 't' ], content: '{{dontHaveAccount}}' } ),
            document.createTextNode( ' ' ),
            UiModule.createElementUI( { tag: 'a', classes: [ 't' ], attributes: { href: '#', id: ids.signupLink }, content: '{{signUp}}' } )
        );

        wrapper.append( providersContainer, registerContainer );
        return wrapper;
    },

    /**
     * Builds a minimal external-session CTA to be rendered inside the
     * drawer login container when `login.queloraSession` is `false`.
     *
     * Authentication state is determined by whether a valid Quelora token
     * exists in storage — the same source of truth the rest of the SDK uses.
     * No separate `isLoggedIn` flag is needed.
     *
     * The CTA contains:
     * - A login button (unauthenticated) that navigates to `login.loginUrl`
     *   with `redirect_to=<current href>` appended at click-time, so the
     *   URL hash anchor is always preserved.
     * - A logout link (authenticated) that navigates to `login.logoutUrl`
     *   so the external provider's session is invalidated.
     *
     * @returns {HTMLElement} Wrapper element containing the external-session CTA.
     */
    createExternalSessionCTA: () => {
        const loginUrl  = /** @type {string} */ ( ConfModule.get( 'login.loginUrl',  '' ) );
        const logoutUrl = /** @type {string} */ ( ConfModule.get( 'login.logoutUrl', '' ) );
        const hasToken  = !! SessionModule.getTokenIfAvailable();

        const wrapper = UiModule.createElementUI( {
            tag:     'div',
            classes: DomUtils.safeClass( 'ql-external-session-cta' )
        } );

        if ( ! hasToken && loginUrl ) {
            const loginBtn = UiModule.createElementUI( {
                tag:     'button',
                classes: DomUtils.safeClass( 'ql-provider-button-submit' )
            } );
            loginBtn.appendChild(
                UiModule.createElementUI( { tag: 'span', classes: [ 't' ], content: '{{login}}' } )
            );
            loginBtn.addEventListener( 'click', () => {
                const separator  = loginUrl.includes( '?' ) ? '&' : '?';
                const redirectTo = encodeURIComponent( window.location.href );
                window.location.href = `${ loginUrl }${ separator }redirect_to=${ redirectTo }`;
            } );
            wrapper.appendChild( loginBtn );
        }

        if ( hasToken && logoutUrl ) {
            const logoutLink = UiModule.createElementUI( {
                tag:        'a',
                classes:    DomUtils.safeClass( 'ql-external-logout-link', 't' ),
                attributes: { href: logoutUrl },
                content:    '{{logout}}'
            } );
            wrapper.appendChild( logoutLink );
        }

        return wrapper;
    },

    /**
     * Renders an error message inside the login form container.
     * Creates the error node on first call; replaces its content on subsequent calls.
     *
     * @param {HTMLElement|null} container - The form container element.
     * @param {string}           message   - I18n key token or raw message string.
     * @returns {void}
     */
    displayError: ( container, message ) => {
        if ( ! container ) return;
        let errorContainer = container.querySelector( '.ql-login-error' );
        if ( ! errorContainer ) {
            errorContainer = UiModule.createElementUI( { tag: 'div', classes: DomUtils.safeClass( 'ql-login-error' ) } );
            ( container.querySelector( '.ql-form-container' ) ?? container ).appendChild( errorContainer );
        }
        errorContainer.replaceChildren(
            UiModule.createElementUI( { tag: 'span', classes: [ 't' ], content: message } )
        );
    }
};

// =============================================================================
// AUTH SERVICE
// =============================================================================

/**
 * Handles third-party SDK loading, provider initialisation, and the core
 * credential exchange with the backend.
 */
const AuthService = {
    /**
     * Lazily injects third-party SDK scripts for enabled providers.
     * Each script is appended at most once, guarded by the corresponding
     * `STATE.scriptsLoaded` flag.
     *
     * Apple Sign In with Apple JS is initialised immediately after load
     * via {@link AuthService.initApple}.
     *
     * @returns {void}
     */
    loadScripts: () => {
        const { PROVIDERS } = getConstants();

        if ( ! STATE.scriptsLoaded.google && PROVIDERS.GOOGLE ) {
            const s = document.createElement( 'script' );
            Object.assign( s, { src: 'https://accounts.google.com/gsi/client', async: true, defer: true } );
            s.onload = () => {
                STATE.scriptsLoaded.google = true;
                AuthService.initProviders( document.body );
            };
            document.body.appendChild( s );
        }

        if ( ! STATE.scriptsLoaded.facebook && PROVIDERS.FACEBOOK ) {
            const s = document.createElement( 'script' );
            Object.assign( s, { src: 'https://connect.facebook.net/en_US/sdk.js', async: true, defer: true } );
            s.onload = () => {
                window.FB.init( { appId: PROVIDERS.FACEBOOK, cookie: true, xfbml: true, version: 'v18.0' } );
                STATE.scriptsLoaded.facebook = true;
            };
            document.body.appendChild( s );
        }

        if ( ! STATE.scriptsLoaded.apple && PROVIDERS.APPLE ) {
            const s = document.createElement( 'script' );
            Object.assign( s, {
                src:   'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js',
                async: true,
                defer: true
            } );
            s.onload = () => {
                STATE.scriptsLoaded.apple = true;
                AuthService.initApple();
            };
            document.body.appendChild( s );
        }
    },

    /**
     * Configures the Apple Sign In with Apple JS SDK.
     * Must be called after the SDK script has loaded.
     * Uses the popup flow so no server-side redirect handling is required.
     *
     * @returns {void}
     */
    initApple: () => {
        const { PROVIDERS, URLS } = getConstants();
        if ( ! window.AppleID?.auth || ! PROVIDERS.APPLE ) return;

        try {
            window.AppleID.auth.init( {
                clientId:    PROVIDERS.APPLE,
                scope:       'name email',
                redirectURI: URLS.REDIRECT_ORIGIN,
                usePopup:    true
            } );
        } catch ( e ) {
            handleLog( `Apple Sign In init failed: ${ e.message }`, 'Session:Auth', 'warn', '🏠' );
        }
    },

    /**
     * Initialises Google Identity Services for all `.ql-provider-button.google`
     * elements found within the given container.
     *
     * @param {HTMLElement|Document} [container=document] - Scope for button discovery.
     * @returns {void}
     */
    initProviders: ( container = document ) => {
        const { PROVIDERS } = getConstants();
        if ( ! window.google?.accounts?.id || ! PROVIDERS.GOOGLE ) return;

        try {
            window.google.accounts.id.initialize( {
                client_id:   PROVIDERS.GOOGLE,
                callback:    ( r ) => AuthService.handleCredentialResponse( r, 'google', container )
                    .catch( ( e ) => {
                        handleLog( e, 'Session:Auth', 'error', '🏠' );
                        // auth_error sentinel: the error message was already rendered in the
                        // container by the responseHandler; do not close the modal.
                        if ( ! e.message.startsWith( 'auth_error:' ) ) {
                            SessionModule.handleError( false, container );
                        }
                    } ),
                ux_mode:     'popup',
                auto_select: false,
                context:     'signin'
            } );
            container.querySelectorAll( '.ql-provider-button.google' ).forEach( ( btn ) => {
                if ( btn.id ) {
                    window.google.accounts.id.renderButton(
                        document.getElementById( btn.id ),
                        { theme: 'filled_blue', size: 'large', width: '300', text: 'signin_with', type: 'standard' }
                    );
                }
            } );
        } catch ( e ) {
            handleLog( `Google Identity Services init failed: ${ e.message }`, 'Session:Auth', 'warn', '🏠' );
        }
    },

    /**
     * Submits a credential payload to the backend authentication endpoint via
     * the shared Worker and resolves with the issued token on success.
     *
     * Rate limiting is applied client-side: after 5 consecutive failures the
     * form is locked for 30 seconds. The lockout is stored in STATE and resets
     * on a successful login.
     *
     * @param {Object}          credentials      - Credential payload (varies by provider).
     * @param {HTMLElement|null} container        - Form container for error display.
     * @param {boolean}         [isSocial=false]  - When true, the payload is forwarded
     *   as-is without Quelora-provider encryption.
     * @returns {Promise<string>} The issued session token.
     */
    login: async ( credentials, container, isSocial = false ) => {
        if ( Date.now() < STATE.loginLockedUntil ) {
            const remainingSeconds = Math.ceil( ( STATE.loginLockedUntil - Date.now() ) / 1000 );
            UiBuilder.displayError( container, `{{rateLimitExceeded}} (${ remainingSeconds }s)` );
            return Promise.reject( new Error( 'Login rate limit active' ) );
        }

        const { URLS } = getConstants();

        try {
            const headers = { 'Content-Type': 'application/json' };
            let body      = {};

            if ( isSocial ) {
                body = credentials;
            } else {
                if ( CaptchaModule.isEnabled() ) {
                    headers[ 'X-Captcha-Token' ] = await CaptchaModule.getToken();
                }
                const encrypted = await CryptoService.encrypt( credentials );
                body = { provider: 'quelora', credential: encrypted };
            }

            return await new Promise( ( resolve, reject ) => {
                const responseEvent = 'auth_login_complete';

                const responseHandler = ( envelope ) => {
                    eventBus.off( responseEvent, responseHandler );
                    const payload = envelope.payload || envelope;

                    if ( payload.status === 'error' || payload.error || ( payload.status && payload.status >= 400 ) ) {
                        const msg = payload.error || payload.message || 'Authentication failed';

                        STATE.loginAttempts++;
                        if ( STATE.loginAttempts >= 5 ) {
                            STATE.loginLockedUntil = Date.now() + 30000;
                            STATE.loginAttempts    = 0;
                        }

                    if ( payload.status === 401 || msg.includes( 'Invalid credentials' ) ) {
                            reject( new Error( 'Invalid credentials' ) );
                            UiBuilder.displayError( container, '{{invalidCredentials}}' );
                        } else {
                            // Map the structured error_code from the backend to a stable i18n key.
                            // Falls back to the raw server message only when no code is present,
                            // which preserves compatibility with non-standard or legacy endpoints.
                            // The modal is intentionally kept open so the user can retry.
                            // reject() is called before displayError() so that any exception thrown
                            // during DOM rendering (caught and swallowed by EventBus.emit) cannot
                            // leave the Promise permanently pending and the spinner stuck.
                            const errorCode  = payload.error_code || '';
                            const I18N_MAP   = { SSO_VERIFICATION_FAILED: '{{ssoVerificationFailed}}' };
                            const i18nKey    = I18N_MAP[ errorCode ];
                            reject( new Error( `auth_error: ${ msg }` ) );
                            UiBuilder.displayError( container, i18nKey || msg );
                        }
                        return;
                    }

                    if ( payload.token ) {
                        STATE.loginAttempts = 0;
                        SessionModule.resolveSuccess( payload.token, payload.expires_in || 3600 )
                            .then( ( token ) => resolve( token ) )
                            .catch( ( err ) => reject( err ) );
                    } else {
                        handleLog( 'Token missing in login payload', 'Session:Auth', 'error', '🏠' );
                        reject( new Error( 'No token returned from worker' ) );
                    }
                };

                eventBus.on( responseEvent, responseHandler );

                CoreModule.postWorkerMessage( {
                    action:  'fetchProxy',
                    payload: {
                        endpoint:       isSocial ? URLS.BACKEND_LOGIN : ConfModule.get( 'login.baseUrl' ),
                        method:         'POST',
                        headers,
                        body,
                        responseAction: responseEvent,
                        errorAction:    responseEvent,
                        skipRetries:    true
                    }
                } );
            } );
        } catch ( e ) {
            // auth_error sentinel: the responseHandler already displayed the server message
            // and the modal must remain open for the user to retry. All other unexpected
            // failures (network errors, crypto exceptions, etc.) are genuine infrastructure
            // faults and warrant a full error teardown via handleError.
            const isAuthRejection = e.message === 'Invalid credentials'
                || e.message === 'Login rate limit active'
                || e.message.startsWith( 'auth_error:' );

            if ( ! isAuthRejection ) {
                SessionModule.handleError( false, container );
            }
            throw e;
        }
    },

    /**
     * Handles an incoming Google Identity Services credential response by
     * delegating to {@link AuthService.login} with the social flag set.
     *
     * @param {{credential: string}} response  - Google credential response object.
     * @param {string}               provider  - Provider identifier string.
     * @param {HTMLElement|null}     container - Form container for error display.
     * @returns {Promise<string>} The issued session token.
     */
    handleCredentialResponse: async ( response, provider, container ) => {
        if ( ! response?.credential ) throw new Error( 'Invalid credential' );
        return AuthService.login( { credential: response.credential, provider }, container, true );
    },

    /**
     * Initiates the Apple Sign In with Apple popup flow.
     * On success, forwards the id_token to the backend via {@link AuthService.login}.
     * User-cancelled popups are silently absorbed; all other errors surface to the
     * form via {@link SessionModule.handleError}.
     *
     * @param {HTMLElement|null} container - Form container for error display.
     * @returns {Promise<void>}
     */
    signInWithApple: async ( container ) => {
        if ( ! window.AppleID?.auth ) {
            handleLog( 'Apple Sign In SDK not loaded.', 'Session:Apple', 'warn', '🏠' );
            UiBuilder.displayError( container, '{{providerUnavailable}}' );
            return;
        }

        try {
            const data    = await window.AppleID.auth.signIn();
            const idToken = data?.authorization?.id_token;

            if ( ! idToken ) {
                throw new Error( 'Apple Sign In did not return an id_token.' );
            }

            await AuthService.login( { credential: idToken, provider: 'apple' }, container, true );
        } catch ( e ) {
            if ( e?.error === 'popup_closed_by_user' || e?.error === 'user_cancelled_authorize' ) {
                return;
            }
            handleLog( e, 'Session:Apple', 'error', '🏠' );
            SessionModule.handleError( false, container );
        }
    }
};

// =============================================================================
// SESSION MODULE
// =============================================================================

/**
 * @typedef {Object} TokenResponse
 * @property {string}  token    - Issued session token.
 * @property {boolean} isCached - Whether the token was read from storage.
 * @property {string}  source   - One of 'localStorage' | 'sessionStorage' | 'new_auth'.
 */

const SessionModule = {
    /**
     * Cancels any in-progress login timeout and polling interval.
     *
     * @returns {void}
     */
    clearLoginTimers: () => {
        if ( STATE.currentLoginProcess.timeout ) {
            UtilsModule.cancelTimeout( STATE.currentLoginProcess.timeout );
            STATE.currentLoginProcess.timeout = null;
        }
        if ( STATE.currentLoginProcess.interval ) {
            clearInterval( STATE.currentLoginProcess.interval );
            STATE.currentLoginProcess.interval = null;
        }
    },

    /**
     * Keyboard handler that closes the login modal when Escape is pressed.
     *
     * @param {KeyboardEvent} e
     * @returns {void}
     */
    handleEscKey: ( e ) => {
        if ( e.key === 'Escape' ) {
            e.preventDefault();
            SessionModule.closeModal( true );
        }
    },

    /**
     * Returns an active token from storage when one exists and has not expired,
     * or opens the login modal to acquire one.
     *
     * In external-session mode (`login.queloraSession = false`) the modal is
     * never opened — the Guard module handles the redirect to the external login
     * page before this method would be called without a valid token. This method
     * remains a passive token reader in that mode.
     *
     * @param {boolean} [silent=false] - When true, returns null instead of opening the modal.
     * @param {boolean} [force=false]  - When true, ignores cached tokens and forces re-authentication.
     * @returns {Promise<TokenResponse|null>}
     */
    getToken: async ( silent = false, force = false ) => {
        if ( STATE.isLoggingOut ) return null;

        if ( STATE.isModalOpen ) {
            return new Promise( ( resolve ) => STATE.pendingCallbacks.push( ( r ) => resolve( r || null ) ) );
        }

        const local   = StorageModule.getLocalItem( 'ql_sso_token' );
        const session = StorageModule.getSessionItem( 'ql_sso_token' );
        const token   = local || session;
        const expires = StorageModule.getLocalItem( 'ql_sso_token_expires' )
            || StorageModule.getSessionItem( 'ql_sso_token_expires' );

        if ( token && expires && Date.now() < parseInt( expires ) && ! force ) {
            return { token, isCached: true, source: local ? 'localStorage' : 'sessionStorage' };
        }

        if ( silent ) return null;

        SessionModule.clearLoginTimers();
        STATE.isModalOpen = true;
        SessionModule.createModal();
        AuthService.loadScripts();

        return new Promise( ( resolve, reject ) => {
            const { POLL_INTERVAL, TIMEOUT, PROVIDERS } = getConstants();

            STATE.currentLoginProcess.timeout = UtilsModule.startTimeout( () => {
                SessionModule.closeModal( true );
                reject( new Error( 'Login timeout' ) );
            }, TIMEOUT );

            STATE.currentLoginProcess.interval = setInterval( () => {
                const googleReady   = ! PROVIDERS.GOOGLE   || window.google?.accounts?.id;
                const facebookReady = ! PROVIDERS.FACEBOOK || window.FB;
                const appleReady    = ! PROVIDERS.APPLE    || window.AppleID?.auth;
                if ( googleReady && facebookReady && appleReady ) {
                    clearInterval( STATE.currentLoginProcess.interval );
                    AuthService.initProviders( STATE.modal );
                    AuthService.initApple();
                }
            }, POLL_INTERVAL );

            STATE.pendingCallbacks.push( ( response ) => {
                SessionModule.clearLoginTimers();
                response?.token ? resolve( response ) : reject( new Error( 'Login failed or cancelled' ) );
            } );
        } );
    },

    /**
     * Returns the current token from memory or storage without triggering a login flow.
     * Validates expiry unless `ignoreExpiry` is true.
     *
     * @param {string|null} [existingToken=null] - Optional token to return directly if present.
     * @param {boolean}     [ignoreExpiry=false] - When true, skips the expiry check.
     * @returns {string|null} The token string or null.
     */
    getTokenIfAvailable: ( existingToken = null, ignoreExpiry = false ) => {
        if ( STATE.token ) return STATE.token;
        const token = StorageModule.getLocalItem( 'ql_sso_token' )
            || StorageModule.getSessionItem( 'ql_sso_token' );
        if ( ignoreExpiry ) return token;
        const exp = StorageModule.getLocalItem( 'ql_sso_token_expires' )
            || StorageModule.getSessionItem( 'ql_sso_token_expires' );
        return ( token && exp && Date.now() < parseInt( exp ) ) ? token : null;
    },

    /**
     * Promotes a sessionStorage token to localStorage to persist it across browser tabs.
     * Intended to be called when the user opts in to "Remember me".
     *
     * @returns {boolean} True if the promotion succeeded.
     */
    rememberSession: () => {
        const token   = StorageModule.getSessionItem( 'ql_sso_token' );
        const expires = StorageModule.getSessionItem( 'ql_sso_token_expires' );
        if ( token && expires ) {
            StorageModule.setLocalItem( 'ql_sso_token', token );
            StorageModule.setLocalItem( 'ql_sso_token_expires', expires );
            return true;
        }
        return false;
    },

    /**
     * Convenience wrapper for initiating a Quelora-provider login from outside the
     * standard modal flow (e.g. from a custom form).
     *
     * @param {string}          username   - User email address.
     * @param {string}          password   - User password.
     * @param {HTMLElement|null} btnElement - Submit button to toggle loading state on.
     * @param {HTMLElement|null} container  - Form container for error display.
     * @returns {Promise<void>}
     */
    performLogin: async ( username, password, btnElement, container ) => {
        try {
            if ( btnElement ) {
                btnElement.classList.add( 'loading' );
                btnElement.disabled = true;
            }
            await AuthService.login( { username, password }, container );
        } finally {
            if ( btnElement ) {
                btnElement.classList.remove( 'loading' );
                btnElement.disabled = false;
            }
        }
    },

    /**
     * Persists a newly issued token to sessionStorage, resets the in-memory cache,
     * and notifies all pending callbacks and the EventBus.
     *
     * @param {string} newToken  - The freshly issued session token.
     * @param {number} expiresIn - Token lifetime in seconds.
     * @returns {Promise<string>} The token, passed through for chaining.
     */
    resolveSuccess: async ( newToken, expiresIn ) => {
        STATE.token = newToken;
        StorageModule.setSessionItem( 'ql_sso_token', newToken );
        StorageModule.setSessionItem( 'ql_sso_token_expires', ( Date.now() + expiresIn * 1000 ).toString() );
        StorageModule.removeLocalItem( 'ql_guest_id' );

        const pendingCount        = STATE.pendingCallbacks.length;
        const isInterruptedAction = pendingCount > 0;

        eventBus.emit( 'SESSION_ESTABLISHED', {
            token:      newToken,
            isNewLogin: ! isInterruptedAction
        } );

        const cbs               = [ ...STATE.pendingCallbacks ];
        STATE.pendingCallbacks  = [];
        cbs.forEach( ( cb ) => {
            try { cb( { token: newToken, isCached: false, source: 'new_auth' } ); }
            catch ( e ) { handleLog( e, 'Session:Callback', 'error', '🏠' ); }
        } );

        SessionModule.closeModal();
        return newToken;
    },

    /**
     * Rejects all pending callbacks and optionally closes the modal.
     *
     * @param {boolean}         [keepModal=false] - When true, the modal remains open.
     * @param {HTMLElement|null} container        - Form container for error display.
     * @returns {void}
     */
    handleError: ( keepModal = false, container ) => {
        const cbs               = [ ...STATE.pendingCallbacks ];
        STATE.pendingCallbacks  = [];
        cbs.forEach( ( cb ) => cb( null ) );
        if ( container ) UiBuilder.displayError( container, '{{error}}' );
        if ( ! keepModal && STATE.isModalOpen ) SessionModule.closeModal( true );
    },

    /**
     * Executes an atomic logout sequence.
     *
     * ### Internal session mode (default)
     *
     * Four phases:
     *  1. Token revocation: fire-and-forget backend revocation request.
     *  2. Worker L1 purge: clears the IndexedDB `own_profile_signed` store.
     *  3. Storage clearance: removes all session keys from localStorage /
     *     sessionStorage and nulls the in-memory token.
     *  4. EventBus notification: emits SESSION_CLEARED.
     *
     * ### External session mode (`login.queloraSession = false`)
     *
     * Executes the same four phases, then a fifth:
     *  5. External provider logout: navigates the browser to `login.logoutUrl`
     *     so the external provider's session cookie is also invalidated.
     *     When `logoutUrl` is not configured, falls back to a full page reload
     *     so the PHP `inject_sso_token` script can clear storage on the next load.
     *
     * @returns {Promise<void>}
     */
    logout: async () => {
        if ( STATE.isLoggingOut ) return;
        STATE.isLoggingOut = true;

        handleLog( 'Initiating atomic logout.', 'Session', 'log', '🏠' );

        const expiringToken = SessionModule.getTokenIfAvailable( null, true );

        if ( expiringToken ) {
            CoreModule.postWorkerMessage( {
                action:  'revokeToken',
                payload: { token: expiringToken }
            } );
        }

        const purgePromise = new Promise( ( resolve ) => {
            const timeout = setTimeout( () => {
                handleLog( 'Logout purge timed out. Proceeding forcibly.', 'Session', 'warn', '🏠' );
                resolve( false );
            }, 800 );

            const handler = () => {
                clearTimeout( timeout );
                eventBus.off( 'sessionCleared', handler );
                resolve( true );
            };

            eventBus.on( 'sessionCleared', handler );
            CoreModule.postWorkerMessage( { action: 'clearSessionData' } );
        } );

        await purgePromise;

        [ 'ql_sso_token', 'ql_sso_token_expires', 'ql_profile', 'ql_hidden_authors' ].forEach( ( k ) => {
            StorageModule.removeLocalItem( k );
            StorageModule.removeSessionItem( k );
        } );
        STATE.token = null;

        eventBus.emit( 'SESSION_CLEARED', { oldToken: expiringToken } );

        handleLog( 'Logout complete.', 'Session', 'log', '🏠' );

        // ── Phase 5 (external session only) ───────────────────────────────────
        if ( ConfModule.get( 'login.queloraSession', true ) === false ) {
            const logoutUrl = /** @type {string} */ ( ConfModule.get( 'login.logoutUrl', '' ) );

            if ( logoutUrl ) {
                handleLog( `Redirecting to external logout: ${ logoutUrl }`, 'Session', 'info', '🏠' );
                window.location.href = logoutUrl;
            } else {
                handleLog(
                    'External session mode active but login.logoutUrl is not configured. Reloading page.',
                    'Session',
                    'warn',
                    '🏠'
                );
                window.location.reload();
            }

            return;
        }

        // ── Internal session only: re-mount drawer login form ─────────────────
        SessionModule.mountDrawerLogin( '#ql-settings-login-container' );
        STATE.isLoggingOut = false;
    },

    /**
     * Mounts and displays the login modal.
     *
     * In external-session mode (`login.queloraSession = false`) this method is a
     * no-op. The Guard module handles the redirect to the external login page
     * before `createModal` would be called; rendering the internal modal in
     * external-session mode would be both incorrect and unreachable in normal flow.
     *
     * @returns {void}
     */
    createModal: () => {
        if ( ConfModule.get( 'login.queloraSession', true ) === false ) {
            handleLog(
                'createModal called in external-session mode. No-op — Guard handles the redirect.',
                'Session',
                'info',
                '🏠'
            );
            return;
        }

        if ( STATE.modal ) return;

        const m = UiModule.createElementUI( { tag: 'div', attributes: { id: 'QueloraSession' } } );
        const c = UiModule.createElementUI( { tag: 'div', classes: DomUtils.safeClass( 'ql-modal-content' ) } );

        const closeBtn = UiModule.createElementUI( {
            tag:     'button',
            classes: DomUtils.safeClass( 'ql-btn', 'ql-close-button' ),
            content: '×'
        } );
        const title = UiModule.createElementUI( {
            tag:     'h2',
            classes: DomUtils.safeClass( 'ql-title', 't' ),
            content: '{{login}}'
        } );

        c.append( closeBtn, title );

        const form = UiBuilder.createForm( false );
        SessionModule.attachListeners( form, false );
        c.appendChild( form );
        m.appendChild( c );

        document.getElementById( 'ql-root' )?.appendChild( m );
        STATE.modal       = m;
        STATE.isModalOpen = true;

        closeBtn.onclick = ( e ) => {
            e.preventDefault();
            e.stopPropagation();
            SessionModule.closeModal( true );
        };

        document.addEventListener( 'keydown', SessionModule.handleEscKey );
        UtilsModule.startTimeout( () => AuthService.initProviders( m ), 0 );
    },

    /**
     * Removes the login modal from the DOM and resets modal state.
     * When `isUserCancelled` is true, all pending callbacks are rejected with null.
     *
     * @param {boolean} [isUserCancelled=false] - Whether the user dismissed the modal intentionally.
     * @returns {void}
     */
    closeModal: ( isUserCancelled = false ) => {
        SessionModule.clearLoginTimers();
        document.removeEventListener( 'keydown', SessionModule.handleEscKey );

        const modalElement = document.getElementById( 'QueloraSession' );
        if ( modalElement ) modalElement.remove();

        if ( isUserCancelled && STATE.pendingCallbacks.length > 0 ) {
            const cbs              = [ ...STATE.pendingCallbacks ];
            STATE.pendingCallbacks = [];
            cbs.forEach( ( cb ) => {
                try { cb( null ); }
                catch ( e ) { handleLog( e, 'Session:Callback', 'error', '🏠' ); }
            } );
        }

        STATE.modal       = null;
        STATE.isModalOpen = false;
    },

    /**
     * Renders the appropriate login interface into a drawer container identified
     * by a CSS selector.
     *
     * ### Internal session mode (default)
     *
     * Renders the full native login form (email/password, social providers) and
     * wires all interaction event listeners.
     *
     * ### External session mode (`login.queloraSession = false`)
     *
     * Renders a minimal external-session CTA in place of the native form:
     * - A login button that navigates to `login.loginUrl` with
     *   `redirect_to=<current href>` appended at click-time.
     * - A logout link (only when `login.isLoggedIn` is `true`) that navigates
     *   to `login.logoutUrl`.
     * The native form, social provider buttons, and registration/recovery links
     * are never rendered in this mode.
     *
     * @param {string} selector - CSS selector for the target container element.
     * @returns {void}
     */
    mountDrawerLogin: ( selector ) => {
        const container = document.querySelector( selector );
        if ( ! container ) return;

        container.replaceChildren();

        if ( ConfModule.get( 'login.queloraSession', true ) === false ) {
            container.appendChild( UiBuilder.createExternalSessionCTA() );
            return;
        }

        const form = UiBuilder.createForm( true );
        container.appendChild( form );
        SessionModule.attachListeners( container, true );
        AuthService.loadScripts();

        if ( STATE.scriptsLoaded.google || STATE.scriptsLoaded.facebook ) {
            AuthService.initProviders( container );
        }
        if ( STATE.scriptsLoaded.apple ) {
            AuthService.initApple();
        }
    },

    /**
     * Wires all interaction event listeners onto a login form container.
     * Handles: Quelora form submission, Facebook OAuth, Apple Sign In, and
     * navigation links for registration and password recovery flows.
     *
     * @param {HTMLElement} container - The element containing the form.
     * @param {boolean}     isDrawer  - Selects the drawer-scoped element IDs.
     * @returns {void}
     */
    attachListeners: ( container, isDrawer ) => {
        const ids   = DomUtils.getIds( isDrawer );
        const getEl = ( id ) => container.querySelector( `#${ id }` );

        const btn   = getEl( ids.submit );
        const email = getEl( ids.email );
        const pass  = getEl( ids.password );

        if ( btn && email && pass ) {
            const submit = () => {
                const u = email.value;
                const p = pass.value;
                if ( ! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test( u ) ) {
                    return UiBuilder.displayError( container, '{{invalidEmailFormat}}' );
                }
                if ( p.length < 8 ) {
                    return UiBuilder.displayError( container, '{{passwordTooShort}}' );
                }
                btn.classList.add( 'loading' );
                btn.disabled = true;
                AuthService.login( { username: u, password: p }, container )
                    .catch( () => {
                        // Rejection is intentional for auth errors (invalid credentials, SSO
                        // failures, rate limits). The error message is already rendered inside
                        // the container by the responseHandler — absorbing here prevents an
                        // Uncaught (in promise) console warning with no actionable information.
                    } )
                    .finally( () => { btn.classList.remove( 'loading' ); btn.disabled = false; } );
            };
            btn.addEventListener( 'click', ( e ) => { e.preventDefault(); submit(); } );
            [ email, pass ].forEach( ( el ) =>
                el.addEventListener( 'keydown', ( e ) => { if ( e.key === 'Enter' ) { e.preventDefault(); submit(); } } )
            );
        }

        const links = [
            { id: ids.signupLink, flow: 'initRegistrationFlow' },
            { id: ids.forgotLink, flow: 'initRecoveryFlow' }
        ];
        links.forEach( ( { id, flow } ) => {
            getEl( id )?.addEventListener( 'click', ( e ) => {
                e.preventDefault();
                if ( STATE.isModalOpen ) SessionModule.closeModal();
                import( '../modules/registration/registration.js' ).then( ( m ) => m.default[ flow ]() );
            } );
        } );

        getEl( ids.fbBtn )?.addEventListener( 'click', () => {
            if ( window.FB ) {
                window.FB.login( ( r ) => {
                    if ( r.authResponse ) {
                        AuthService.login(
                            { access_token: r.authResponse.accessToken, provider: 'facebook' },
                            container,
                            true
                        ).catch( ( e ) => {
                            handleLog( e, 'Session:FB', 'error', '🏠' );
                            // auth_error sentinel: the error message was already rendered in the
                            // container by the responseHandler; do not close the modal.
                            if ( ! e.message.startsWith( 'auth_error:' ) ) {
                                SessionModule.handleError( false, container );
                            }
                        } );
                    }
                }, { scope: 'public_profile,email' } );
            }
        } );

        getEl( ids.appleBtn )?.addEventListener( 'click', () => {
            AuthService.signInWithApple( container );
        } );
    }
};

export default SessionModule;