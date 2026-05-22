/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/features/audio.js */
/**
 * @module Modules/Features/Audio
 * @description Core Audio Recorder & UI Effects.
 * V3.3.0: Refactored to use Web Audio API synthesis, unified CONFIG, and standardized logs.
 * @version 3.3.0
 */
import handleLog from '../../core/logs.js'; 
import ConfModule from '../../core/conf.js';
import UiModule from '../../ui/ui.js';
import I18n from '../../core/i18n.js';
import UtilsModule from '../../core/utils.js';

const CONFIG = {
    LOG_ICON: '🎤',
    FULL_DASH_ARRAY: 283,
    TIMEOUT_MS: 30000,
    AUDIO: {
        MIME_TYPE: 'audio/webm;codecs=opus',
        DEFAULT_BITRATE: 16000,
        DEFAULT_MAX_SECONDS: 10,
        BEEP_FREQUENCY: 440,
        BEEP_DURATION: 0.2,
        BEEP_INTERVAL: 500
    },
    SELECTORS: {
        THREAD: '.ql-thread',
        INTERACTION_ITEM: '.ql-interaction__item',
        VOICE_BUTTON: '.ql-voice-button',
        CHAT_MESSAGES: '.ql-chat-view__messages', 
        CHAT_HEADER: '.ql-chat-view__header-custom' 
    }
};

let recognizer;
let isRecording = false;
let mediaRecorder;
let audioChunks = [];
let stopTimeout;
let isManualStop = false;
const callbackMap = new Map();
let maxRecordingSeconds = ConfModule.get('audio.max_recording_seconds', CONFIG.AUDIO.DEFAULT_MAX_SECONDS);
let timerInterval = null;
let timerElement = null;
let audioCtx = null;

const calculateSHA1 = async (text) => {
    const data = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const cleanupUI = () => {
    // Clean Community Thread Blur
    document.querySelectorAll(CONFIG.SELECTORS.THREAD).forEach(el => {
        el.style.pointerEvents = '';
        el.style.filter = '';
        el.style.transition = '';
        el.classList.remove('blurred-thread');
    });

    // Clean Chat UI Blur
    const chatMessages = document.querySelectorAll(CONFIG.SELECTORS.CHAT_MESSAGES);
    const chatHeaders = document.querySelectorAll(CONFIG.SELECTORS.CHAT_HEADER);
    
    [...chatMessages, ...chatHeaders].forEach(el => {
        el.style.pointerEvents = '';
        el.style.filter = '';
        el.style.transition = '';
    });

    // Clean Interaction Items
    document.querySelectorAll(CONFIG.SELECTORS.INTERACTION_ITEM).forEach(el => {
        el.style.pointerEvents = '';
        el.style.opacity = '';
    });

    document.querySelectorAll(CONFIG.SELECTORS.VOICE_BUTTON).forEach(button => button.classList.remove('recording'));
    removeTimer();
};

const removeTimer = () => {
    if (timerElement) {
        timerElement.remove();
        timerElement = null;
    }
    const infoElement = document.querySelector('#ql-root > .ql-timer-language-info');
    if (infoElement) {
        infoElement.remove();
    }
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
};

const createTimer = () => {
    removeTimer();
    const langCode = I18n.getSpeechVariant().substring(0, 2);
    const langNameKey = I18n.getLanguageNames()[langCode]?.replace(/{{|}}/g, '') || 'english';
    const langName = I18n.getTranslation(langNameKey);
    
    timerElement = UiModule.createElementUI({
        tag: 'div',
        classes: 'quelora_base-timer',
        innerHTML: `
            <svg class="quelora_base-timer__svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <g class="quelora_base-timer__circle">
                    <circle class="quelora_base-timer__path-elapsed" cx="50" cy="50" r="45"></circle>
                    <path class="quelora_base-timer__path-remaining green"
                        d="M 50, 50 m -45, 0 a 45,45 0 1,0 90,0 a 45,45 0 1,0 -90,0">
                    </path>
                </g>
            </svg>
            <span class="quelora_base-timer__label">${formatTime(maxRecordingSeconds)}</span>
        `
    });

    const languageInfoElement = UiModule.createElementUI({
        tag: 'div',
        attributes: { id: 'ql-timer-language-info' },
        classes: 'ql-timer-language-info',
        innerHTML: `
            <div class="t">{{speakingLanguage}}: ${langName}</div>
            <div class="t">{{changeLanguageWarning}}</div>
        `
    });

    const root = document.getElementById('ql-root');
    root.appendChild(timerElement);
    root.appendChild(languageInfoElement);

    let timeLeft = maxRecordingSeconds;
    const warningThreshold = maxRecordingSeconds * 0.3;
    const alertThreshold = maxRecordingSeconds * 0.1;

    timerInterval = setInterval(() => {
        timeLeft -= 1;
        timerElement.querySelector('.quelora_base-timer__label').textContent = formatTime(timeLeft);

        const pathRemaining = timerElement.querySelector('.quelora_base-timer__path-remaining');
        if (timeLeft <= alertThreshold) {
            pathRemaining.classList.remove('green', 'orange');
            pathRemaining.classList.add('red');
        } else if (timeLeft <= warningThreshold) {
            pathRemaining.classList.remove('green');
            pathRemaining.classList.add('orange');
        }

        const rawTimeFraction = timeLeft / maxRecordingSeconds;
        const adjustedFraction = 1 - (rawTimeFraction - (1 / maxRecordingSeconds) * (1 - rawTimeFraction));
        const circleDasharray = `${(adjustedFraction * CONFIG.FULL_DASH_ARRAY).toFixed(0)} ${CONFIG.FULL_DASH_ARRAY}`;
        pathRemaining.setAttribute('stroke-dasharray', circleDasharray);

        if (timeLeft <= 0) clearInterval(timerInterval);
    }, 1000);
};

const formatTime = (time) => {
    const minutes = Math.floor(time / 60);
    const seconds = time % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
};

const requestMicrophonePermission = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return stream;
    } catch (error) {
        handleLog(error.message || error, 'AudioRecorderModule', 'error', CONFIG.LOG_ICON);
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
            UiModule.renderErrorMessageUI(I18n.getTranslation('microphonePermissionDenied'));
        } else {
            UiModule.renderErrorMessageUI(I18n.getTranslation('microphoneUnavailable'));
        }
        return null;
    }
};

