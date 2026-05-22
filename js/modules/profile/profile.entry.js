/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/profile/profile.entry.js */
/**
 * @module Modules/AuthWidget
 * @description Injects a compact authentication widget into any host-page element
 * specified via `window.QUELORA_CONFIG.authWidget.selector`.
 *
 * The widget has two visual states:
 *
 * **Unauthenticated** — renders a "Sign in" and a "Sign up" button.
 *   Clicking "Sign in" delegates to {@link CoreModule.getTokenIfNeeded}, which
 *   opens the standard Quelora login modal.
 *   Clicking "Sign up" dynamically imports the Registration module and calls
 *   `initRegistrationFlow()`.
 *
 * **Authenticated** — renders a circular avatar button with the user's display
 *   name beside it. Clicking the avatar attaches and toggles the standard
 *   `ql-profile-dropup` menu via
 *   {@link ProfileUiModule.createProfileDropupUI}, keeping all profile actions
 *   (settings, activity, logout, etc.) consistent with the rest of the SDK.
 *
 * The dropup is rendered with the `ql-profile-dropup--below` modifier so that
 * it opens downward — appropriate for a top navigation bar — rather than
 * upward as it does in the community footer.
 *
 * **Lifecycle events consumed:**
 * - `SESSION_ESTABLISHED` → transitions widget to authenticated state.
 * - `SESSION_CLEARED`     → transitions widget to unauthenticated state.
 * - `USER_PROFILE_UPDATED` → refreshes avatar and display name in place.
 *
 * **Configuration (`window.QUELORA_CONFIG.authWidget`):**
 * ```js
 * authWidget: {
 *   enabled:  true,
 *   selector: '#my-nav-actions',    // CSS selector for the host container
 *   position: 'inside'              // 'inside' | 'before' | 'after'
 * }
 * ```
 *
 * @version 1.0.0
 */
import handleLog from '../../core/logs.js';
import ConfModule from '../../core/conf.js';
import SessionModule from '../../core/session.js';
import { eventBus } from '../../core/event.js';
import I18n from '../../core/i18n.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const LOG_ICON = '🔑';
const LOG_CONTEXT = 'AuthWidget';

const CLASSES = {
    ROOT:           'ql-auth-widget',
    GUEST_VIEW:     'ql-auth-widget__guest',
    USER_VIEW:      'ql-auth-widget__user',
    AVATAR_BTN:     'ql-auth-widget__avatar',
    AVATAR_IMG:     'ql-auth-widget__avatar-img',
    AVATAR_INITIALS:'ql-auth-widget__avatar-initials',
    NAME:           'ql-auth-widget__name',
    BTN_LOGIN:      'ql-auth-widget__btn-login',
    BTN_SIGNUP:     'ql-auth-widget__btn-signup',
    DROPUP_BELOW:   'ql-profile-dropup--below'
};

// =============================================================================
// PRIVATE STATE
// =============================================================================

/** @type {HTMLElement|null} The `.ql-auth-widget` root element once injected. */
let _widgetRoot = null;

/** @type {boolean} Guards against duplicate initialisation. */
let _initialized = false;

/** @type {HTMLElement|null} */
let _detachedDropup = null;

/** @type {HTMLElement|null} */
let _detachedTrigger = null;

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Resolves the insertion target from the configured selector and position.
 *
 * @returns {{ host: HTMLElement, position: string }|null}
 *   `host` is the element to insert relative to; `position` is one of
 *   `'inside'`, `'before'`, or `'after'`. Returns `null` when the selector
 *   does not match any element.
 */
function _resolveTarget() {
    const selector = ConfModule.get('authWidget.selector', null);
    const position = ConfModule.get('authWidget.position', 'inside');

    if (!selector) {
        handleLog('authWidget.selector is not configured.', LOG_CONTEXT, 'warn', LOG_ICON);
        return null;
    }

    const host = document.querySelector(selector);
    if (!host) {
        handleLog(`authWidget selector "${selector}" matched no element.`, LOG_CONTEXT, 'warn', LOG_ICON);
        return null;
    }

    return { host, position };
}

