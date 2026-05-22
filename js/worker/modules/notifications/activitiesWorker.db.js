/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/worker/modules/notifications/activitiesWorker.db.js */
/**
 * @module Worker/ActivitiesDB
 * @description IndexedDB wrapper for persistent activity storage.
 * SECURITY ARCHITECTURE (v2.5.0):
 * - Encryption/Decryption: Uses 'user.id' (profile._id) as the secret key.
 * - Indexing/Querying: Uses 'user.author' as the public shard key.
 * This ensures that even if the database file is compromised, the content remains
 * encrypted with a key that is never stored on disk.
 * @version 2.5.0
 */
import SecurityModule from '../../../core/security.js';
import handleLog from '../../../core/logs.js';

const CONSTANTS = {
    DB_NAME: 'QueloraActivitiesDB',
    VERSION: 1,
    STORES: {
        ACTIVITIES: 'activities',
        META: 'meta'
    },
    INDEXES: {
        USER_ID: 'userId'
    },
    DEFAULTS: {
        MAX_ITEMS: 500
    },
    LOG_ICON: '👷🛎️'
};

let _dbInstance = null;

const _Private = {
    /**
     * Opens or initializes the IndexedDB instance.
     * @returns {Promise<IDBDatabase>}
     */
    openDB: () => {
        return new Promise((resolve, reject) => {
            if (_dbInstance) return resolve(_dbInstance);
            const request = indexedDB.open(CONSTANTS.DB_NAME, CONSTANTS.VERSION);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(CONSTANTS.STORES.ACTIVITIES)) {
                    const store = db.createObjectStore(CONSTANTS.STORES.ACTIVITIES, { keyPath: '_id' });
                    // Indexing by 'userId' which will store the public 'author' handle.
                    store.createIndex(CONSTANTS.INDEXES.USER_ID, 'userId', { unique: false });
                }
                if (!db.objectStoreNames.contains(CONSTANTS.STORES.META)) {
                    db.createObjectStore(CONSTANTS.STORES.META, { keyPath: 'userId' });
                }
            };
            request.onsuccess = (event) => {
                _dbInstance = event.target.result;
                resolve(_dbInstance);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    },

    /**
     * Removes old records to prevent storage bloat.
     * @param {string} authorId - The public author ID used for indexing.
     */
    pruneStorage: async (authorId) => {
        try {
            const db = await _Private.openDB();
            const tx = db.transaction(CONSTANTS.STORES.ACTIVITIES, 'readwrite');
            const store = tx.objectStore(CONSTANTS.STORES.ACTIVITIES);
            const index = store.index(CONSTANTS.INDEXES.USER_ID);
            const limit = CONSTANTS.DEFAULTS.MAX_ITEMS;

            const countReq = index.count(IDBKeyRange.only(authorId));
            countReq.onsuccess = () => {
                if (countReq.result > limit) {
                    let deleted = 0;
                    const needed = countReq.result - limit;
                    const cursorReq = index.openCursor(IDBKeyRange.only(authorId)); 
                    cursorReq.onsuccess = (e) => {
                        const cursor = e.target.result;
                        if (cursor && deleted < needed) {
                            cursor.delete();
                            deleted++;
                            cursor.continue();
                        }
                    };
                }
            };
        } catch (e) {
            handleLog(e, 'NOTIFICATIONS WORKER', 'error', CONSTANTS.LOG_ICON, { action: 'pruneStorage', authorId });
        }
    },

    /**
     * Encrypts the activity payload using the private user ID.
     * @param {Object} activity 
     * @param {Object} user - Identity object containing {id, author}.
     * @returns {Promise<Object>}
     */
    encryptPayload: async (activity, user) => {
        const timestamp = activity.created_at || activity.createdAt || new Date().toISOString();
        const recordId = activity._id || activity.id || `gen-${timestamp}-${Math.random().toString(36).substr(2, 9)}`;
        const serialized = JSON.stringify(activity);
        
        let secureData = null;
        try {
            if (SecurityModule && typeof SecurityModule.encrypt === 'function') {
                // Encryption key is the private profile._id
                secureData = await SecurityModule.encrypt(serialized, user.id);
            } else {
                handleLog('SecurityModule missing. Storing in plaintext fallback.', 'NOTIFICATIONS WORKER', 'warn', CONSTANTS.LOG_ICON);
                secureData = JSON.stringify({ _plaintext: true, data: activity });
            }
        } catch (e) {
            handleLog(e, 'NOTIFICATIONS WORKER', 'error', CONSTANTS.LOG_ICON, { action: 'encryptPayload' });
            throw e;
        }

        return {
            _id: recordId,
            userId: user.author, // Indexed by public author handle
            timestamp: timestamp,
            type: activity.type || 'unknown',
            secureData: secureData
        };
    },

    /**
     * Decrypts a stored record using the private user ID.
     * @param {Object} record 
     * @param {Object} user - Identity object containing {id, author}.
     * @returns {Promise<Object|null>}
     */
    decryptPayload: async (record, user) => {
        if (!record.secureData) return null;

        try {
            let json = null;
            if (record.secureData.startsWith('{"_plaintext":true')) {
                json = JSON.parse(record.secureData).data;
                return { ...json, _id: record._id, created_at: record.timestamp };
            }

            if (SecurityModule && typeof SecurityModule.decrypt === 'function') {
                // Decryption key is the private profile._id
                json = await SecurityModule.decrypt(record.secureData, user.id);
            }

            if (!json) return null;
            
            const originalActivity = JSON.parse(json);
            return {
                ...originalActivity,
                _id: record._id,
                created_at: originalActivity.created_at || record.timestamp
            };
        } catch (e) { 
            handleLog(e, 'NOTIFICATIONS WORKER', 'error', CONSTANTS.LOG_ICON, { action: 'decryptPayload', recordId: record._id });
            return null; 
        }
    }
};

export const ActivitiesWorkerDB = {
    /**
     * Persists multiple activities to the database.
     * @param {Array<Object>} activities 
     * @param {Object} user 
     */
    addActivities: async (activities, user) => {
        if (!user || !user.id || !user.author || !activities.length) return;
        const db = await _Private.openDB();
        
        const records = await Promise.all(activities.map(a => _Private.encryptPayload(a, user)));
        
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CONSTANTS.STORES.ACTIVITIES, 'readwrite');
            const store = tx.objectStore(CONSTANTS.STORES.ACTIVITIES);
            
            records.forEach(r => {
                try {
                    store.put(r);
                } catch (e) {
                    handleLog(e, 'NOTIFICATIONS WORKER', 'error', CONSTANTS.LOG_ICON, { action: 'addActivities_put', recordId: r._id });
                }
            });
            
            tx.oncomplete = () => {
                _Private.pruneStorage(user.author);
                resolve(true);
            };
            tx.onerror = (e) => reject(e.target.error);
        });
    },

    /**
     * Retrieves all activities belonging to a specific user.
     * @param {Object} user 
     * @returns {Promise<Array<Object>>}
     */
    getActivities: async (user) => {
        if (!user || !user.id || !user.author) return [];
        const db = await _Private.openDB();
        return new Promise(resolve => {
            const tx = db.transaction(CONSTANTS.STORES.ACTIVITIES, 'readonly');
            const store = tx.objectStore(CONSTANTS.STORES.ACTIVITIES);
            const index = store.index(CONSTANTS.INDEXES.USER_ID);
            const req = index.getAll(IDBKeyRange.only(user.author));
            
            req.onsuccess = async () => {
                const records = req.result || [];
                records.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                const decryptedPromises = records.map(r => _Private.decryptPayload(r, user));
                const decryptedResults = await Promise.all(decryptedPromises);
                resolve(decryptedResults.filter(Boolean));
            };
            req.onerror = (e) => {
                resolve([]);
            };
        });
    },

    /**
     * Gets the push subscription hash for a user.
     * @param {Object} user 
     * @returns {Promise<string|null>}
     */
    getPushHash: async (user) => {
        if (!user || !user.author) return null;
        const db = await _Private.openDB();
        return new Promise(resolve => {
            const tx = db.transaction(CONSTANTS.STORES.META, 'readonly');
            const req = tx.objectStore(CONSTANTS.STORES.META).get(user.author);
            req.onsuccess = () => resolve(req.result?.pushHash || null);
            req.onerror = () => resolve(null);
        });
    },

    /**
     * Saves a push subscription hash.
     * @param {Object} user 
     * @param {string} hash 
     */
    savePushHash: async (user, hash) => {
        if (!user || !user.author) return;
        const db = await _Private.openDB();
        const tx = db.transaction(CONSTANTS.STORES.META, 'readwrite');
        const store = tx.objectStore(CONSTANTS.STORES.META);
        const req = store.get(user.author);
        req.onsuccess = () => {
            const data = req.result || { userId: user.author };
            data.pushHash = hash;
            store.put(data);
        };
    },
    
    /**
     * Explicitly clears all activities for a user.
     * @param {Object} user 
     */
    clearUser: async (user) => {
        if (!user || !user.author) return;
        const db = await _Private.openDB();
        const tx = db.transaction([CONSTANTS.STORES.ACTIVITIES, CONSTANTS.STORES.META], 'readwrite');
        const store = tx.objectStore(CONSTANTS.STORES.ACTIVITIES);
        const index = store.index(CONSTANTS.INDEXES.USER_ID);
        const req = index.openCursor(IDBKeyRange.only(user.author));
        req.onsuccess = (e) => {
            const cursor = e.target.result;
            if(cursor) { cursor.delete(); cursor.continue(); }
        };
        tx.objectStore(CONSTANTS.STORES.META).delete(user.author);
    }
};