const playAudioSignal = async (times = 1) => {
    try {
        times = Math.max(1, Math.min(4, times));
        
        if (!audioCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContext();
        }
        
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }

        let count = 0;
        const playOnce = () => {
            try {
                const oscillator = audioCtx.createOscillator();
                const gainNode = audioCtx.createGain();

                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(CONFIG.AUDIO.BEEP_FREQUENCY, audioCtx.currentTime); 

                gainNode.gain.setValueAtTime(1, audioCtx.currentTime);
                gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + CONFIG.AUDIO.BEEP_DURATION);

                oscillator.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                oscillator.start();
                oscillator.stop(audioCtx.currentTime + CONFIG.AUDIO.BEEP_DURATION);
                
                count++;
                if (count < times) UtilsModule.startTimeout(playOnce, CONFIG.AUDIO.BEEP_INTERVAL);
            } catch (e) {
                handleLog(e.message || e, 'AudioRecorderModule.playAudioSignal', 'warn', CONFIG.LOG_ICON);
            }
        };
        
        playOnce();
    } catch (e) {
        handleLog(e.message || e, 'AudioRecorderModule.playAudioSignal', 'error', CONFIG.LOG_ICON);
    }
};

const audioSignaling = async (referenceElement) => {
    if (isRecording) return;
    try {
        const stream = await requestMicrophonePermission();
        if (!stream) return;

        // Apply Blur to Community Thread
        document.querySelectorAll(CONFIG.SELECTORS.THREAD).forEach(el => {
            el.style.pointerEvents = 'none';
            el.style.filter = 'blur(4px)';
            el.style.transition = 'filter 0.3s ease';
            el.classList.add('blurred-thread');
        });

        // Apply Blur to Chat UI 
        const chatMessages = document.querySelectorAll(CONFIG.SELECTORS.CHAT_MESSAGES);
        const chatHeaders = document.querySelectorAll(CONFIG.SELECTORS.CHAT_HEADER);
        
        [...chatMessages, ...chatHeaders].forEach(el => {
            el.style.pointerEvents = 'none';
            el.style.filter = 'blur(4px)';
            el.style.transition = 'filter 0.3s ease';
        });
        
        // Dim Interaction Items
        document.querySelectorAll(CONFIG.SELECTORS.INTERACTION_ITEM).forEach(el => {
             el.style.pointerEvents = 'none';
             el.style.opacity = '0.5';
        });

        recognizer = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
        recognizer.continuous = true;
        recognizer.interimResults = true;
        recognizer.lang = I18n.getSpeechVariant();
        recognizer.maxAlternatives = 1;

        let partialTranscript = '';

        recognizer.onresult = async (event) => {
            partialTranscript = Array.from(event.results).map(r => r[0].transcript).join('');
            if (event.results[0].isFinal) {
                const audioBase64 = await finalizeAudio();
                if (!partialTranscript || partialTranscript.trim() === '') {
                    cleanupUI();
                    await stopRecording();
                    return;
                }
                const callback = callbackMap.get(referenceElement);
                if (typeof callback === 'function') {
                    const hash = await calculateSHA1((audioBase64 || '') + (partialTranscript || ''));
                    callback(partialTranscript, audioBase64, hash);
                }
                audioChunks = [];
                await stopRecording();
            }
        };

        recognizer.onerror = async (event) => {
            await handleErrorStop('', referenceElement);
        };

        recognizer.onend = async () => {
            await handleErrorStop('', referenceElement);
        };

        recognizer.start();

        audioChunks = [];
        mediaRecorder = new MediaRecorder(stream, {
            mimeType: CONFIG.AUDIO.MIME_TYPE,
            audioBitsPerSecond: ConfModule.get('audio.bitrate', CONFIG.AUDIO.DEFAULT_BITRATE)
        });
        mediaRecorder.ondataavailable = e => e.data.size > 0 && audioChunks.push(e.data);
        mediaRecorder.start(100);

        createTimer();
        stopTimeout = UtilsModule.startTimeout(async () => {
            await handleErrorStop('', referenceElement);
            await stopRecording();
        }, CONFIG.TIMEOUT_MS);

        isRecording = true;
        await playAudioSignal();
        document.querySelectorAll(CONFIG.SELECTORS.VOICE_BUTTON).forEach(b => b.classList.add('recording'));

    } catch (error) {
        handleLog(error.message || error, 'audioSignaling', 'error', CONFIG.LOG_ICON);
        await handleErrorStop('', referenceElement);
        stopRecording();
    }
};

