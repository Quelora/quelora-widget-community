/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: quelora/js/services/geoStorage.js */
/**
 * @module Services/GeoStorage
 * @description Client-side geolocation cache and provider abstraction.
 *
 * Design decisions:
 * - Location data is fetched once per 24 hours and persisted in localStorage.
 *   Subsequent calls within that window are served from memory or storage
 *   without an additional network request.
 * - An in-memory cache (`cachedData`) avoids repeated localStorage reads
 *   within the same page session.
 * - When localStorage contains a corrupted entry, {@link _parseStoredLocation}
 *   removes it and falls through to a fresh network fetch rather than
 *   throwing an unhandled exception.
 * - Server-side location headers (from the API response) can be injected via
 *   {@link saveServerLocation}, bypassing the external GeoIP provider entirely
 *   when the backend already resolved the client's location.
 *
 * @version 2.1.0
 */
import StorageModule from '../core/storage.js';
import handleLog from '../core/logs.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const STORAGE_KEY  = 'ql_user_location';
const HOURS_24_MS  = 24 * 60 * 60 * 1000;

/**
 * Registry of supported GeoIP providers.
 * Each entry defines the request URL, an optional API key query parameter
 * template, and a field mapping from the provider response to the
 * normalised {@link LocationData} shape.
 *
 * @type {Record<string, ProviderConfig>}
 */
const PROVIDERS = {
    ipapi: {
        url: 'https://ipapi.co/json/',
        keyParam: null,
        fields: {
            country:     'country_name',
            region:      'region',
            city:        'city',
            ip:          'ip',
            countryCode: 'country',
            lat:         'latitude',
            lon:         'longitude'
        }
    }
};

// =============================================================================
// PRIVATE STATE
// =============================================================================

/** @type {string} */
let _currentProvider = 'ipapi';

/** @type {string|null} */
let _apiKey = null;

/** @type {LocationData|null} */
let _cachedData = null;

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Assembles the full GeoIP request URL for the active provider,
 * appending the API key query parameter when required.
 *
 * @returns {string} Fully qualified request URL.
 */
function _buildApiUrl() {
    const provider = PROVIDERS[_currentProvider];
    if (!provider.keyParam || !_apiKey) return provider.url;

    const separator = provider.url.includes('?') ? '&' : '?';
    return `${provider.url}${separator}${provider.keyParam.replace('{key}', _apiKey)}`;
}

/**
 * Maps a raw provider response object to the normalised {@link LocationData} shape
 * using the field mapping declared in {@link PROVIDERS}.
 *
 * @param {Record<string, unknown>} data - Raw API response object.
 * @returns {LocationData} Normalised location data.
 */
function _normalizeData(data) {
    const fields = PROVIDERS[_currentProvider].fields;
    return {
        country:     data[fields.country]     ?? null,
        region:      data[fields.region]      ?? null,
        city:        data[fields.city]        ?? null,
        ip:          data[fields.ip]          ?? null,
        countryCode: data[fields.countryCode] ?? null,
        lat:         data[fields.lat]         ?? null,
        lon:         data[fields.lon]         ?? null,
        timestamp:   Date.now(),
        provider:    _currentProvider
    };
}

/**
 * Returns whether the timestamp of a cached entry falls within the 24-hour
 * freshness window.
 *
 * @param {number|null|undefined} timestamp - Unix epoch milliseconds.
 * @returns {boolean}
 */
function _isDataFresh(timestamp) {
    return Boolean(timestamp) && (Date.now() - timestamp < HOURS_24_MS);
}

/**
 * Projects a stored location record into the public {@link LocationData} shape,
 * appending a `fresh` flag that consumers can use to decide whether to
 * trigger a background refresh.
 *
 * @param {LocationData} data - Stored location record.
 * @returns {LocationData}
 */
function _toPublicShape(data) {
    return {
        country:     data.country,
        region:      data.region,
        city:        data.city,
        ip:          data.ip,
        countryCode: data.countryCode,
        lat:         data.lat,
        lon:         data.lon,
        fresh:       _isDataFresh(data.timestamp),
        provider:    data.provider
    };
}

/**
 * Parses a raw JSON string retrieved from localStorage.
 *
 * When the string is malformed, the corrupted entry is removed so that the
 * next read attempt triggers a fresh network fetch instead of repeatedly
 * failing on the same corrupt data.
 *
 * @param {string} stored - Raw JSON string from localStorage.
 * @returns {LocationData|null} Parsed object or `null` on parse failure.
 */
function _parseStoredLocation(stored) {
    try {
        return JSON.parse(stored);
    } catch {
        StorageModule.removeLocalItem(STORAGE_KEY);
        return null;
    }
}

/**
 * Fetches fresh location data from the active GeoIP provider, persists
 * the result in localStorage, and updates the in-memory cache.
 *
 * When the network request fails (e.g. blocked by browser tracking prevention),
 * an empty location record is cached so that callers always receive a
 * consistent object shape rather than `null`.
 *
 * @returns {Promise<LocationData>} Resolved location data or an empty record.
 */
