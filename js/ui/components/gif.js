/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/ui/components/gif.js */
/**
 * @module UI/Components/GifPicker
 * @description Giphy-powered GIF search panel that mounts above the comment bar
 * using the same `addElementHeaderUI` recipe as the mention and reply-header panels.
 *
 * ## Security model
 *
 * The Giphy API key is **never present on the client**.  All Giphy requests are
 * proxied through the existing worker infrastructure:
 *
 * - Main thread  →  `CoreModule.postWorkerMessage({ action: 'searchGif', payload })`
 * - Worker       →  hits `${apiUrl}/giphy/search?q=...` (your backend proxies to Giphy)
 * - Worker       →  `self.postMessage({ action: 'gifResults', payload: { gifs, query, _seq } })`
 * - Main thread  →  `eventBus.on('gifResults', …)` populates the grid
 *
 * The backend endpoint (`/giphy/search` and `/giphy/trending`) is responsible
 * for injecting the Giphy API key and forwarding the response.
 *
 * ## Integration
 *
 * ```js
 * // In comments.js — after the input element is ready:
 * import GifPickerModule from '../../ui/components/gif.js';
 * GifPickerModule.attach(inputElement);
 *
 * // In quelora-app.js worker result handlers:
 * gifResults: (payload) => GifPickerModule.handleResults(payload),
 *
 * // In comments.js submitComment — close the panel on submit:
 * GifPickerModule.close();
 * ```
 *
 * ## GIF insertion format (composing vs. submit)
 *
 * When a GIF is selected the module inserts a **visual preview node** into the
 * `contenteditable` input rather than raw markdown text.  The preview is an
 * `<img>` element that:
 *
 * - Is visually identical to what the WASM renderer would produce after submit.
 * - Carries `data-giphy-id="<id>"` so `getCleanInputText({ forSubmit: true })`
 * can reconstruct the `![GIF](giphy|<id>)` notation at submit time.
 * - Carries `contenteditable="false"` so the browser never lets the user type
 * inside it.
 * - Counts as **zero logical characters** — `getCleanInputText` strips it when
 * measuring length, matching the existing behaviour for Gboard GIF nodes.
 *
 * For `<input>` / `<textarea>` targets (non-contenteditable), the raw notation
 * is still inserted directly because those elements cannot host child nodes.
 *
 * ## Closing without selection
 *
 * The panel always exposes a close button and responds to the `Escape` key so
 * users can dismiss it without inserting any content.
 *
 * @version 2.4.1 
 */
import handleLog from '../../core/logs.js';
import ConfModule from '../../core/conf.js';
import CommentsUiModule from '../../modules/comments/comments.ui.js';
import CoreModule from '../../core/core.js';
import I18n from '../../core/i18n.js';
import GuardModule from '../../core/guard.js';
import { eventBus } from '../../core/event.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** @constant {string} CSS class placed on the panel root element. */
const PANEL_CLASS = 'ql-gif-picker-panel';

/** @constant {string} CSS class placed on the trigger button. */
const TRIGGER_CLASS = 'ql-gif-picker-btn';

/** @constant {number} Minimum query length before a search request is dispatched. */
const MIN_QUERY_LENGTH = 2;

/** @constant {number} Debounce delay in ms applied to the search input. */
const SEARCH_DEBOUNCE_MS = 450;

/** @constant {number} Maximum allowed pagination depths. */
const MAX_PAGES = 3;

/** @constant {string} Module log icon — identifies GifPicker entries in the console. */
const LOG_ICON = '🎞️';

/**
 * Base URL used to build the live Giphy image src for preview nodes.
 * Matches the URL pattern already accepted by `GIPHY_REGEX` in `lib.rs`.
 *
 * @constant {string}
 */
const GIPHY_MEDIA_BASE = 'https://media.giphy.com/media';

// =============================================================================
// MODULE STATE
// =============================================================================

/**
 * Reference to the instrumented comment input element.
 * @type {HTMLElement|null}
 */
let _inputElement = null;

/**
 * Reference to the currently mounted panel element, or `null` when closed.
 * @type {HTMLElement|null}
 */
let _panelElement = null;

/**
 * Reference to the grid container inside the open panel.
 * Kept here so that `handleResults` can populate it without DOM queries.
 * @type {HTMLElement|null}
 */
let _gridElement = null;

/**
 * Array holding references to the physical column elements used for masonry.
 * @type {HTMLElement[]}
 */
