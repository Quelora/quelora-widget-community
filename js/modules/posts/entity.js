/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/entity.js */
import handleLog from '../../core/logs.js'; 
import ConfModule from '../../core/conf.js';
import Anchor from '../../ui/anchor.js';

/**
 * @module Entity
 * @description Manages entity discovery, hashing, and link generation for the Quelora ecosystem.
 * Utilizes Anchor module for protocol-compliant deep-link generation.
 * @version 1.2.0
 */

const CONSTANTS = {
    DEFAULT_SELECTOR: '[data-entity]',
    ATTR_ID: 'data-entity',
    ATTR_READY: 'data-entity-ready',
    ATTR_ORIGINAL: 'data-entity-original',
    DETERMINISTIC_SELECTOR: 'span.ql-deterministic',
    ATTR_HREF: 'data-href',
    PLACEMENT: {
        DEFAULT_POS: 'inside',
        DEFAULT_REL: '[data-entity-interaction-containter]',
        DETERMINISTIC: false
    }
};

/**
 * Helper for resolving configuration settings from the central config module.
 * @private
 */
const _ConfigHelper = {
    get: () => {
        try {
            const conf = ConfModule.get('entityConfig', {});
            const isDeterministic = conf.interactionPlacement?.deterministic ?? CONSTANTS.PLACEMENT.DETERMINISTIC;
            return {
                selector: conf.selector || CONSTANTS.DEFAULT_SELECTOR,
                goTo: conf.goTo || false,
                hrefAttribute: conf.hrefAttribute || 'href',
                entityIdAttribute: conf.entityIdAttribute || CONSTANTS.ATTR_ID,
                entityIdFn: conf.entityIdAttribute
                    ? (el) => {
                        const direct = el.getAttribute(conf.entityIdAttribute);
                        if (direct) return direct;
                        const child = el.querySelector(`[${conf.entityIdAttribute}]`);
                        return child ? child.getAttribute(conf.entityIdAttribute) : null;
                    }
                    : (el) => el.getAttribute(CONSTANTS.ATTR_ID),
                interaction: {
                    position: isDeterministic ? 'deterministic' : (conf.interactionPlacement?.position || CONSTANTS.PLACEMENT.DEFAULT_POS),
                    relativeTo: conf.interactionPlacement?.relativeTo || CONSTANTS.PLACEMENT.DEFAULT_REL,
                    deterministic: isDeterministic
                }
            };
        } catch (e) {
            return {
                selector: CONSTANTS.DEFAULT_SELECTOR,
                goTo: false,
                hrefAttribute: 'href',
                entityIdFn: (el) => el.getAttribute(CONSTANTS.ATTR_ID),
                interaction: { ...CONSTANTS.PLACEMENT, position: CONSTANTS.PLACEMENT.DEFAULT_POS }
            };
        }
    }
};

/**
 * Service for generating 24-character hexadecimal hashes for entity identification.
 * Ensures consistent entity ID lengths regardless of the source attribute format.
 * @private
 */
const _HashService = {
    /**
     * Generates a SHA-256 hash or returns the input if already a valid 24-char hex.
     * @param {string|number} input - The raw ID to be processed.
     * @returns {Promise<string|null>} The processed 24-character hex string.
     */
    generate: async (input) => {
        try {
            if (!input) return null;
            const str = String(input);
            if (/^[0-9a-f]{24}$/.test(str.toLowerCase())) return str.toLowerCase();
            
            const data = new TextEncoder().encode(str);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('')
                .substring(0, 24)
                .toLowerCase();
        } catch (e) {
            handleLog(e, 'Entity.HashService', 'error', '📰');
            return null;
        }
    }
};

