/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/**
 * @file toast.js
 * @module UI/Toast
 * @description
 * Toast notification system for the Quelora UI layer.
 *
 * This module provides a self-contained toast manager responsible for:
 * - Rendering toast notifications with optional avatars, actions and buttons
 * - Managing toast lifecycle, animations and dismissal
 * - Keeping a bounded notification history
 * - Supporting dynamic positioning (top / bottom)
 * - Graceful integration with WASM-based HTML rendering (if available)
 *
 * The module is intentionally UI-scoped and does not depend on the global EventBus.
 * Notifications are triggered via its public API methods.
 *
 * @version 3.0.0
 */

import UtilsModule from "../core/utils.js";
import UiModule from "./ui.js";

const ToastModule = (() => {
    'use strict';

    const CONFIG = {
        MAX_TOASTS: 4,
        ANIMATION_DURATION: 300,
        POSITION: 'bottom',
        CSS: {
            CONTAINER: 'ql-toast-container',
            TOAST: 'ql-toast',
            CONTENT: 'ql-toast-content',
            AVATAR_FRAME: 'ql-avatar-frame',
            AVATAR_IMG: 'ql-avatar-img',
            TITLE: 'ql-toast-title t',
            BODY: 'ql-toast-body',
            CLOSE: 'ql-toast-close',
            VISIBLE: 'ql-toast-visible'
        }
    };

    let toasts = [];
    let notificationHistory = [];
    let container = null;

    /**
     * Safely renders text using the WASM markdown parser if available.
     * @param {string} rawText
     * @returns {string}
     */
    const safeRender = (rawText) => {
        if (window.WasmModule && typeof window.WasmModule.parse === 'function') {
            return window.WasmModule.parse(rawText);
        }
        return rawText;
    };

    /**
     * Creates or recreates the toast container.
     */
    const createContainer = () => {
        const existing = document.querySelector(`.${CONFIG.CSS.CONTAINER}`);
        if (existing) existing.remove();

        container = UiModule.createElementUI({
            tag: 'div',
            classes: [
                CONFIG.CSS.CONTAINER,
                `ql-toast-${CONFIG.POSITION}`
            ]
        });

        const root = document.getElementById('ql-root') || document.body;
        root.appendChild(container);
    };

    /**
     * Builds an avatar/icon component.
     * @param {string} iconSource
     * @returns {HTMLElement}
     */
    const buildAvatarComponent = (iconSource) => {
        const frame = UiModule.createElementUI({
            tag: 'div',
            classes: CONFIG.CSS.AVATAR_FRAME
        });

        if (!iconSource) return frame;

        const src = iconSource.trim();

        if (src.startsWith('<')) {
            frame.innerHTML = src;
            const img = frame.querySelector('img');
            if (img) {
                img.classList.add(CONFIG.CSS.AVATAR_IMG);
                img.style.width = '100%';
                img.style.height = '100%';
                img.style.objectFit = 'cover';
            }
            return frame;
        }

        if (src.includes('/') || src.startsWith('data:')) {
            frame.appendChild(UiModule.createElementUI({
                tag: 'img',
                classes: CONFIG.CSS.AVATAR_IMG,
                attributes: { src, alt: 'Avatar' }
            }));
            return frame;
        }

        frame.appendChild(UiModule.createElementUI({
            tag: 'span',
            classes: 'ql-icons-outlined',
            content: src
        }));

        return frame;
    };

    /**
     * Attaches swipe-to-dismiss logic for touch devices.
     * @param {HTMLElement} element
     * @param {Function} onClose
     */
    const attachSwipeLogic = (element, onClose) => {
        let startX = 0;
        let currentX = 0;
        let swiping = false;

        element.addEventListener('touchstart', e => {
            startX = e.changedTouches[0].screenX;
            swiping = true;
            element.style.transition = 'none';
        }, { passive: true });

        element.addEventListener('touchmove', e => {
            if (!swiping) return;
            currentX = e.changedTouches[0].screenX;
            const diff = Math.max(0, currentX - startX);
            element.style.transform = `translateX(${diff}px)`;
        }, { passive: true });

        element.addEventListener('touchend', () => {
            swiping = false;
            element.style.transition = 'all 0.3s ease-out';
            if (currentX - startX > 100) onClose();
            else element.style.transform = 'translateX(0)';
        });
    };

    /**
     * Removes a toast instance.
     * @param {{element: HTMLElement}} toastObj
     */
    const removeToast = (toastObj) => {
        if (!toastObj || !toastObj.element) return;

        const index = toasts.indexOf(toastObj);
        if (index > -1) toasts.splice(index, 1);

        toastObj.element.classList.remove(CONFIG.CSS.VISIBLE);
        UtilsModule.startTimeout(() => {
            toastObj.element.remove();
        }, CONFIG.ANIMATION_DURATION);
    };

    /**
     * Renders a toast notification.
     * @param {Object} payload
     */
    const renderNotification = (payload) => {
        if (!container) createContainer();

        const toastEl = UiModule.createElementUI({
            tag: 'div',
            classes: [CONFIG.CSS.TOAST, `ql-toast-${payload.type}`]
        });

        if (payload.icon) {
            toastEl.appendChild(buildAvatarComponent(payload.icon));
        }

        const contentEl = UiModule.createElementUI({
            tag: 'div',
            classes: CONFIG.CSS.CONTENT
        });

        if (payload.title) {
            contentEl.appendChild(UiModule.createElementUI({
                tag: 'div',
                classes: CONFIG.CSS.TITLE,
                content: payload.title
            }));
        }

        const bodyEl = UiModule.createElementUI({
            tag: 'div',
            classes: CONFIG.CSS.BODY,
            innerHTML: safeRender(payload.body || '')
        });

        if (payload.action && !payload.buttons?.length) {
            bodyEl.style.cursor = 'pointer';
            bodyEl.addEventListener('click', e => {
                e.stopPropagation();
                if (typeof payload.action === 'function') payload.action();
                else if (typeof payload.action === 'string') window.location.href = payload.action;
                removeToast({ element: toastEl });
            });
        }

        contentEl.appendChild(bodyEl);

        if (Array.isArray(payload.buttons)) {
            const btnContainer = UiModule.createElementUI({
                tag: 'div',
                classes: 'ql-toast-buttons'
            });

            payload.buttons.forEach(btn => {
                const classes = ['ql-toast-button']
                    .concat(btn.class ? btn.class.split(/\s+/) : ['ql-toast-button-secondary']);

                const btnEl = UiModule.createElementUI({
                    tag: 'button',
                    classes,
                    innerHTML: btn.text
                });

                btnEl.addEventListener('click', e => {
                    e.stopPropagation();
                    if (typeof btn.action === 'function') btn.action();
                    removeToast({ element: toastEl });
                });

                btnContainer.appendChild(btnEl);
            });

            contentEl.appendChild(btnContainer);
        }

        toastEl.appendChild(contentEl);

        const closeBtn = UiModule.createElementUI({
            tag: 'button',
            classes: CONFIG.CSS.CLOSE,
            content: '×'
        });

        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            removeToast({ element: toastEl });
        });

        toastEl.appendChild(closeBtn);

        attachSwipeLogic(toastEl, () => removeToast({ element: toastEl }));

        container.prepend(toastEl);

        const toastObj = { element: toastEl, payload };
        toasts.unshift(toastObj);

        if (toasts.length > CONFIG.MAX_TOASTS) {
            removeToast(toasts.pop());
        }

        UtilsModule.startTimeout(() => {
            toastEl.classList.add(CONFIG.CSS.VISIBLE);
        }, 10);

        const duration = payload.buttons?.length ? 0 : payload.duration;
        if (duration > 0) {
            UtilsModule.startTimeout(() => removeToast(toastObj), duration);
        }

        notificationHistory.unshift({
            timestamp: new Date(),
            ...payload
        });

        if (notificationHistory.length > 50) {
            notificationHistory.pop();
        }
    };

    return {
        /**
         * Initializes the toast system.
         * @param {{position?: 'top'|'bottom'}} options
         */
        init(options = {}) {
            if (options.position) this.setPosition(options.position);
            if (!container) createContainer();
        },

        /**
         * Sets the toast position.
         * @param {'top'|'bottom'} position
         */
        setPosition(position) {
            if (position === 'top' || position === 'bottom') {
                CONFIG.POSITION = position;
                createContainer();
            }
        },

        show(icon, title, body, action, duration = 0, type = 'info', buttons = null) {
            renderNotification({ icon, title, body, action, duration, type, buttons });
        },

        success(icon, title, body, action, duration = 0, buttons = null) {
            this.show(icon, title, body, action, duration, 'success', buttons);
        },

        error(icon, title, body, action, duration = 0, buttons = null) {
            this.show(icon, title, body, action, duration, 'error', buttons);
        },

        warning(icon, title, body, action, duration = 0, buttons = null) {
            this.show(icon, title, body, action, duration, 'warning', buttons);
        },

        info(icon, title, body, action, duration = 0, buttons = null) {
            this.show(icon, title, body, action, duration, 'info', buttons);
        },

        destroy() {
            toasts.forEach(t => t.element.remove());
            toasts = [];
            container?.remove();
            container = null;
        },

        /**
         * Returns the toast notification history.
         * @returns {Array<Object>}
         */
        getHistory() {
            return [...notificationHistory];
        }
    };
})();

export default ToastModule;