/**
 * Inserts `element` into the DOM according to the `position` strategy.
 *
 * @param {HTMLElement} element  - Element to insert.
 * @param {HTMLElement} host     - Reference element.
 * @param {string}      position - `'inside'` | `'before'` | `'after'`.
 */
function _insert(element, host, position) {
    if (position === 'before') {
        host.parentElement?.insertBefore(element, host);
    } else if (position === 'after') {
        host.parentElement?.insertBefore(element, host.nextSibling);
    } else {
        host.appendChild(element);
    }
}

/**
 * Derives a deterministic background colour from a two-character initial
 * string, matching the palette used by {@link ProfileModule.updateProfileOptionUI}.
 *
 * @param {string} initials - Up to two characters.
 * @returns {string} A CSS hex colour string.
 */
function _initialsColour(initials) {
    const PALETTE = ['#ef5350', '#ab47bc', '#26a69a', '#ff7043', '#5c6bc0', '#7e57c2'];
    return PALETTE[(initials.charCodeAt(0) || 0) % PALETTE.length];
}

/**
 * Generates the two-character uppercased initials from a display name.
 *
 * @param {string} name - User display name.
 * @returns {string}
 */
function _toInitials(name) {
    return (name || '')
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .substring(0, 2);
}

// =============================================================================
// VIEW BUILDERS
// =============================================================================

/**
 * Builds the unauthenticated view fragment containing the "Sign in" and
 * "Sign up" buttons.
 *
 * @returns {HTMLElement} A `<div class="ql-auth-widget__guest">` element.
 */
function _buildGuestView() {
    const container = document.createElement('div');
    container.className = CLASSES.GUEST_VIEW;

    const loginBtn = document.createElement('button');
    loginBtn.className = CLASSES.BTN_LOGIN;
    loginBtn.setAttribute('data-i18n-key', 'login');
    loginBtn.textContent = I18n.getTranslation('login') || 'Sign in';
    loginBtn.addEventListener('click', _handleLoginClick);

    const signupBtn = document.createElement('button');
    signupBtn.className = CLASSES.BTN_SIGNUP;
    signupBtn.setAttribute('data-i18n-key', 'signUp');
    signupBtn.textContent = I18n.getTranslation('signUp') || 'Sign up';
    signupBtn.addEventListener('click', _handleSignupClick);

    container.append(loginBtn, signupBtn);
    return container;
}

/**
 * Builds the authenticated view fragment containing the avatar button and
 * display name.
 *
 * The avatar element serves as the dropup trigger; it stores no profile data
 * of its own — that is populated by {@link _hydrateUserView} immediately after
 * insertion.
 *
 * @returns {HTMLElement} A `<div class="ql-auth-widget__user">` element.
 */
