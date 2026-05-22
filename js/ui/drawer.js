/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/ui/drawer.js */
/**
 * @module UI/Drawer
 * @description Drawer UI component for managing navigation and content presentation.
 *
 * Key improvements over previous versions:
 * - `SafeAreaCoordinator`: a JS-only solution for dynamic top and bottom gaps
 * that works in widget/embed contexts where the host page meta viewport cannot
 * be controlled. Measures the real gap between `window.innerHeight` and
 * `visualViewport.offsetTop + visualViewport.height` for the bottom.
 * - Raycasting Top Detection: Uses `document.elementsFromPoint` to dynamically 
 * detect any hostile sticky/fixed headers (e.g., third-party `.app-header`) 
 * intercepting the viewport without DOM thrashing or knowing the class names.
 * - Writes `--ql-safe-bottom` and `--ql-safe-top` on the widget root element, 
 * and updates on every resize.
 * - Enforces dynamic safe area calculation both for mobile (bottom sheet) and 
 * desktop (side panel) layouts adjusting `height` and `top` properties.
 *
 * @version 2.6.0
 */

import UtilsModule from '../core/utils.js';
import I18n from '../core/i18n.js';
import ToastModule from './toast.js';
import IconsModule from './icons.js';
import StorageModule from '../core/storage.js';
import queloraRootElement from '../core/scaffold.js';
import { eventBus } from '../core/event.js';

/**
 * Configuration constants for Drawer behavior and styling.
 * @constant {Object}
 */
const CONSTANTS = {
    MIN_HEIGHT_RATIO: 0.3,
    /**
     * Maximum fraction of the layout viewport a bottom drawer may occupy.
     * Set to 1.0 because the home-indicator / browser-chrome gap is handled
     * exclusively via CSS custom properties.
     */
    MAX_HEIGHT_RATIO: 1.0,
    MAGNET_ZONE_PX: 60,
    SWIPE_THRESHOLD_RATIO: 0.25,
    /** Breakpoint (px) that separates mobile from desktop layout. */
    DESKTOP_BREAKPOINT: 769,
    INDICATOR: {
        itemWidth: 44,
        gap: 8,
        timeoutMs: 1000,
        VISIBLE_CLASS: 'ql-drawer-indicator--visible',
        NO_TRANSITION_CLASS: 'ql-drawer-indicator__highlight--no-transition'
    },
    CLASSES: {
        DRAWER: 'drawer',
        HEADER: 'drawer-header',
        CONTENT: 'drawer-content',
        ACTIVE: 'active',
        SHADOW: 'shadow',
        NO_SHADOW: 'no-shadow',
        LIVE_ACTIVE: 'live-active'
    },
    STATE: {
        CLOSED: 'closed',
        OPEN: 'open',
        HIDDEN: 'hide',
        SHOW: 'show',
        SWIPED_OUT: 'swiped_out',
        STACKED: 'stacked',
        SWITCHED: 'switched'
    },
    DIRECTION: {
        HORIZONTAL: 'horizontal',
        VERTICAL: 'vertical',
        NEXT: 'next',
        PREV: 'prev',
        BOTTOM: 'bottom',
        RIGHT: 'right',
        LEFT: 'left'
    }
};

// ---------------------------------------------------------------------------
// Viewport helpers
// ---------------------------------------------------------------------------

/**
 * Returns the layout viewport height (`window.innerHeight`).
 *
 * @returns {number} Layout viewport height in pixels.
 */
function getLayoutViewportHeight() {
    return window.innerHeight;
}

/**
 * Returns the layout viewport width (`window.innerWidth`).
 * Used for breakpoint detection and horizontal swipe calculations.
 *
 * @returns {number} Layout viewport width in pixels.
 */
function getLayoutViewportWidth() {
    return window.innerWidth;
}

/**
 * Detects whether the virtual keyboard is currently open by comparing
 * `visualViewport.height` against `window.innerHeight`. A reduction greater
 * than 100 px reliably indicates an on-screen keyboard is visible.
 *
 * @returns {boolean} `true` when the virtual keyboard is likely visible.
 */
function isVirtualKeyboardOpen() {
    if (!window.visualViewport) return false;
    return (window.innerHeight - window.visualViewport.height) > 100;
}

/**
 * Determines whether the current viewport should be treated as a mobile
 * layout based on the configured breakpoint.
 *
 * @returns {boolean} `true` when the layout width is below the breakpoint.
 */
function isViewportMobile() {
    return getLayoutViewportWidth() < CONSTANTS.DESKTOP_BREAKPOINT;
}

// ---------------------------------------------------------------------------
// Safe-area coordinator
// ---------------------------------------------------------------------------

/**
 * @namespace SafeAreaCoordinator
 * @description Measures the real gesture-bar / browser-chrome gap at the
 * bottom of the visual viewport and utilizes raycasting to detect hostile 
 * sticky elements at the top. Writes these as CSS custom properties
 * (`--ql-safe-bottom`, `--ql-safe-top`) on the widget root element.
 */
const SafeAreaCoordinator = {
    /** @type {HTMLElement|null} The widget root element that receives the property. */
    _root: null,
    /** @type {number} Last written bottom value in pixels. */
    _lastBottomValue: -1,
    /** @type {number} Last written top value in pixels. */
    _lastTopValue: -1,
    /** @type {number} Cached safe top value for synchronous drawer calculations. */
    _safeTop: 0,
    /** @type {boolean} Flag to prevent multiple initializations. */
    _initialized: false,

    /**
     * Initializes the coordinator with the widget root element and performs
     * the first measurement.
     *
     * @param {HTMLElement} rootElement - The widget root (e.g. `#ql-root`).
     */
    init(rootElement) {
        if (this._initialized) return;
        this._initialized = true;
        if (rootElement) {
            this._root = rootElement;
        }
        this.update();
    },

    /**
     * Measures the current safe areas and writes the custom properties
     * on the root element. Skips the update when the virtual keyboard is
     * open so padding does not collapse during text input.
     */
    update() {
        if (isVirtualKeyboardOpen()) return;

        const bottomGap = this._measureBottom();
        const topGap = this._measureTop();

        if (bottomGap !== this._lastBottomValue) {
            this._lastBottomValue = bottomGap;
            if (this._root) {
                this._root.style.setProperty('--ql-safe-bottom', `${bottomGap}px`);
            }
        }

        if (topGap !== this._lastTopValue) {
            this._lastTopValue = topGap;
            this._safeTop = topGap;
            if (this._root) {
                this._root.style.setProperty('--ql-safe-top', `${topGap}px`);
            }
        }
    },

    /**
     * Returns the currently cached safe top value for synchronous height constraints.
     * @returns {number} The height of hostile top elements in pixels.
     */
    getSafeTop() {
        return this._safeTop;
    },

    /**
     * Computes the pixel gap between the layout viewport bottom and the
     * visual viewport bottom.
     *
     * @returns {number} Gap in pixels, clamped to [0, 60].
     * @private
     */
    _measureBottom() {
        if (!window.visualViewport) return 0;
        const gap = window.innerHeight - (window.visualViewport.offsetTop + window.visualViewport.height);
        return Math.min(60, Math.max(0, Math.round(gap)));
    },

    /**
     * Uses raycasting (document.elementsFromPoint) to detect unknown sticky or 
     * fixed headers injected by the host page without iterating the entire DOM.
     * * @returns {number} Top gap in pixels.
     * @private
     */
    _measureTop() {
        if (typeof document.elementsFromPoint !== 'function') return 0;

        let maxBottom = 0;
        const x = window.innerWidth / 2;
        const y = 1; 

        const elements = document.elementsFromPoint(x, y);

        for (let i = 0; i < elements.length; i++) {
            const el = elements[i];
            if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') continue;

            if (el.id === 'ql-root' || el.closest('#ql-root')) continue;

            const computedStyle = window.getComputedStyle(el);
            const position = computedStyle.position;

            if (position === 'fixed' || position === 'sticky' || position === 'absolute') {
                const rect = el.getBoundingClientRect();
                if (rect.bottom > maxBottom && rect.bottom < (window.innerHeight / 2)) {
                    maxBottom = Math.round(rect.bottom);
                    break; 
                }
            }
        }

        return maxBottom;
    }
};

