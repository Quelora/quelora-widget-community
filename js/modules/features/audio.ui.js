/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/features/audio.ui.js */
/**
 * @module Modules/Features/AudioUI
 * @description Factory for creating standard audio players.
 * V3.5.0: Added dynamic playback speed toggle (1x, 1.5x, 2x).
 * @version 3.5.0
 */
import handleLog from '../../core/logs.js'; 
import CommentsModule from '../comments/comments.js';
import IconsModule from '../../ui/icons.js';

/**
 * Helper to create DOM elements without circular dependencies.
 * @param {Object} config - Element configuration.
 * @returns {HTMLElement} The constructed DOM element.
 */
function createEl({ tag, classes = [], attributes = {}, styles = {}, content = '', listeners = {}, children = [], innerHTML }) {
    const element = document.createElement(tag);
    if (classes) {
        const classList = Array.isArray(classes) ? classes : classes.split(/\s+/).filter(Boolean);
        classList.forEach(cls => element.classList.add(cls));
    }
    Object.entries(attributes).forEach(([key, value]) => {
        if (value != null) element.setAttribute(key, value);
    });
    Object.assign(element.style, styles);
    if (innerHTML) {
        element.innerHTML = innerHTML;
    } else if (content) {
        element.textContent = content;
    }
    children.forEach(child => {
        if (child instanceof Node) element.appendChild(child);
    });
    Object.entries(listeners).forEach(([event, handler]) => {
        if (typeof handler === 'function') element.addEventListener(event, handler);
    });
    return element;
}

/**
 * Handles the UI state when an audio payload is successfully fetched from the network.
 * @param {string} commentId - The target element identifier.
 * @param {string} audioBase64 - The fetched audio data in Base64 or Blob URL format.
 */
export function handleAudioResponseUI(commentId, audioBase64) {
    const audioContainer = document.querySelector(`.ql-audio-container[data-comment-id="${commentId}"]`);
    if (!audioContainer) return;

    audioContainer.querySelectorAll('.ql-audio-container').forEach(nested => nested.remove());
    
    const audioEl = audioContainer.querySelector('audio');
    const marquee = audioContainer.querySelector('.ql-audio-transcript');
    if (!audioEl) return;

    if (audioBase64.startsWith('blob:') || audioBase64.startsWith('data:')) {
        audioEl.src = audioBase64;
    } else {
        audioEl.src = `data:audio/webm;codecs=opus;base64,${audioBase64}`;
    }
    
    audioEl.dataset.loaded = true;
    
    const playBtn = audioContainer.querySelector('.ql-audio-play');
    if (playBtn) {
        playBtn.innerHTML = IconsModule.getIconSvg('pause');
        audioContainer.classList.remove('loading');
        
        if (marquee) {
            marquee.style.display = 'inline-block';
            marquee.style.animation = `marquee ${Math.max(marquee.scrollWidth / 50, 10)}s linear infinite`;
        }
        
        audioEl.play().catch((e) => {
            console.warn('[AudioUI] Autoplay blocked or codec error:', e);
            playBtn.innerHTML = IconsModule.getIconSvg('play_arrow');
        });
    }
}

/**
 * Creates the standard audio player DOM structure.
 * @param {string} transcript - Text transcript of the audio.
 * @param {string} audioSource - Base64 string or Blob URL.
 * @param {string|null} audioHash - Verification hash.
 * @param {string|null} commentId - ID for association/lazy loading.
 * @returns {HTMLElement|null} The audio player container or null if already exists.
 */
