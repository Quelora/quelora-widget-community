/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: quelora/js/services/captcha.js */
/**
 * @module Services/Captcha
 * @description Pluggable CAPTCHA service supporting Cloudflare Turnstile and Google reCAPTCHA Enterprise.
 * Implements an abstract provider pattern with a unified CaptchaModule facade.
 * @version 2.2.0
 */
import handleLog from '../core/logs.js';

const CAPTCHA_ICON = '🤖';

/**
 * @class BaseCaptchaProvider
 * @abstract
 * @description Abstract base class for CAPTCHA provider implementations.
 * Handles container lifecycle, script loading, and resolver queue management.
 */
class BaseCaptchaProvider {
    constructor() {
        if (this.constructor === BaseCaptchaProvider) {
            handleLog('Abstract class "BaseCaptchaProvider" cannot be instantiated directly', 'BaseCaptchaProvider', 'error', CAPTCHA_ICON);
            return;
        }
        this.siteKey = null;
        this.widgetId = null;
        this.options = {};
        this.container = null;
        this.wrapper = null;
        this.isReady = false;
        this.tokenPromiseResolvers = [];
    }

    /**
     * Initialises the provider: stores the site key, creates the DOM container,
     * loads the third-party script, and renders the widget.
     * @param {string} siteKey - The provider-specific public site key.
     * @param {Object} [options={}] - Optional configuration overrides.
     * @param {string} [options.containerId='captcha-container'] - DOM ID of the widget container.
     * @param {string} [options.size='normal'] - Widget size ('normal' | 'compact' | 'invisible').
     * @param {string} [options.theme='auto'] - Widget theme ('auto' | 'light' | 'dark').
     * @returns {Promise<boolean>}
     */
    async initialize(siteKey, options = {}) {
        if (!siteKey) {
            handleLog('Site key is required', 'BaseCaptchaProvider.initialize', 'error', CAPTCHA_ICON, { siteKey });
            return false;
        }
        
        this.siteKey = siteKey;
        this.options = { containerId: 'captcha-container', size: 'normal', theme: 'auto', ...options };
        
        try {
            this._createContainer();
            await this._loadScript();
            
            return new Promise((resolve) => {
                const onReady = () => { 
                    this._render(); 
                    this.isReady = true; 
                    resolve(true); 
                };
                
                if (this.apiNamespace) {
                    onReady();
                } else {
                    handleLog('API namespace not available after script load', 'BaseCaptchaProvider.initialize', 'warn', CAPTCHA_ICON, { scriptSrc: this.scriptSrc });
                    resolve(false);
                }
            });
        } catch (error) {
            handleLog(error, 'BaseCaptchaProvider.initialize', 'error', CAPTCHA_ICON, { siteKey, options });
            return false;
        }
    }

    /**
     * Returns a Promise that resolves with a one-time challenge token.
     * @abstract
     * @returns {Promise<string>}
     */
    async getToken() { 
        handleLog('Method "getToken()" must be implemented', 'BaseCaptchaProvider.getToken', 'error', CAPTCHA_ICON);
        return Promise.reject(new Error('Method not implemented'));
    }

    /**
     * Resets the widget back to its initial unchallenged state.
     * @abstract
     */
    reset() { 
        handleLog('Method "reset()" must be implemented', 'BaseCaptchaProvider.reset', 'error', CAPTCHA_ICON);
    }

    /**
     * Destroys the widget and removes its DOM node.
     */
    destroy() {
        try {
            if (this.widgetId && this.apiNamespace && this.apiNamespace.remove) {
                this.apiNamespace.remove(this.widgetId);
            }
            if (this.wrapper && this.wrapper.parentNode) {
                this.wrapper.parentNode.removeChild(this.wrapper);
            }
        } catch (error) {
            handleLog(error, 'BaseCaptchaProvider.destroy', 'error', CAPTCHA_ICON, { widgetId: this.widgetId });
        } finally {
            this.isReady = false;
            this.widgetId = null;
            this.container = null;
            this.wrapper = null;
        }
    }

    /**
     * Renders the CAPTCHA widget inside the container element.
     * @abstract
     * @protected
     */
    _render() { 
        handleLog('Method "_render()" must be implemented', 'BaseCaptchaProvider._render', 'error', CAPTCHA_ICON);
    }

