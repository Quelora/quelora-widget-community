/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: quelora/js/cropper.js */
import UiModule from '../ui.js';

// CONSTANTS
const CONSTANTS = {
    ASPECT_RATIO_AVATAR: 1,
    ASPECT_RATIO_BACKGROUND: 2.5875,
    MIN_SIZE: 90,
    TYPE_AVATAR: 'avatar',
    TYPE_BACKGROUND: 'background'
};

// _state
let _state = {
    options: null,
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    selectionStartX: 0,
    selectionStartY: 0,
    selectionStartWidth: 0,
    selectionStartHeight: 0,
    selectionStartX_img: 0,
    selectionStartY_img: 0,
    resizeDirection: null,
    currentSelection: { x: 0, y: 0, width: 0, height: 0 },
    imgDimensions: { width: 0, height: 0, offsetX: 0, offsetY: 0 },
    scale: { x: 1, y: 1 },
    elements: {
        modalEl: null,
        imageContainerEl: null,
        imageEl: null,
        selectionEl: null,
        cancelBtnEl: null,
        confirmBtnEl: null
    },
    boundEvents: {}
};

// _PrivateServices
function _resetState(options) {
    _state.options = {
        aspectRatio: 1,
        type: CONSTANTS.TYPE_AVATAR,
        onConfirm: () => {},
        onCancel: () => {},
        ...options
    };
    _state.isDragging = false;
    _state.resizeDirection = null;
    _state.elements = {
        modalEl: null,
        imageContainerEl: null,
        imageEl: null,
        selectionEl: null,
        cancelBtnEl: null,
        confirmBtnEl: null
    };
    // Ensure boundEvents is clean
    _state.boundEvents = {};
}

function _createInterface() {
    _state.elements.modalEl = UiModule.createElementUI({
        tag: 'div',
        classes: 'ql-cropper__modal'
    });

    const containerEl = UiModule.createElementUI({
        tag: 'div',
        classes: 'ql-cropper__container'
    });

    const instructionsEl = UiModule.createElementUI({
        tag: 'div',
        classes: ['ql-cropper__instructions','t'],
        content: _state.options.type === CONSTANTS.TYPE_AVATAR ?
            '{{adjust_square_area_avatar}}' :
            '{{adjust_rectangular_area_background}}'
    });

    _state.elements.imageContainerEl = UiModule.createElementUI({
        tag: 'div',
        classes: 'ql-cropper__image-container'
    });

    _state.elements.imageEl = UiModule.createElementUI({
        tag: 'img',
        classes: 'ql-cropper__image',
        attributes: {
            src: _state.options.imageSrc
        }
    });

    _state.elements.selectionEl = UiModule.createElementUI({
        tag: 'div',
        classes: ['ql-cropper__selection', `ql-cropper__selection--${_state.options.type}`],
        innerHTML: `
            <div class="ql-cropper__handle ql-cropper__handle--tl" data-direction="nw"></div>
            <div class="ql-cropper__handle ql-cropper__handle--tr" data-direction="ne"></div>
            <div class="ql-cropper__handle ql-cropper__handle--bl" data-direction="sw"></div>
            <div class="ql-cropper__handle ql-cropper__handle--br" data-direction="se"></div>
        `
    });

    const buttonsEl = UiModule.createElementUI({
        tag: 'div',
        classes: 'ql-cropper__buttons'
    });

    _state.elements.cancelBtnEl = UiModule.createElementUI({
        tag: 'button',
        classes: ['ql-cropper__button', 'ql-cropper__button--secondary','t'],
        content: '{{cancel}}'
    });

    _state.elements.confirmBtnEl = UiModule.createElementUI({
        tag: 'button',
        classes: ['ql-cropper__button', 'ql-cropper__button--primary','t'],
        content: '{{confirm}}'
    });

    if (buttonsEl && _state.elements.cancelBtnEl && _state.elements.confirmBtnEl) {
        buttonsEl.appendChild(_state.elements.cancelBtnEl);
        buttonsEl.appendChild(_state.elements.confirmBtnEl);
    }

    if (_state.elements.imageContainerEl && _state.elements.imageEl && _state.elements.selectionEl) {
        _state.elements.imageContainerEl.appendChild(_state.elements.imageEl);
        _state.elements.imageContainerEl.appendChild(_state.elements.selectionEl);
    }

    if (containerEl && instructionsEl && _state.elements.imageContainerEl) {
        containerEl.appendChild(instructionsEl);
        containerEl.appendChild(_state.elements.imageContainerEl);
    }

    if (_state.elements.modalEl && containerEl && buttonsEl) {
        _state.elements.modalEl.appendChild(containerEl);
        _state.elements.modalEl.appendChild(buttonsEl);
    }

    if (_state.elements.modalEl) {
        const root = document.getElementById('ql-root') || document.body;
        root.appendChild(_state.elements.modalEl);
        document.body.style.overflow = 'hidden';
    }
}