export function audioUI(transcript, audioSource, audioHash, commentId) {
    try {
        if (commentId && document.querySelector(`.ql-audio-container[data-comment-id="${commentId}"]`)) return null;

        const audioContainer = createEl({
            tag: 'div',
            classes: 'ql-audio-container',
            styles: { marginTop: 'var(--spacing-md)', position: 'relative', overflow: 'hidden' },
            attributes: { 
                ...(commentId && { 'data-comment-id': commentId }),
                ...(audioHash && { 'data-audio-hash': audioHash })
            }
        });

        const audioEl = document.createElement('audio');
        audioEl.className = 'ql-audio-element';
        audioEl.preload = 'metadata'; 
        
        if (audioSource) {
            if (audioSource.startsWith('blob:') || audioSource.startsWith('data:')) {
                audioEl.src = audioSource;
            } else {
                audioEl.src = `data:audio/webm;codecs=opus;base64,${audioSource}`;
            }
            audioEl.dataset.loaded = 'true';
        }

        const playBtn = createEl({ tag: 'span', classes: 'ql-audio-play', innerHTML: IconsModule.getIconSvg('play_arrow') });
        const progressBar = createEl({ tag: 'div', classes: 'ql-audio-progress-bar' });
        const progressWrapper = createEl({ tag: 'div', classes: 'ql-audio-progress-wrapper', children: [progressBar] });
        const timeDisplay = createEl({ tag: 'span', classes: 'ql-audio-time', content: '0:00' });
        
        let currentSpeed = 1;
        const speedBtn = createEl({ 
            tag: 'span', 
            classes: 'ql-audio-speed', 
            content: '1x',
            styles: {
                fontSize: '11px',
                fontWeight: 'bold',
                padding: '2px 6px',
                borderRadius: '4px',
                backgroundColor: 'rgba(0, 0, 0, 0.08)',
                cursor: 'pointer',
                userSelect: 'none',
                marginLeft: '6px',
                minWidth: '28px',
                textAlign: 'center',
                display: 'inline-block',
                color: 'var(--ql-primary-text-color, inherit)'
            }
        });

        speedBtn.onclick = (e) => {
            e.stopPropagation();
            if (currentSpeed === 1) currentSpeed = 1.5;
            else if (currentSpeed === 1.5) currentSpeed = 2;
            else currentSpeed = 1;

            audioEl.playbackRate = currentSpeed;
            speedBtn.textContent = currentSpeed + 'x';
        };
        
        const marquee = createEl({ tag: 'div', classes: 'ql-audio-transcript', content: transcript || '' });
        const marqueeWrapper = createEl({ tag: 'div', classes: 'ql-audio-marquee-wrapper', children: [marquee] });
        const mainRow = createEl({ tag: 'div', classes: 'ql-audio-main-row', children: [playBtn, progressWrapper, timeDisplay, speedBtn] });

        audioContainer.append(audioEl, mainRow, marqueeWrapper);

        const showError = (msg) => {
            const existingErr = audioContainer.querySelector('.audio-error');
            if (existingErr) existingErr.remove();

            audioContainer.appendChild(createEl({ tag: 'span', classes: ['audio-error', 't', 'comment-error-message'], content: msg }));
            audioContainer.classList.remove('loading');
            playBtn.innerHTML = IconsModule.getIconSvg('play_arrow');
        };

        const handlePlay = async () => {
            if (audioEl.ended) {
                audioEl.currentTime = 0;
            }

            if (audioEl.paused) {
                if (!audioEl.src && commentId) {
                    audioContainer.classList.add('loading');
                    playBtn.innerHTML = IconsModule.getIconSvg('hourglass_empty');
                    CommentsModule.fetchAudio(commentId);
                } else if (audioEl.src) {
                    try {
                        await audioEl.play();
                        playBtn.innerHTML = IconsModule.getIconSvg('pause');
                        marquee.style.display = 'inline-block';
                        marquee.style.animation = `marquee ${Math.max(marquee.scrollWidth / 50, 10)}s linear infinite`;
                    } catch (e) {
                        showError('{{playback_error}}');
                        handleLog(e, 'AudioUI.play');
                    }
                }
            } else {
                audioEl.pause();
                playBtn.innerHTML = IconsModule.getIconSvg('play_arrow');
                marquee.style.animationPlayState = 'paused';
            }
        };

        playBtn.onclick = handlePlay;

        audioEl.onloadedmetadata = () => {
            const duration = audioEl.duration;
            if (isFinite(duration) && duration > 0) {
                const m = Math.floor(duration / 60);
                const s = Math.floor(duration % 60);
                timeDisplay.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
            }
        };

        audioEl.ontimeupdate = () => {
            const current = audioEl.currentTime || 0;
            const duration = audioEl.duration || 1;
            
            timeDisplay.textContent = `${Math.floor(current / 60)}:${Math.floor(current % 60).toString().padStart(2, '0')}`;
            
            if (isFinite(duration) && duration > 0) {
                progressBar.style.width = `${(current / duration) * 100}%`;
            }
        };

        progressWrapper.onclick = (e) => {
            if (audioEl.src && audioEl.duration && isFinite(audioEl.duration)) {
                audioEl.currentTime = (e.offsetX / progressWrapper.offsetWidth) * audioEl.duration;
            }
        };

        audioEl.onended = () => {
            playBtn.innerHTML = IconsModule.getIconSvg('play_arrow');
            progressBar.style.width = '0%';
            
            if (audioEl.duration) {
                const duration = audioEl.duration;
                const m = Math.floor(duration / 60);
                const s = Math.floor(duration % 60);
                timeDisplay.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
            } else {
                timeDisplay.textContent = '0:00';
            }
            
            marquee.style.display = 'inline-block'; 
            marquee.style.animation = 'none';
        };

        audioEl.onerror = () => {
            console.error('Audio Error:', audioEl.error);
            showError('{{playback_error}}');
        };

        return audioContainer;
    } catch (error) {
        handleLog(error, 'AudioUI.create');
        return null;
    }
}