    /**
     * Returns the URL of the third-party CAPTCHA script to load.
     * @abstract
     * @type {string}
     */
    get scriptSrc() { 
        handleLog('Getter "scriptSrc" must be implemented', 'BaseCaptchaProvider.scriptSrc', 'error', CAPTCHA_ICON);
        return '';
    }

    /**
     * Returns the global API namespace object exposed by the loaded script, or undefined.
     * @abstract
     * @type {object|undefined}
     */
    get apiNamespace() { 
        handleLog('Getter "apiNamespace" must be implemented', 'BaseCaptchaProvider.apiNamespace', 'error', CAPTCHA_ICON);
        return undefined;
    }

    /**
     * Loads the third-party CAPTCHA script into the document head.
     * Removes any pre-existing Turnstile script tags to avoid duplicate widget registrations.
     * @protected
     * @returns {Promise<boolean>}
     */
    _loadScript() {
        return new Promise((resolve) => {
            if (this.apiNamespace) return resolve(true);
            
            const scriptUrl = this.scriptSrc;
            if (!scriptUrl) {
                handleLog('Script source URL is empty', 'BaseCaptchaProvider._loadScript', 'error', CAPTCHA_ICON);
                return resolve(false);
            }

            try {
                const isTurnstile = scriptUrl.includes('challenges.cloudflare.com/turnstile');
                const existingScripts = document.querySelectorAll(`script[src^="https://challenges.cloudflare.com/turnstile"]`);
                existingScripts.forEach(s => s.parentNode.removeChild(s));

                const script = document.createElement('script');
                script.src = scriptUrl;
                if (!isTurnstile) {
                    script.async = true;
                    script.defer = true;
                }
                
                script.onload = () => resolve(true);
                script.onerror = () => {
                    handleLog(`Failed to load CAPTCHA script from ${scriptUrl}`, 'BaseCaptchaProvider._loadScript', 'error', CAPTCHA_ICON);
                    resolve(false);
                };
                
                document.head.appendChild(script);
            } catch (error) {
                handleLog(error, 'BaseCaptchaProvider._loadScript', 'error', CAPTCHA_ICON, { scriptUrl });
                resolve(false);
            }
        });
    }

    /**
     * Creates and appends the CAPTCHA wrapper and container DOM elements.
     * Handles backdrop-click cancellation by draining and rejecting all pending resolvers.
     * @protected
     */
    _createContainer() {
        try {
            const existingWrapper = document.getElementById('ql-captcha');
            if (existingWrapper) existingWrapper.remove();

            this.wrapper = document.createElement('div');
            this.wrapper.className = 'ql-captcha';
            this.wrapper.id = 'ql-captcha';
            this.wrapper.style.display = 'none';

            this.wrapper.addEventListener('click', (e) => {
                if (e.target !== this.wrapper) return;
                
                const rejectionCount = this.tokenPromiseResolvers.length;
                while (this.tokenPromiseResolvers.length) {
                    const p = this.tokenPromiseResolvers.shift();
                    p.reject(new Error('Captcha cancelled by user.'));
                }
                
                if (rejectionCount > 0) {
                    handleLog(`Captcha cancelled by user, rejected ${rejectionCount} pending promises`, 'BaseCaptchaProvider._createContainer', 'info', CAPTCHA_ICON);
                }
                
                this.hide();
                this.reset();
            });

            const inner = document.createElement('div');
            inner.className = 'ql-container';

            this.container = document.createElement('div');
            this.container.id = this.options.containerId;

            inner.appendChild(this.container);
            this.wrapper.appendChild(inner);

            const root = document.getElementById('ql-root');
            if (!root) {
                handleLog('Root element #ql-root not found', 'BaseCaptchaProvider._createContainer', 'error', CAPTCHA_ICON);
                return;
            }
            
            root.appendChild(this.wrapper);
        } catch (error) {
            handleLog(error, 'BaseCaptchaProvider._createContainer', 'error', CAPTCHA_ICON, { containerId: this.options?.containerId });
        }
    }

    /**
     * Makes the CAPTCHA wrapper visible.
     */
    show() {
        if (this.wrapper) {
            this.wrapper.style.display = 'block';
            handleLog('Captcha wrapper shown', 'BaseCaptchaProvider.show', 'debug', CAPTCHA_ICON);
        }
    }

    /**
     * Hides the CAPTCHA wrapper.
     */
    hide() {
        if (this.wrapper) {
            this.wrapper.style.display = 'none';
            handleLog('Captcha wrapper hidden', 'BaseCaptchaProvider.hide', 'debug', CAPTCHA_ICON);
        }
    }
}