let _columns = [];

/**
 * Round-robin pointer to distribute incoming GIFs evenly across columns.
 * @type {number}
 */
let _nextColIndex = 0;

/**
 * Reference to the loader element inside the open panel.
 * @type {HTMLElement|null}
 */
let _loaderElement = null;

/**
 * Debounce timer handle for the search input field.
 * @type {ReturnType<typeof setTimeout>|null}
 */
let _debounceTimer = null;

/**
 * Monotonically increasing counter used as a request-sequence token.
 * Each call to `_dispatchSearch` increments this value and embeds it in the
 * worker payload.  The worker echoes it back in `gifResults` so stale
 * responses can be detected and discarded on the main thread.
 * @type {number}
 */
let _requestSeq = 0;

/**
 * The sequence number of the most recently dispatched request.
 * Responses carrying a lower sequence number are ignored.
 * @type {number}
 */
let _lastDispatchedSeq = 0;

/**
 * Unsubscribe function returned by `eventBus.on('gifResults', …)`.
 * Stored so the listener is removed when the panel closes.
 * @type {Function|null}
 */
let _resultsUnsubscribe = null;

/**
 * Optional callback invoked after a GIF is inserted into the input.
 * When provided (via {@link GifPickerModule.attach}), the picker auto-submits
 * the comment immediately after insertion.
 *
 * @type {Function|null}
 */
let _onSubmitCallback = null;

// Pagination state
let _currentOffset = 0;
let _currentPage = 1;
let _hasMore = true;
let _currentQuery = '';
let _isFetching = false;
let _sentinelObserver = null;
let _sentinelElement = null;

// =============================================================================
// PRIVATE — GIF INSERTION
// =============================================================================

/**
 * Inserts a Giphy GIF into the comment input registered via
 * {@link GifPickerModule.attach}.
 *
 * @param {string} gifId  - Alphanumeric Giphy GIF identifier.
 * @param {string} gifUrl - CDN URL of the GIF used as the preview `src`.
 * @returns {void}
 * @private
 */
function _insertGifMarkdown(gifId, gifUrl) {
    if (!_inputElement || !gifId) return;

    const notation = `![GIF](giphy|${gifId})`;

    if (_inputElement.isContentEditable) {
        _inputElement.focus();

        _inputElement.querySelectorAll('img[data-giphy-id]').forEach(n => n.remove());

        const img = document.createElement('img');
        img.src = gifUrl || `${GIPHY_MEDIA_BASE}/${gifId}/giphy.gif`;
        img.alt = 'GIF';
        img.className = 'ql-gif-preview';
        img.setAttribute('contenteditable', 'false');
        img.setAttribute('data-giphy-id', gifId);
        img.setAttribute('data-giphy-notation', notation);
        img.style.cssText = 'max-width:100%;height:auto;display:block;border-radius:8px;pointer-events:none;';

        const selection = window.getSelection();

        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            range.collapse(false);
            range.insertNode(img);
            range.setStartAfter(img);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        } else {
            _inputElement.appendChild(img);
        }
    } else {
        _inputElement.value = _inputElement.value
            .replace(/!\[GIF\]\(giphy\|[a-zA-Z0-9]+(?:\|[^)]*)?\)/g, '')
            .trim();

        _inputElement.value = (_inputElement.value
            ? _inputElement.value + ' '
            : '') + notation;
    }

    _inputElement.dispatchEvent(new Event('input', { bubbles: true }));

    if (typeof _onSubmitCallback === 'function') {
        GifPickerModule.close();
        _onSubmitCallback();
    }
}

// =============================================================================
// PRIVATE — WORKER COMMUNICATION
// =============================================================================

/**
 * Dispatches a `searchGif` or `trendingGif` message to the internal worker.
 *
 * @param {string} query - Search term. An empty string triggers a trending request.
 * @param {boolean} isLoadMore - Whether this request is appending paginated results.
 * @returns {void}
 * @private
 */
function _dispatchSearch(query, isLoadMore = false) {
    if (!isLoadMore) {
        _currentOffset = 0;
        _currentPage = 1;
        _hasMore = true;
        _currentQuery = query;
    } else {
        _currentPage++;
    }

    _isFetching = true;
    _requestSeq += 1;
    _lastDispatchedSeq = _requestSeq;

    const action = _currentQuery.trim().length >= MIN_QUERY_LENGTH ? 'searchGif' : 'trendingGif';

    CoreModule.postWorkerMessage({
        action,
        payload: {
            query: _currentQuery.trim(),
            _seq:  _requestSeq,
            offset: _currentOffset
        }
    });

    handleLog(
        `GIF request dispatched — action: ${action}, seq: ${_requestSeq}, query: "${_currentQuery}", offset: ${_currentOffset}`,
        'GifPickerModule',
        'info',
        LOG_ICON
    );
}

