/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/worker/utilsWorker.js */
/**
 * @module Worker/Utils
 * @description Utility helper functions for the Service Worker.
 * @version 7.3.0
 */

const getHeader = (headers, key) => {
    if (!headers) return null;
    if (typeof headers.get === 'function') {
        return headers.get(key);
    }
    const lowerKey = key.toLowerCase();
    for (const k in headers) {
        if (k.toLowerCase() === lowerKey) return headers[k];
    }
    return null;
};

export const Utils = {
    
    /**
     * Generates standard Authorization headers.
     */
    authHeaders(token) {
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    },

    /**
     * Safely extracts GeoIP headers from a response object.
     */
    extractGeoHeadersFromResponse(headers) {
        if (!headers) return null;
        const ip = getHeader(headers, 'X-IP') || getHeader(headers, 'x-ip');
        if (!ip) return null;

        return {
            ip: ip,
            country: getHeader(headers, 'X-Country'),
            countryCode: getHeader(headers, 'X-Country-Code'),
            region: getHeader(headers, 'X-Region'),
            city: getHeader(headers, 'X-City'),
            lat: getHeader(headers, 'X-Lat'),
            lon: getHeader(headers, 'X-Lon')
        };
    },

    extractServerHeaders(headers) {
        const country = getHeader(headers, 'X-Server-Country');
        const region = getHeader(headers, 'X-Server-Region');
        if (country) {
            return { country, region };
        }
        return null;
    },

    /**
     * Extracts Geo headers from internal state to inject into outgoing requests.
     */
    extractGeoHeaders(sharedIp, sharedLocation) {
        if (!sharedIp) return {};
        const headers = { 'X-IP': sharedIp };
        if (sharedLocation) {
            if (sharedLocation.country) headers['X-Country'] = sharedLocation.country;
            if (sharedLocation.countryCode) headers['X-Country-Code'] = sharedLocation.countryCode;
            if (sharedLocation.region) headers['X-Region'] = sharedLocation.region;
            if (sharedLocation.city) headers['X-City'] = sharedLocation.city;
            if (sharedLocation.lat) headers['X-Lat'] = sharedLocation.lat;
            if (sharedLocation.lon) headers['X-Lon'] = sharedLocation.lon;
        }
        return headers;
    },

    hashPayload(payload) {
        if (!payload) return 'void';
        try {
            return JSON.stringify(payload).split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a;
            }, 0);
        } catch (e) {
            return 'error';
        }
    },

    async parseFetchError(response) {
        const errorInfo = {
            status: response.status,
            statusText: response.statusText,
            url: response.url
        };
        try {
            const text = await response.text();
            if (text) {
                try {
                    const json = JSON.parse(text);
                    errorInfo.message = json.message || json.error || response.statusText;
                    errorInfo.details = json;
                } catch {
                    errorInfo.message = text;
                }
            } else {
                errorInfo.message = response.statusText;
            }
        } catch (e) {
            errorInfo.message = 'Network error or unable to read response';
        }
        return errorInfo;
    },

    /**
     * Deserializes optimized/compressed data using a dictionary RECURSIVELY.
     * Transforms keys like "1", "2" into "entityId", "views", etc.
     * Handles deep nesting (e.g. comments -> list -> items -> profile).
     */
    deserializeData(data, dictionary) {
        // Base validation
        if (typeof data !== 'object' || data === null) {
            return data;
        }
        
        if (!dictionary) return data;

        if (Array.isArray(data)) {
            return data.map(item => this.deserializeData(item, dictionary));
        } 

        else {
            const decompressed = {};
            for (const key in data) {
                if (Object.prototype.hasOwnProperty.call(data, key)) {
                    const translatedKey = dictionary[String(key)] || key;

                    decompressed[translatedKey] = this.deserializeData(data[key], dictionary);
                }
            }
            return decompressed;
        }
    }
};