/**
 * @class TurnstileProvider
 * @extends BaseCaptchaProvider
 * @description Cloudflare Turnstile CAPTCHA provider.
 *
 * Re-entrancy guard: a single `_isExecuting` flag prevents calling
 * `turnstile.execute()` while a challenge is already in flight.
 *
 * Full resolver drain on error/expiry: both `error-callback` and
 * `expired-callback` drain all pending resolvers with `reject`.
 */
class TurnstileProvider extends BaseCaptchaProvider {

    constructor() {
        super();
        this._isExecuting = false;
    }

    /**
     * @returns {string}
     */
    get scriptSrc() {
        return 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    }

    /**
     * @returns {object|undefined}
     */
    get apiNamespace() { 
        return window.turnstile; 
    }

    /**
     * Requests a challenge token from Cloudflare Turnstile.
     * If a challenge is already executing this call is coalesced onto the
     * existing Promise rather than triggering a second `execute()` call.
     * @returns {Promise<string>}
     */
    async getToken() {
        return new Promise((resolve, reject) => {
            if (!this.isReady || !this.widgetId) {
                handleLog('Turnstile provider not initialized', 'TurnstileProvider.getToken', 'error', CAPTCHA_ICON, { 
                    isReady: this.isReady, 
                    widgetId: this.widgetId 
                });
                return reject(new Error('Turnstile provider not initialized.'));
            }

            this.tokenPromiseResolvers.push({ resolve, reject });
            this.show();

            if (this._isExecuting) {
                handleLog('Challenge already in progress — coalescing token request', 'TurnstileProvider.getToken', 'info', CAPTCHA_ICON, {
                    pendingResolvers: this.tokenPromiseResolvers.length
                });
                return;
            }

            this._isExecuting = true;
            
            try {
                this.apiNamespace.execute(this.widgetId);
                handleLog('Turnstile execute called', 'TurnstileProvider.getToken', 'debug', CAPTCHA_ICON, { widgetId: this.widgetId });
            } catch (error) {
                handleLog(error, 'TurnstileProvider.getToken', 'error', CAPTCHA_ICON, { widgetId: this.widgetId });
                this._isExecuting = false;
                
                while (this.tokenPromiseResolvers.length) {
                    const p = this.tokenPromiseResolvers.shift();
                    p.reject(new Error('Failed to execute Turnstile challenge.'));
                }
                this.hide();
                this.reset();
            }
        });
    }

    /**
     * Resets the Turnstile widget and clears the execution guard.
     */
    reset() {
        this._isExecuting = false;
        if (this.isReady && this.widgetId) {
            try {
                this.apiNamespace.reset(this.widgetId);
                handleLog('Turnstile widget reset', 'TurnstileProvider.reset', 'debug', CAPTCHA_ICON, { widgetId: this.widgetId });
            } catch (error) {
                handleLog(error, 'TurnstileProvider.reset', 'error', CAPTCHA_ICON, { widgetId: this.widgetId });
            }
        }
    }

    /**
     * Renders the Turnstile widget in explicit execution mode.
     * Includes diagnostic logging for iframe sandbox issues.
     * @protected
     */
    _render() {
        try {
            this.widgetId = this.apiNamespace.render(this.container, {
                sitekey:    this.siteKey,
                size:       this.options.size,
                theme:      this.options.theme,
                execution:  'execute',

                callback: (token) => {
                    this._isExecuting = false;
                    const p = this.tokenPromiseResolvers.shift();
                    if (p) {
                        p.resolve(token);
                        handleLog('Turnstile token received', 'TurnstileProvider._render.callback', 'success', CAPTCHA_ICON, { 
                            tokenLength: token?.length 
                        });
                    }
                    this.hide();
                    this.reset();
                },

                'error-callback': () => {
                    this._isExecuting = false;
                    
                    document.querySelectorAll('iframe[src*="challenges.cloudflare.com"]').forEach(iframe => {
                        handleLog({
                            message: 'Turnstile iframe diagnostic',
                            src: iframe.src,
                            sandboxAttr: iframe.getAttribute('sandbox'),
                            hasAllowScripts: iframe.sandbox ? iframe.sandbox.contains('allow-scripts') : false
                        }, 'TurnstileProvider._render.error-callback', 'error', CAPTCHA_ICON);
                    });

                    const resolverCount = this.tokenPromiseResolvers.length;
                    handleLog(`error-callback fired — draining ${resolverCount} pending resolvers`, 'TurnstileProvider._render.error-callback', 'warn', CAPTCHA_ICON);
                    
                    while (this.tokenPromiseResolvers.length) {
                        const p = this.tokenPromiseResolvers.shift();
                        p.reject(new Error('Turnstile challenge failed.'));
                    }
                    
                    this.hide();
                    this.reset();
                },

                'expired-callback': () => {
                    this._isExecuting = false;
                    
                    const resolverCount = this.tokenPromiseResolvers.length;
                    handleLog(`expired-callback fired — draining ${resolverCount} pending resolvers`, 'TurnstileProvider._render.expired-callback', 'warn', CAPTCHA_ICON);
                    
                    while (this.tokenPromiseResolvers.length) {
                        const p = this.tokenPromiseResolvers.shift();
                        p.reject(new Error('Turnstile token expired.'));
                    }
                    
                    this.hide();
                    this.reset();
                }
            });
            
            handleLog('Turnstile widget rendered', 'TurnstileProvider._render', 'debug', CAPTCHA_ICON, { 
                widgetId: this.widgetId,
                siteKey: this.siteKey,
                size: this.options.size,
                theme: this.options.theme
            });
        } catch (error) {
            handleLog(error, 'TurnstileProvider._render', 'error', CAPTCHA_ICON, {
                siteKey: this.siteKey,
                containerId: this.options.containerId
            });
        }
    }
}