const handleErrorStop = async (partialTranscript, referenceElement) => {
    await stopRecording();
    if (!partialTranscript || partialTranscript.trim() === '') {
        cleanupUI();
        return;
    }
    const audioBase64 = await finalizeAudio();
    const callback = callbackMap.get(referenceElement);
    if (typeof callback === 'function') {
        const hash = await calculateSHA1((audioBase64 || '') + partialTranscript);
        callback(partialTranscript, audioBase64, hash);
    }
};

const stopRecording = async () => {
    if (!isRecording) return;
    isRecording = false;
    try {
        recognizer?.stop();
    } catch (e) {
        handleLog(e.message || e, 'AudioRecorderModule', 'warn', CONFIG.LOG_ICON);
    }
    try {
        if (mediaRecorder?.state !== "inactive") {
            await new Promise(resolve => {
                mediaRecorder.onstop = resolve;
                mediaRecorder.stop();
            });
            mediaRecorder.stream.getTracks().forEach(t => t.stop());
        }
    } catch (e) {
        handleLog(e.message || e, 'AudioRecorderModule', 'warn', CONFIG.LOG_ICON);
    }
    if (stopTimeout) {
        clearTimeout(stopTimeout);
        stopTimeout = null;
    }
    cleanupUI();
};

const finalizeAudio = async () => {
    if (!audioChunks.length) return null;
    const blob = new Blob(audioChunks, { type: CONFIG.AUDIO.MIME_TYPE });
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result?.split(',')[1] || null);
        reader.readAsDataURL(blob);
    });
};

const addVoiceButton = ({ iconReferenceElement, onResult }) => {
    try {
        if (!iconReferenceElement || typeof onResult !== 'function') throw new Error("iconReferenceElement and onResult callback are required.");
        if (iconReferenceElement.parentElement.querySelector(CONFIG.SELECTORS.VOICE_BUTTON)) return;

        callbackMap.set(iconReferenceElement, onResult);

        if (!UtilsModule.isMobile) {
            const voiceButton = UiModule.createElementUI({
                tag: 'div',
                classes: ['ql-icons-outlined', 'ql-voice-button'],
                content: 'mic'
            });

            const start = e => {
                e.preventDefault();
                audioSignaling(iconReferenceElement);
            };
            const stop = e => {
                e.preventDefault();
                isManualStop = true;
                stopRecording();
            };

            voiceButton.addEventListener('mousedown', start);
            voiceButton.addEventListener('mouseup', stop);
            voiceButton.addEventListener('mouseleave', e => isRecording && stopRecording());
            voiceButton.addEventListener('touchstart', start, { passive: false });
            voiceButton.addEventListener('touchend', stop);

            iconReferenceElement.insertAdjacentElement('afterend', voiceButton);
        }
    } catch (error) {
        handleLog(error.message || error, 'addVoiceButton', 'error', CONFIG.LOG_ICON);
    }
};

const AudioRecorderModule = {
    addVoiceButton,
    stopRecording,
    playAudioSignal,
    isRecording: () => isRecording,
    setMaxRecordingSeconds: seconds => {
        if (typeof seconds === 'number' && seconds > 0) maxRecordingSeconds = seconds;
    }
};

export default AudioRecorderModule;