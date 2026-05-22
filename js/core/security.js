/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/core/security.js */
/**
 * @module Core/Security
 * @description Centralized Security & Cryptography Module.
 * FIX: Removed 'window' dependency to ensure compatibility with Web Workers.
 * @version 1.2.0
 */

import handleLog from './logs.js';

const CONSTANTS = {
    ALGORITHM: 'AES-GCM',
    KDF: 'PBKDF2',
    HASH: 'SHA-256',
    ITERATIONS: 100000,
    KEY_LENGTH: 256,
    SALT_LENGTH: 16,
    IV_LENGTH: 12
};

// Polyfill-like helper for Base64 in Worker/Window environments
const _Env = {
    btoa: (str) => {
        if (typeof self !== 'undefined' && self.btoa) return self.btoa(str);
        if (typeof window !== 'undefined' && window.btoa) return window.btoa(str);
        throw new Error('Environment does not support btoa');
    },
    atob: (str) => {
        if (typeof self !== 'undefined' && self.atob) return self.atob(str);
        if (typeof window !== 'undefined' && window.atob) return window.atob(str);
        throw new Error('Environment does not support atob');
    }
};

const _Private = {
    /**
     * Derives a CryptoKey from a raw string (token) and a salt.
     */
    deriveKey: async (secret, salt, usages) => {
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw', 
            encoder.encode(secret), 
            { name: CONSTANTS.KDF }, 
            false, 
            ['deriveBits', 'deriveKey']
        );
        
        return await crypto.subtle.deriveKey(
            { 
                name: CONSTANTS.KDF, 
                salt: salt, 
                iterations: CONSTANTS.ITERATIONS, 
                hash: CONSTANTS.HASH 
            },
            keyMaterial, 
            { name: CONSTANTS.ALGORITHM, length: CONSTANTS.KEY_LENGTH }, 
            false, 
            usages
        );
    },

    bufferToBase64: (buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return _Env.btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    },

    base64ToUint8Array: (base64) => {
        const padded = base64.replace(/-/g, '+').replace(/_/g, '/');
        const padLength = (4 - (padded.length % 4)) % 4;
        const finalBase64 = padded + '='.repeat(padLength);
        
        const binaryString = _Env.atob(finalBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }
};

const SecurityModule = {
    /**
     * Encrypts a string payload using the provided secret (token).
     */
    encrypt: async (data, secret) => {
        try {
            if (!secret) return null;

            const encoder = new TextEncoder();
            const iv = crypto.getRandomValues(new Uint8Array(CONSTANTS.IV_LENGTH));
            const salt = crypto.getRandomValues(new Uint8Array(CONSTANTS.SALT_LENGTH));
            
            const key = await _Private.deriveKey(secret, salt, ['encrypt']);
            const encryptedBuffer = await crypto.subtle.encrypt(
                { name: CONSTANTS.ALGORITHM, iv: iv }, 
                key, 
                encoder.encode(data)
            );

            const packed = new Uint8Array(salt.length + iv.length + encryptedBuffer.byteLength);
            packed.set(salt, 0);
            packed.set(iv, salt.length);
            packed.set(new Uint8Array(encryptedBuffer), salt.length + iv.length);

            return _Private.bufferToBase64(packed.buffer);

        } catch (error) {
            handleLog(error, 'SecurityModule.encrypt', 'error', '🔐');
            return null;
        }
    },

    /**
     * Decrypts a payload using the provided secret (token).
     */
    decrypt: async (packedData, secret) => {
        try {
            if (!secret || !packedData) return null;

            const packed = _Private.base64ToUint8Array(packedData);
            
            const salt = packed.slice(0, CONSTANTS.SALT_LENGTH);
            const iv = packed.slice(CONSTANTS.SALT_LENGTH, CONSTANTS.SALT_LENGTH + CONSTANTS.IV_LENGTH);
            const ciphertext = packed.slice(CONSTANTS.SALT_LENGTH + CONSTANTS.IV_LENGTH);

            const key = await _Private.deriveKey(secret, salt, ['decrypt']);
            
            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: CONSTANTS.ALGORITHM, iv: iv }, 
                key, 
                ciphertext
            );

            return new TextDecoder().decode(decryptedBuffer);

        } catch (error) {
            return null;
        }
    },

    generateUUID: () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
};

export default SecurityModule;