/**
 * @class RecaptchaProvider
 * @extends BaseCaptchaProvider
 * @description Google reCAPTCHA Enterprise provider.
 * Supports both visible widget and invisible (v3-style) execution modes.
 */
class RecaptchaProvider extends BaseCaptchaProvider {

    /**
     * @returns {string}
     */
    get scriptSrc() {
        return `https://www.google.com/recaptcha/enterprise.js?render=${this.siteKey}`;
    }

    /**
     * @returns {object|undefined}
     */
    get apiNamespace() {
        return window.grecaptcha && window.grecaptcha.enterprise;
    }

    /**
     * Requests a challenge token from reCAPTCHA Enterprise.
     * @returns {Promise<string>}
     */
    async getToken() {
        if (!this.isReady) {
            handleLog('reCAPTCHA provider not initialized', 'RecaptchaProvider.getToken', 'error', CAPTCHA_ICON, { 
                isReady: this.isReady 
            });
            return Promise.reject(new Error('reCAPTCHA provider not initialized.'));
        }

        try {
            const token = await this.apiNamespace.execute(this.siteKey, { 
                action: this.options.action || 'submit' 
            });
            
            handleLog('reCAPTCHA token received', 'RecaptchaProvider.getToken', 'success', CAPTCHA_ICON, { 
                tokenLength: token?.length,
                action: this.options.action || 'submit'
            });
            
            return token;
        } catch (error) {
            handleLog(error, 'RecaptchaProvider.getToken', 'error', CAPTCHA_ICON, {
                siteKey: this.siteKey,
                action: this.options.action || 'submit'
            });
            throw error;
        }
    }

    /**
     * Resets the reCAPTCHA widget. No-op for invisible mode.
     */
    reset() {
        if (this.isReady && this.widgetId) {
            try {
                this.apiNamespace.reset(this.widgetId);
                handleLog('reCAPTCHA widget reset', 'RecaptchaProvider.reset', 'debug', CAPTCHA_ICON, { widgetId: this.widgetId });
            } catch (error) {
                handleLog(error, 'RecaptchaProvider.reset', 'error', CAPTCHA_ICON, { widgetId: this.widgetId });
            }
        } else if (this.isReady) {
            handleLog('reCAPTCHA Enterprise (invisible) does not require widget reset', 'RecaptchaProvider.reset', 'info', CAPTCHA_ICON);
        }
    }

