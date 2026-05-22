/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: quelora/js/core/scaffold.js */
import handleLog from './logs.js';

const CONSTANTS = {
    IDS: {
        THEME_ROOT: 'ql-theme-root',
        ROOT: 'ql-root',
        PICKER_CONTAINER: 'ql-picker-container',
        MODAL: 'ql-modal'
    },
    CLASSES: {
        MODAL: 'ql-modal',
        CONTAINER: 'ql-container',
        BODY: 'ql-body',
        MODAL_CONTENT: 'ql-modal-content',
        FOOTER: 'ql-modal-footer'
    }
};

const STATE = {
    isInitialized: false,
    rootElement: null,
    themeRootElement: null
};

const DomBuilder = {
    createModalStructure: () => {
        const modal = document.createElement('div');
        modal.id = CONSTANTS.IDS.MODAL;
        modal.className = CONSTANTS.CLASSES.MODAL;

        const container = document.createElement('div');
        container.className = CONSTANTS.CLASSES.CONTAINER;

        const body = document.createElement('div');
        body.classList.add(CONSTANTS.CLASSES.BODY, CONSTANTS.CLASSES.MODAL_CONTENT);

        const footer = document.createElement('div');
        footer.className = CONSTANTS.CLASSES.FOOTER;

        container.append(body, footer);
        modal.appendChild(container);

        return modal;
    },

    createScaffold: () => {
        const themeRoot = document.createElement('div');
        themeRoot.id = CONSTANTS.IDS.THEME_ROOT;

        const root = document.createElement('div');
        root.id = CONSTANTS.IDS.ROOT;

        const pickerContainer = document.createElement('div');
        pickerContainer.id = CONSTANTS.IDS.PICKER_CONTAINER;

        const modalStructure = DomBuilder.createModalStructure();

        root.append(pickerContainer, modalStructure);
        themeRoot.appendChild(root);

        return { themeRoot, root };
    }
};

const ScaffoldModule = {
    init: () => {
        const existingThemeRoot = document.getElementById(CONSTANTS.IDS.THEME_ROOT);
        if (existingThemeRoot) {
            STATE.themeRootElement = existingThemeRoot;
            STATE.rootElement = document.getElementById(CONSTANTS.IDS.ROOT);
            STATE.isInitialized = true;
            return STATE.rootElement;
        }

        if (STATE.isInitialized && STATE.rootElement) {
            return STATE.rootElement;
        }

        try {
            const { themeRoot, root } = DomBuilder.createScaffold();
            document.body.appendChild(themeRoot);

            STATE.themeRootElement = themeRoot;
            STATE.rootElement = root;
            STATE.isInitialized = true;

            handleLog('DOM Scaffold injected successfully.', 'Scaffold', 'log', '🏠');

            return root;
        } catch (error) {
            handleLog(`Fatal Error: Could not append Quelora scaffold to document. ${error.message}`, 'Scaffold', 'error', '🏠');
            return null;
        }
    }
};

const rootElement = ScaffoldModule.init();

export const themeRootElement = STATE.themeRootElement;
export default rootElement;
