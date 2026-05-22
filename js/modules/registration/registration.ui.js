/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/registration/registration.ui.js */
import handleLog from '../../core/logs.js'; 
import I18n from '../../core/i18n.js';
import Drawer from '../../ui/drawer.js';
import UtilsModule from '../../core/utils.js';

// CONSTANTS
const CONSTANTS = {
    CLASSES: {
        DRAWER_CUSTOM: 'ql-registration__drawer',
        STEP: 'ql-registration__step',
        STEP_ACTIVE: 'ql-registration__step--active',
        GROUP: 'ql-form__group',
        GROUP_FLOATING: 'ql-form__group--floating',
        GROUP_ACTIVE: 'ql-form__group--active',
        INPUT: 'ql-form__input',
        INPUT_ERROR: 'ql-form__input--error',
        ERROR_MSG: 'ql-form__error-message',
        BTN_LOADING: 'ql-button__submit--loading',
        BTN_DISABLED: 'ql-registration__resend--disabled',
        STRENGTH_BAR: 'ql-registration__strength-bar',
        STRENGTH_TEXT: 'ql-registration__strength-text'
    },
    SELECTORS: {
        REG: {
            EMAIL: '.js-ql-reg-email',
            NAME: '.js-ql-reg-name',
            LASTNAME: '.js-ql-reg-lastname',
            PASS: '.js-ql-reg-pass',
            PASS_VERIFY: '.js-ql-reg-pass-verify',
            COUNTRY: '.js-ql-reg-country',
            LANG: '.js-ql-reg-lang',
            TERMS: '.js-ql-reg-terms',
            SUBMIT: '.js-ql-reg-submit',
            VERIFY_BTN: '.js-ql-reg-verify-btn',
            CODE: '.js-ql-reg-code',
            TIMER: '.js-ql-reg-timer',
            RESEND: '.js-ql-reg-resend',
            METER: '.js-ql-reg-meter',
            NOTIF_WEB: '.js-ql-reg-notif-web',
            NOTIF_EMAIL: '.js-ql-reg-notif-email',
            NOTIF_PUSH: '.js-ql-reg-notif-push',
            ERROR: '.js-ql-reg-error'
        },
        REC: {
            EMAIL: '.js-ql-rec-email',
            SUBMIT: '.js-ql-rec-submit',
            VERIFY_BTN: '.js-ql-rec-verify-btn',
            CODE: '.js-ql-rec-code',
            TIMER: '.js-ql-rec-timer',
            RESEND: '.js-ql-rec-resend',
            RESET_BTN: '.js-ql-rec-reset-btn',
            NEW_PASS: '.js-ql-rec-new-pass',
            NEW_PASS_VERIFY: '.js-ql-rec-new-pass-verify',
            METER: '.js-ql-rec-meter',
            ERROR: '.js-ql-rec-error'
        }
    }
};

// _state
let _state = {
    drawers: {
        registration: null,
        recovery: null
    },
    timers: {}
};

// _PrivateServices
function _createLanguageOptions() {
    let options = `<option value="auto">${I18n.getTranslation('autoDetectLanguage')}</option>`;
    const supported = I18n.getSupportedLanguages();
    const names = I18n.getLanguageNames();
    supported.forEach(lang => {
        const key = names[lang] || lang;
        options += `<option value="${lang}" class="t">${key}</option>`;
    });
    return options;
}

function _setupFloatingLabels(container) {
    container.querySelectorAll(`.${CONSTANTS.CLASSES.GROUP_FLOATING} input`).forEach(input => {
        const update = () => {
            if (input.value !== '') input.closest(`.${CONSTANTS.CLASSES.GROUP}`).classList.add(CONSTANTS.CLASSES.GROUP_ACTIVE);
            else input.closest(`.${CONSTANTS.CLASSES.GROUP}`).classList.remove(CONSTANTS.CLASSES.GROUP_ACTIVE);
        };
        input.addEventListener('focus', () => input.closest(`.${CONSTANTS.CLASSES.GROUP}`).classList.add(CONSTANTS.CLASSES.GROUP_ACTIVE));
        input.addEventListener('blur', update);
        input.addEventListener('input', update);
        update();
    });
}