function _calculateInitialSelection() {
    const { imageEl, imageContainerEl } = _state.elements;

    // Logic extracted to handle both cached (synchronous) and new (asynchronous) images
    const handleImageLoad = () => {
        const containerRect = imageContainerEl.getBoundingClientRect();
        const imgRect = imageEl.getBoundingClientRect();
        
        // Prevent division by zero if image hasn't rendered dimensions yet
        if (imgRect.width === 0 || imgRect.height === 0) {
            requestAnimationFrame(handleImageLoad);
            return;
        }

        const scaleX = imageEl.naturalWidth / imgRect.width;
        const scaleY = imageEl.naturalHeight / imgRect.height;

        const targetAspectRatio = _state.options.type === CONSTANTS.TYPE_AVATAR 
            ? CONSTANTS.ASPECT_RATIO_AVATAR 
            : CONSTANTS.ASPECT_RATIO_BACKGROUND;

        let selectionWidth, selectionHeight;
        
        if (_state.options.type === CONSTANTS.TYPE_AVATAR) {
            const size = Math.min(imageEl.naturalWidth, imageEl.naturalHeight, containerRect.width * 0.6 * scaleX);
            selectionWidth = size;
            selectionHeight = size;
        } else {
            selectionWidth = Math.min(imageEl.naturalWidth, containerRect.width * 0.8 * scaleX);
            selectionHeight = selectionWidth / targetAspectRatio;
            
            if (selectionHeight > imageEl.naturalHeight) {
                selectionHeight = imageEl.naturalHeight;
                selectionWidth = selectionHeight * targetAspectRatio;
            }
        }

        const imgOffsetX = (containerRect.width - imgRect.width) / 2;
        const imgOffsetY = (containerRect.height - imgRect.height) / 2;
        const left = (imageEl.naturalWidth - selectionWidth) / 2;
        const top = (imageEl.naturalHeight - selectionHeight) / 2;

        _state.imgDimensions = {
            width: imageEl.naturalWidth,
            height: imageEl.naturalHeight,
            offsetX: imgOffsetX,
            offsetY: imgOffsetY
        };
        
        _state.scale = { x: scaleX, y: scaleY };
        _state.currentSelection = {
            x: left,
            y: top,
            width: selectionWidth,
            height: selectionHeight
        };

        _updateSelectionDom();
    };
    
    // Race condition fix: Check if image is already complete
    if (imageEl.complete && imageEl.naturalWidth > 0) {
        handleImageLoad();
    } else {
        imageEl.onload = handleImageLoad;
    }
}

function _updateSelectionDom() {
    const { selectionEl } = _state.elements;
    const { currentSelection, scale, imgDimensions } = _state;
    if (!selectionEl) return;

    selectionEl.style.width = `${currentSelection.width / scale.x}px`;
    selectionEl.style.height = `${currentSelection.height / scale.y}px`;
    selectionEl.style.left = `${imgDimensions.offsetX + (currentSelection.x / scale.x)}px`;
    selectionEl.style.top = `${imgDimensions.offsetY + (currentSelection.y / scale.y)}px`;
}

function _calculateDragLogic(deltaX, deltaY) {
    const { selectionStartX, imgDimensions, scale, currentSelection } = _state;
    const containerRect = _state.elements.imageContainerEl.getBoundingClientRect();

    let newX = ((selectionStartX - containerRect.left - imgDimensions.offsetX) + deltaX) * scale.x;
    let newY = ((_state.selectionStartY - containerRect.top - imgDimensions.offsetY) + deltaY) * scale.y;

    const maxX = imgDimensions.width - currentSelection.width;
    const maxY = imgDimensions.height - currentSelection.height;

    _state.currentSelection.x = Math.max(0, Math.min(newX, maxX));
    _state.currentSelection.y = Math.max(0, Math.min(newY, maxY));
}

function _calculateResizeLogic(deltaX) {
    const { scale, resizeDirection, selectionStartX_img, selectionStartY_img, selectionStartWidth, selectionStartHeight, imgDimensions } = _state;
    const aspectRatio = _state.options.type === CONSTANTS.TYPE_AVATAR ? 
        CONSTANTS.ASPECT_RATIO_AVATAR : 
        CONSTANTS.ASPECT_RATIO_BACKGROUND;
    
    const adjustedDeltaX = deltaX * scale.x;

    let newX = selectionStartX_img;
    let newY = selectionStartY_img;
    let newWidth = selectionStartWidth;
    let newHeight = selectionStartHeight;

    switch (resizeDirection) {
        case 'se':
            newWidth = selectionStartWidth + adjustedDeltaX;
            break;
        case 'sw':
            newWidth = selectionStartWidth - adjustedDeltaX;
            newX = selectionStartX_img + adjustedDeltaX;
            break;
        case 'ne':
            newWidth = selectionStartWidth + adjustedDeltaX;
            break;
        case 'nw':
            newWidth = selectionStartWidth - adjustedDeltaX;
            newX = selectionStartX_img + adjustedDeltaX;
            break;
    }

    newWidth = Math.max(CONSTANTS.MIN_SIZE, newWidth);
    newHeight = newWidth / aspectRatio;

    if (resizeDirection === 'nw' || resizeDirection === 'sw') {
        newX = selectionStartX_img + (selectionStartWidth - newWidth);
    }
    
    if (resizeDirection === 'nw' || resizeDirection === 'ne') {
        newY = selectionStartY_img + (selectionStartHeight - newHeight);
    }

    if (newX < 0) {
        newWidth += newX;
        newX = 0;
    }
    if (newY < 0) {
        newHeight += newY;
        newY = 0;
    }
    if (newX + newWidth > imgDimensions.width) {
        newWidth = imgDimensions.width - newX;
    }
    if (newY + newHeight > imgDimensions.height) {
        newHeight = imgDimensions.height - newY;
    }

    if (resizeDirection.includes('w')) {
        newHeight = newWidth / aspectRatio;
    } else {
        newWidth = newHeight * aspectRatio;
    }

    _state.currentSelection = { x: newX, y: newY, width: newWidth, height: newHeight };
}