/**
 * Schedules a debounced search dispatch for the given query string.
 *
 * @param {string} query - Current value of the search input field.
 * @returns {void}
 * @private
 */
function _scheduledSearch(query) {
    if (_debounceTimer !== null) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
    }

    if (_loaderElement) _loaderElement.style.display = 'flex';
    _initColumns();

    _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        _dispatchSearch(query, false);
    }, SEARCH_DEBOUNCE_MS);
}

// =============================================================================
// PRIVATE — GRID RENDERING & PAGINATION (JS MASONRY)
// =============================================================================

/**
 * Creates the physical DOM columns for the masonry layout.
 * Called automatically when starting a fresh search.
 * @private
 */
function _initColumns() {
    if (!_gridElement) return;
    
    _gridElement.innerHTML = '';
    _columns = [];
    _nextColIndex = 0;
    
    const numCols = window.innerWidth >= 769 ? 4 : 3;
    
    for (let i = 0; i < numCols; i++) {
        const col = document.createElement('div');
        col.className = 'ql-gif-column';
        _gridElement.appendChild(col);
        _columns.push(col);
    }
}

/**
 * Configures the Intersection Observer for pagination.
 * @private
 */
function _setupSentinel() {
    if (_sentinelObserver) {
        _sentinelObserver.disconnect();
    }
    
    _sentinelObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && _hasMore && !_isFetching && _currentPage < MAX_PAGES) {
            if (_loaderElement) _loaderElement.style.display = 'flex';
            _dispatchSearch(_currentQuery, true);
        }
    }, { rootMargin: '150px' });
}

/**
 * Appends the sentinel element to the shortest column to ensure smooth triggering.
 * @private
 */
function _appendSentinel() {
    if (!_gridElement || _columns.length === 0) return;
    
    if (_sentinelElement) {
        _sentinelElement.remove();
    }
    
    if (_hasMore && _currentPage < MAX_PAGES) {
        if (!_sentinelElement) {
            _sentinelElement = document.createElement('div');
            _sentinelElement.className = 'ql-gif-sentinel';
            _sentinelElement.style.width = '100%';
            _sentinelElement.style.height = '10px';
        }
        
        // Find the column with the fewest children to append the sentinel
        let targetCol = _columns[0];
        let minChildren = targetCol.children.length;
        
        for (let i = 1; i < _columns.length; i++) {
            if (_columns[i].children.length < minChildren) {
                targetCol = _columns[i];
                minChildren = _columns[i].children.length;
            }
        }
        
        targetCol.appendChild(_sentinelElement);
        
        if (_sentinelObserver) {
            _sentinelObserver.observe(_sentinelElement);
        }
    }
}

/**
 * Renders a single GIF tile element.
 *
 * @param {{ id: string, url: string, title: string }} gif - GIF descriptor.
 * @returns {HTMLButtonElement} The tile element.
 * @private
 */
function _renderTile(gif) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'ql-gif-tile';
    tile.setAttribute('aria-label', gif.title);
    tile.setAttribute('data-gif-id', gif.id);
    tile.setAttribute('tabindex', '0');

    tile.style.minHeight = '120px';
    tile.style.display = 'block';
    tile.style.width = '100%';

    const img = document.createElement('img');
    img.src      = gif.url;
    img.alt      = gif.title;
    img.loading  = 'lazy';
    img.decoding = 'async';
    img.style.width = '100%';
    img.style.display = 'block';

    img.addEventListener('load', () => {
        tile.style.minHeight = '';
    });

    tile.appendChild(img);

    tile.addEventListener('click', () => {
        _insertGifMarkdown(gif.id, gif.url);
        if (typeof _onSubmitCallback !== 'function') {
            GifPickerModule.close();
        }
    });

    return tile;
}

/**
 * Populates `_gridElement` distributing GIFs in a Round-Robin fashion
 * across the physical DOM columns.
 *
 * @param {Array<{id: string, url: string, title: string}>} gifs - Normalised GIF list.
 * @param {boolean} hasMore - Boolean determining if more pages are available.
 * @returns {void}
 * @private
 */