function _updatePasswordMeter(value, meterSelector) {
    const meter = document.querySelector(meterSelector);
    if (!meter) return;

    const bar = meter.querySelector(`.${CONSTANTS.CLASSES.STRENGTH_BAR}`);
    const text = meter.querySelector(`.${CONSTANTS.CLASSES.STRENGTH_TEXT}`);
    const result = UtilsModule.validatePasswordStrength(value);

    if (bar) {
        bar.style.width = `${result.strength * 25}%`;
        bar.className = `${CONSTANTS.CLASSES.STRENGTH_BAR} ql-registration__strength-bar--${result.strength}`;
    }
    if (text) {
        const labelKey = result.strength < 2 ? 'passwordWeak' : result.strength < 4 ? 'passwordMedium' : 'passwordStrong';
        text.textContent = I18n.getTranslation(labelKey);
    }
}

// Public API
const RegistrationUI = {
    initDrawers(callbacks) {
        if (!_state.drawers.registration) {
            _state.drawers.registration = new Drawer({
                id: 'ql-registration',
                customClass: CONSTANTS.CLASSES.DRAWER_CUSTOM,
                title: I18n.getTranslation('signUp'),
                height: '100%',
                zIndex: 9008,
                content: this._getRegistrationHTML()
            });
            this._attachRegistrationEvents(callbacks);
        }
        if (!_state.drawers.recovery) {
            _state.drawers.recovery = new Drawer({
                id: 'ql-recovery',
                customClass: CONSTANTS.CLASSES.DRAWER_CUSTOM,
                title: I18n.getTranslation('passwordRecovery'),
                height: '100%',
                zIndex: 9009,
                content: this._getRecoveryHTML()
            });
            this._attachRecoveryEvents(callbacks);
        }
    },

    openRegistration() {
        if (_state.drawers.registration) {
            handleLog('Opening Registration drawer', 'RegistrationUI', 'log', '🆔');
            this._resetDrawer(_state.drawers.registration.element);
            _state.drawers.registration.open();
            const countrySelect = document.querySelector(CONSTANTS.SELECTORS.REG.COUNTRY);
            if (countrySelect) {
                const browserLang = (navigator.language || 'en').split('-')[1]?.toUpperCase() || '';
                countrySelect.innerHTML = UtilsModule.getCountryOptions(browserLang);
            }
        }
    },

    openRecovery() {
        if (_state.drawers.recovery) {
            handleLog('Opening Recovery drawer', 'RegistrationUI', 'log', '🆔');
            this._resetDrawer(_state.drawers.recovery.element);
            _state.drawers.recovery.open();
        }
    },

    closeAll() {
        if (_state.drawers.registration) _state.drawers.registration.close();
        if (_state.drawers.recovery) _state.drawers.recovery.close();

        Object.values(_state.timers).forEach(timer => clearInterval(timer));
        _state.timers = {};
    },

    setLoading(btnSelector, isLoading) {
        const btn = document.querySelector(btnSelector);
        if (!btn) return;
        if (isLoading) {
            btn.classList.add(CONSTANTS.CLASSES.BTN_LOADING);
            btn.disabled = true;
        } else {
            btn.classList.remove(CONSTANTS.CLASSES.BTN_LOADING);
            btn.disabled = false;
        }
    },

    setInputError(inputSelector, errorKey) {
        const input = document.querySelector(inputSelector);
        if (!input) return;
        
        const group = input.closest(`.${CONSTANTS.CLASSES.GROUP}`);
        let errorEl = group.querySelector(`.${CONSTANTS.CLASSES.ERROR_MSG}`);
        
        if (errorKey) {
            if (!errorEl) {
                errorEl = document.createElement('div');
                errorEl.className = CONSTANTS.CLASSES.ERROR_MSG;
                group.appendChild(errorEl);
            }
            const translatedError = I18n.getTranslation(errorKey);
            errorEl.textContent = translatedError.replace(/{{|}}/g, '');
            input.classList.add(CONSTANTS.CLASSES.INPUT_ERROR);
        } else {
            errorEl?.remove();
            input.classList.remove(CONSTANTS.CLASSES.INPUT_ERROR);
        }
    },

    setFormError(containerSelector, message) {
        const el = document.querySelector(containerSelector);
        if (el) {
            if (message) {
                const cleanMessage = message.replace(/{{|}}/g, '');
                el.textContent = cleanMessage;
            } else {
                el.textContent = '';
            }
        }
    },

    getValues(selectors) {
        const values = {};
        for (const [key, selector] of Object.entries(selectors)) {
            const el = document.querySelector(selector);
            if (el) {
                values[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
            }
        }
        return values;
    },

    showStep(drawerType, stepIndex) {
        const drawer = _state.drawers[drawerType];
        if (!drawer) return;
        handleLog(`Switching to step ${stepIndex} in ${drawerType}`, 'RegistrationUI', 'log', '🆔');
        const steps = drawer.element.querySelectorAll(`.${CONSTANTS.CLASSES.STEP}`);
        steps.forEach((s, idx) => {
            if (idx === stepIndex - 1) {
                s.classList.add(CONSTANTS.CLASSES.STEP_ACTIVE);
            } else {
                s.classList.remove(CONSTANTS.CLASSES.STEP_ACTIVE);
            }
        });
    },

    startTimer(timerSelector, resendSelector, duration = 300) {
        const timerEl = document.querySelector(timerSelector);
        const resendLink = document.querySelector(resendSelector);
        if (!timerEl || !resendLink) return;

        const timerKey = timerSelector; 
        if (_state.timers[timerKey]) clearInterval(_state.timers[timerKey]);

        resendLink.classList.add(CONSTANTS.CLASSES.BTN_DISABLED);
        
        let remaining = duration;
        
        const tick = () => {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            if (remaining <= 0) {
                clearInterval(_state.timers[timerKey]);
                timerEl.textContent = I18n.getTranslation('codeExpired');
                resendLink.classList.remove(CONSTANTS.CLASSES.BTN_DISABLED);
                delete _state.timers[timerKey];
            }
            remaining--;
        };

        tick();
        _state.timers[timerKey] = setInterval(tick, 1000);
    },

    _resetDrawer(element) {
        element.querySelectorAll(`.${CONSTANTS.CLASSES.STEP}`).forEach(s => s.classList.remove(CONSTANTS.CLASSES.STEP_ACTIVE));
        const firstStep = element.querySelector(`.${CONSTANTS.CLASSES.STEP}:first-child`);
        if (firstStep) firstStep.classList.add(CONSTANTS.CLASSES.STEP_ACTIVE);
        element.querySelectorAll('input').forEach(i => {
            if (i.type !== 'checkbox') i.value = '';
            i.classList.remove(CONSTANTS.CLASSES.INPUT_ERROR);
        });
        element.querySelectorAll(`.${CONSTANTS.CLASSES.ERROR_MSG}`).forEach(e => e.remove());
        element.querySelectorAll(`.${CONSTANTS.CLASSES.GROUP_ACTIVE}`).forEach(g => g.classList.remove(CONSTANTS.CLASSES.GROUP_ACTIVE));
        element.querySelectorAll(`.${CONSTANTS.CLASSES.BTN_DISABLED}`).forEach(b => b.classList.remove(CONSTANTS.CLASSES.BTN_DISABLED));
    },

    _getRegistrationHTML() {
        return `
        <div class="ql-registration__step step-1 ql-registration__step--active">
            <fieldset class="ql-registration__fieldset">
                <legend class="ql-registration__legend">${I18n.getTranslation('personalInfo')}</legend>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="email" class="ql-form__input js-ql-reg-email" required autocomplete="email">
                    <label class="ql-form__label">${I18n.getTranslation('userEmail')}</label>
                </div>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="text" class="ql-form__input js-ql-reg-name" required autocomplete="given-name">
                    <label class="ql-form__label">${I18n.getTranslation('firstName')}</label>
                </div>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="text" class="ql-form__input js-ql-reg-lastname" required autocomplete="family-name">
                    <label class="ql-form__label">${I18n.getTranslation('lastName')}</label>
                </div>
            </fieldset>
            <fieldset class="ql-registration__fieldset">
                <legend class="ql-registration__legend">${I18n.getTranslation('accountDetails')}</legend>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="password" class="ql-form__input js-ql-reg-pass" required autocomplete="new-password">
                    <label class="ql-form__label">${I18n.getTranslation('password')}</label>
                    <div class="ql-registration__meter js-ql-reg-meter">
                        <div class="ql-registration__strength-bar"></div>
                        <span class="ql-registration__strength-text"></span>
                    </div>
                </div>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="password" class="ql-form__input js-ql-reg-pass-verify" required autocomplete="new-password">
                    <label class="ql-form__label">${I18n.getTranslation('passwordVerify')}</label>
                </div>
            </fieldset>
            <fieldset class="ql-registration__fieldset">
                <legend class="ql-registration__legend">${I18n.getTranslation('preferences')}</legend>
                <div class="ql-form__group">
                    <select class="ql-form__select js-ql-reg-country"></select>
                </div>
                <div class="ql-form__group">
                    <div class="ql-registration__language-wrapper">
                        <span class="ql-icons-outlined">language</span>
                        <select class="ql-form__select js-ql-reg-lang">${_createLanguageOptions()}</select>
                        <span class="ql-icons-outlined">arrow_drop_down</span>
                    </div>
                </div>
            </fieldset>
            <fieldset class="ql-registration__fieldset">
                <legend class="ql-registration__legend">${I18n.getTranslation('notifications')}</legend>
                <div class="ql-settings__option">
                    <span>${I18n.getTranslation('webNotifications')}</span>
                    <label class="ql-switch">
                        <input type="checkbox" class="ql-switch__input js-ql-reg-notif-web" checked>
                        <span class="ql-switch__slider"></span>
                    </label>
                </div>
                <div class="ql-settings__option">
                    <span>${I18n.getTranslation('emailNotifications')}</span>
                    <label class="ql-switch">
                        <input type="checkbox" class="ql-switch__input js-ql-reg-notif-email" checked>
                        <span class="ql-switch__slider"></span>
                    </label>
                </div>
                <div class="ql-settings__option">
                    <span>${I18n.getTranslation('pushNotifications')}</span>
                    <label class="ql-switch">
                        <input type="checkbox" class="ql-switch__input js-ql-reg-notif-push" checked>
                        <span class="ql-switch__slider"></span>
                    </label>
                </div>
            </fieldset>
            <div class="ql-registration__terms">
                <textarea class="ql-registration__terms-text" readonly>${I18n.getTranslation('termsAndConditions')}</textarea>
                <label>
                    <input type="checkbox" class="js-ql-reg-terms"> 
                    <span>${I18n.getTranslation('iAcceptTheTerms')}</span>
                </label>
            </div>
            <button class="ql-button__submit js-ql-reg-submit" disabled>
                <span>${I18n.getTranslation('signUp')}</span>
            </button>
            <div class="ql-registration__form-error js-ql-reg-error"></div>
        </div>
        <div class="ql-registration__step step-2 ql-registration__step--center">
            <p class="ql-registration__verification-intro">${I18n.getTranslation('verificationIntro')}</p>
            <div class="ql-form__group">
                <input type="text" class="ql-form__input ql-form__input--code js-ql-reg-code" placeholder="${I18n.getTranslation('enterCodePlaceholder')}" maxlength="6">
            </div>
            <div class="ql-registration__timer js-ql-reg-timer">05:00</div>
            <button class="ql-button__submit js-ql-reg-verify-btn">
                <span>${I18n.getTranslation('verify')}</span>
            </button>
            <a href="#" class="ql-registration__resend js-ql-reg-resend ql-registration__resend--disabled">${I18n.getTranslation('resendCode')}</a>
            <div class="ql-registration__form-error js-ql-reg-error"></div>
        </div>`;
    },

    _getRecoveryHTML() {
        return `
        <div class="ql-registration__step step-1 ql-registration__step--active">
            <p style="margin-bottom: 20px;">${I18n.getTranslation('recoveryIntro')}</p>
            <fieldset class="ql-registration__fieldset">
                <legend class="ql-registration__legend">${I18n.getTranslation('accountDetails')}</legend>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="email" class="ql-form__input js-ql-rec-email" required autocomplete="email">
                    <label class="ql-form__label">${I18n.getTranslation('userEmail')}</label>
                </div>
            </fieldset>
            <button class="ql-button__submit js-ql-rec-submit">
                <span>${I18n.getTranslation('sendCode')}</span>
            </button>
            <div class="ql-registration__form-error js-ql-rec-error"></div>
        </div>
        <div class="ql-registration__step step-2 ql-registration__step--center">
            <p class="ql-registration__verification-intro">${I18n.getTranslation('recoveryCodeIntro')}</p>
            <div class="ql-form__group">
                <input type="text" class="ql-form__input ql-form__input--code js-ql-rec-code" placeholder="${I18n.getTranslation('enterCodePlaceholder')}" maxlength="6">
            </div>
            <div class="ql-registration__timer js-ql-rec-timer">05:00</div>
            <button class="ql-button__submit js-ql-rec-verify-btn">
                <span>${I18n.getTranslation('verify')}</span>
            </button>
            <a href="#" class="ql-registration__resend js-ql-rec-resend ql-registration__resend--disabled">${I18n.getTranslation('resendCode')}</a>
            <div class="ql-registration__form-error js-ql-rec-error"></div>
        </div>
        <div class="ql-registration__step step-3">
            <p style="margin-bottom: 20px;">${I18n.getTranslation('setNewPassword')}</p>
            <fieldset class="ql-registration__fieldset">
                <legend class="ql-registration__legend">${I18n.getTranslation('security')}</legend>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="password" class="ql-form__input js-ql-rec-new-pass" required autocomplete="new-password">
                    <label class="ql-form__label">${I18n.getTranslation('newPassword')}</label>
                    <div class="ql-registration__meter js-ql-rec-meter">
                        <div class="ql-registration__strength-bar"></div>
                        <span class="ql-registration__strength-text"></span>
                    </div>
                </div>
                <div class="ql-form__group ql-form__group--floating">
                    <input type="password" class="ql-form__input js-ql-rec-new-pass-verify" required autocomplete="new-password">
                    <label class="ql-form__label">${I18n.getTranslation('passwordVerify')}</label>
                </div>
            </fieldset>
            <button class="ql-button__submit js-ql-rec-reset-btn">
                <span>${I18n.getTranslation('changePassword')}</span>
            </button>
            <div class="ql-registration__form-error js-ql-rec-error"></div>
        </div>`;
    },

    _attachRegistrationEvents(callbacks) {
        const el = _state.drawers.registration.element;
        _setupFloatingLabels(el);

        const terms = el.querySelector(CONSTANTS.SELECTORS.REG.TERMS);
        const submit = el.querySelector(CONSTANTS.SELECTORS.REG.SUBMIT);
        const pass = el.querySelector(CONSTANTS.SELECTORS.REG.PASS);
        const lang = el.querySelector(CONSTANTS.SELECTORS.REG.LANG);

        if (terms) terms.addEventListener('change', () => submit.disabled = !terms.checked);
        if (pass) pass.addEventListener('input', (e) => _updatePasswordMeter(e.target.value, CONSTANTS.SELECTORS.REG.METER));
        if (lang) lang.addEventListener('change', (e) => { 
            if (e.target.value !== 'auto') I18n.changeLanguage(e.target.value); 
        });
        
        el.querySelector(CONSTANTS.SELECTORS.REG.SUBMIT)?.addEventListener('click', (e) => { e.preventDefault(); callbacks.onRegister(); });
        el.querySelector(CONSTANTS.SELECTORS.REG.VERIFY_BTN)?.addEventListener('click', (e) => { e.preventDefault(); callbacks.onVerify(); });
        el.querySelector(CONSTANTS.SELECTORS.REG.RESEND)?.addEventListener('click', (e) => { 
            e.preventDefault(); 
            if (!e.target.classList.contains(CONSTANTS.CLASSES.BTN_DISABLED)) {
                callbacks.onResend(); 
            }
        });
    },

    _attachRecoveryEvents(callbacks) {
        const el = _state.drawers.recovery.element;
        _setupFloatingLabels(el);
        
        const newPass = el.querySelector(CONSTANTS.SELECTORS.REC.NEW_PASS);
        if (newPass) newPass.addEventListener('input', (e) => _updatePasswordMeter(e.target.value, CONSTANTS.SELECTORS.REC.METER));

        el.querySelector(CONSTANTS.SELECTORS.REC.SUBMIT)?.addEventListener('click', (e) => { e.preventDefault(); callbacks.onRecoveryStart(); });
        el.querySelector(CONSTANTS.SELECTORS.REC.VERIFY_BTN)?.addEventListener('click', (e) => { e.preventDefault(); callbacks.onRecoveryVerify(); });
        el.querySelector(CONSTANTS.SELECTORS.REC.RESET_BTN)?.addEventListener('click', (e) => { e.preventDefault(); callbacks.onRecoveryReset(); });
        el.querySelector(CONSTANTS.SELECTORS.REC.RESEND)?.addEventListener('click', (e) => { 
            e.preventDefault(); 
            if (!e.target.classList.contains(CONSTANTS.CLASSES.BTN_DISABLED)) {
                callbacks.onRecoveryResend(); 
            }
        });
    }
};

export default RegistrationUI;