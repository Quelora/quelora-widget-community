/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/registration/registration.js */
/**
 * @module Modules/Registration
 * @description Manages User Registration, Password Recovery, and Verification.
 * Refactored to react to Session Events (Event-Driven) for UI cleanup.
 *
 * Fix 1 — Toast auto-dismiss: all ToastModule calls were missing a `duration`
 * argument, causing every toast to remain visible indefinitely (duration = 0
 * means "never auto-dismiss" per toast.js contract). A module-level constant
 * `TOAST_DURATION` (2 000 ms) is now forwarded as the fifth argument to every
 * `ToastModule.error`, `ToastModule.success`, and `ToastModule.show` call.
 *
 * Fix 2 — Token expiry parsing: the backend returns `expiresIn` as a
 * human-readable duration string (e.g. `"72h"`, `"1h"`, `"30m"`).
 * Passing it directly to `SessionModule.resolveSuccess` caused `parseInt`
 * to strip the unit suffix, yielding a value in the wrong order of magnitude
 * (e.g. `72` instead of `259200` seconds). `ql_sso_token_expires` was
 * therefore set ~72 ms in the future and evaluated as expired on the very
 * next storage read, making every post-registration token lookup return null.
 * A `_parseExpiresIn` helper now converts the string to seconds before the
 * value reaches `resolveSuccess`.
 *
 * @version 3.3.0
 */

import handleLog from '../../core/logs.js';
import RegistrationUI from './registration.ui.js';
import UtilsModule from '../../core/utils.js';
import CaptchaModule from '../../services/captcha.js';
import ProfileModule from '../profile/profile.js';
import SessionModule from '../../core/session.js';
import ToastModule from '../../ui/toast.js';
import I18n from '../../core/i18n.js';
import CoreModule from '../../core/core.js';
import { eventBus } from '../../core/event.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const CONSTANTS = {
    ENDPOINTS: {
        REGISTER:       '/auth/register',
        VERIFY:         '/auth/verify-code',
        RECOVER_START:  '/auth/password/recover/start',
        RECOVER_VERIFY: '/auth/password/recover/verify',
        RESET:          '/auth/password/reset'
    },
    REGEX: {
        EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    },
    SELECTORS: {
        REG: {
            EMAIL:      '.js-ql-reg-email',
            NAME:       '.js-ql-reg-name',
            LASTNAME:   '.js-ql-reg-lastname',
            PASS:       '.js-ql-reg-pass',
            PASS_VERIFY:'.js-ql-reg-pass-verify',
            COUNTRY:    '.js-ql-reg-country',
            LANG:       '.js-ql-reg-lang',
            TERMS:      '.js-ql-reg-terms',
            SUBMIT:     '.js-ql-reg-submit',
            VERIFY_BTN: '.js-ql-reg-verify-btn',
            CODE:       '.js-ql-reg-code',
            TIMER:      '.js-ql-reg-timer',
            RESEND:     '.js-ql-reg-resend',
            ERROR:      '.js-ql-reg-error',
            NOTIF_WEB:  '.js-ql-reg-notif-web',
            NOTIF_EMAIL:'.js-ql-reg-notif-email',
            NOTIF_PUSH: '.js-ql-reg-notif-push'
        },
        REC: {
            EMAIL:          '.js-ql-rec-email',
            SUBMIT:         '.js-ql-rec-submit',
            VERIFY_BTN:     '.js-ql-rec-verify-btn',
            CODE:           '.js-ql-rec-code',
            TIMER:          '.js-ql-rec-timer',
            RESEND:         '.js-ql-rec-resend',
            RESET_BTN:      '.js-ql-rec-reset-btn',
            NEW_PASS:       '.js-ql-rec-new-pass',
            NEW_PASS_VERIFY:'.js-ql-rec-new-pass-verify',
            ERROR:          '.js-ql-rec-error'
        }
    }
};

/**
 * Auto-dismiss duration in milliseconds applied to every toast notification
 * triggered by the registration and recovery flows.
 *
 * A value of `0` means "never auto-dismiss" per the ToastModule contract.
 * Setting this to `2000` ensures all registration toasts close after 2 s.
 *
 * @constant {number}
 */
const TOAST_DURATION = 2000;