// ---------------------------------------------------------------------------
// Static resize coordinator
// ---------------------------------------------------------------------------

/**
 * @namespace DrawerResizeCoordinator
 * @description Singleton that owns the single `visualViewport` / `resize`
 * listener and fans resize events out to all registered `Drawer` instances.
 * Using one coordinator avoids N separate listeners for N drawers.
 */
const DrawerResizeCoordinator = {
    /** @type {Set<Drawer>} */
    _subscribers: new Set(),
    _rafId: null,
    _attached: false,

    /**
     * Registers a Drawer instance to receive resize callbacks.
     * Attaches the global listeners on first subscription.
     *
     * @param {Drawer} drawer - The drawer instance to register.
     */
    subscribe(drawer) {
        this._subscribers.add(drawer);
        if (!this._attached) this._attach();
    },

    /**
     * Removes a Drawer instance from resize callbacks.
     *
     * @param {Drawer} drawer - The drawer instance to unregister.
     */
    unsubscribe(drawer) {
        this._subscribers.delete(drawer);
    },

    /**
     * Attaches resize event listeners to `window` and, when available, to
     * `visualViewport`.
     *
     * @private
     */
    _attach() {
        this._attached = true;
        const handler = this._onResize.bind(this);
        window.addEventListener('resize', handler);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', handler);
        }
    },

    /**
     * Debounces resize handling to one rAF frame and notifies all subscribers.
     *
     * @private
     */
    _onResize() {
        if (this._rafId) cancelAnimationFrame(this._rafId);
        this._rafId = requestAnimationFrame(() => {
            this._rafId = null;
            SafeAreaCoordinator.update();
            this._subscribers.forEach(drawer => {
                try { drawer._handleViewportResize(); } catch (err) { console.error(err); }
            });
        });
    }
};

// ---------------------------------------------------------------------------
// Drawer class
// ---------------------------------------------------------------------------

/**
 * Class representing a UI Drawer component.
 * Supports swipe gestures, stacking, history navigation integration, and
 * dynamic adaptation between mobile (bottom sheet) and desktop (side panel)
 * layouts whenever the viewport crosses the configured breakpoint.
 */
class Drawer {
    /** @type {Drawer|null} The currently active drawer instance. */
    static activeDrawer = null;
    /** @type {boolean} Flag indicating if history listeners have been attached. */
    static historyHandled = false;
    /** @type {Drawer[]} Stack of drawers for nested navigation. */
    static drawerStack = [];
    /** @type {Drawer[]} Registry of all instantiated drawers. */
    static instances = [];

    /**
     * Visual indicator for swipe navigation between drawer groups.
     * @type {Object}
     */
    static Indicator = {
        element: null,
        timeoutId: null,

        /**
         * Ensures the indicator DOM element exists.
         */
        ensure() {
            if (this.element) return;
            const el = document.createElement('div');
            el.id = 'ql-drawer-indicator';
            el.className = 'ql-drawer-indicator';
            (document.getElementById('ql-theme-root') || document.body).appendChild(el);
            this.element = el;
        },

        /**
         * Clears the auto-hide timeout.
         */
        clearTimeout() {
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }
        },

        /**
         * Hides the indicator after a delay.
         */
        hideDelayed() {
            this.clearTimeout();
            this.timeoutId = setTimeout(() => {
                if (this.element) this.element.classList.remove(CONSTANTS.INDICATOR.VISIBLE_CLASS);
            }, CONSTANTS.INDICATOR.timeoutMs);
        },

        /**
         * Hides the indicator immediately.
         */
        hideImmediate() {
            this.clearTimeout();
            if (this.element) this.element.classList.remove(CONSTANTS.INDICATOR.VISIBLE_CLASS);
        },

        /**
         * Toggles the CSS transition for the indicator highlight.
         * @param {boolean} enable - Whether to enable transitions.
         */
        toggleTransition(enable) {
            if (!this.element) return;
            const highlight = this.element.querySelector('.ql-drawer-indicator__highlight');
            if (!highlight) return;
            if (enable) highlight.classList.remove(CONSTANTS.INDICATOR.NO_TRANSITION_CLASS);
            else highlight.classList.add(CONSTANTS.INDICATOR.NO_TRANSITION_CLASS);
        },

        /**
         * Renders the indicator dots based on the active drawer's group.
         */
        renderForActiveDrawer() {
            if (!this.element) return;
            const active = Drawer.activeDrawer;
            if (!active || !active.swipeGroup || !active.enabled) {
                this.hideImmediate();
                return;
            }

            const group = Drawer.instances
                .filter(d => d.swipeGroup === active.swipeGroup && d.swipeRank !== -1 && d.enabled)
                .sort((a, b) => a.swipeRank - b.swipeRank);

            if (group.length <= 1) {
                this.hideImmediate();
                return;
            }

            this.element.innerHTML = '';
            const highlight = document.createElement('div');
            highlight.className = 'ql-drawer-indicator__highlight';
            this.element.appendChild(highlight);

            let activeIndex = 0;
            group.forEach((d, idx) => {
                const isActive = d === active;
                if (isActive) activeIndex = idx;
                const dot = document.createElement('div');
                dot.className = `ql-drawer-indicator__dot ${isActive ? 'is-active' : ''}`;
                dot.innerHTML = IconsModule.getIconSvg(d.icon) || '';
                this.element.appendChild(dot);
            });

            const translateX = activeIndex * (CONSTANTS.INDICATOR.itemWidth + CONSTANTS.INDICATOR.gap);
            highlight.style.transform = `translateX(${translateX}px)`;
            this.element.classList.add(CONSTANTS.INDICATOR.VISIBLE_CLASS);

            this.hideDelayed();
        },

