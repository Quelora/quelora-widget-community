/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: quelora/js/modules/features/quote.js */
import Drawer from '../../ui/drawer.js';
import UiModule from '../../ui/ui.js';

const CONSTANTS = {
    CLASSES: {
        HANDLE: 'ql-quote-handle',
        POPUP: 'ql-quote-popup',
        BTN_ACTION: 'ql-btn-action',
        BTN_CLOSE: 'ql-btn-close',
        TEXT_SOURCE: 'ql-thread__body',
    },
    SELECTORS: {
        AUTHOR: '.ql-thread__author',
        THREAD_ITEM: '.ql-thread'
    },
    OFFSETS: {
        POPUP_MARGIN: 10,
        SCROLL_PADDING: 50
    }
};

const STATE = {
    initialized: false,
    elements: {
        startHandle: null,
        endHandle: null,
        popup: null
    },
    active: {
        range: null,
        sourceElement: null,
        scrollParent: null,
        observer: null,
        callback: null
    },
    flags: {
        isDragging: false
    }
};

const DomHelper = {
    createUI: () => {
        if (STATE.initialized) return;

        STATE.elements.startHandle = UiModule.createElementUI({ tag: 'div', classes: [CONSTANTS.CLASSES.HANDLE] });
        STATE.elements.endHandle = UiModule.createElementUI({ tag: 'div', classes: [CONSTANTS.CLASSES.HANDLE] });
        STATE.elements.popup = UiModule.createElementUI({ tag: 'div', classes: [CONSTANTS.CLASSES.POPUP] });
        
        const quoteBtn = UiModule.createElementUI({ 
            tag: 'button', 
            classes: [CONSTANTS.CLASSES.BTN_ACTION], 
            content: 'Quote' 
        });
        
        const closeBtn = UiModule.createElementUI({ 
            tag: 'button', 
            classes: [CONSTANTS.CLASSES.BTN_CLOSE], 
            content: '×' 
        });

        STATE.elements.popup.append(quoteBtn, closeBtn);
        document.body.append(STATE.elements.startHandle, STATE.elements.endHandle, STATE.elements.popup);
        
        quoteBtn.addEventListener('click', EventHandlers.handleQuoteAction);
        
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault(); 
            e.stopPropagation(); 
            QuoteModule.hideAndDeselect();
        });

        EventHandlers.attachDragListeners(STATE.elements.startHandle, true);
        EventHandlers.attachDragListeners(STATE.elements.endHandle, false);

        if (typeof Drawer !== 'undefined' && Drawer.onGlobal) {
            Drawer.onGlobal('drawerClosed', QuoteModule.hideAndDeselect);
        }

        STATE.initialized = true;
    },

    getScrollParent: (node) => {
        if (!node) return null;
        if (node.scrollHeight > node.clientHeight) {
            const overflowY = window.getComputedStyle(node).overflowY;
            if (overflowY === 'scroll' || overflowY === 'auto') return node;
        }
        return DomHelper.getScrollParent(node.parentElement) || document.body;
    }
};

const ScrollService = {
    attach: (element) => {
        const scrollParent = DomHelper.getScrollParent(element);
        
        if (scrollParent && scrollParent !== STATE.active.scrollParent) {
            ScrollService.detach();
            
            STATE.active.scrollParent = scrollParent;
            STATE.active.scrollParent.addEventListener('scroll', QuoteModule.hideAndDeselect, { passive: true, capture: true });
        }
        // Siempre escuchar al window por si acaso
        window.addEventListener('scroll', QuoteModule.hideAndDeselect, { passive: true, capture: true });
        window.addEventListener('resize', QuoteModule.hideAndDeselect, { passive: true });
    },

    detach: () => {
        if (STATE.active.scrollParent) {
            STATE.active.scrollParent.removeEventListener('scroll', QuoteModule.hideAndDeselect, { capture: true });
            STATE.active.scrollParent = null;
        }
        window.removeEventListener('scroll', QuoteModule.hideAndDeselect, { capture: true });
        window.removeEventListener('resize', QuoteModule.hideAndDeselect);
    }
};

const SelectionService = {
    getCaretFromEvent: (e) => {
        const x = e.clientX || e.touches?.[0]?.clientX;
        const y = e.clientY || e.touches?.[0]?.clientY;
        
        if (document.caretRangeFromPoint) {
            const range = document.caretRangeFromPoint(x, y);
            return range ? { node: range.startContainer, offset: range.startOffset } : null;
        }
        if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
        }
        return null;
    },

    setRange: (node, offset, isStart) => {
        if (!STATE.active.range) return;
        try {
            if (isStart) STATE.active.range.setStart(node, offset);
            else STATE.active.range.setEnd(node, offset);
            
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(STATE.active.range);
        } catch (e) {}
    },

    extractAuthor: () => {
        if (!STATE.active.sourceElement) return undefined;
        const container = STATE.active.sourceElement.closest(CONSTANTS.SELECTORS.THREAD_ITEM);
        const authorEl = container?.querySelector(CONSTANTS.SELECTORS.AUTHOR);
        return authorEl ? authorEl.textContent.trim() : undefined;
    }
};