function _populateGrid(gifs, hasMore) {
    if (!_gridElement) return;

    if (_sentinelElement) _sentinelElement.remove();

    if (!gifs || !gifs.length) {
        if (_currentOffset === 0) {
            _gridElement.innerHTML = '';
            _columns = [];
            const empty = document.createElement('div');
            empty.className = 'ql-gif-empty t';
            empty.textContent = I18n.getTranslation('noResults') || '{{noResults}}';
            _gridElement.appendChild(empty);
        }
        _hasMore = false;
        return;
    }

    const existingIds = new Set(
        Array.from(_gridElement.querySelectorAll('.ql-gif-tile')).map(el => el.getAttribute('data-gif-id'))
    );

    const uniqueGifs = gifs.filter(gif => !existingIds.has(gif.id));

    if (gifs.length > 0 && uniqueGifs.length === 0) {
        handleLog('Giphy returned 100% duplicate page. Halting pagination.', 'GifPickerModule', 'info', LOG_ICON);
        _hasMore = false;
        return;
    }

    // Safety fallback in case state was corrupted
    if (_columns.length === 0) {
        _initColumns();
    }

    uniqueGifs.forEach(gif => {
        _columns[_nextColIndex].appendChild(_renderTile(gif));
        _nextColIndex = (_nextColIndex + 1) % _columns.length;
    });

    _currentOffset += gifs.length;
    _hasMore = typeof hasMore === 'boolean' ? hasMore : gifs.length > 0;

    _appendSentinel();
}

// =============================================================================
// PRIVATE — PANEL DOM
// =============================================================================

/**
 * Builds the full panel DOM tree and wires internal events.
 *
 * @returns {{ panel: HTMLElement, searchInput: HTMLInputElement }} Assembled elements.
 * @private
 */
function _buildPanel() {
    const panel = document.createElement('div');
    panel.className = PANEL_CLASS;

    const toolbar = document.createElement('div');
    toolbar.className = 'ql-gif-picker-panel__toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'ql-gif-search-input';
    searchInput.setAttribute('placeholder', I18n.getTranslation('search'));
    searchInput.setAttribute('autocomplete', 'off');
    searchInput.setAttribute('spellcheck', 'false');
    searchInput.setAttribute('maxlength', '100');

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ql-gif-close-btn';
    closeBtn.setAttribute('aria-label', I18n.getTranslation('close'));
    closeBtn.innerHTML = '<span class="ql-icons-outlined">close</span>';
    closeBtn.addEventListener('click', () => GifPickerModule.close());

    toolbar.appendChild(searchInput);
    toolbar.appendChild(closeBtn);

    const loader = document.createElement('div');
    loader.className = 'ql-gif-loader';
    loader.style.display = 'none';
    loader.innerHTML = '<div class="ql-loader"></div>';

    const grid = document.createElement('div');
    grid.className = 'ql-gif-grid';

    panel.appendChild(toolbar);
    panel.appendChild(loader);
    panel.appendChild(grid);

    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            GifPickerModule.close();
        }
    });

    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    searchInput.addEventListener('input', () => _scheduledSearch(searchInput.value));

    return { panel, searchInput };
}

// =============================================================================
// PRIVATE — TRIGGER BUTTON
// =============================================================================

/**
 * Creates and injects the GIF trigger button adjacent to the comment input.
 *
 * @param {HTMLElement} inputEl - The registered comment input element.
 * @returns {HTMLElement|null} The created button, or `null` on failure.
 * @private
 */
function _injectTriggerButton(inputEl) {
    try {
        const existing = document.querySelector(`.${TRIGGER_CLASS}`);
        if (existing) return existing;

        const btn = document.createElement('span');
        btn.className = `ql-icons-outlined ${TRIGGER_CLASS}`;
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('aria-label', I18n.getTranslation('insertGif') || 'GIF');
        btn.setAttribute('title', 'GIF');
        btn.textContent = 'gif_box';
        btn.style.cursor = 'pointer';

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            GifPickerModule.toggle();
        });

        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                GifPickerModule.toggle();
            }
        });

        const inputContainer = inputEl.closest('.ql-comment-bar__input-container');
        if (inputContainer) {
            inputContainer.appendChild(btn);
        } else {
            const bar = inputEl.closest('.ql-comment-bar');
            if (bar) bar.appendChild(btn);
        }

        return btn;
    } catch (err) {
        handleLog(err, 'GifPickerModule._injectTriggerButton', 'warn', LOG_ICON);
        return null;
    }
}