/**
 * Converts a backend `expiresIn` value to a plain number of seconds.
 *
 * The backend may return either a numeric value (already in seconds) or a
 * human-readable duration string such as `"72h"`, `"30m"`, or `"3600s"`.
 * Passing the raw string directly to `SessionModule.resolveSuccess` causes
 * `parseInt` inside that function to strip the unit suffix, producing a value
 * in the wrong order of magnitude (e.g. `72` instead of `259 200`), which
 * makes `ql_sso_token_expires` expire almost immediately.
 *
 * Supported unit suffixes: `h` (hours), `m` (minutes), `s` (seconds).
 * Falls back to `DEFAULT_EXPIRES_IN_SECONDS` for any unrecognised format.
 *
 * @param {string|number} raw                          - Raw `expiresIn` value from the API response.
 * @param {number}        [fallback=3600]              - Fallback value in seconds when parsing fails.
 * @returns {number} Duration expressed as a whole number of seconds.
 */
function _parseExpiresIn(raw, fallback = 3600) {
    if (typeof raw === 'number' && raw > 0) return raw;
    if (typeof raw !== 'string') return fallback;

    const match = raw.trim().match(/^(\d+)(h|m|s)?$/i);
    if (!match) return fallback;

    const value = parseInt(match[1], 10);
    const unit  = (match[2] || 's').toLowerCase();

    const multipliers = { h: 3600, m: 60, s: 1 };
    return value * (multipliers[unit] ?? 1);
}

// =============================================================================
// ERROR KEY → INPUT FIELD MAPPING
// =============================================================================

/** @type {Object.<string, string|string[]>} */
const ERROR_FIELD_MAP = {
    emailInUse:         CONSTANTS.SELECTORS.REG.EMAIL,
    invalidEmailFormat: CONSTANTS.SELECTORS.REG.EMAIL,
    codeExpired:        [CONSTANTS.SELECTORS.REG.CODE,      CONSTANTS.SELECTORS.REC.CODE],
    verificationError:  [CONSTANTS.SELECTORS.REG.CODE,      CONSTANTS.SELECTORS.REC.CODE],
    profileNotFound:    CONSTANTS.SELECTORS.REC.EMAIL,
    passwordRequirements:[CONSTANTS.SELECTORS.REG.PASS,     CONSTANTS.SELECTORS.REC.NEW_PASS],
    passwordsDoNotMatch:[CONSTANTS.SELECTORS.REG.PASS_VERIFY, CONSTANTS.SELECTORS.REC.NEW_PASS_VERIFY],
    requiredField:      [CONSTANTS.SELECTORS.REG.EMAIL,     CONSTANTS.SELECTORS.REC.EMAIL],
    invalidNameFormat:  [CONSTANTS.SELECTORS.REG.NAME,      CONSTANTS.SELECTORS.REG.LASTNAME],
    selectCountry:      CONSTANTS.SELECTORS.REG.COUNTRY
};

// =============================================================================
// MODULE STATE
// =============================================================================

let _state = {
    context: {
        regEmail: '',
        recEmail: '',
        recToken: ''
    }
};

// =============================================================================
// EVENT BUS LISTENERS
// =============================================================================

/**
 * Automatically closes registration/recovery drawers upon a successful login
 * or session restoration so the user is never left with a stale modal open.
 */
eventBus.on('SESSION_ESTABLISHED', () => {
    handleLog('SESSION_ESTABLISHED received, closing drawers', 'Registration', 'log', '🆔');
    RegistrationUI.closeAll();
});

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Validates a single form input against a predicate, applying inline error
 * feedback via {@link RegistrationUI.setInputError}.
 *
 * @param {string}   selector  - CSS selector for the target input element.
 * @param {Function} checkFn   - Predicate that receives the trimmed value and returns `boolean`.
 * @param {string}   errorKey  - I18n error key applied when the check fails.
 * @param {boolean}  [required=true] - When `true`, empty values are treated as invalid.
 * @returns {boolean} `true` when the field is valid.
 */
