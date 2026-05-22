/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/**
 * Creates a progress input module that visually shows input progress based on maxlength.
 * @returns {Object} An object with an `init` method to set up the progress bar.
 */
function createProgressInput() {
    let inputElement, progressBar;

    /**
     * Updates the progress bar based on the current input length.
     */
    const updateProgress = () => {
        const isContentEditable = inputElement.isContentEditable;
        const maxLength = parseInt(inputElement.getAttribute('maxlength')) || 100;
        
        const val = isContentEditable ? inputElement.textContent : inputElement.value;
        const currentLength = val ? val.length : 0;
        
        const percentage = (currentLength / maxLength) * 100;

        // Set progress bar width proportional to input width
        if (inputElement.offsetWidth > 0) {
            progressBar.style.width = `${(percentage / 100) * inputElement.offsetWidth}px`;
        }
        
        // Change color based on fill percentage
        progressBar.style.backgroundColor = 
            percentage < 50 ? '#4caf50' :  // Green (<50%)
            percentage < 75 ? '#e5be01' :  // Yellow (50-75%)
            percentage < 100 ? '#ff9800' : // Orange (75-100%)
            '#f44336';                    // Red (100% or over)
        
        // Toggle 'full' class when reaching 100%
        progressBar.classList[percentage < 100 ? 'remove' : 'add']('full');
    };

    return {
        /**
         * Initializes the progress bar for a given input field.
         * @param {string} inputId - ID of the input element to monitor.
         * @param {string} progressBarId - ID for the progress bar element.
         * @returns {boolean} False if input element doesn't exist.
         */
        init: (inputId, progressBarId) => {
            inputElement = document.getElementById(inputId);
            if (!inputElement) return false;

            // Try to get existing progress bar or create a new one
            progressBar = document.getElementById(progressBarId);
            
            // Si el contenedor padre no tiene position relative, el estilo de la barra podría romperse,
            // pero mantenemos la lógica original de creación.
            if (!progressBar) {
                // Importamos UiModule dinámicamente o asumimos que está en el scope global si es un módulo bundleado
                // En este contexto, usamos document.createElement si UiModule no está disponible directamente aquí
                progressBar = document.createElement('div');
                progressBar.id = progressBarId;
                progressBar.className = 'progress-bar';
                Object.assign(progressBar.style, {
                    width: '0',
                    height: '4px',
                    backgroundColor: '#4caf50',
                    transition: 'width 0.3s ease, background-color 0.3s ease'
                });

                // Insert after the input field
                if (inputElement.parentNode) {
                    inputElement.parentNode.insertBefore(progressBar, inputElement.nextSibling);
                }
            }

            // Initial update
            updateProgress();

            // Update on input events
            inputElement.addEventListener('input', updateProgress);
        }
    };
}

/**
 * Factory function that creates and initializes a ProgressInput instance.
 * @param {string} inputId - ID of the input element.
 * @param {string} barId - ID for the progress bar.
 * @returns {Object} The ProgressInput instance.
 */
const ProgressInput = (inputId, barId) => {
    const instance = createProgressInput();
    instance.init(inputId, barId);
    return instance;
};

export default ProgressInput;