// =============================================================================
// PRIVATE — EVENT BUS SUBSCRIPTION
// =============================================================================

/**
 * Subscribes to the `gifResults` event on the shared event bus.
 *
 * @returns {void}
 * @private
 */
function _subscribeResults() {
    if (_resultsUnsubscribe) return;

    const handler = (payload) => {
        if (!_panelElement) return;

        if (typeof payload._seq === 'number' && payload._seq < _lastDispatchedSeq) {
            handleLog(
                `GIF response discarded (stale seq ${payload._seq} < ${_lastDispatchedSeq}).`,
                'GifPickerModule',
                'info',
                LOG_ICON
            );
            return;
        }
        
        if (_loaderElement) _loaderElement.style.display = 'none';
        _populateGrid(payload.gifs || [], payload.hasMore);

        setTimeout(() => {
            _isFetching = false;
        }, 300);
    };

    eventBus.on('gifResults', handler);

    _resultsUnsubscribe = () => {
        eventBus.off('gifResults', handler);
        _resultsUnsubscribe = null;
    };
}

/**
 * Removes the `gifResults` event bus subscription.
 *
 * @returns {void}
 * @private
 */
function _unsubscribeResults() {
    if (_resultsUnsubscribe) {
        _resultsUnsubscribe();
    }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * @namespace GifPickerModule
 * @description Public interface for the GIF picker component.
 */
const GifPickerModule = {

    attach(inputEl, options = {}) {
        try {
            if (!inputEl) {
                handleLog('attach() called without a valid input element.', 'GifPickerModule', 'warn', LOG_ICON);
                return;
            }

            const isEnabled = Boolean(ConfModule.get('comments.allowGif', false));
            if (!isEnabled) {
                handleLog('comments.allowGif is false — GIF picker will not be shown.', 'GifPickerModule', 'info', LOG_ICON);
                return;
            }

            _inputElement     = inputEl;
            _onSubmitCallback = typeof options.onSubmit === 'function' ? options.onSubmit : null;
            _injectTriggerButton(inputEl);

            handleLog('GIF picker attached.', 'GifPickerModule', 'info', LOG_ICON);
        } catch (err) {
            handleLog(err, 'GifPickerModule.attach', 'error', LOG_ICON);
        }
    },

    open() {
        GuardModule.protect(() => {
            try {
                if (_panelElement) {
                    this.close();
                }

                const { panel, searchInput } = _buildPanel();
                _panelElement  = panel;
                _gridElement   = panel.querySelector('.ql-gif-grid');
                _loaderElement = panel.querySelector('.ql-gif-loader');

                _setupSentinel();
                _subscribeResults();
                CommentsUiModule.addElementHeaderUI(panel);

                requestAnimationFrame(() => searchInput.focus());

                _scheduledSearch('');

                eventBus.emit('GIF_PICKER_OPENED');
                handleLog('GIF picker opened.', 'GifPickerModule', 'info', LOG_ICON);
            } catch (err) {
                handleLog(err, 'GifPickerModule.open', 'error', LOG_ICON);
            }
        });
    },

    close() {
        try {
            if (_debounceTimer !== null) {
                clearTimeout(_debounceTimer);
                _debounceTimer = null;
            }

            if (_sentinelObserver) {
                _sentinelObserver.disconnect();
                _sentinelObserver = null;
            }

            _unsubscribeResults();

            if (_panelElement) {
                _panelElement.remove();
                _panelElement  = null;
                _gridElement   = null;
                _columns       = [];
                _nextColIndex  = 0;
                _loaderElement = null;
                _sentinelElement = null;
                
                eventBus.emit('GIF_PICKER_CLOSED');
            }

            if (_inputElement) {
                _inputElement.focus();
            }

            handleLog('GIF picker closed.', 'GifPickerModule', 'info', LOG_ICON);
        } catch (err) {
            handleLog(err, 'GifPickerModule.close', 'error', LOG_ICON);
        }
    },

    toggle() {
        if (_panelElement) {
            this.close();
        } else {
            this.open();
        }
    },

    isOpen() {
        return _panelElement !== null;
    },

    handleResults(payload) {
        eventBus.emit('gifResults', payload);
    }
};

export default GifPickerModule;