    /**
     * Renders the reCAPTCHA widget. Skipped entirely for invisible mode.
     * @protected
     */
    _render() {
        if (this.options.size !== 'invisible') {
            try {
                this.widgetId = this.apiNamespace.render(this.container, {
                    sitekey: this.siteKey,
                    size:    this.options.size,
                    theme:   this.options.theme,
                    callback: (token) => {
                        const p = this.tokenPromiseResolvers.shift();
                        if (p) {
                            p.resolve(token);
                            handleLog('reCAPTCHA token received via callback', 'RecaptchaProvider._render.callback', 'success', CAPTCHA_ICON, {
                                tokenLength: token?.length
                            });
                        }
                    },
                    'error-callback': () => {
                        const resolverCount = this.tokenPromiseResolvers.length;
                        handleLog(`reCAPTCHA error-callback fired — draining ${resolverCount} pending resolvers`, 'RecaptchaProvider._render.error-callback', 'warn', CAPTCHA_ICON);
                        
                        while (this.tokenPromiseResolvers.length) {
                            const p = this.tokenPromiseResolvers.shift();
                            p.reject(new Error('reCAPTCHA challenge failed.'));
                        }
                    },
                });
                
                handleLog('reCAPTCHA widget rendered', 'RecaptchaProvider._render', 'debug', CAPTCHA_ICON, { 
                    widgetId: this.widgetId,
                    siteKey: this.siteKey,
                    size: this.options.size,
                    theme: this.options.theme
                });
            } catch (error) {
                handleLog(error, 'RecaptchaProvider._render', 'error', CAPTCHA_ICON, {
                    siteKey: this.siteKey,
                    size: this.options.size,
                    containerId: this.options.containerId
                });
            }
        } else {
            handleLog('reCAPTCHA invisible mode - skipping render', 'RecaptchaProvider._render', 'debug', CAPTCHA_ICON, {
                siteKey: this.siteKey,
                action: this.options.action || 'submit'
            });
        }
    }

    /**
     * Destroys the reCAPTCHA widget and removes the container from the DOM.
     */
    destroy() {
        try {
            if (this.widgetId && this.apiNamespace && this.apiNamespace.remove) {
                this.apiNamespace.remove(this.widgetId);
            }
            if (this.container && this.container.parentNode) {
                this.container.parentNode.removeChild(this.container);
            }
        } catch (error) {
            handleLog(error, 'RecaptchaProvider.destroy', 'error', CAPTCHA_ICON, { widgetId: this.widgetId });
        } finally {
            this.isReady = false;
            this.widgetId = null;
            this.container = null;
        }
    }
}

/**
 * @class CaptchaService
 * @description Thin wrapper that owns a single provider instance and gates
 * all calls behind an `initialized` flag.
 */
class CaptchaService {

    /**
     * @param {string} type - Provider type: 'turnstile' | 'recaptcha'.
     */
    constructor(type) {
        if (type === 'turnstile') {
            this.provider = new TurnstileProvider();
        } else if (type === 'recaptcha') {
            this.provider = new RecaptchaProvider();
        } else {
            handleLog(`Unsupported CAPTCHA provider type: ${type}`, 'CaptchaService.constructor', 'error', CAPTCHA_ICON);
            return;
        }
        
        this.type = type;
        this.initialized = false;
        
        handleLog(`CaptchaService created for provider: ${type}`, 'CaptchaService.constructor', 'debug', CAPTCHA_ICON);
    }

    /**
     * Initialises the underlying provider. Idempotent — subsequent calls
     * return true immediately without re-initialising.
     * @param {string} siteKey - Provider-specific public site key.
     * @param {Object} [options={}] - Provider options forwarded verbatim.
     * @returns {Promise<boolean>}
     */
    async initialize(siteKey, options = {}) {
        if (this.initialized) {
            handleLog('CaptchaService already initialized', 'CaptchaService.initialize', 'info', CAPTCHA_ICON, { type: this.type });
            return true;
        }
        
        try {
            const result = await this.provider.initialize(siteKey, options);
            this.initialized = result;
            
            if (result) {
                handleLog('CaptchaService initialized successfully', 'CaptchaService.initialize', 'success', CAPTCHA_ICON, { 
                    type: this.type,
                    siteKey,
                    options
                });
            } else {
                handleLog('CaptchaService initialization failed', 'CaptchaService.initialize', 'error', CAPTCHA_ICON, { 
                    type: this.type,
                    siteKey,
                    options
                });
            }
            
            return result;
        } catch (error) {
            handleLog(error, 'CaptchaService.initialize', 'error', CAPTCHA_ICON, { type: this.type, siteKey, options });
            this.initialized = false;
            return false;
        }
    }

    /**
     * @returns {Promise<string>}
     */
    async getToken() {
        if (!this.initialized) {
            const error = new Error('CaptchaService is not initialized.');
            handleLog(error, 'CaptchaService.getToken', 'error', CAPTCHA_ICON, { type: this.type });
            throw error;
        }
        
        try {
            return await this.provider.getToken();
        } catch (error) {
            handleLog(error, 'CaptchaService.getToken', 'error', CAPTCHA_ICON, { type: this.type });
            throw error;
        }
    }