const EntityModule = {
    /**
     * Retrieves the current entity configuration.
     * @returns {Object}
     */
    getConfig: () => _ConfigHelper.get(),

    /**
     * Gets the preferred interaction bar position.
     * @returns {string}
     */
    getInteractionPosition: () => _ConfigHelper.get().interaction.position,

    /**
     * Scans the DOM for new entities and processes their IDs.
     *
     * In **deterministic mode** the widget looks for `span.ql-deterministic` markers
     * placed by the site admin. Each marker must carry `data-entity` (the entity ID)
     * and, optionally, `data-href` (the entity page URL used when `goTo` is active).
     * The widget replaces each marker with the interaction bar at render time.
     *
     * In **standard mode** the widget uses `config.selector` to discover entity
     * containers and extracts their ID via `config.entityIdAttribute`. Deep-link
     * anchors are attached to child link elements when `goTo` is active.
     *
     * @returns {Promise<[string[], Object]>} Tuple: [array of hashed entity IDs, original-ID map].
     */
    findEntities: async () => {
        const config = _ConfigHelper.get();
        const hashedIds  = [];
        const originalMap = {};
        let   needsMapping = false;

        if (config.interaction.deterministic) {
            const spans = Array.from(
                document.querySelectorAll(`${CONSTANTS.DETERMINISTIC_SELECTOR}:not([${CONSTANTS.ATTR_READY}])`)
            );

            await Promise.all(spans.map(async (el) => {
                const originalId = el.getAttribute(CONSTANTS.ATTR_ID);
                if (!originalId) return;

                const finalId = await _HashService.generate(originalId);
                if (!finalId) return;

                el.setAttribute(CONSTANTS.ATTR_ID, finalId);
                el.setAttribute(CONSTANTS.ATTR_READY, 'true');

                if (finalId !== originalId) {
                    el.setAttribute(CONSTANTS.ATTR_ORIGINAL, encodeURIComponent(originalId));
                    originalMap[finalId] = encodeURIComponent(originalId);
                    needsMapping = true;
                }

                hashedIds.push(finalId);
            }));

            return [hashedIds, needsMapping ? originalMap : {}];
        }

        // --- Standard (non-deterministic) mode ---
        const nodes    = document.querySelectorAll(config.selector);
        const elements = Array.from(nodes).filter(el => !el.hasAttribute(CONSTANTS.ATTR_READY));

        await Promise.all(elements.map(async (el) => {
            const originalId = config.entityIdFn(el);
            if (!originalId) return;

            const shouldHash = config.entityIdAttribute !== CONSTANTS.ATTR_ID;
            const finalId    = shouldHash ? await _HashService.generate(originalId) : originalId;

            el.setAttribute(CONSTANTS.ATTR_ID, finalId);
            el.setAttribute(CONSTANTS.ATTR_ORIGINAL, encodeURIComponent(originalId));
            el.setAttribute(CONSTANTS.ATTR_READY, 'true');

            if (config.goTo) {
                let linkEl;
                const attr = config.hrefAttribute || 'href';
                const isSel = !/^[\w-]+$/.test(attr);

                if (isSel) {
                    linkEl = el.querySelector(attr);
                } else {
                    if (attr !== 'href') linkEl = el.querySelector(`[${attr}]`);
                    if (!linkEl) linkEl = el.querySelector('a[href]');
                }

                if (linkEl) {
                    const rawHref = (isSel ? null : linkEl.getAttribute(attr)) || linkEl.getAttribute('href') || '';
                    const baseUrl = rawHref.split('#')[0];
                    if (baseUrl) {
                        const anchor = Anchor.generateLink({ type: 'entity', ids: { entity: finalId } });
                        el.setAttribute('data-href', `${baseUrl}${anchor}`);
                    }
                }
            }

            hashedIds.push(finalId);
            if (shouldHash || finalId !== originalId) {
                originalMap[finalId] = encodeURIComponent(originalId);
                needsMapping = true;
            }
        }));

        return [hashedIds, needsMapping ? originalMap : {}];
    },

    /**
     * Resolves DOM targets for interaction bar injection based on entity ID.
     *
     * **Deterministic mode:** returns every `span.ql-deterministic[data-entity]` marker
     * for the given ID (multiple occurrences on the same page are supported). Each
     * marker will be hidden and the interaction bar placed immediately before it so
     * the marker acts as a permanent DOM anchor for subsequent updates.
     *
     * **Standard mode:** locates the entity container via `config.selector`, then
     * returns `relativeTo` sub-elements (or the container itself as fallback).
     *
     * @param {string} entityId - The 24-character entity identifier.
     * @returns {Element[]} Array of target elements for the interaction bar.
     */
    getInteractionPlacementsByEntity: (entityId) => {
        const config = _ConfigHelper.get();

        if (config.interaction.deterministic) {
            const spans = document.querySelectorAll(
                `${CONSTANTS.DETERMINISTIC_SELECTOR}[${CONSTANTS.ATTR_ID}="${entityId}"]`
            );
            return spans.length > 0 ? Array.from(spans) : [];
        }

        const mainEl = document.querySelector(`${config.selector}[${CONSTANTS.ATTR_ID}="${entityId}"]`);
        if (!mainEl) {
            handleLog(`Entity ${entityId} not found`, 'EntityModule', 'warn', '📰');
            return [];
        }

        const targets = mainEl.querySelectorAll(config.interaction.relativeTo);
        return targets.length > 0 ? Array.from(targets) : [mainEl];
    },

    /**
     * Returns the `data-href` value from the `ql-deterministic` marker for the
     * given entity. Used in deterministic mode to resolve navigation and share URLs.
     *
     * @param {string} entityId - The 24-character entity identifier.
     * @returns {string|null} The href string, or `null` if absent or empty.
     */
    getDeterministicHref: (entityId) => {
        const span = document.querySelector(
            `${CONSTANTS.DETERMINISTIC_SELECTOR}[${CONSTANTS.ATTR_ID}="${entityId}"]`
        );
        if (!span) return null;
        const href = span.getAttribute(CONSTANTS.ATTR_HREF);
        return (href && href.trim()) ? href.trim() : null;
    }
};

export default EntityModule;