function _buildUserView() {
    const container = document.createElement('div');
    container.className = CLASSES.USER_VIEW;

    const avatarBtn = document.createElement('button');
    avatarBtn.className = CLASSES.AVATAR_BTN;
    avatarBtn.setAttribute('aria-label', I18n.getTranslation('myProfile') || 'My profile');
    // Pointer-events disabled on inner button — click is handled by the container.
    avatarBtn.style.pointerEvents = 'none';

    const nameEl = document.createElement('span');
    nameEl.className = CLASSES.NAME;

    // The whole user-view area (avatar + name) is the click target.
    container.style.cursor = 'pointer';
    container.addEventListener('click', _handleAvatarClick);

    container.append(avatarBtn, nameEl);
    return container;
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

/**
 * Builds a fully-qualified redirect URL for external auth flows.
 * Appends `redirect_to` pointing at the current page href so the external
 * provider can return the user to the exact same location.
 *
 * @param {string} baseUrl - The external login or register URL.
 * @returns {string} The destination URL with the `redirect_to` param appended.
 */
function _buildExternalUrl( baseUrl ) {
    const separator  = baseUrl.includes( '?' ) ? '&' : '?';
    const redirectTo = encodeURIComponent( window.location.href );
    return `${ baseUrl }${ separator }redirect_to=${ redirectTo }`;
}

/**
 * Handles the "Sign in" button click.
 *
 * ## Resolution order
 * 1. `login.loginUrl` configured  → redirect browser to the external login page
 *    with `redirect_to=<current href>` appended.
 * 2. Not configured               → open the internal Quelora login modal via
 *    {@link CoreModule.getTokenIfNeeded} (original behaviour).
 *
 * @returns {Promise<void>}
 */
async function _handleLoginClick() {
    try {
        const loginUrl = /** @type {string} */ ( ConfModule.get( 'login.loginUrl', '' ) );

        if ( loginUrl ) {
            window.location.href = _buildExternalUrl( loginUrl );
            return;
        }

        const { default: CoreModule } = await import( '../../core/core.js' );
        await CoreModule.getTokenIfNeeded( null, false );
    } catch ( e ) {
        handleLog( e, `${ LOG_CONTEXT }._handleLoginClick`, 'error', LOG_ICON );
    }
}

/**
 * Handles the "Sign up" button click.
 *
 * ## Resolution order
 * 1. `login.registerUrl` configured → redirect browser to the external
 *    registration page with `redirect_to=<current href>` appended.
 * 2. Not configured, but `login.loginUrl` configured → redirect to the login
 *    page instead (the external provider handles registration from there).
 * 3. Neither configured → open the internal registration flow via
 *    {@link RegistrationModule.initRegistrationFlow} (original behaviour).
 *
 * @returns {Promise<void>}
 */
async function _handleSignupClick() {
    try {
        const registerUrl = /** @type {string} */ ( ConfModule.get( 'login.registerUrl', '' ) );
        const loginUrl    = /** @type {string} */ ( ConfModule.get( 'login.loginUrl',    '' ) );

        if ( registerUrl ) {
            window.location.href = _buildExternalUrl( registerUrl );
            return;
        }

        if ( loginUrl ) {
            window.location.href = _buildExternalUrl( loginUrl );
            return;
        }

        const m = await import( '../registration/registration.js' );
        m.default.initRegistrationFlow();
    } catch ( e ) {
        handleLog( e, `${ LOG_CONTEXT }._handleSignupClick`, 'error', LOG_ICON );
    }
}

/**
 * Closes the detached dropup when the user clicks outside it or its trigger.
 * @param {MouseEvent} e
 */
function _onDocumentClickClose(e) {
    if (!_detachedDropup || !_detachedTrigger) return;
    if (_detachedDropup.contains(e.target) || _detachedTrigger.contains(e.target)) return;
    _closeDropup(_detachedDropup);
}

/**
 * Bootstrap handler — builds the dropup via `createProfileDropupUI`, then
 * immediately reparents it to `document.body` with `position: fixed` so that
 * positioning is fully independent of any DOM ancestor in the host page.
 * @param {MouseEvent} e
 */
async function _handleAvatarClick(e) {
    e.stopPropagation();
    // Capture currentTarget synchronously — it becomes null after any await.
    // currentTarget is the .ql-auth-widget__user container; resolve the inner button.
    const container = e.currentTarget;
    const avatarBtn = container.querySelector(`.${CLASSES.AVATAR_BTN}`);
    if (!avatarBtn) return;
    try {
        const { default: ProfileUiModule } = await import('../profile/profile.ui.js');

        if (!avatarBtn._qlDropup) {
            ProfileUiModule.createProfileDropupUI(avatarBtn);

            const dropup = avatarBtn._qlDropup;
            if (!dropup) return;

            // Translate immediately so keys are resolved before first render,
            // regardless of whether a drawer has been opened yet.
            try {
                const { default: I18n } = await import('../../core/i18n.js');
                I18n.translateElement(dropup);
            } catch (_) {}

            document.body.appendChild(dropup);
            dropup.style.position = 'fixed';
            dropup.style.bottom   = 'auto';

            _detachedDropup  = dropup;
            _detachedTrigger = container;

            container.removeEventListener('click', _handleAvatarClick);
            container.addEventListener('click', _toggleDropup);
            document.addEventListener('click', _onDocumentClickClose);
        }

        _positionAndOpenDropup(container, avatarBtn._qlDropup);
    } catch (err) {
        handleLog(err, `${LOG_CONTEXT}._handleAvatarClick`, 'error', LOG_ICON);
    }
}

/**
 * Toggle handler active from the second click onward.
 * @param {MouseEvent} e
 */
function _toggleDropup(e) {
    e.stopPropagation();
    const container = e.currentTarget;
    const avatarBtn = container.querySelector(`.${CLASSES.AVATAR_BTN}`);
    if (!avatarBtn) return;
    const dropup = avatarBtn._qlDropup;
    if (!dropup) return;

    if (dropup.classList.contains('ql-profile-dropup--visible')) {
        _closeDropup(dropup);
    } else {
        _positionAndOpenDropup(container, dropup);
    }
}

/**
 * Positions the fixed dropup below the trigger using getBoundingClientRect,
 * then opens it with a CSS transition.
 * @param {HTMLElement} trigger
 * @param {HTMLElement} dropup
 */
function _positionAndOpenDropup(trigger, dropup) {
    const rect        = trigger.getBoundingClientRect();
    const dropupWidth = dropup.offsetWidth || 200;
    const vw          = window.innerWidth;

    dropup.style.top = `${rect.bottom + 6}px`;

    if (rect.left + dropupWidth > vw) {
        // Would overflow right edge — anchor to the right side of the trigger
        dropup.style.left  = 'auto';
        dropup.style.right = `${vw - rect.right}px`;
    } else {
        dropup.style.left  = `${rect.left}px`;
        dropup.style.right = 'auto';
    }

    requestAnimationFrame(() => {
        dropup.style.display = 'block';
        void dropup.offsetWidth;
        dropup.classList.add('ql-profile-dropup--visible');
    });
}

/**
 * Hides a dropup after its CSS transition completes.
 * @param {HTMLElement} dropup
 */
function _closeDropup(dropup) {
    dropup.classList.remove('ql-profile-dropup--visible');
    setTimeout(() => {
        if (!dropup.classList.contains('ql-profile-dropup--visible')) {
            dropup.style.display = 'none';
        }
    }, 200);
}

/**
 * Removes the detached dropup and cleans up related listeners.
 */
function _teardownDetachedDropup() {
    if (_detachedDropup) {
        _detachedDropup.remove();
        document.removeEventListener('click', _onDocumentClickClose);
        _detachedDropup  = null;
        _detachedTrigger = null;
    }
}

// =============================================================================
// STATE TRANSITIONS
// =============================================================================

/**
 * Transitions the widget to the unauthenticated (guest) state.
 * Replaces any existing child of `_widgetRoot` with the guest view.
 */
function _showGuestState() {
    if (!_widgetRoot) return;
    _teardownDetachedDropup();
    _widgetRoot.innerHTML = '';
    _widgetRoot.appendChild(_buildGuestView());
}

/**
 * Transitions the widget to the authenticated state and immediately
 * hydrates it with profile data.
 *
 * @param {{ picture?: string, name?: string }|null} [profile=null]
 *   Pre-resolved profile object. When null, {@link ProfileModule.getOwnProfile}
 *   is called to resolve it asynchronously.
 */
async function _showUserState(profile = null) {
    if (!_widgetRoot) return;

    _teardownDetachedDropup();
    _widgetRoot.innerHTML = '';
    const userView = _buildUserView();
    _widgetRoot.appendChild(userView);

    let resolved = profile;
    if (!resolved) {
        try {
            const { default: ProfileModule } = await import('../profile/profile.js');
            resolved = await ProfileModule.getOwnProfile();
        } catch (e) {
            handleLog(e, `${LOG_CONTEXT}._showUserState`, 'error', LOG_ICON);
        }
    }

    if (resolved) {
        _hydrateUserView(userView, resolved);
    }
}

/**
 * Populates the avatar button and name element with data from a resolved
 * profile object.
 *
 * Avatar resolution order:
 * 1. `profile.picture` — set as CSS `background-image`.
 * 2. Initials generated from `profile.name` — drawn as coloured text on a
 *    solid background, matching the palette from ProfileModule.
 *
 * @param {HTMLElement}                            userView - The user-view container element.
 * @param {{ picture?: string, name?: string }} profile  - Resolved own-profile object.
 */
function _hydrateUserView(userView, profile) {
    const avatarBtn = userView.querySelector(`.${CLASSES.AVATAR_BTN}`);
    const nameEl    = userView.querySelector(`.${CLASSES.NAME}`);

    if (!avatarBtn) return;

    avatarBtn.innerHTML = '';

    if (profile.picture) {
        const img = document.createElement('span');
        img.className = CLASSES.AVATAR_IMG;
        img.style.backgroundImage = `url('${profile.picture}')`;
        avatarBtn.appendChild(img);
        avatarBtn.classList.remove(CLASSES.AVATAR_INITIALS);
    } else {
        const initials = _toInitials(profile.name);
        const initialsEl = document.createElement('span');
        initialsEl.className = CLASSES.AVATAR_INITIALS;
        initialsEl.textContent = initials;
        initialsEl.style.backgroundColor = _initialsColour(initials);
        avatarBtn.appendChild(initialsEl);
        avatarBtn.classList.add(CLASSES.AVATAR_INITIALS);
    }

    if (nameEl) {
        nameEl.textContent = profile.name || '';
        nameEl.title = profile.name || '';
    }
}

// =============================================================================
// EVENT BUS SUBSCRIPTIONS
// =============================================================================

/**
 * Reacts to a successful login or silent session restoration by transitioning
 * the widget to the authenticated state.
 */
eventBus.on('SESSION_ESTABLISHED', () => {
    if (!_widgetRoot) return;
    _showUserState();
});

/**
 * Reacts to logout by transitioning the widget back to the guest state.
 */
eventBus.on('SESSION_CLEARED', () => {
    if (!_widgetRoot) return;
    _showGuestState();
});

/**
 * Reacts to profile updates (e.g. avatar change, name change) by refreshing
 * the avatar and name without rebuilding the full user view.
 *
 * @param {{ picture?: string, name?: string }} profile - Updated profile object.
 */
eventBus.on('USER_PROFILE_UPDATED', (profile) => {
    if (!_widgetRoot) return;
    const userView = _widgetRoot.querySelector(`.${CLASSES.USER_VIEW}`);
    if (userView && profile) {
        _hydrateUserView(userView, profile);
    }
});

// =============================================================================
// PUBLIC API
// =============================================================================

const AuthWidgetModule = {
    /**
     * Initialises the auth widget.
     *
     * Called once by {@link QueloraApp.init} when
     * `window.QUELORA_CONFIG.authWidget.enabled` is `true`.
     *
     * The method resolves the insertion target, builds the widget root element,
     * inserts it into the DOM, then renders either the guest or authenticated
     * view depending on whether a valid session token is already present.
     *
     * @returns {Promise<void>}
     */
    async init() {
        if (_initialized) return;

        const enabled = ConfModule.get('authWidget.enabled', false);
        if (!enabled) return;

        const target = _resolveTarget();
        if (!target) return;

        _widgetRoot = document.createElement('div');
        _widgetRoot.className = CLASSES.ROOT;

        _insert(_widgetRoot, target.host, target.position);

        const hasSession = !!SessionModule.getTokenIfAvailable();

        if (hasSession) {
            await _showUserState();
        } else {
            _showGuestState();
        }

        _initialized = true;
        handleLog('Auth widget initialised.', LOG_CONTEXT, 'log', LOG_ICON);
    },

    /**
     * Resets the module to its uninitialised state and removes the widget from
     * the DOM.  Useful for testing or when the SDK is destroyed.
     */
    destroy() {
        _teardownDetachedDropup();
        _widgetRoot?.remove();
        _widgetRoot  = null;
        _initialized = false;
    }
};

export default AuthWidgetModule;