function _validateField(selector, checkFn, errorKey, required = true) {
    const el = document.querySelector(selector);
    if (!el) return false;
    const val = el.value.trim();
    if (required && val === '') {
        RegistrationUI.setInputError(selector, 'requiredField');
        return false;
    }
    if (!required && val === '') {
        RegistrationUI.setInputError(selector, null);
        return true;
    }
    if (!checkFn(val)) {
        RegistrationUI.setInputError(selector, errorKey);
        return false;
    }
    RegistrationUI.setInputError(selector, null);
    return true;
}

/**
 * Runs all validation rules for the registration form.
 *
 * @returns {boolean} `true` when every field passes validation.
 */
function _validateRegistrationForm() {
    let valid = true;
    valid &= _validateField(CONSTANTS.SELECTORS.REG.EMAIL,    v => CONSTANTS.REGEX.EMAIL.test(v), 'invalidEmailFormat');
    valid &= _validateField(CONSTANTS.SELECTORS.REG.NAME,     v => v.length >= 2,                 'invalidNameFormat');
    valid &= _validateField(CONSTANTS.SELECTORS.REG.LASTNAME, v => v.length >= 2,                 'invalidNameFormat');
    valid &= _validateField(CONSTANTS.SELECTORS.REG.COUNTRY,  v => v !== '',                      'selectCountry');

    const pass = document.querySelector(CONSTANTS.SELECTORS.REG.PASS);
    if (pass) {
        const strength = UtilsModule.validatePasswordStrength(pass.value);
        if (!strength.isValid) {
            RegistrationUI.setInputError(CONSTANTS.SELECTORS.REG.PASS, 'passwordRequirements');
            valid = false;
        } else {
            RegistrationUI.setInputError(CONSTANTS.SELECTORS.REG.PASS, null);
        }
    }

    const pass2 = document.querySelector(CONSTANTS.SELECTORS.REG.PASS_VERIFY);
    if (pass2 && pass && pass.value !== pass2.value) {
        RegistrationUI.setInputError(CONSTANTS.SELECTORS.REG.PASS_VERIFY, 'passwordsDoNotMatch');
        valid = false;
    } else {
        RegistrationUI.setInputError(CONSTANTS.SELECTORS.REG.PASS_VERIFY, null);
    }

    return Boolean(valid);
}

/**
 * Extracts a normalised error key from an API response payload.
 *
 * Returns `null` when the payload describes a success condition so that
 * callers can use a single guard: `if (!errorKey) { /* success *\/ }`.
 *
 * @param {Object} payload - Raw response object from the worker.
 * @returns {string|null} Normalised error key, or `null` for success responses.
 */
function _extractErrorKey(payload) {
    let key = payload.error || payload.message || payload.details?.error || 'error';

    if (key.startsWith('{{') && key.endsWith('}}')) {
        key = key.replace(/{{|}}/g, '');
    }

    const successKeywords = [
        'Password recovery code sending initiated',
        'recovery code',
        'verification code',
        'code sending',
        'initiated',
        'success'
    ];

    const isSuccessMessage = successKeywords.some(
        keyword => key.toLowerCase().includes(keyword.toLowerCase())
    );

    return isSuccessMessage ? null : key;
}

/**
 * Displays an error toast and applies inline field/form error feedback.
 *
 * The toast auto-dismisses after {@link TOAST_DURATION} milliseconds.
 *
 * @param {Object}  payload          - Raw response object from the worker.
 * @param {string}  genericSelector  - Fallback form-error container selector used when
 *   the error key does not map to a specific input field.
 * @param {boolean} [showToast=true] - When `false`, suppresses the toast notification.
 * @returns {void}
 */
function _handleError(payload, genericSelector, showToast = true) {
    const errorKey = _extractErrorKey(payload);
    if (!errorKey) {
        RegistrationUI.setFormError(genericSelector, null);
        return;
    }

    const translatedMessage = I18n.getTranslation(errorKey);
    let targetInput = ERROR_FIELD_MAP[errorKey];

    if (Array.isArray(targetInput)) {
        targetInput = targetInput.find(sel => {
            const el = document.querySelector(sel);
            return el && el.offsetParent !== null;
        });
    }

    if (showToast) {
        ToastModule.error(null, I18n.getTranslation('error'), translatedMessage, null, TOAST_DURATION);
    }

    if (targetInput) {
        RegistrationUI.setFormError(genericSelector, null);
        RegistrationUI.setInputError(targetInput, errorKey);
    } else {
        const displayMessage = translatedMessage || errorKey;
        RegistrationUI.setFormError(genericSelector, displayMessage);
    }
}

