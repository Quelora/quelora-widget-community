/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/ui/modal.js */
/**
 * @module UI/Modal
 * @description Singleton modal controller for the Quelora widget.
 * Encapsulates DOM nodes and exposes strict UI mutation boundaries to prevent
 * unauthorized structural interference by consuming modules.
 * @version 3.0.0
 */
import handleLog from '../core/logs.js';
import UtilsModule from '../core/utils.js';
import I18n from '../core/i18n.js';

// =============================================================================
// ENCAPSULATED STATE
// =============================================================================

/**
 * Internal references to the modal's structural DOM nodes.
 * @private
 * @typedef  {Object}           ModalState
 * @property {Element|null}     modal          - Root modal element (`.ql-modal`).
 * @property {Element|null}     modalBody      - Content container (`.ql-body`).
 * @property {Element|null}     footer         - Footer container (`.ql-modal-footer`).
 * @property {Function|null}    escapeHandler  - Currently active `keydown` listener reference.
 */
const _internalState = {
    modal:         null,
    modalBody:     null,
    footer:        null,
    escapeHandler: null
};

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Applies or removes a CSS `filter: blur(5px)` on all elements matching
 * `blurSelector` by querying the live DOM at call time.
 * @private
 * @param {string}  blurSelector - CSS selector for elements to blur.
 * @param {boolean} active       - `true` to apply blur, `false` to remove it.
 */
const _setBlur = (blurSelector, active) => {
    if (!blurSelector) return;
    document.querySelectorAll(blurSelector).forEach(el => {
        if (active) {
            el.style.filter = 'blur(5px)';
        } else {
            el.style.removeProperty('filter');
        }
    });
};

/**
 * Lazily resolves and caches references to the modal's structural nodes.
 * @private
 * @returns {boolean} `true` when all references are available.
 */
const _resolveModalNodes = () => {
    if (_internalState.modal) return true;

    const modal = document.querySelector('.ql-modal');
    if (!modal) return false;

    _internalState.modal     = modal;
    _internalState.modalBody = modal.querySelector('.ql-body');
    _internalState.footer    = modal.querySelector('.ql-modal-footer');
    return true;
};

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Safely updates the modal body content, clearing previous content.
 * @param {string|Node} content - HTML string, DocumentFragment, or DOM node to inject.
 */
export const updateModalBodyUI = (content) => {
    if (!_resolveModalNodes() || !_internalState.modalBody) return;
    _internalState.modalBody.innerHTML = '';
    if (typeof content === 'string') {
        _internalState.modalBody.innerHTML = content;
    } else if (content instanceof Node) {
        _internalState.modalBody.appendChild(content);
    }
};

/**
 * Safely updates the modal footer content, clearing previous content.
 * @param {string|Node} content - HTML string, DocumentFragment, or DOM node to inject.
 */
export const updateModalFooterUI = (content) => {
    if (!_resolveModalNodes() || !_internalState.footer) return;
    _internalState.footer.innerHTML = '';
    if (typeof content === 'string') {
        _internalState.footer.innerHTML = content;
    } else if (content instanceof Node) {
        _internalState.footer.appendChild(content);
    }
};

/**
 * Closes the modal and removes the blur effect from all previously targeted elements.
 */
export const closeModalUI = () => {
    const modal = _internalState.modal || document.querySelector('.ql-modal');
    if (!modal) return;

    const blurSelector = modal.dataset.blur;
    modal.style.display = 'none';
    _setBlur(blurSelector, false);
};

/**
 * Opens the modal, injects `bodyContent` into the body slot, applies the
 * blur effect to all elements matching `blurSelector`, and wires up
 * backdrop-click and escape-key dismissal according to `modalOptions`.
 *
 * @param {string|Node|null} bodyContent                          - HTML string or DOM node to render inside the modal body.
 * @param {string}           blurSelector                         - CSS selector for elements to blur while the modal is open.
 * @param {Object}           [modalOptions={}]                    - Behavioural overrides.
 * @param {boolean}          [modalOptions.closeOnBackdropClick=true] - Whether clicking the backdrop dismisses the modal.
 * @param {boolean}          [modalOptions.closeOnEscape=true]    - Whether pressing Escape dismisses the modal.
 */
export const setupModalUI = (bodyContent, blurSelector, modalOptions = {}) => {
    const { closeOnBackdropClick = true, closeOnEscape = true } = modalOptions;

    try {
        if (!_resolveModalNodes()) return;

        const { modal } = _internalState;

        if (bodyContent) {
            updateModalBodyUI(bodyContent);
        } else {
            _internalState.modalBody.innerHTML = '';
        }
        
        _internalState.footer.innerHTML = '';

        _setBlur(blurSelector, true);
        modal.dataset.blur   = blurSelector || '';
        modal.style.display  = 'flex';

        if (closeOnBackdropClick) {
            modal.onclick = (event) => {
                if (event.target === modal) closeModalUI();
            };
            modal.oncontextmenu = (event) => {
                if (event.target === modal) {
                    event.preventDefault();
                    closeModalUI();
                }
            };
        } else {
            modal.onclick       = null;
            modal.oncontextmenu = null;
        }

        if (_internalState.escapeHandler) {
            document.removeEventListener('keydown', _internalState.escapeHandler);
        }

        _internalState.escapeHandler = (event) => {
            if (event.key === 'Escape' && modal.style.display === 'flex' && closeOnEscape) {
                closeModalUI();
            }
        };

        document.addEventListener('keydown', _internalState.escapeHandler);

    } catch (error) {
        handleLog(error, 'ModalModule.setupModalUI');
    }
};

/**
 * Closes the modal and clears all body, footer, and event handler state.
 */
export function resetModalUI() {
    try {
        const modal = _internalState.modal || document.querySelector('.ql-modal');
        if (!modal) return;

        const blurSelector = modal.dataset.blur;
        modal.style.display = 'none';

        _setBlur(blurSelector, false);

        if (_internalState.modalBody) _internalState.modalBody.innerHTML = '';
        if (_internalState.footer)    _internalState.footer.innerHTML    = '';

        modal.onclick       = null;
        modal.oncontextmenu = null;
        modal.removeAttribute('data-blur');

        if (_internalState.escapeHandler) {
            document.removeEventListener('keydown', _internalState.escapeHandler);
            _internalState.escapeHandler = null;
        }
    } catch (error) {
        handleLog(error, 'ModalModule.resetModalUI');
    }
}

/**
 * Replaces the modal body with a success confirmation screen and schedules
 * automatic dismissal after 3 seconds.
 *
 * @param {Object}      [payload]         - Optional server response payload.
 * @param {string}      [payload.message] - Localised confirmation message from the server.
 */
export function renderReportedUI(payload) {
    try {
        const serverMsg = payload?.message
            ? `<p class="report-success-msg">${payload.message}</p>`
            : '';

        const content = `
            <div class="report-success-content">
                <span class="ql-icons-outlined report-success-icon">check_circle</span>
                <p class="t report-success-title">{{thankYouMessage}}</p>
                ${serverMsg}
            </div>`;

        const wrapper = document.createElement('div');
        wrapper.innerHTML = content;
        
        if (I18n?.translateElement) {
            I18n.translateElement(wrapper);
        }

        updateModalBodyUI(wrapper);
        updateModalFooterUI('');

        UtilsModule.startTimeout(() => closeModalUI(), 3000);

    } catch (error) {
        handleLog(error, 'ModalModule.renderReportedUI');
    }
}