async function _fetchAndStoreLocation() {
    try {
        const res = await fetch(_buildApiUrl());
        if (!res.ok) throw new Error(`${_currentProvider} API failed: ${res.status}`);

        const location = _normalizeData(await res.json());
        StorageModule.setLocalItem(STORAGE_KEY, JSON.stringify(location));
        _cachedData = location;
        return location;
    } catch (error) {
        handleLog(error, 'GeoStorage._fetchAndStoreLocation', 'warn');

        const emptyLocation = {
            country:     null,
            region:      null,
            city:        null,
            ip:          null,
            countryCode: null,
            lat:         null,
            lon:         null,
            timestamp:   Date.now(),
            provider:    'none'
        };

        _cachedData = emptyLocation;
        return emptyLocation;
    }
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Selects the active GeoIP provider and optionally associates an API key.
 *
 * @param {string}      providerName - Provider identifier (must exist in {@link PROVIDERS}).
 * @param {string|null} [key=null]   - API key required by the provider, if any.
 * @throws {Error} When the requested provider is not registered.
 */
function configure(providerName, key = null) {
    if (!PROVIDERS[providerName]) {
        throw new Error(
            `Provider "${providerName}" not supported. Available: ${Object.keys(PROVIDERS).join(', ')}`
        );
    }
    _currentProvider = providerName;
    _apiKey          = key;
}

/**
 * Resolves the client's full location.
 *
 * Resolution order:
 * 1. In-memory cache (`_cachedData`).
 * 2. Valid localStorage entry.
 * 3. Fresh network fetch from the active provider.
 *
 * @returns {Promise<LocationData>}
 */
async function getLocation() {
    if (_cachedData) return _toPublicShape(_cachedData);

    const stored = StorageModule.getLocalItem(STORAGE_KEY);
    if (stored) {
        const parsed = _parseStoredLocation(stored);
        if (parsed) {
            _cachedData = parsed;
            return _toPublicShape(_cachedData);
        }
    }

    return _toPublicShape(await _fetchAndStoreLocation());
}

/**
 * Resolves the client's public IP address.
 *
 * Resolution order mirrors {@link getLocation} but returns only the `ip` field.
 *
 * @returns {Promise<string|null>} IP address string or `null` when unavailable.
 */
async function getIp() {
    if (_cachedData?.ip) return _cachedData.ip;

    const stored = StorageModule.getLocalItem(STORAGE_KEY);
    if (stored) {
        const parsed = _parseStoredLocation(stored);
        if (parsed) {
            _cachedData = parsed;
            if (_cachedData.ip) return _cachedData.ip;
        }
    }

    return (await _fetchAndStoreLocation()).ip;
}

/**
 * Persists a location record derived from server-side response headers,
 * bypassing the external GeoIP provider.
 *
 * Called by the worker after extracting `X-IP`, `X-Country`, etc. headers
 * from the first authenticated API response, which avoids an additional
 * third-party request for authenticated users.
 *
 * @param {Partial<LocationData>} serverData - Location fields extracted from server headers.
 * @returns {LocationData|undefined} The persisted record, or `undefined` when `serverData` lacks an IP.
 */
function saveServerLocation(serverData) {
    if (!serverData?.ip) return;

    const location = {
        country:     serverData.country     ?? null,
        region:      serverData.region      ?? null,
        city:        serverData.city        ?? null,
        ip:          serverData.ip,
        countryCode: serverData.countryCode ?? null,
        lat:         serverData.lat         ?? null,
        lon:         serverData.lon         ?? null,
        timestamp:   Date.now(),
        provider:    serverData.provider    ?? 'server'
    };

    StorageModule.setLocalItem(STORAGE_KEY, JSON.stringify(location));
    _cachedData = location;
    return location;
}

/**
 * Removes the cached location from both localStorage and memory.
 */
function clearStorage() {
    StorageModule.removeLocalItem(STORAGE_KEY);
    _cachedData = null;
}

/**
 * Forces a fresh GeoIP lookup, discarding any cached or stored data first.
 *
 * @returns {Promise<LocationData>}
 */
async function forceRefresh() {
    clearStorage();
    return _toPublicShape(await _fetchAndStoreLocation());
}

/**
 * Returns the identifier of the currently active GeoIP provider.
 *
 * @returns {string}
 */
function getCurrentProvider() {
    return _currentProvider;
}

/**
 * Returns all registered provider identifiers.
 *
 * @returns {string[]}
 */
function getAvailableProviders() {
    return Object.keys(PROVIDERS);
}

// =============================================================================
// TYPEDEFS
// =============================================================================

/**
 * @typedef {Object} LocationData
 * @property {string|null} country     - Full country name.
 * @property {string|null} region      - Region or state name.
 * @property {string|null} city        - City name.
 * @property {string|null} ip          - Public IP address.
 * @property {string|null} countryCode - ISO 3166-1 alpha-2 country code.
 * @property {number|null} lat         - Latitude coordinate.
 * @property {number|null} lon         - Longitude coordinate.
 * @property {number}      [timestamp] - Unix epoch milliseconds of the last fetch.
 * @property {string}      [provider]  - Provider identifier used for this record.
 * @property {boolean}     [fresh]     - Whether the record is within the 24-hour window.
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {string}                   url      - Base API endpoint URL.
 * @property {string|null}              keyParam - Query parameter template for the API key.
 * @property {Record<string, string>}   fields   - Mapping from normalised keys to provider response keys.
 */

// =============================================================================
// MODULE EXPORT
// =============================================================================

const GeoStorage = {
    configure,
    getLocation,
    getIp,
    clearStorage,
    forceRefresh,
    saveServerLocation,
    getCurrentProvider,
    getAvailableProviders
};

export default GeoStorage;