/**
 * Displays a success toast notification.
 *
 * The toast auto-dismisses after {@link TOAST_DURATION} milliseconds.
 *
 * @param {Object}  payload              - Raw response object (currently unused, reserved for future use).
 * @param {string|null} [messageKey=null] - I18n key for the toast body. No toast is shown when `null`.
 * @param {boolean} [showToast=true]     - When `false`, suppresses the toast notification.
 * @returns {void}
 */
function _handleSuccess(payload, messageKey = null, showToast = true) {
    if (showToast && messageKey) {
        const translatedMessage = I18n.getTranslation(messageKey);
        ToastModule.success(null, I18n.getTranslation('info'), translatedMessage, null, TOAST_DURATION);
    }
}

/**
 * Dispatches an API request through the internal worker via `fetchProxy`.
 *
 * Handles captcha token acquisition, loading-state toggling, and stale
 * inline error cleanup before posting the message.
 *
 * @async
 * @param {string} action          - Logical action label (used for logging only).
 * @param {string} endpoint        - API endpoint path (relative to the base URL).
 * @param {Object} body            - Request body serialised as JSON.
 * @param {string} responseAction  - Worker response-action key routed to the registered handler.
 * @param {string} btnSelector     - CSS selector for the submit button to toggle loading state.
 * @returns {Promise<void>}
 */
async function _sendRequest(action, endpoint, body, responseAction, btnSelector) {
    if (btnSelector) RegistrationUI.setLoading(btnSelector, true);

    if (btnSelector) {
        const formStep = document.querySelector(btnSelector)?.closest('.ql-registration__step');
        if (formStep) {
            formStep.querySelectorAll('.ql-form__input--error').forEach(input => {
                input.classList.remove('ql-form__input--error');
            });
            formStep.querySelectorAll('.ql-form__error-message').forEach(msg => msg.remove());
            formStep.querySelectorAll('.ql-registration__form-error').forEach(el => {
                el.textContent = '';
            });
        }
    }

    let captchaToken = null;
    if (CaptchaModule.isEnabled()) {
        try {
            captchaToken = await CaptchaModule.getToken();
        } catch (e) {
            if (btnSelector) RegistrationUI.setLoading(btnSelector, false);
            ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('captchaError'), null, TOAST_DURATION);
            return;
        }
    }

    const workerPayload = {
        endpoint,
        method: 'POST',
        body,
        captchaToken,
        responseAction,
        errorAction: 'reg_error'
    };

    if (endpoint === CONSTANTS.ENDPOINTS.RESET && _state.context.recToken) {
        workerPayload.headers = { 'Authorization': `Bearer ${_state.context.recToken}` };
        if (workerPayload.body?.token) {
            delete workerPayload.body.token;
        }
    }

    CoreModule.postWorkerMessage({ action: 'fetchProxy', payload: workerPayload });
}

// =============================================================================
// PUBLIC MODULE
// =============================================================================