        /**
         * Moves the indicator highlight based on drag delta.
         * @param {number} deltaX - The horizontal drag distance.
         */
        move(deltaX) {
            if (!this.element) return;
            const highlight = this.element.querySelector('.ql-drawer-indicator__highlight');
            if (!highlight) return;

            const active = Drawer.activeDrawer;
            if (!active || !active.swipeGroup || !active.enabled) return;

            const group = Drawer.instances
                .filter(d => d.swipeGroup === active.swipeGroup && d.swipeRank !== -1 && d.enabled)
                .sort((a, b) => a.swipeRank - b.swipeRank);

            const activeIndex = group.indexOf(active);
            if (activeIndex === -1) return;

            const totalUnit = CONSTANTS.INDICATOR.itemWidth + CONSTANTS.INDICATOR.gap;
            const width = getLayoutViewportWidth();
            const dragPercentage = deltaX / width;
            const indicatorShift = -(dragPercentage * totalUnit);
            let final = activeIndex * totalUnit + indicatorShift;

            const max = (group.length - 1) * totalUnit;
            final = Math.max(0, Math.min(final, max));

            highlight.style.transform = `translateX(${final}px)`;
        },

        /**
         * Snaps the indicator to a specific target index.
         * @param {number} targetIndex - The index to snap to.
         */
        snapTo(targetIndex) {
            if (!this.element) return;
            const highlight = this.element.querySelector('.ql-drawer-indicator__highlight');
            if (!highlight) return;
            const totalUnit = CONSTANTS.INDICATOR.itemWidth + CONSTANTS.INDICATOR.gap;
            highlight.style.transform = `translateX(${targetIndex * totalUnit}px)`;
        }
    };

    /**
     * Initializes the browser history handling for drawers.
     * Ensures pressing 'Back' closes the active drawer.
     */
    static setupHistoryHandling() {
        if (this.historyHandled) return;
        this.historyHandled = true;
        window.addEventListener('popstate', () => {
            if (Drawer.activeDrawer) Drawer.activeDrawer.close(true);
        });
    }

    /**
     * Unlocks the body scroll (Mobile optimization).
     */
    static unlockBodyScroll() {
        document.body.style.overflow = '';
        document.body.style.touchAction = '';
    }

    /**
     * Updates the body scroll lock state.
     */
    static updateBodyScrollLock() {
        this.unlockBodyScroll();
    }

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    /**
     * Creates a new Drawer instance.
     *
     * @param {Object}          config                        - Configuration object.
     * @param {string}          [config.id]                   - Unique identifier.
     * @param {string}          [config.customClass]          - Additional CSS class.
     * @param {string}          [config.title]                - Drawer title text.
     * @param {string}          [config.content]              - Inner HTML content.
     * @param {string|number}   [config.height='100%']        - Desired height/width.
     * @param {string}          [config.transitionSpeed='0.3s'] - CSS transition duration.
     * @param {number}          [config.zIndex=9000]          - CSS z-index.
     * @param {string}          [config.position='bottom']    - Initial position hint.
     * @param {string|null}     [config.swipeGroup]           - Horizontal swipe group ID.
     * @param {number}          [config.swipeRank=-1]         - Rank within the group.
     * @param {string}          [config.icon='circle']        - Indicator icon name.
     * @param {boolean}         [config.enabled=true]         - Whether drawer participates in swipe.
     * @param {boolean}         [config.closeOnDrag=false]    - Allow drag-to-close.
     * @param {boolean}         [config.confirmCloseOnDrag=false] - Confirm before drag-close.
     * @param {string}          [config.confirmCloseMessage=''] - Confirmation message key.
     * @param {Function}        [config.afterRender]          - Callback after DOM creation.
     * @param {Function}        [config.afterClose]           - Callback after the drawer closes.
     */
    constructor(config = {}) {
        this.id = config.id || `drawer-${Math.random().toString(36).slice(2, 11)}`;
        this.customClass = config.customClass || '';
        this.title = config.title || 'Quelora';
        this.content = config.content || `<div class="${CONSTANTS.CLASSES.CONTENT}"></div>`;
        this.height = config.height || '100%';
        this.transitionSpeed = config.transitionSpeed || '0.3s';
        this.zIndex = config.zIndex || 9000;

        this._configPosition = config.position || CONSTANTS.DIRECTION.BOTTOM;
        this.position = this._resolvePosition();

        this.swipeGroup = config.swipeGroup || null;
        this.swipeRank = typeof config.swipeRank === 'number' ? config.swipeRank : -1;
        this.icon = config.icon || 'circle';
        this.enabled = config.enabled !== false;

        this.closeOnDrag = config.closeOnDrag || false;
        this.confirmCloseOnDrag = config.confirmCloseOnDrag || false;
        this.confirmCloseMessage = config.confirmCloseMessage || '';
        this.afterRender = config.afterRender || null;
        this.afterClose = config.afterClose || null;

        this.element = null;
        this.header = null;

        this.isDragging = false;
        this.isHeaderDrag = false;
        this.isSwipingOut = false;
        this.isSwipeEntry = false;
        this.dragDirection = null;
        this.startX = 0;
        this.startY = 0;
        this.startHeight = 0;
        this.currentHeight = 0;
        this.startTime = 0;
        this.isHalfHeight = false;
        this.neighborDrawer = null;
        this.temporaryBackDrawer = null;

        this.eventHandlers = {};
        this._boundOnDragging = this.onDragging.bind(this);
        this._boundStopDragging = this.stopDragging.bind(this);
        this._hideReason = null;

        this.storageKey = `ql_drawer_h_${this.id}`;

        // Initialize safe area before DOM creation so values are ready
        const widgetRoot = queloraRootElement || document.getElementById('ql-root');
        SafeAreaCoordinator.init(widgetRoot);

        this.initializeDrawer();
        Drawer.instances.push(this);
        Drawer.Indicator.ensure();
        DrawerResizeCoordinator.subscribe(this);
    }

    // -----------------------------------------------------------------------
    // Viewport / layout helpers
    // -----------------------------------------------------------------------

    /**
     * Resolves whether the drawer should use mobile (bottom) or desktop (side)
     * layout based on the current viewport width.
     *
     * @returns {string} Resolved position constant.
     */
    _resolvePosition() {
        if (!isViewportMobile()) {
            return CONSTANTS.DIRECTION.RIGHT;
        }
        return this._configPosition;
    }

    /**
     * Returns `true` when the current viewport qualifies as mobile layout.
     *
     * @returns {boolean}
     */
    get isMobile() {
        return isViewportMobile();
    }

    /**
     * Returns the layout viewport dimension relevant to this drawer's position.
     *
     * @returns {number} Pixel value.
     */
    getDimension() {
        return this.position === CONSTANTS.DIRECTION.BOTTOM
            ? getLayoutViewportHeight()
            : getLayoutViewportWidth();
    }

    /**
     * Clamps a proposed height in pixels so it never exceeds the safe visible
     * area of the screen, dynamically adjusting for known hostile fixed headers.
     *
     * @param {number} proposedPx    - The height/width value to clamp, in pixels.
     * @param {number} [dimension]   - Reference dimension. Defaults to `getDimension()`.
     * @returns {number} Clamped value in pixels.
     */
    clampHeight(proposedPx, dimension) {
        const dim = dimension !== undefined ? dimension : this.getDimension();
        const min = dim * CONSTANTS.MIN_HEIGHT_RATIO;
        let max = dim * CONSTANTS.MAX_HEIGHT_RATIO;
        
        if (this.position === CONSTANTS.DIRECTION.BOTTOM && dim === getLayoutViewportHeight()) {
            max = (dim - SafeAreaCoordinator.getSafeTop()) * CONSTANTS.MAX_HEIGHT_RATIO;
        }

        return Math.min(max, Math.max(min, proposedPx));
    }

    /**
     * Parses a size string or number into pixels, then clamps it to safe
     * viewport bounds.
     *
     * @param {string|number} size      - The size to parse ('80%', '400px', 400).
     * @param {number}        dimension - Reference dimension for percentage calculations.
     * @returns {number} Size in pixels, clamped to safe bounds.
     */
    parseSize(size, dimension) {
        let px;
        if (typeof size === 'number') {
            px = size;
        } else if (typeof size === 'string' && size.includes('%')) {
            px = dimension * (parseFloat(size) / 100);
        } else {
            px = parseFloat(size) || dimension;
        }
        return this.clampHeight(px, dimension);
    }

    // -----------------------------------------------------------------------
    // Resize handling
    // -----------------------------------------------------------------------

    /**
     * Called by `DrawerResizeCoordinator` on every viewport resize event.
     */
    _handleViewportResize() {
        if (!this.element) return;
        if (isVirtualKeyboardOpen()) return;

        const nowMobile = isViewportMobile();
        const wasMobile = this.position === CONSTANTS.DIRECTION.BOTTOM;

        if (nowMobile !== wasMobile) {
            this._applyLayoutMode(nowMobile);
        } else if (!nowMobile) {
            const safeTop = SafeAreaCoordinator.getSafeTop();
            this.element.style.top = safeTop > 0 ? `${safeTop}px` : '0';
            this.element.style.height = safeTop > 0 ? `calc(100% - ${safeTop}px)` : '100%';
        }

        if (this.element.classList.contains(CONSTANTS.CLASSES.ACTIVE)) {
            this._constrainOpenDrawer();
        }
    }

    /**
     * Switches the drawer between mobile and desktop layouts.
     *
     * @param {boolean} mobile - `true` to apply mobile layout, `false` for desktop.
     */
    _applyLayoutMode(mobile) {
        this.position = mobile ? this._configPosition : CONSTANTS.DIRECTION.RIGHT;

        if (mobile) {
            this.element.classList.remove('right', 'left');
            this.element.classList.add(this._configPosition);
            this.element.style.transition =
                `transform ${this.transitionSpeed} ease, height ${this.transitionSpeed} ease`;
            this.element.style.willChange = 'transform, height';
            this.element.style.width = '';
            this.element.style.maxWidth = '';
            this.element.style.right = '';
            this.element.style.top = ''; // Remove top offset for mobile bottom sheets
            this.element.style.height = this.height;

            this._renderMobileHeader();

            if (!this.element.classList.contains(CONSTANTS.CLASSES.ACTIVE)) {
                this.element.style.bottom = `-${this.parseSize(this.height, getLayoutViewportHeight())}px`;
            }
        } else {
            this.element.classList.remove(
                CONSTANTS.DIRECTION.BOTTOM,
                CONSTANTS.DIRECTION.LEFT
            );
            this.element.classList.add(CONSTANTS.DIRECTION.RIGHT);
            this.element.style.transition =
                `right ${this.transitionSpeed} ease`;
            this.element.style.willChange = '';
            
            const safeTop = SafeAreaCoordinator.getSafeTop();
            this.element.style.top = safeTop > 0 ? `${safeTop}px` : '0';
            this.element.style.height = safeTop > 0 ? `calc(100% - ${safeTop}px)` : '100%';
            this.element.style.maxWidth = '500px';
            this.element.style.bottom = 'auto'; // Let height define layout

            this._renderDesktopHeader();

            if (!this.element.classList.contains(CONSTANTS.CLASSES.ACTIVE)) {
                const dim = this.parseSize(this.height, getLayoutViewportWidth());
                this.element.style.right = `-${dim}px`;
            } else {
                this.element.style.right = '0';
            }
        }
    }

    /**
     * Re-applies the mobile touch listener and removes the desktop close button.
     *
     * @private
     */
    _renderMobileHeader() {
        if (!this.header) return;
        this.header.classList.remove(`${CONSTANTS.CLASSES.HEADER}--desktop`);

        const existingBtn = this.element.querySelector('.drawer-close-btn');
        if (existingBtn) existingBtn.remove();

        if (!this._touchListenerAttached) {
            this.element.addEventListener('touchstart', this.startDragging.bind(this), { passive: false });
            this._touchListenerAttached = true;
        }
    }

    /**
     * Injects the desktop close button and removes mobile drag handle styles.
     *
     * @private
     */
    _renderDesktopHeader() {
        if (!this.header) return;
        this.header.classList.add(`${CONSTANTS.CLASSES.HEADER}--desktop`);

        if (!this.element.querySelector('.drawer-close-btn')) {
            const btn = document.createElement('button');
            btn.className = 'drawer-close-btn';
            btn.setAttribute('aria-label', 'Close');
            btn.innerHTML = '&times;';
            btn.addEventListener('click', () => this.close());
            this.header.appendChild(btn);
        }
    }

    /**
     * Recalculates and enforces the maximum allowed size for an open drawer.
     *
     * @private
     */
    _constrainOpenDrawer() {
        if (!this.isMobile || this.position !== CONSTANTS.DIRECTION.BOTTOM) return;

        const dimension = this.getDimension();
        const currentPx = this.element.getBoundingClientRect().height;
        const clamped = this.clampHeight(currentPx, dimension);

        if (Math.abs(clamped - currentPx) > 1) {
            this.element.style.height = `${clamped}px`;
            this.currentHeight = clamped;
            const pct = ((clamped / dimension) * 100).toFixed(2);
            StorageModule.setLocalItem(this.storageKey, `${pct}%`);
        }
    }

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /**
     * Initializes the drawer DOM and event listeners.
     */
    initializeDrawer() {
        this.createElement();
        this.setupEventListeners();
        if (typeof this.afterRender === 'function') {
            try { this.afterRender(); } catch (err) { console.error(err); }
        }
    }

    /**
     * Sets up DOM event listeners.
     */
    setupEventListeners() {
        if (!this.element) return;
        if (this.isMobile) {
            this.element.addEventListener('touchstart', this.startDragging.bind(this), { passive: false });
            this._touchListenerAttached = true;
        }
        this.element.addEventListener('transitionend', this.handleTransitionEnd.bind(this));
        this.element.addEventListener('contextmenu', e => e.preventDefault());
    }

    // -----------------------------------------------------------------------
    // Event bus (internal)
    // -----------------------------------------------------------------------

    /**
     * Subscribes to an internal drawer event.
     * @param {string}   event    - Event name.
     * @param {Function} callback - Handler function.
     */
    on(event, callback) {
        (this.eventHandlers[event] ||= []).push(callback);
    }

    /**
     * Unsubscribes from an internal drawer event.
     * @param {string}   event             - Event name.
     * @param {Function} callbackToRemove  - Handler to remove.
     */
    off(event, callbackToRemove) {
        if (!this.eventHandlers[event]) return;
        this.eventHandlers[event] = this.eventHandlers[event].filter(cb => cb !== callbackToRemove);
    }

    /**
     * Emits an internal drawer event.
     * @param {string} event - Event name.
     */
    emit(event) {
        const handlers = this.eventHandlers[event];
        if (!handlers) return;
        handlers.forEach(cb => {
            try { cb(); } catch (err) { console.error(err); }
        });
    }

    // -----------------------------------------------------------------------
    // Positioning helpers
    // -----------------------------------------------------------------------

    /**
     * Returns the CSS property name used to position this drawer off-screen.
     * @returns {'bottom'|'right'|'left'}
     */
    getPositionProperty() {
        if (this.position === CONSTANTS.DIRECTION.BOTTOM) return CONSTANTS.DIRECTION.BOTTOM;
        if (this.position === CONSTANTS.DIRECTION.RIGHT)  return CONSTANTS.DIRECTION.RIGHT;
        return CONSTANTS.DIRECTION.LEFT;
    }

    /**
     * Finds the adjacent drawer in the swipe group.
     * @param {'next'|'prev'} direction - Direction to search.
     * @returns {Drawer|null} Adjacent drawer or `null`.
     */
    getNeighbor(direction) {
        if (this.swipeGroup && this.swipeRank !== -1 && this.enabled) {
            const groupDrawers = Drawer.instances
                .filter(d => d.swipeGroup === this.swipeGroup && d.swipeRank !== -1)
                .sort((a, b) => a.swipeRank - b.swipeRank);

            const myIndex = groupDrawers.indexOf(this);
            if (myIndex === -1) return null;

            if (direction === CONSTANTS.DIRECTION.NEXT) {
                for (let i = myIndex + 1; i < groupDrawers.length; i++) {
                    if (groupDrawers[i].enabled) return groupDrawers[i];
                }
            } else {
                for (let i = myIndex - 1; i >= 0; i--) {
                    if (groupDrawers[i].enabled) return groupDrawers[i];
                }
            }
            return null;
        }

        if (direction === CONSTANTS.DIRECTION.PREV && this.temporaryBackDrawer) {
            return this.temporaryBackDrawer;
        }

        return null;
    }

    // -----------------------------------------------------------------------
    // DOM creation
    // -----------------------------------------------------------------------

    /**
     * Creates the DOM structure for the drawer and appends it to the root.
     */
    createElement() {
        const container = document.createElement('div');
        container.id = this.id;
        container.className = `${CONSTANTS.CLASSES.DRAWER} ${this.position} ${this.customClass}`.trim();
        container.style.zIndex = this.zIndex;

        if (this.isMobile) {
            container.style.transition = `transform ${this.transitionSpeed} ease, height ${this.transitionSpeed} ease`;
            container.style.willChange = 'transform, height';
        } else {
            container.style.transition = `${this.getPositionProperty()} ${this.transitionSpeed} ease`;
        }

        container.style.display = 'flex';
        container.style.visibility = 'hidden';
        container.style.pointerEvents = 'none';

        const closeBtn = !this.isMobile
            ? `<button class="drawer-close-btn" aria-label="Close">&times;</button>`
            : '';

        container.innerHTML = `
            <div class="${CONSTANTS.CLASSES.HEADER}">
                <div class="t">${this.title}</div>
                ${closeBtn}
            </div>
            <div class="${CONSTANTS.CLASSES.CONTENT}">${this.content}</div>`;

        const root = queloraRootElement || document.getElementById('ql-root');
        if (!root) return;

        root.appendChild(container);
        this.element = container;
        this.header = container.querySelector(`.${CONSTANTS.CLASSES.HEADER}`);

        if (!this.isMobile) {
            this.header.classList.add(`${CONSTANTS.CLASSES.HEADER}--desktop`);
            const btn = container.querySelector('.drawer-close-btn');
            if (btn) btn.addEventListener('click', () => this.close());
            const dimension = this.parseSize(this.height, getLayoutViewportWidth());
            this.element.style[this.getPositionProperty()] = `-${dimension}px`;
            
            const safeTop = SafeAreaCoordinator.getSafeTop();
            this.element.style.top = safeTop > 0 ? `${safeTop}px` : '0';
            this.element.style.height = safeTop > 0 ? `calc(100% - ${safeTop}px)` : '100%';
            this.element.style.maxWidth = '500px';
            this.element.style.bottom = 'auto'; 
        } else {
            const dimension = this.getDimension();
            const parsed = this.parseSize(this.height, dimension);
            if (this.position === CONSTANTS.DIRECTION.BOTTOM) {
                this.element.style.height = `${parsed}px`;
                this.element.style.bottom = `-${parsed}px`;
            } else {
                this.element.style.width = `${parsed}px`;
            }
        }

        container.classList.add(CONSTANTS.CLASSES.NO_SHADOW);
    }

    // -----------------------------------------------------------------------
    // Transition end
    // -----------------------------------------------------------------------

    /**
     * Handles the end of CSS transitions.
     *
     * @param {TransitionEvent} e - The browser transition event.
     */
    handleTransitionEnd(e) {
        if (e && e.target !== this.element) return;

        if (this.isSwipeEntry) {
            this.isSwipeEntry = false;
            return;
        }

        if (this.isSwipingOut && !this.element.classList.contains(CONSTANTS.CLASSES.ACTIVE)) {
            this.isSwipingOut = false;
            this.element.style.transform = '';
            if (this.isMobile && this.position === CONSTANTS.DIRECTION.BOTTOM) {
                this.element.style.bottom = '-100%';
            }
        }

        if (!this.element.classList.contains(CONSTANTS.CLASSES.ACTIVE)) {
            this.element.style.visibility = 'hidden';
            this.element.style.pointerEvents = 'none';

            this.emit(CONSTANTS.STATE.CLOSED);

            eventBus.emit('DRAWER_STATE_CHANGE', {
                id: this.id,
                state: CONSTANTS.STATE.CLOSED,
                group: this.swipeGroup,
                reason: this._hideReason
            });

            const reason = this._hideReason;
            this._hideReason = null;

            if (
                reason !== CONSTANTS.STATE.STACKED &&
                reason !== CONSTANTS.STATE.SWIPED_OUT &&
                typeof this.afterClose === 'function'
            ) {
                try { this.afterClose(); } catch (err) { console.error(err); }
            }

            if (!Drawer.activeDrawer && Drawer.drawerStack.length > 0) {
                const previous = Drawer.drawerStack.pop();
                previous.show();
            }
            Drawer.updateBodyScrollLock();
        }
    }

    // -----------------------------------------------------------------------
    // Touch / drag handlers
    // -----------------------------------------------------------------------

    /**
     * Initiates a touch-drag interaction on the drawer.
     * @param {TouchEvent} e - The touchstart event.
     */
    startDragging(e) {
        if (!this.isMobile) return;

        this.isHeaderDrag = this.header.contains(e.target);
        this.startX = e.touches ? e.touches[0].clientX : e.clientX;
        this.startY = e.touches ? e.touches[0].clientY : e.clientY;
        this.isDragging = true;
        this.dragDirection = null;
        this.startTime = Date.now();
        this.startHeight = this.element.getBoundingClientRect().height;
        this.neighborDrawer = null;

        this.element.style.transition = 'none';

        document.addEventListener('touchmove', this._boundOnDragging, { passive: false });
        document.addEventListener('touchend', this._boundStopDragging);
    }

    /**
     * Handles touch-move events during an active drag.
     *
     * @param {TouchEvent} e - The touchmove event.
     */
    onDragging(e) {
        if (!this.isDragging) return;

        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const deltaX = clientX - this.startX;
        const deltaY = clientY - this.startY;

        if (!this.dragDirection) {
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 5) {
                if (this.element.classList.contains(CONSTANTS.CLASSES.LIVE_ACTIVE)) return;

                this.dragDirection = CONSTANTS.DIRECTION.HORIZONTAL;

                if (this.swipeGroup) {
                    Drawer.Indicator.renderForActiveDrawer();
                    Drawer.Indicator.clearTimeout();
                    Drawer.Indicator.toggleTransition(false);
                }

                this.neighborDrawer = deltaX < 0
                    ? this.getNeighbor(CONSTANTS.DIRECTION.NEXT)
                    : this.getNeighbor(CONSTANTS.DIRECTION.PREV);

                if (this.neighborDrawer) {
                    const neighbor = this.neighborDrawer;
                    neighbor.element.style.transition = 'none';
                    neighbor.element.style.visibility = 'visible';
                    neighbor.element.style.zIndex = this.zIndex + 1;
                    neighbor.element.style.display = 'flex';

                    if (neighbor.position === CONSTANTS.DIRECTION.BOTTOM) {
                        const dimension = getLayoutViewportHeight();
                        const savedHeight = StorageModule.getLocalItem(neighbor.storageKey);
                        let numericH = neighbor.parseSize(
                            savedHeight || neighbor.height,
                            dimension
                        );
                        neighbor.element.style.height = `${numericH}px`;
                        neighbor.element.style.bottom = '0';
                    }

                    const vw = getLayoutViewportWidth();
                    const overlap = 1;
                    const startOffset = deltaX < 0 ? vw - overlap : -vw + overlap;
                    neighbor.element.style.transform = `translateX(${startOffset}px)`;
                }
            } else if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 5) {
                if (this.isHeaderDrag) {
                    this.dragDirection = CONSTANTS.DIRECTION.VERTICAL;
                } else {
                    this.isDragging = false;
                    return;
                }
            }
        }

        if (this.dragDirection === CONSTANTS.DIRECTION.HORIZONTAL) {
            e.preventDefault();
            if (!this.neighborDrawer) return;

            if (this.swipeGroup) Drawer.Indicator.move(deltaX);

            const vw = getLayoutViewportWidth();
            const overlap = 1;
            const startOffset = deltaX < 0 ? vw - overlap : -vw + overlap;

            this.element.style.transform = `translateX(${deltaX}px)`;
            this.neighborDrawer.element.style.transform = `translateX(${startOffset + deltaX}px)`;

        } else if (
            this.dragDirection === CONSTANTS.DIRECTION.VERTICAL &&
            this.position === CONSTANTS.DIRECTION.BOTTOM
        ) {
            e.preventDefault();

            const dimension = getLayoutViewportHeight();
            const minHeight = dimension * CONSTANTS.MIN_HEIGHT_RATIO;
            const maxHeight = (dimension - SafeAreaCoordinator.getSafeTop()) * CONSTANTS.MAX_HEIGHT_RATIO;
            let proposedHeight = this.startHeight - deltaY;

            if (proposedHeight >= minHeight) {
                if (proposedHeight > maxHeight - CONSTANTS.MAGNET_ZONE_PX) {
                    proposedHeight = maxHeight;
                }
                proposedHeight = Math.min(proposedHeight, maxHeight);

                this.element.style.height = `${proposedHeight}px`;
                this.element.style.transform = 'translateY(0px)';
            } else {
                this.element.style.height = `${minHeight}px`;
                const translateY = minHeight - proposedHeight;
                this.element.style.transform = `translateY(${translateY}px)`;
            }
        }
    }

    /**
     * Handles drag termination.
     *
     * @param {TouchEvent} e - The touchend event.
     */
    stopDragging(e) {
        if (!this.isDragging) return;
        this.isDragging = false;

        if (this.swipeGroup) {
            Drawer.Indicator.toggleTransition(true);
            Drawer.Indicator.hideDelayed();
        }

        const transition = `transform ${this.transitionSpeed} ease, height ${this.transitionSpeed} ease`;
        this.element.style.transition = transition;

        if (this.dragDirection === CONSTANTS.DIRECTION.HORIZONTAL) {
            const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
            const deltaX = clientX - this.startX;
            const vw = getLayoutViewportWidth();
            const threshold = vw * CONSTANTS.SWIPE_THRESHOLD_RATIO;

            if (this.neighborDrawer) {
                this.neighborDrawer.element.style.transition = transition;

                if (Math.abs(deltaX) > threshold) {
                    this.neighborDrawer.isSwipeEntry = true;

                    const exitOffset = deltaX < 0 ? -vw : vw;
                    const direction = deltaX < 0 ? 'next' : 'prev';

                    if (this.temporaryBackDrawer && this.neighborDrawer === this.temporaryBackDrawer) {
                        this.isSwipingOut = true;

                        this.element.style.transform = `translateX(${exitOffset}px)`;
                        this.neighborDrawer.element.style.transform = `translateX(0px)`;

                        eventBus.emit('DRAWER_SWIPE_TRANSITION', {
                            exitingDrawer: this.id,
                            enteringDrawer: this.neighborDrawer.id,
                            direction,
                            group: this.swipeGroup,
                            action: 'back_gesture'
                        });

                        if (history.state && history.state.drawerId === this.id) {
                            history.back();
                        } else {
                            this.close();
                        }
                    } else {
                        this.element.style.transform = `translateX(${exitOffset}px)`;
                        this.neighborDrawer.element.style.transform = `translateX(0px)`;

                        if (this.swipeGroup) {
                            const group = Drawer.instances
                                .filter(d => d.swipeGroup === this.swipeGroup && d.swipeRank !== -1 && d.enabled)
                                .sort((a, b) => a.swipeRank - b.swipeRank);

                            const neighborIndex = group.indexOf(this.neighborDrawer);
                            if (neighborIndex !== -1) Drawer.Indicator.snapTo(neighborIndex);
                        }

                        eventBus.emit('DRAWER_SWIPE_TRANSITION', {
                            exitingDrawer: this.id,
                            enteringDrawer: this.neighborDrawer.id,
                            direction,
                            group: this.swipeGroup,
                            action: 'swap'
                        });

                        const targetDrawer = this.neighborDrawer;
                        setTimeout(() => {
                            this.hide(CONSTANTS.STATE.SWIPED_OUT);
                            if (targetDrawer) targetDrawer.open();
                            this.element.style.transform = '';
                            this.element.style.bottom = '-100%';
                        }, 300);
                    }
                } else {
                    this.element.style.transform = `translateX(0px)`;
                    const overlap = 1;
                    const startOffset = deltaX < 0 ? vw - overlap : -vw + overlap;
                    this.neighborDrawer.element.style.transform = `translateX(${startOffset}px)`;

                    if (this.swipeGroup) {
                        const group = Drawer.instances
                            .filter(d => d.swipeGroup === this.swipeGroup && d.swipeRank !== -1 && d.enabled)
                            .sort((a, b) => a.swipeRank - b.swipeRank);
                        const myIndex = group.indexOf(this);
                        if (myIndex !== -1) Drawer.Indicator.snapTo(myIndex);
                    }

                    const targetDrawer = this.neighborDrawer;
                    setTimeout(() => {
                        if (targetDrawer) {
                            targetDrawer.element.style.visibility = 'hidden';
                            targetDrawer.element.style.display = 'none';
                        }
                    }, 300);
                }
            } else {
                this.element.style.transform = `translateX(0px)`;
                if (this.swipeGroup) {
                    const group = Drawer.instances
                        .filter(d => d.swipeGroup === this.swipeGroup && d.swipeRank !== -1 && d.enabled)
                        .sort((a, b) => a.swipeRank - b.swipeRank);
                    const myIndex = group.indexOf(this);
                    if (myIndex !== -1) Drawer.Indicator.snapTo(myIndex);
                }
            }

        } else if (this.dragDirection === CONSTANTS.DIRECTION.VERTICAL) {
            const clientY = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
            const deltaY = clientY - this.startY;
            const dimension = getLayoutViewportHeight();
            const minHeight = dimension * CONSTANTS.MIN_HEIGHT_RATIO;
            const currentH = this.element.getBoundingClientRect().height;
            const duration = Date.now() - this.startTime;
            const isFast = duration < 300 && deltaY > 30;

            if (this.confirmCloseOnDrag && (currentH <= minHeight || isFast)) {
                if (isFast || (minHeight - (this.startHeight - deltaY)) > 50) {
                    this.element.style.height = `${minHeight}px`;
                    this.element.style.transform = 'translateY(0px)';
                    this.triggerCloseConfirmation();
                    return;
                }
            }

            if (isFast || (this.startHeight - deltaY) < (minHeight - 50)) {
                this.close();
            } else {
                if (dimension - currentH < CONSTANTS.MAGNET_ZONE_PX) {
                    this.setHeight(dimension);
                    StorageModule.setLocalItem(this.storageKey, '100%');
                    return;
                }

                if (currentH < minHeight) {
                    this.element.style.height = `${minHeight}px`;
                }
                this.element.style.transform = 'translateY(0px)';

                const finalHeight = this.element.getBoundingClientRect().height;
                const percentage = (finalHeight / dimension) * 100;
                StorageModule.setLocalItem(this.storageKey, `${percentage.toFixed(2)}%`);

                Drawer.updateBodyScrollLock();
            }
        }

        document.removeEventListener('touchmove', this._boundOnDragging);
        document.removeEventListener('touchend', this._boundStopDragging);
        this.dragDirection = null;
        this.neighborDrawer = null;
    }

    // -----------------------------------------------------------------------
    // Confirmation toast
    // -----------------------------------------------------------------------

    /**
     * Triggers a confirmation toast before closing the drawer via drag.
     */
    triggerCloseConfirmation() {
        const toastButtons = [
            {
                text: I18n.getTranslation('confirm'),
                action: () => this.close(),
                class: 'ql-btn ql-btn-md'
            },
            {
                text: I18n.getTranslation('cancel'),
                action: () => {},
                class: 'ql-btn ql-btn-md'
            }
        ];

        ToastModule.show(
            'alert',
            null,
            I18n.getTranslation(this.confirmCloseMessage),
            null,
            0,
            'alert',
            toastButtons
        );
    }

    // -----------------------------------------------------------------------
    // Public size API
    // -----------------------------------------------------------------------

    /**
     * Sets the drawer height (bottom position) or width (side position) and
     * persists the computed value. Enforces safe viewport bounds on all
     * screen sizes.
     *
     * @param {string|number} height - Target size as pixels or percentage string.
     */
    setHeight(height) {
        if (!this.isMobile) return;
        const dimension = this.getDimension();
        const raw = typeof height === 'number' ? height : this.parseSize(height, dimension);
        const numericHeight = this.clampHeight(raw, dimension);

        if (this.position === CONSTANTS.DIRECTION.BOTTOM) {
            this.element.style.height = `${numericHeight}px`;
        } else {
            this.element.style.width = `${numericHeight}px`;
        }

        this.element.style[this.getPositionProperty()] = '0';
        this.currentHeight = numericHeight;
        this.element.style.transform = '';

        this.isHalfHeight = Math.abs(numericHeight - dimension * CONSTANTS.MIN_HEIGHT_RATIO) < 10;
        Drawer.updateBodyScrollLock();
    }

    // -----------------------------------------------------------------------
    // Lifecycle: open / hide / show / close / destroy
    // -----------------------------------------------------------------------

    /**
     * Opens the drawer. Manages stacking and switching logic when another
     * drawer is already active.
     */
    open() {
        if (Drawer.activeDrawer && Drawer.activeDrawer !== this) {
            if (!this.swipeGroup || this.swipeRank === -1) {
                this.temporaryBackDrawer = Drawer.activeDrawer;
            }

            if (Drawer.activeDrawer.swipeGroup !== this.swipeGroup) {
                Drawer.activeDrawer.hide(CONSTANTS.STATE.STACKED);
                Drawer.drawerStack.push(Drawer.activeDrawer);
            } else {
                Drawer.activeDrawer.hide(CONSTANTS.STATE.SWITCHED);
            }
        }

        Drawer.activeDrawer = this;
        Drawer.setupHistoryHandling();
        window.history.pushState({ drawerId: this.id }, '', window.location.href);

        this.element.style.transition = 'none';

        if (this.isMobile && this.position === CONSTANTS.DIRECTION.BOTTOM) {
            const dimension = getLayoutViewportHeight();
            const savedHeight = StorageModule.getLocalItem(this.storageKey);
            let numericH = this.parseSize(savedHeight || this.height, dimension);
            numericH = this.clampHeight(numericH, dimension);
            this.element.style.height = `${numericH}px`;
        }

        this.element.offsetHeight;

        if (this.isMobile) {
            this.element.style.transition =
                `transform ${this.transitionSpeed} ease, height ${this.transitionSpeed} ease`;
        } else {
            this.element.style.transition =
                `${this.getPositionProperty()} ${this.transitionSpeed} ease`;
        }

        this.element.style.visibility = 'visible';
        this.element.style.pointerEvents = 'auto';
        this.element.style.display = 'flex';
        
        if (this.isMobile && this.position === CONSTANTS.DIRECTION.BOTTOM) {
            this.element.style.bottom = '0';
        }
        
        this.element.style.transform = 'translate(0,0)';

        this.element.classList.add(CONSTANTS.CLASSES.ACTIVE, CONSTANTS.CLASSES.SHADOW);
        this.element.classList.remove(CONSTANTS.CLASSES.NO_SHADOW);
        this.element.style[this.getPositionProperty()] = '0';
        this.currentPosition = 0;
        this.isHalfHeight = false;
        Drawer.updateBodyScrollLock();

        this.emit(CONSTANTS.STATE.OPEN);
        eventBus.emit('DRAWER_STATE_CHANGE', {
            id: this.id,
            state: CONSTANTS.STATE.OPEN,
            group: this.swipeGroup
        });
    }

    /**
     * Hides the drawer without destroying it (used for stacking).
     * @param {string} [reason=CONSTANTS.STATE.CLOSED] - Reason for hiding.
     */
    hide(reason = CONSTANTS.STATE.CLOSED) {
        this._hideReason = reason;
        this.element.classList.remove(CONSTANTS.CLASSES.ACTIVE, CONSTANTS.CLASSES.SHADOW);
        this.element.classList.add(CONSTANTS.CLASSES.NO_SHADOW);

        if (reason !== CONSTANTS.STATE.SWIPED_OUT) {
            if (this.isMobile && this.position === CONSTANTS.DIRECTION.BOTTOM) {
                this.element.style.bottom = '-100%';
            } else {
                const dimension = this.parseSize(this.height, this.getDimension());
                this.element.style[this.getPositionProperty()] = `-${dimension}px`;
            }
        }

        this.emit(CONSTANTS.STATE.HIDDEN);
    }

    /**
     * Restores a hidden drawer to its visible state.
     */
    show() {
        this.element.style.visibility = 'visible';
        this.element.style.pointerEvents = 'auto';

        if (this.isMobile) {
            if (this.position === CONSTANTS.DIRECTION.BOTTOM) {
                const dimension = getLayoutViewportHeight();
                const savedHeight = StorageModule.getLocalItem(this.storageKey);
                let numericH = this.parseSize(savedHeight || this.height, dimension);
                numericH = this.clampHeight(numericH, dimension);
                this.element.style.height = `${numericH}px`;
            } else {
                this.element.style.width = this.height;
            }
        }

        Drawer.activeDrawer = this;
        this.element.classList.add(CONSTANTS.CLASSES.ACTIVE, CONSTANTS.CLASSES.SHADOW);
        this.element.classList.remove(CONSTANTS.CLASSES.NO_SHADOW);
        this.element.style[this.getPositionProperty()] = '0';
        this.currentPosition = 0;
        this.isHalfHeight = false;
        Drawer.updateBodyScrollLock();
        this.emit(CONSTANTS.STATE.SHOW);

        eventBus.emit('DRAWER_STATE_CHANGE', {
            id: this.id,
            state: CONSTANTS.STATE.SHOW,
            group: this.swipeGroup
        });
    }

    /**
     * Closes the drawer fully and optionally restores the previous one.
     * @param {boolean} [fromHistory=false] - Whether triggered by browser back navigation.
     */
    close(fromHistory = false) {
        const wasActive = Drawer.activeDrawer === this;

        const tempBack = this.temporaryBackDrawer;
        this.temporaryBackDrawer = null;

        this._hideReason = CONSTANTS.STATE.CLOSED;
        this.element.classList.remove(CONSTANTS.CLASSES.ACTIVE, CONSTANTS.CLASSES.SHADOW);
        this.element.classList.add(CONSTANTS.CLASSES.NO_SHADOW);

        if (!this.isSwipingOut) {
            if (this.isMobile) {
                this.element.style.transform = '';
                this.element.style.bottom = '-100%';
            } else {
                const dimension = this.parseSize(this.height, this.getDimension());
                this.element.style[this.getPositionProperty()] = `-${dimension}px`;
            }
            this.element.style.transform = '';
        }

        if (tempBack) {
            tempBack.show();
            Drawer.activeDrawer = tempBack;
        } else if (wasActive) {
            Drawer.activeDrawer = null;
        }

        if (!fromHistory && history.state && history.state.drawerId === this.id) {
            history.back();
        }

        this.isHalfHeight = false;
        this.emit(CONSTANTS.STATE.CLOSED);
    }

    /**
     * Destroys the drawer instance, removes it from the DOM and unregisters
     * it from all coordinators.
     */
    destroy() {
        const wasActive = Drawer.activeDrawer === this;
        const idx = Drawer.drawerStack.indexOf(this);
        if (idx > -1) Drawer.drawerStack.splice(idx, 1);

        if (wasActive) {
            Drawer.activeDrawer = null;
            if (Drawer.drawerStack.length > 0) {
                const prev = Drawer.drawerStack.pop();
                prev.show();
            }
        }

        DrawerResizeCoordinator.unsubscribe(this);
        Drawer.instances = Drawer.instances.filter(i => i !== this);
        if (this.element && this.element.parentNode) this.element.remove();
        Drawer.updateBodyScrollLock();
    }
}

export default Drawer;