    /**
     * Resets the provider widget.
     */
    reset() { 
        if (this.initialized) {
            this.provider.reset();
            handleLog('CaptchaService reset', 'CaptchaService.reset', 'debug', CAPTCHA_ICON, { type: this.type });
        }
    }

    /**
     * Destroys the provider widget and marks the service as uninitialised.
     */
    destroy() {
        if (this.initialized) {
            this.provider.destroy();
            this.initialized = false;
            handleLog('CaptchaService destroyed', 'CaptchaService.destroy', 'debug', CAPTCHA_ICON, { type: this.type });
        }
    }

    /**
     * @returns {boolean}
     */
    isEnabled() { 
        return this.initialized; 
    }
}

/**
 * @namespace CaptchaModule
 * @description Singleton facade for the CAPTCHA service.
 * Manages the service lifecycle and exposes a minimal public API.
 */
const CaptchaModule = {

    /** @type {CaptchaService|null} */
    _serviceInstance: null,

    /**
     * Creates and initialises a CaptchaService for the given provider type.
     * @param {string} type    - Provider type: 'turnstile' | 'recaptcha'.
     * @param {string} siteKey - Provider-specific public site key.
     * @param {Object} [options={}] - Provider options forwarded verbatim.
     * @returns {Promise<boolean>}
     */
    async initialize(type, siteKey, options = {}) {
        if (this._serviceInstance) {
            handleLog(
                'CaptchaModule is already initialized. Call destroy() first to reinitialize.',
                'CaptchaModule.initialize', 'warn', CAPTCHA_ICON,
                { currentType: this._serviceInstance.type, newType: type }
            );
            return this._serviceInstance.isEnabled();
        }

        this._serviceInstance = new CaptchaService(type);
        const result = await this._serviceInstance.initialize(siteKey, options);
        
        if (result) {
            handleLog('CaptchaModule initialized', 'CaptchaModule.initialize', 'success', CAPTCHA_ICON, { type, siteKey });
        } else {
            handleLog('CaptchaModule initialization failed', 'CaptchaModule.initialize', 'error', CAPTCHA_ICON, { type, siteKey });
            this._serviceInstance = null;
        }
        
        return result;
    },

    /**
     * Requests a one-time challenge token from the active provider.
     * @returns {Promise<string>}
     */
    async getToken() {
        if (!this._serviceInstance || !this._serviceInstance.isEnabled()) {
            const error = new Error('CaptchaModule is not initialized or failed to initialize. Call initialize() first.');
            handleLog(error, 'CaptchaModule.getToken', 'error', CAPTCHA_ICON, {
                hasInstance: !!this._serviceInstance,
                isEnabled: this._serviceInstance?.isEnabled()
            });
            throw error;
        }

        try {
            const token = await this._serviceInstance.getToken();
            handleLog('Token obtained successfully', 'CaptchaModule.getToken', 'success', CAPTCHA_ICON, {
                tokenLength: token?.length,
                type: this._serviceInstance.type
            });
            return token;
        } catch (error) {
            handleLog(error, 'CaptchaModule.getToken', 'error', CAPTCHA_ICON, {
                type: this._serviceInstance?.type
            });
            throw error;
        }
    },

    /**
     * Resets the active provider widget back to its unchallenged state.
     */
    reset() {
        if (this._serviceInstance) {
            this._serviceInstance.reset();
            handleLog('CaptchaModule reset', 'CaptchaModule.reset', 'debug', CAPTCHA_ICON, {
                type: this._serviceInstance.type
            });
        } else {
            handleLog('Cannot reset, CaptchaModule is not initialized', 'CaptchaModule.reset', 'warn', CAPTCHA_ICON);
        }
    },

    /**
     * Destroys the active service instance and nullifies the reference,
     * allowing a subsequent `initialize()` call with different parameters.
     */
    destroy() {
        if (this._serviceInstance) {
            const type = this._serviceInstance.type;
            this._serviceInstance.destroy();
            this._serviceInstance = null;
            handleLog('CaptchaModule destroyed', 'CaptchaModule.destroy', 'debug', CAPTCHA_ICON, { type });
        }
    },

    /**
     * Returns true if a service instance exists and has been successfully initialised.
     * @returns {boolean}
     */
    isEnabled() {
        return this._serviceInstance ? this._serviceInstance.isEnabled() : false;
    }
};

export default CaptchaModule;