const UiService = {
    updatePosition: () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return QuoteModule.hideUI();

        const range = sel.getRangeAt(0);
        
        if (STATE.active.sourceElement && 
           (!STATE.active.sourceElement.contains(range.startContainer) || 
            !STATE.active.sourceElement.contains(range.endContainer))) {
            return QuoteModule.hideAndDeselect();
        }

        STATE.active.range = range.cloneRange();
        const rects = range.getClientRects();
        if (!rects.length) return;

        const startRect = rects[0];
        const endRect = rects[rects.length - 1];
        const scrollX = window.scrollX;
        const scrollY = window.scrollY;

        const { startHandle, endHandle, popup } = STATE.elements;

        // Handles
        startHandle.style.left = `${startRect.left + scrollX - startHandle.offsetWidth}px`;
        startHandle.style.top = `${startRect.top + scrollY}px`;
        
        endHandle.style.left = `${endRect.right + scrollX}px`;
        endHandle.style.top = `${endRect.bottom + scrollY - endHandle.offsetHeight}px`;

        // Popup Smart Positioning
        // Aseguramos display block temporalmente para leer dimensiones si es la primera vez
        popup.style.display = 'flex'; 
        
        const popupWidth = popup.offsetWidth || 100; 
        const popupHeight = popup.offsetHeight || 36;
        
        let popupLeft = startRect.left + scrollX + (endRect.right - startRect.left) / 2 - popupWidth / 2;
        popupLeft = Math.max(10, Math.min(window.innerWidth - popupWidth - 10, popupLeft));

        const spaceAbove = startRect.top - CONSTANTS.OFFSETS.SCROLL_PADDING; 
        let popupTop;

        if (spaceAbove > popupHeight) {
            popupTop = startRect.top + scrollY - popupHeight - CONSTANTS.OFFSETS.POPUP_MARGIN;
        } else {
            popupTop = endRect.bottom + scrollY + CONSTANTS.OFFSETS.POPUP_MARGIN;
        }

        popup.style.left = `${popupLeft}px`;
        popup.style.top = `${popupTop}px`;

        startHandle.style.display = 'block';
        endHandle.style.display = 'block';
    }
};

const EventHandlers = {
    handleQuoteAction: (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (STATE.active.range && STATE.active.callback) {
            const text = STATE.active.range.toString();
            const author = SelectionService.extractAuthor();
            STATE.active.callback(text, author);
            QuoteModule.hideAndDeselect();
        }
    },

    handleDragStart: (e, isStartHandle) => {
        e.preventDefault();
        e.stopPropagation();
        STATE.flags.isDragging = true;
        
        if (!window.getSelection().rangeCount || !STATE.active.range) return;

        const onMove = (ev) => {
            const caret = SelectionService.getCaretFromEvent(ev);
            if (!caret) return;
            if (!STATE.active.sourceElement || !STATE.active.sourceElement.contains(caret.node)) return;
            SelectionService.setRange(caret.node, caret.offset, isStartHandle);
            UiService.updatePosition();
        };

        const onUp = () => {
            STATE.flags.isDragging = false;
            ['mousemove', 'mouseup', 'touchmove', 'touchend'].forEach(evt => 
                document.removeEventListener(evt, evt.includes('move') ? onMove : onUp)
            );
        };

        ['mousemove', 'mouseup', 'touchmove', 'touchend'].forEach(evt => 
            document.addEventListener(evt, evt.includes('move') ? onMove : onUp, { passive: false })
        );
    },

    attachDragListeners: (element, isStart) => {
        ['mousedown', 'touchstart'].forEach(evt => 
            element.addEventListener(evt, (e) => EventHandlers.handleDragStart(e, isStart), { passive: false })
        );
    }
};

export class QuoteSelector {
    constructor(callback) {
        DomHelper.createUI();
        STATE.active.callback = callback;
    }

    activateWithElement(element) {
        if (!element || !element.classList.contains(CONSTANTS.CLASSES.TEXT_SOURCE)) return;

        STATE.active.sourceElement = element;

        const range = document.createRange();
        range.selectNodeContents(element);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);

        STATE.active.range = range;
        
        // 1. Mostrar UI
        UiService.updatePosition();

        // 2. Adjuntar listener de scroll INMEDIATAMENTE al contenedor correcto
        ScrollService.attach(element);

        // 3. Observer por si el elemento se destruye
        if (STATE.active.observer) STATE.active.observer.disconnect();
        STATE.active.observer = new MutationObserver(() => {
            if (!document.body.contains(element)) QuoteModule.hideAndDeselect();
        });
        STATE.active.observer.observe(document.body, { childList: true, subtree: true });
    }
}

const QuoteModule = {
    hideUI: () => {
        if (!STATE.initialized) return;
        STATE.elements.startHandle.style.display = 'none';
        STATE.elements.endHandle.style.display = 'none';
        STATE.elements.popup.style.display = 'none';
    },

    hideAndDeselect: () => {
        // Ignorar eventos de scroll si estamos arrastrando los handles nosotros mismos
        if (STATE.flags.isDragging) return;

        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        
        QuoteModule.hideUI();
        ScrollService.detach(); // Dejar de escuchar scroll
        
        if (STATE.active.observer) {
            STATE.active.observer.disconnect();
            STATE.active.observer = null;
        }
        STATE.active.sourceElement = null;
        STATE.active.range = null;
    }
};

export default QuoteModule;