function _getCropData() {
    const { currentSelection, imgDimensions } = _state;
    return {
        x: Math.max(0, currentSelection.x),
        y: Math.max(0, currentSelection.y),
        width: Math.min(currentSelection.width, imgDimensions.width),
        height: Math.min(currentSelection.height, imgDimensions.height)
    };
}

function _destroy() {
    document.removeEventListener('mousemove', _state.boundEvents.handleMove);
    document.removeEventListener('touchmove', _state.boundEvents.handleMove);
    document.removeEventListener('mouseup', _state.boundEvents.handleEnd);
    document.removeEventListener('touchend', _state.boundEvents.handleEnd);
    
    if (_state.elements.imageEl) _state.elements.imageEl.onload = null;
    document.body.style.overflow = '';
    
    if (_state.elements.modalEl && _state.elements.modalEl.parentNode) {
        _state.elements.modalEl.remove();
    }
    
    _state.elements = {};
    _state.boundEvents = {};
}

function _handleSelectionStart(e) {
    e.preventDefault();
    _state.isDragging = true;
    _state.resizeDirection = null;

    const clientX = e.clientX || e.touches[0].clientX;
    const clientY = e.clientY || e.touches[0].clientY;

    _state.dragStartX = clientX;
    _state.dragStartY = clientY;

    const rect = _state.elements.selectionEl.getBoundingClientRect();
    _state.selectionStartX = rect.left;
    _state.selectionStartY = rect.top;
}

function _handleResizeStart(e, direction) {
    e.preventDefault();
    e.stopPropagation();
    _state.isDragging = true;
    _state.resizeDirection = direction;

    const clientX = e.clientX || e.touches[0].clientX;
    const clientY = e.clientY || e.touches[0].clientY;

    _state.dragStartX = clientX;
    _state.dragStartY = clientY;

    _state.selectionStartX_img = _state.currentSelection.x;
    _state.selectionStartY_img = _state.currentSelection.y;
    _state.selectionStartWidth = _state.currentSelection.width;
    _state.selectionStartHeight = _state.currentSelection.height;
}

function _handleMove(e) {
    if (!_state.isDragging) return;
    e.preventDefault();

    const clientX = e.clientX || (e.changedTouches && e.changedTouches[0].clientX);
    const clientY = e.clientY || (e.changedTouches && e.changedTouches[0].clientY);

    const deltaX = clientX - _state.dragStartX;
    const deltaY = clientY - _state.dragStartY;

    if (_state.resizeDirection) {
        _calculateResizeLogic(deltaX);
    } else {
        _calculateDragLogic(deltaX, deltaY);
    }
    
    requestAnimationFrame(_updateSelectionDom);
}

function _handleEnd() {
    _state.isDragging = false;
    _state.resizeDirection = null;
}

function _bindEvents() {
    const { selectionEl, cancelBtnEl, confirmBtnEl } = _state.elements;
    if (!selectionEl) return;

    selectionEl.addEventListener('mousedown', _handleSelectionStart);
    selectionEl.addEventListener('touchstart', _handleSelectionStart, { passive: false });

    selectionEl.querySelectorAll('.ql-cropper__handle').forEach(handle => {
        const direction = handle.dataset.direction;
        handle.addEventListener('mousedown', (e) => _handleResizeStart(e, direction));
        handle.addEventListener('touchstart', (e) => _handleResizeStart(e, direction), { passive: false });
    });

    _state.boundEvents.handleMove = _handleMove;
    _state.boundEvents.handleEnd = _handleEnd;

    document.addEventListener('mousemove', _state.boundEvents.handleMove);
    document.addEventListener('touchmove', _state.boundEvents.handleMove, { passive: false });
    document.addEventListener('mouseup', _state.boundEvents.handleEnd);
    document.addEventListener('touchend', _state.boundEvents.handleEnd);

    if (cancelBtnEl) {
        cancelBtnEl.addEventListener('click', () => {
            _destroy();
            _state.options.onCancel();
        });
    }

    if (confirmBtnEl) {
        confirmBtnEl.addEventListener('click', () => {
            const cropData = _getCropData();
            _destroy();
            _state.options.onConfirm(cropData);
        });
    }
}

// Public API
export default {
    create(options) {
        _resetState(options);
        _createInterface();
        _calculateInitialSelection();
        _bindEvents();
        return this;
    }
};