const RegistrationModule = {
    /**
     * Initialises the Registration module.
     *
     * Registers all worker-response handlers, initialises the UI drawers,
     * and wires up all user interaction callbacks.
     *
     * @async
     * @param {Object} worker        - The shared Web Worker instance.
     * @param {Object} sharedModules - Shared module registry exposing `registerHandler`.
     * @returns {Promise<void>}
     */
    async init(worker, sharedModules) {
        handleLog('init called', 'RegistrationModule', 'log', '🆔');

        try {
            await I18n.loadModuleTranslations('profile');
        } catch (e) {
            handleLog(e, 'RegistrationModule', 'warn', '🆔');
        }

        const handlers = {
            /**
             * Handles the response to the initial registration request.
             * On success, advances the drawer to the OTP verification step.
             *
             * @param {Object} payload - Worker response payload.
             */
            reg_registered: (payload) => {
                RegistrationUI.setLoading(CONSTANTS.SELECTORS.REG.SUBMIT, false);
                RegistrationUI.setLoading(CONSTANTS.SELECTORS.REG.RESEND, false);

                const successMessages = [
                    'Password recovery code sending initiated.',
                    'verification code',
                    'success',
                    'Verification code sent successfully.',
                    'code sending initiated'
                ];

                const isSuccess = successMessages.some(msg =>
                    (payload.message && payload.message.includes(msg)) ||
                    payload.status === 'success' ||
                    payload.message === 'success'
                );

                if (isSuccess) {
                    _handleSuccess(payload, 'verificationCodeSent', true);
                    RegistrationUI.showStep('registration', 2);
                    RegistrationUI.startTimer(CONSTANTS.SELECTORS.REG.TIMER, CONSTANTS.SELECTORS.REG.RESEND);
                } else {
                    _handleError(payload, CONSTANTS.SELECTORS.REG.ERROR, true);
                }
            },

            /**
             * Handles the OTP verification response.
             * On success, persists the profile and resolves the session.
             * SESSION_ESTABLISHED (emitted by SessionModule) closes the drawers via eventBus.
             *
             * @param {Object} payload - Worker response payload containing `token` and `profile`.
             */
            reg_verified: (payload) => {
                RegistrationUI.setLoading(CONSTANTS.SELECTORS.REG.VERIFY_BTN, false);
                if (payload.token) {
                    _handleSuccess(payload, 'registrationSuccess', true);
                    if (payload.profile) ProfileModule.saveMyProfile(payload.profile);
                    SessionModule.resolveSuccess(payload.token, _parseExpiresIn(payload.expiresIn));
                } else {
                    _handleError(payload, CONSTANTS.SELECTORS.REG.ERROR, true);
                }
            },

            /**
             * Handles the response to the password-recovery initiation request.
             * On success, advances the recovery drawer to the OTP verification step.
             *
             * @param {Object} payload - Worker response payload.
             */
            reg_recoverStarted: (payload) => {
                RegistrationUI.setLoading(CONSTANTS.SELECTORS.REC.SUBMIT, false);
                RegistrationUI.setLoading(CONSTANTS.SELECTORS.REC.RESEND, false);

                const successMessages = [
                    'Password recovery code sending initiated.',
                    'recovery code',
                    'success',
                    'Verification code sent successfully.',
                    'code sending initiated'
                ];

                const isSuccess = successMessages.some(msg =>
                    (payload.message && payload.message.includes(msg)) ||
                    payload.status === 'success' ||
                    payload.message === 'success'
                );

                if (isSuccess) {
                    _handleSuccess(payload, 'passwordRecoveryCodeSent', true);
                    RegistrationUI.showStep('recovery', 2);
                    RegistrationUI.startTimer(CONSTANTS.SELECTORS.REC.TIMER, CONSTANTS.SELECTORS.REC.RESEND);
                } else {
                    _handleError(payload, CONSTANTS.SELECTORS.REC.ERROR, true);
                }
            },

            /**
             * Handles the recovery OTP verification response.
             * On success, stores the reset token and advances to the new-password step.
             *
             * @param {Object} payload - Worker response payload containing `resetToken`.
             */
            reg_recoverVerified: (payload) => {
                RegistrationUI.setLoading(CONSTANTS.SELECTORS.REC.VERIFY_BTN, false);
                if (payload.resetToken) {
                    _state.context.recToken = payload.resetToken;
                    _handleSuccess(payload, 'recoveryVerified', true);
                    RegistrationUI.showStep('recovery', 3);
                } else {
                    _handleError(payload, CONSTANTS.SELECTORS.REC.ERROR, true);
                }
            },

            /**
             * Handles the password-reset response.
             * On success, attempts an automatic login; falls back to closing the drawer
             * and showing a confirmation toast when auto-login is not possible.
             *
             * @param {Object} payload - Worker response payload.
             */
            reg_reset: (payload) => {
                RegistrationUI.setLoading(CONSTANTS.SELECTORS.REC.RESET_BTN, false);

                const successMessages = [
                    'success',
                    'Password updated successfully.',
                    'password updated',
                    'Password reset successfully'
                ];

                const isSuccess = successMessages.some(msg =>
                    (payload.message && payload.message.includes(msg)) ||
                    (typeof payload === 'string' && payload.includes(msg)) ||
                    payload.status === 'success' ||
                    payload.message === 'success'
                );

                if (isSuccess) {
                    _handleSuccess(payload, 'passwordResetSuccess', true);

                    const newPass = document.querySelector(CONSTANTS.SELECTORS.REC.NEW_PASS)?.value;
                    if (_state.context.recEmail && newPass) {
                        SessionModule.performLogin(_state.context.recEmail, newPass, null, null)
                            .then(() => {
                                // Drawer closes automatically via SESSION_ESTABLISHED on the eventBus.
                            })
                            .catch((loginError) => {
                                handleLog(`Auto-login failed: ${loginError.message}`, 'Registration', 'warn', '🆔');
                                RegistrationUI.closeAll();
                                SessionModule.getToken(false, true);
                            });
                    } else {
                        RegistrationUI.closeAll();
                        ToastModule.success(
                            null,
                            I18n.getTranslation('info'),
                            I18n.getTranslation('passwordResetSuccess'),
                            null,
                            TOAST_DURATION
                        );
                    }
                } else {
                    _handleError(payload, CONSTANTS.SELECTORS.REC.ERROR, true);
                }
            },

            /**
             * Generic error handler for any failed registration or recovery request.
             * Resets all loading states before delegating to `_handleError`.
             *
             * @param {Object} payload - Worker error payload.
             */
            reg_error: (payload) => {
                const isReg = document.querySelector('.ql-registration__drawer')?.classList.contains('active');
                const selector = isReg ? CONSTANTS.SELECTORS.REG.ERROR : CONSTANTS.SELECTORS.REC.ERROR;

                [
                    CONSTANTS.SELECTORS.REG.SUBMIT,
                    CONSTANTS.SELECTORS.REG.VERIFY_BTN,
                    CONSTANTS.SELECTORS.REC.SUBMIT,
                    CONSTANTS.SELECTORS.REC.VERIFY_BTN,
                    CONSTANTS.SELECTORS.REC.RESET_BTN
                ].forEach(s => RegistrationUI.setLoading(s, false));

                _handleError(payload, selector, true);
            }
        };

        if (sharedModules && sharedModules.registerHandler) {
            Object.keys(handlers).forEach(key => {
                sharedModules.registerHandler(key, handlers[key]);
            });
        }

        RegistrationUI.initDrawers({
            onRegister: () => {
                if (_validateRegistrationForm()) {
                    const vals = RegistrationUI.getValues({
                        email:       CONSTANTS.SELECTORS.REG.EMAIL,
                        name:        CONSTANTS.SELECTORS.REG.NAME,
                        lastName:    CONSTANTS.SELECTORS.REG.LASTNAME,
                        password:    CONSTANTS.SELECTORS.REG.PASS,
                        country:     CONSTANTS.SELECTORS.REG.COUNTRY,
                        language:    CONSTANTS.SELECTORS.REG.LANG,
                        web:         CONSTANTS.SELECTORS.REG.NOTIF_WEB,
                        emailNotif:  CONSTANTS.SELECTORS.REG.NOTIF_EMAIL,
                        push:        CONSTANTS.SELECTORS.REG.NOTIF_PUSH,
                        terms:       CONSTANTS.SELECTORS.REG.TERMS
                    });

                    if (!vals.terms) {
                        ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('acceptTermsRequired'), null, TOAST_DURATION);
                        return;
                    }

                    _state.context.regEmail = vals.email;

                    const browserLang = (navigator.language || navigator.userLanguage || 'en').split('-')[0];
                    const finalLang   = vals.language === 'auto' ? browserLang : vals.language;

                    _sendRequest('register', CONSTANTS.ENDPOINTS.REGISTER, {
                        email:    vals.email,
                        name:     vals.name,
                        lastName: vals.lastName,
                        password: vals.password,
                        country:  vals.country,
                        language: finalLang,
                        settings: { notifications: { web: vals.web, email: vals.emailNotif, push: vals.push } }
                    }, 'reg_registered', CONSTANTS.SELECTORS.REG.SUBMIT);
                } else {
                    ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('fillAllFields'), null, TOAST_DURATION);
                }
            },

            onVerify: () => {
                const code = document.querySelector(CONSTANTS.SELECTORS.REG.CODE)?.value;
                if (!code || code.length < 6) {
                    ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('verificationCodeRequired'), null, TOAST_DURATION);
                    RegistrationUI.setInputError(CONSTANTS.SELECTORS.REG.CODE, 'verificationCodeRequired');
                    return;
                }
                _sendRequest('verify', CONSTANTS.ENDPOINTS.VERIFY, {
                    email: _state.context.regEmail,
                    code
                }, 'reg_verified', CONSTANTS.SELECTORS.REG.VERIFY_BTN);
            },

            onResend: () => {
                if (!_state.context.regEmail) {
                    ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('emailRequiredForResend'), null, TOAST_DURATION);
                    return;
                }
                _sendRequest('resend', CONSTANTS.ENDPOINTS.REGISTER, {
                    email:    _state.context.regEmail,
                    isResend: true
                }, 'reg_registered', CONSTANTS.SELECTORS.REG.RESEND);
            },

            onRecoveryStart: () => {
                if (_validateField(CONSTANTS.SELECTORS.REC.EMAIL, v => CONSTANTS.REGEX.EMAIL.test(v), 'invalidEmailFormat')) {
                    const email = document.querySelector(CONSTANTS.SELECTORS.REC.EMAIL).value;
                    _state.context.recEmail = email;
                    _sendRequest('rec_start', CONSTANTS.ENDPOINTS.RECOVER_START, { email }, 'reg_recoverStarted', CONSTANTS.SELECTORS.REC.SUBMIT);
                }
            },

            onRecoveryVerify: () => {
                const code = document.querySelector(CONSTANTS.SELECTORS.REC.CODE)?.value;
                if (!code || code.length < 6) {
                    ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('verificationCodeRequired'), null, TOAST_DURATION);
                    RegistrationUI.setInputError(CONSTANTS.SELECTORS.REC.CODE, 'verificationCodeRequired');
                    return;
                }
                _sendRequest('rec_verify', CONSTANTS.ENDPOINTS.RECOVER_VERIFY, {
                    email: _state.context.recEmail,
                    code
                }, 'reg_recoverVerified', CONSTANTS.SELECTORS.REC.VERIFY_BTN);
            },

            onRecoveryReset: () => {
                const p1 = document.querySelector(CONSTANTS.SELECTORS.REC.NEW_PASS)?.value;
                const p2 = document.querySelector(CONSTANTS.SELECTORS.REC.NEW_PASS_VERIFY)?.value;
                const validPass = UtilsModule.validatePasswordStrength(p1).isValid;

                if (!validPass) {
                    RegistrationUI.setInputError(CONSTANTS.SELECTORS.REC.NEW_PASS, 'passwordRequirements');
                    ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('passwordRequirements'), null, TOAST_DURATION);
                    return;
                }
                if (p1 !== p2) {
                    RegistrationUI.setInputError(CONSTANTS.SELECTORS.REC.NEW_PASS_VERIFY, 'passwordsDoNotMatch');
                    ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('passwordsDoNotMatch'), null, TOAST_DURATION);
                    return;
                }

                _sendRequest('reset', CONSTANTS.ENDPOINTS.RESET, { newPassword: p1 }, 'reg_reset', CONSTANTS.SELECTORS.REC.RESET_BTN);
            },

            onRecoveryResend: () => {
                if (!_state.context.recEmail) {
                    ToastModule.error(null, I18n.getTranslation('error'), I18n.getTranslation('emailRequiredForResend'), null, TOAST_DURATION);
                    return;
                }
                _sendRequest('rec_resend', CONSTANTS.ENDPOINTS.RECOVER_START, {
                    email: _state.context.recEmail
                }, 'reg_recoverStarted', CONSTANTS.SELECTORS.REC.RESEND);
            }
        });
    },

    /**
     * Opens the registration drawer.
     * @returns {void}
     */
    initRegistrationFlow() {
        RegistrationUI.openRegistration();
    },

    /**
     * Opens the password-recovery drawer.
     * @returns {void}
     */
    initRecoveryFlow() {
        RegistrationUI.openRecovery();
    },

    /**
     * Closes all registration and recovery drawers programmatically.
     * @returns {void}
     */
    closeAllDrawers() {
        RegistrationUI.closeAll();
    }
};

export default RegistrationModule;