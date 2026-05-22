/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/plugins/placer/interaction-placer.js */
/**
 * @module Plugins/InteractionPlacer
 * @description Visual positioning tool for the ql-interaction bar and auth widget.
 *
 * Architecture overview:
 * - **Hover panel** (`#ql-placer-panel`): compact pill fixed above or below the hovered target.
 * - **Style toolbar** (`#ql-placer-style-toolbar`): singleton strip fixed to the top-center.
 * - **Export Modal**: Overlays toolbar to copy JSON configuration and CSS rules.
 * - **Latent Activation**: Keyboard Alt+Shift+Q to initialize. Uses localStorage with TTL (10m).
 * - **Entity Picker**: Interactive DOM picker to reassign the root entity or auth selector.
 * - **Deactivation FAB**: Floating button to manually kill the session.
 *
 * @version 21.2.1
 */

import handleLog     from '../../core/logs.js';
import IconModule    from '../../ui/icons.js';
import I18n          from '../../core/i18n.js';
import StorageModule from '../../core/storage.js';
import ToastModule   from '../../ui/toast.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const PLUGIN_ID     = 'ql-placer';
const PANEL_ID      = `${PLUGIN_ID}-panel`;
const TOOLBAR_ID    = `${PLUGIN_ID}-style-toolbar`;
const FAB_ID        = `${PLUGIN_ID}-fab`;
const STYLE_LIVE_ID = `${PLUGIN_ID}-live-css`;
const BAR_SEL       = '.ql-interaction:not(.ql-interaction--skeleton)';
const BAR_CLASS     = 'ql-interaction';
const VERTICAL_CLASS= 'ql-interaction--vertical';
const AUTH_PREVIEW_CLASS = `${PLUGIN_ID}-auth-preview`;
const AUTH_WIDGET_SEL = '.ql-auth-widget';

const TTL_MS = 10 * 60 * 1000;

const I18N_KEYS = {
    drag:             'placer_drag_title',
    tune:             'placer_tune_title',
    close:            'placer_close_title',
    applyAll:         'placer_apply_all_title',
    applyAllLabel:    'placer_apply_all_label',
    exportTitle:      'placer_export_title',
    exportLabel:      'placer_export_label',
    exportJson:       'placer_export_json',
    exportCss:        'placer_export_css',
    copyBtn:          'placer_copy',
    copiedBtn:        'placer_copied',
    disableBtn:       'placer_disable_btn',

    sectionContainer: 'placer_section_container',
    sectionEntity:    'placer_section_entity',
    sectionBar:       'placer_section_bar',
    sectionAuth:      'placer_section_auth',

    layout:           'placer_group_layout',
    horizontal:       'placer_opt_horizontal',
    vertical:         'placer_opt_vertical',
    
    direction:        'placer_group_direction',
    justify:          'placer_group_justify',
    align:            'placer_group_align',
    width:            'placer_group_width',
    spacing:          'placer_group_spacing',
    injectPos:        'placer_group_inject_pos',
    alignSelf:        'placer_group_align_self',
    barMargin:        'placer_group_bar_margin',

    row:              'placer_opt_row',
    column:           'placer_opt_column',
    start:            'placer_opt_start',
    center:           'placer_opt_center',
    end:              'placer_opt_end',
    spaceBetween:     'placer_opt_space_between',
    spaceAround:      'placer_opt_space_around',
    spaceEvenly:      'placer_opt_space_evenly',
    stretch:          'placer_opt_stretch',
    baseline:         'placer_opt_baseline',
    fitContent:       'placer_opt_fit_content',
    fullWidth:        'placer_opt_full_width',
    
    mtAuto:           'placer_opt_mt_auto',
    mbAuto:           'placer_opt_mb_auto',
    mlAuto:           'placer_opt_ml_auto',
    mrAuto:           'placer_opt_mr_auto',
    
    selfAuto:         'placer_opt_self_auto',
    selfStart:        'placer_opt_self_start',
    selfCenter:       'placer_opt_self_center',
    selfEnd:          'placer_opt_self_end',
    selfStretch:      'placer_opt_self_stretch',

    gap:              'placer_slider_gap',
    pt:               'placer_slider_pt',
    pb:               'placer_slider_pb',
    pl:               'placer_slider_pl',
    pr:               'placer_slider_pr',

    inside:           'placer_pos_inside',
    before:           'placer_pos_before',
    after:            'placer_pos_after',
    replace:          'placer_pos_replace',

    pickEntity:       'placer_pick_entity',
    pickAuth:         'placer_pick_auth',
    pickerHover:      'placer_picker_hover',
    pickerContainer:  'placer_picker_container',
    pickerDetected:   'placer_picker_detected',
    pickerAttrs:      'placer_picker_attrs',
    pickerClick:      'placer_picker_click',
    pickerScroll:     'placer_picker_scroll',
    pickerInvalid:    'placer_picker_invalid',
    
    selectorTitle:    'placer_selector_title',
    selectorDesc:     'placer_selector_desc',
    selectorMatches:  'placer_selector_matches',
    selectorCancel:   'placer_selector_cancel',

    activated:        'placer_activated',
    activatedDesc:    'placer_activated_desc',
    deactivated:      'placer_deactivated',
    deactivatedDesc:  'placer_deactivated_desc',
    deterministicWarn: 'placer_deterministic_warn',
    deterministicDesc: 'placer_deterministic_desc'
};

const _t = (key) => {
    const result = I18n.getTranslation(I18N_KEYS[key] || key);
    return result.startsWith('{{') ? (I18N_KEYS[key] || key) : result;
};

const ICONS = {
    drag_indicator:        `<path d="M11 18c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zm-2-8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 4c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/>`,
    science:               `<path d="M13 11.33L18 18H6l5-6.67V6h2m2.96-2H9.04c-.42 0-.65.48-.39.81L9 5v6l-5.33 7.11c-.4.53-.02 1.33.66 1.33h15.33c.69 0 1.07-.8.66-1.33L15 11V5l.39-.19c.26-.33.03-.81-.39-.81zM11 13v3h2v-3l-1-1.33L11 13z"/>`,
    tune:                  `<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/>`,
    close:                 `<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>`,
    code:                  `<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>`,
    content_copy:          `<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>`,
    arrow_right_alt:       `<path d="M16.01 11H4v2h12.01v3L20 12l-3.99-4v3z"/>`,
    arrow_downward:        `<path d="M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z"/>`,
    format_align_left:     `<path d="M15 15H3v2h12v-2zm0-8H3v2h12V7zM3 13h18v-2H3v2zm0 8h18v-2H3v2zM3 3v2h18V3H3z"/>`,
    format_align_center:   `<path d="M7 15v2h10v-2H7zm-4 6h18v-2H3v2zm0-8h18v-2H3v2zm4-6v2h10V7H7zM3 3v2h18V3H3z"/>`,
    format_align_right:    `<path d="M3 21h18v-2H3v2zm6-4h12v-2H9v2zm-6-4h18v-2H3v2zm6-4h12V7H9v2zM3 3v2h18V3H3z"/>`,
    space_bar:             `<path d="M18 9v4H6V9H4v6h16V9z"/>`,
    space_between:         `<path d="M2 3h2v18H2V3zm18 0h2v18h-2V3zM9 6h6v12H9V6z"/>`,
    space_around:          `<path d="M5 5h4v14H5V5zm10 0h4v14h-4V5z"/>`,
    space_evenly:          `<path d="M3 5h2v14H3V5zm6 0h2v14H9V5zm6 0h2v14h-2V5zm6 0h2v14h-2V5z"/>`,
    baseline:              `<path d="M3 19h18v2H3v-2zm6-12l3 8 3-8H9z"/>`,
    vertical_align_top:    `<path d="M8 11h3v10h2V11h3l-4-4-4 4zM4 3v2h16V3H4z"/>`,
    vertical_align_center: `<path d="M8 19h3v4h2v-4h3l-4-4-4 4zm8-14h-3V1h-2v4H8l4 4 4-4zM4 11v2h16v-2H4z"/>`,
    vertical_align_bottom: `<path d="M16 13h-3V3h-2v10H8l4 4 4-4zM4 19v2h16v-2H4z"/>`,
    height:                `<path d="M13 6.99h3L12 3 8 6.99h3v10.02H8L12 21l4-3.99h-3z"/>`,
    width_full:            `<path d="M21 11V3h-8l3.29 3.29-4.3 4.3 1.42 1.42 4.3-4.3L21 11zM3 13v8h8l-3.29-3.29 4.3-4.3-1.42-1.42-4.3 4.3L3 13z"/>`,
    width_fit:             `<path d="M15 3l2.3 2.3-2.89 2.87 1.42 1.42L18.7 6.7 21 9V3zM3 9l2.3-2.3 2.87 2.89 1.42-1.42L6.7 5.3 9 3H3zm6 12l-2.3-2.3 2.89-2.87-1.42-1.42L5.3 17.3 3 15v6zm12-6l-2.3 2.3-2.87-2.89-1.42 1.42 2.89 2.87L15 21h6z"/>`,
    my_location:           `<path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/>`,
    security:              `<path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>`,
    warning_svg:           `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`,
    power_svg:             `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M16.56 5.44l-1.45 1.45C16.84 7.94 18 9.83 18 12c0 3.31-2.69 6-6 6s-6-2.69-6-6c0-2.17 1.16-4.06 2.88-5.12L7.44 5.44C5.36 6.88 4 9.28 4 12c0 4.42 3.58 8 8 8s8-3.58 8-8c0-2.72-1.36-5.12-3.44-6.56zM11 3h2v10h-2z"/></svg>`,
    power_off_svg:         `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M18.36 16.78L4.27 2.69 2.85 4.11l2.69 2.69C4.55 8.55 4 10.2 4 12c0 4.42 3.58 8 8 8 1.82 0 3.49-.62 4.86-1.65l2.73 2.73 1.41-1.41-2.64-2.89zM12 18c-3.31 0-6-2.69-6-6 0-1.28.41-2.47 1.11-3.44l8.34 8.34c-.98.69-2.17 1.1-3.45 1.1zM11 3h2v6.17l-2-2V3zm6.65 3.35l-1.45 1.45C16.84 8.94 18 10.37 18 12c0 1.22-.38 2.36-1.02 3.3l1.45 1.45C19.41 15.35 20 13.75 20 12c0-3.38-1.74-6.35-4.35-8.65z"/></svg>`
};

// ============================================================================
// STATE
// ============================================================================

const _state = {
    targetMode:    'interactions', 
    targetBar:     null,
    targetEntity:  null,
    dropTarget:    null,
    dropPosition:  'inside',
    relativePath:  '',
    authContainer: null,
    authDropPosition: 'inside',
    isDragging:    false,
    isToolbarOpen: false,
    testApplied:   false,
    isBooted:      false,
    isPickingEntity: false,
    stopPickerFn:  null,
    activeTab:     'bar',
    dropZones:     [],
    feedbackTimeout: null,
    container: {
        display:        '',
        flexDirection:  'row',
        justifyContent: 'flex-start',
        alignItems:     'center',
        gap:            '',
        paddingTop:     '',
        paddingBottom:  '',
        paddingLeft:    '',
        paddingRight:   ''
    },
    entity: {
        display:        '',
        flexDirection:  'column',
        justifyContent: 'flex-start',
        alignItems:     'stretch',
        gap:            '',
        paddingTop:     '',
        paddingBottom:  '',
        paddingLeft:    '',
        paddingRight:   ''
    },
    bar: {
        layout:           'horizontal',
        alignSelf:        'auto',
        width:            'fit-content',
        marginTop:        '',
        marginRight:      '',
        marginBottom:     '',
        marginLeft:       '',
        marginTopAuto:    false,
        marginRightAuto:  false,
        marginBottomAuto: false,
        marginLeftAuto:   false
    }
};

let _context = null;

// ============================================================================
// VISUAL FEEDBACK ENGINE (Tooltips & Highlights)
// ============================================================================

function _getStylesList(obj) {
    const list = [];
    if (obj.display) list.push(`display: ${obj.display};`);
    if (obj.display === 'flex') {
        list.push(`flex-direction: ${obj.flexDirection};`);
        list.push(`justify-content: ${obj.justifyContent};`);
        list.push(`align-items: ${obj.alignItems};`);
        if (obj.gap !== '') list.push(`gap: ${obj.gap}px;`);
    }
    if (obj.paddingTop !== '') list.push(`padding-top: ${obj.paddingTop}px;`);
    if (obj.paddingRight !== '') list.push(`padding-right: ${obj.paddingRight}px;`);
    if (obj.paddingBottom !== '') list.push(`padding-bottom: ${obj.paddingBottom}px;`);
    if (obj.paddingLeft !== '') list.push(`padding-left: ${obj.paddingLeft}px;`);
    return list;
}

function _getBarStylesList(b) {
    const list = [];
    list.push(`/* Layout Mode: ${b.layout} */`);
    if (b.alignSelf && b.alignSelf !== 'auto') list.push(`align-self: ${b.alignSelf};`);
    if (b.width && b.width !== 'fit-content') list.push(`width: ${b.width};`);
    
    if (b.marginTopAuto) list.push(`margin-top: auto;`);
    else if (b.marginTop !== '') list.push(`margin-top: ${b.marginTop}px;`);

    if (b.marginRightAuto) list.push(`margin-right: auto;`);
    else if (b.marginRight !== '') list.push(`margin-right: ${b.marginRight}px;`);

    if (b.marginBottomAuto) list.push(`margin-bottom: auto;`);
    else if (b.marginBottom !== '') list.push(`margin-bottom: ${b.marginBottom}px;`);

    if (b.marginLeftAuto === 'auto') list.push(`margin-left: auto;`);
    else if (b.marginLeft !== '') list.push(`margin-left: ${b.marginLeft}px;`);

    return list;
}

function _showFeedback() {
    if (_state.activeTab === 'auth') return; 
    if (!_state.targetEntity || !_state.targetBar) return;

    let targetEl = null;
    let title = '';
    let styles = [];

    if (_state.activeTab === 'entity') {
        targetEl = _state.targetEntity;
        title = 'Entity Styles';
        styles = _getStylesList(_state.entity);
    } else if (_state.activeTab === 'container') {
        targetEl = _state.relativePath ? _state.targetEntity.querySelector(_state.relativePath) : _state.targetEntity;
        title = 'Container Styles';
        styles = _getStylesList(_state.container);
    } else {
        targetEl = _state.targetBar;
        title = 'Bar Styles';
        styles = _getBarStylesList(_state.bar);
    }

    if (!targetEl) return;

    document.querySelectorAll(`.${PLUGIN_ID}-highlight-active`).forEach(el => el.classList.remove(`${PLUGIN_ID}-highlight-active`));
    targetEl.classList.add(`${PLUGIN_ID}-highlight-active`);

    let tooltip = document.getElementById(`${PLUGIN_ID}-style-tooltip`);
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = `${PLUGIN_ID}-style-tooltip`;
        tooltip.className = `${PLUGIN_ID}-style-tooltip`;
        document.body.appendChild(tooltip);
    }

    if (styles.length === 0) {
        tooltip.innerHTML = `<strong>${title}</strong><br><span style="color:#888;">No explicit styles</span>`;
    } else {
        tooltip.innerHTML = `<strong>${title}</strong><br>` + styles.map(s => `<span>${s}</span>`).join('');
    }

    tooltip.classList.add('is-visible');

    const rect = targetEl.getBoundingClientRect();
    const ttRect = tooltip.getBoundingClientRect();
    
    const toolbar = document.getElementById(TOOLBAR_ID);
    const toolbarOffset = (_state.isToolbarOpen && toolbar) ? toolbar.getBoundingClientRect().bottom : 0;

    let top = rect.top - ttRect.height - 10;
    let left = rect.left + (rect.width / 2) - (ttRect.width / 2);

    if (top < toolbarOffset + 10) {
        top = Math.max(toolbarOffset + 10, rect.top + 10);
    }

    if (top + ttRect.height > window.innerHeight - 10) {
        top = window.innerHeight - ttRect.height - 10;
    }

    if (left < 10) left = 10;
    if (left + ttRect.width > window.innerWidth - 10) left = window.innerWidth - ttRect.width - 10;

    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;

    clearTimeout(_state.feedbackTimeout);
    _state.feedbackTimeout = setTimeout(() => {
        tooltip.classList.remove('is-visible');
        targetEl.classList.remove(`${PLUGIN_ID}-highlight-active`);
    }, 2500);
}

// ============================================================================
// CSS COMPILER
// ============================================================================

function _compileCSS() {
    const cfg   = _getEntityConfig();
    const c     = _state.container;
    const en    = _state.entity;
    const b     = _state.bar;

    const entitySel    = cfg.selector;
    const containerSel = _state.relativePath
        ? `${entitySel} ${_state.relativePath}`
        : entitySel;

    const actualBarParent = _state.targetBar?.parentElement;
    const barParentPath = (actualBarParent && actualBarParent !== _state.targetEntity)
        ? _buildRelativePath(actualBarParent, _state.targetEntity)
        : null;
    const barContainerSel = barParentPath ? `${entitySel} ${barParentPath}` : entitySel;
    const barSel          = `${barContainerSel} > .${BAR_CLASS}`;

    const blocks = [];

    if (c.display) {
        let css = `/* Container: direct parent of .ql-interaction */\n${containerSel} {\n`;
        css += `  display: ${c.display} !important;\n`;

        if (c.display === 'flex') {
            css += `  flex-direction: ${c.flexDirection} !important;\n`;
            css += `  justify-content: ${c.justifyContent} !important;\n`;
            css += `  align-items: ${c.alignItems} !important;\n`;
            if (c.gap !== '') css += `  gap: ${c.gap}px !important;\n`;
        }

        const pt = c.paddingTop;
        const pb = c.paddingBottom;
        const pl = c.paddingLeft;
        const pr = c.paddingRight;
        if (pt !== '' || pb !== '' || pl !== '' || pr !== '') {
            css += `  padding: ${pt || 0}px ${pr || 0}px ${pb || 0}px ${pl || 0}px !important;\n`;
        }
        css += `}`;
        blocks.push(css);
    }

    if (en.display) {
        let css = `/* Entity root */\n${entitySel} {\n`;
        css += `  display: ${en.display} !important;\n`;
        
        if (en.display === 'flex') {
            css += `  flex-direction: ${en.flexDirection} !important;\n`;
            css += `  justify-content: ${en.justifyContent} !important;\n`;
            css += `  align-items: ${en.alignItems} !important;\n`;
            if (en.gap !== '') css += `  gap: ${en.gap}px !important;\n`;
        }

        const ept = en.paddingTop;
        const epb = en.paddingBottom;
        const epl = en.paddingLeft;
        const epr = en.paddingRight;
        if (ept !== '' || epb !== '' || epl !== '' || epr !== '') {
            css += `  padding: ${ept || 0}px ${epr || 0}px ${epb || 0}px ${epl || 0}px !important;\n`;
        }
        css += `}`;
        blocks.push(css);
    }

    const barRules = [];
    if (b.alignSelf && b.alignSelf !== 'auto') barRules.push(`  align-self: ${b.alignSelf} !important;`);
    if (b.width)                               barRules.push(`  width: ${b.width} !important;`);

    const mt = b.marginTop;
    const mr = b.marginRight;
    const mb = b.marginBottom;
    const ml = b.marginLeft;

    if (b.marginTopAuto) {
        barRules.push(`  margin-top: auto !important;`);
    } else if (mt !== '') {
        barRules.push(`  margin-top: ${mt}px !important;`);
    }

    if (b.marginRightAuto) {
        barRules.push(`  margin-right: auto !important;`);
    } else if (mr !== '') {
        barRules.push(`  margin-right: ${mr}px !important;`);
    }

    if (b.marginBottomAuto) {
        barRules.push(`  margin-bottom: auto !important;`);
    } else if (mb !== '') {
        barRules.push(`  margin-bottom: ${mb}px !important;`);
    }

    if (b.marginLeftAuto) {
        barRules.push(`  margin-left: auto !important;`);
    } else if (ml !== '') {
        barRules.push(`  margin-left: ${ml}px !important;`);
    }

    if (barRules.length) {
        blocks.push(`/* Bar self-layout */\n${barSel} {\n${barRules.join('\n')}\n}`);
    }

    const fullCss = blocks.join('\n\n');

    let node = document.getElementById(STYLE_LIVE_ID);
    if (!node) {
        node = document.createElement('style');
        node.id = STYLE_LIVE_ID;
        document.body.appendChild(node);
    }
    node.textContent = fullCss;

    return fullCss;
}

function _getCurrentCSS() {
    return document.getElementById(STYLE_LIVE_ID)?.textContent || '';
}

function _getEntityConfig() {
    const conf = _context.ConfModule.get('entityConfig', {});
    return {
        selector: conf.selector || '[data-entity]',
        interaction: {
            position:   conf.interactionPlacement?.position   || 'inside',
            relativeTo: conf.interactionPlacement?.relativeTo || '[data-entity-interaction-containter]',
            deterministic: conf.interactionPlacement?.deterministic || false
        }
    };
}

function _buildRelativePath(el, root) {
    if (!el || el === root) return '';
    const parts = [];
    let   curr  = el;

    while (curr && curr !== root) {
        let segment = curr.tagName.toLowerCase();
        const stableClass = Array.from(curr.classList).find(c => !c.startsWith('ql-') && !c.startsWith('js-'));

        if (stableClass) {
            segment += `.${CSS.escape(stableClass)}`;
        } else {
            const siblings = Array.from(curr.parentElement?.children || []).filter(s => s.tagName === curr.tagName);
            if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(curr) + 1})`;
        }

        parts.unshift(segment);
        curr = curr.parentElement;
    }
    return parts.join(' > ');
}

function _injectBar(containerEl, elementToInject, position) {
    const pos = String(position || 'inside').toLowerCase().trim();
    if (pos === 'replace') {
        containerEl.innerHTML = '';
        containerEl.insertAdjacentElement('beforeend', elementToInject);
    } else if (pos === 'after') {
        containerEl.insertAdjacentElement('afterend', elementToInject);
    } else if (pos === 'before') {
        containerEl.insertAdjacentElement('beforebegin', elementToInject);
    } else {
        containerEl.insertAdjacentElement('beforeend', elementToInject);
    }
}

// ============================================================================
// ENTITY PICKER ENGINE (DOM RE-ASSIGNMENT)
// ============================================================================

function _buildStableClassSelector(el) {
    const stableClass = Array.from(el.classList).find(c => 
        !c.startsWith('ql-') && !c.startsWith('js-') && !c.startsWith(PLUGIN_ID)
    );
    if (stableClass) return `.${CSS.escape(stableClass)}`;
    return el.tagName.toLowerCase();
}

function _buildAttributesHtml(el) {
    const maxValLen = 40;
    const attrs = Array.from(el.attributes)
        .filter(a => a.name !== 'class' && !a.name.startsWith(PLUGIN_ID) && !a.name.startsWith('style'))
        .map(a => {
            const safeVal = a.value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const truncVal = safeVal.length > maxValLen ? safeVal.substring(0, maxValLen) + '…' : safeVal;
            return `<span style="display:inline-block; margin:2px 4px; background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px;"><span style="color:#8e44ad">${a.name}</span>=<span style="color:#e67e22">"${truncVal}"</span></span>`;
        });
    
    if (!attrs.length) return '';
    
    return `<div style="margin-top:8px; padding-top:8px; border-top:1px solid #333; font-size:11px; text-align:left; max-height: 80px; overflow: hidden;">
        <div style="color:#888; margin-bottom:4px; font-size:10px; text-transform:uppercase;" class="t">${_t('pickerAttrs')}:</div>
        ${attrs.join('')}
    </div>`;
}

function _showPatternSelectorModal(el, mode) {
    let modal = document.getElementById(`${PLUGIN_ID}-pattern-modal`);
    if (modal) modal.remove();

    const options = [];
    const tag = el.tagName.toLowerCase();
    
    try { 
        options.push({ selector: tag, count: document.querySelectorAll(tag).length }); 
    } catch(e) {}

    const classes = Array.from(el.classList).filter(c => 
        !c.startsWith('ql-') && !c.startsWith('js-') && !c.startsWith(PLUGIN_ID)
    );
    
    classes.forEach(c => {
        const sel = `.${CSS.escape(c)}`;
        try {
            options.push({ selector: sel, count: document.querySelectorAll(sel).length });
        } catch(e) {}
    });

    const uniqueOptions = Array.from(new Map(options.map(item => [item.selector, item])).values());
    uniqueOptions.sort((a, b) => b.count - a.count);

    modal = document.createElement('div');
    modal.id = `${PLUGIN_ID}-pattern-modal`;
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(0,0,0,0.8); z-index: 9999999; display: flex;
        align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
        background: #1e1e1e; border: 1px solid #333; border-radius: 8px;
        width: 400px; max-width: 90vw; max-height: 80vh; display: flex; flex-direction: column;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
        padding: 16px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center;
    `;
    
    const title = document.createElement('span');
    title.style.cssText = 'color: #fff; font-weight: bold; font-size: 14px;';
    title.textContent = _t('selectorTitle');

    const closeBtn = document.createElement('div');
    closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="#888" style="cursor:pointer; transition:fill 0.2s;"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    closeBtn.onmouseover = () => closeBtn.firstChild.style.fill = '#fff';
    closeBtn.onmouseout = () => closeBtn.firstChild.style.fill = '#888';
    closeBtn.onclick = () => modal.remove();

    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.style.cssText = `padding: 16px; overflow-y: auto; flex: 1;`;

    const desc = document.createElement('div');
    desc.style.cssText = `color: #aaa; font-size: 12px; margin-bottom: 16px; line-height: 1.4;`;
    desc.textContent = _t('selectorDesc');

    const list = document.createElement('div');
    list.style.cssText = `display: flex; flex-direction: column; gap: 8px;`;

    uniqueOptions.forEach(opt => {
        const btn = document.createElement('button');
        btn.style.cssText = `
            background: #2a2a2a; border: 1px solid #444; border-radius: 6px; padding: 12px;
            color: #fff; text-align: left; cursor: pointer; display: flex; justify-content: space-between;
            align-items: center; transition: background 0.2s; outline: none;
        `;
        btn.onmouseover = () => btn.style.background = '#333';
        btn.onmouseout = () => btn.style.background = '#2a2a2a';
        
        const selSpan = document.createElement('span');
        selSpan.style.cssText = 'color: #f1c40f; font-family: monospace; font-size: 13px; word-break: break-all; padding-right: 12px;';
        selSpan.textContent = opt.selector;

        const countSpan = document.createElement('span');
        countSpan.style.cssText = 'background: #27ae60; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; white-space: nowrap;';
        countSpan.textContent = `${opt.count} ${_t('selectorMatches')}`;

        btn.append(selSpan, countSpan);

        btn.onclick = () => {
            modal.remove();
            if (mode === 'auth') {
                _reassignAuth(opt.selector);
            } else {
                _reassignEntity(opt.selector);
            }
        };

        list.appendChild(btn);
    });

    body.append(desc, list);
    box.append(header, body);
    modal.appendChild(box);
    document.body.appendChild(modal);
}

function _startEntityPicker(mode = 'interactions') {
    if (_state.isPickingEntity) return;

    if (mode === 'interactions') {
        const config = _getEntityConfig();
        if (config.interaction.deterministic) {
            ToastModule.warning(ICONS.warning_svg, _t('deterministicWarn'), _t('deterministicDesc'), null, 5000);
            return;
        }
    }

    _state.targetMode = mode;
    _state.isPickingEntity = true;
    _closeStyleToolbar();

    const badge = document.createElement('div');
    badge.id = `${PLUGIN_ID}-picker-badge`;
    badge.className = `${PLUGIN_ID}-picker-badge`;
    badge.innerHTML = `<span class="t">${_t('pickerHover')}</span>`;
    document.body.appendChild(badge);

    const overlay = document.createElement('div');
    overlay.id = `${PLUGIN_ID}-picker-overlay`;
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        z-index: 9999998; cursor: crosshair;
    `;
    document.body.appendChild(overlay);

    let baseElement = null;
    let currentTarget = null;
    let currentDepth = 0;

    const updateSelection = (el) => {
        if (currentTarget) currentTarget.classList.remove(`${PLUGIN_ID}-picker-hover`);
        currentTarget = el;
        currentTarget.classList.add(`${PLUGIN_ID}-picker-hover`);

        const currentSelector = _buildStableClassSelector(currentTarget);
        
        try {
            const count = document.querySelectorAll(currentSelector).length;
            const attrsHtml = _buildAttributesHtml(currentTarget);
            badge.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <div>
                        <span class="t">${_t('pickerContainer')}</span>: <span style="color:#f1c40f">${currentSelector}</span> | 
                        <span class="t">${_t('pickerDetected')}</span>: <span style="color:#2ecc71">${count}</span>
                    </div>
                    ${attrsHtml}
                    <div style="display:flex; align-items:center; justify-content:center; gap:12px; margin-top:4px; font-size:11px; font-weight:normal; color:#aaa; border-top:1px dashed #444; padding-top:8px;">
                        <span>🖱️ <span class="t">${_t('pickerClick')}</span></span>
                        <span style="display:flex; align-items:center;">
                            <div class="${PLUGIN_ID}-mouse-icon"><div class="${PLUGIN_ID}-mouse-wheel"></div></div>
                            <span class="t">${_t('pickerScroll')}</span>
                        </span>
                    </div>
                </div>
            `;
        } catch (err) {
            badge.innerHTML = `<span class="t">${_t('pickerInvalid')}</span>`;
        }
    };

    const onMove = (e) => {
        overlay.style.pointerEvents = 'none';
        const el = document.elementFromPoint(e.clientX, e.clientY);
        overlay.style.pointerEvents = 'auto';

        if (!el || el === document.body || el.tagName === 'HTML') return;

        if (el !== baseElement) {
            baseElement = el;
            currentDepth = 0;
            updateSelection(baseElement);
        }
    };

    const onWheel = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!baseElement || !currentTarget) return;

        if (e.deltaY < 0) {
            const parent = currentTarget.parentElement;
            if (parent && parent !== document.body && parent.tagName !== 'HTML') {
                currentDepth++;
                updateSelection(parent);
            }
        } else if (e.deltaY > 0) {
            if (currentDepth > 0) {
                currentDepth--;
                let el = baseElement;
                for (let i = 0; i < currentDepth; i++) {
                    el = el.parentElement;
                }
                updateSelection(el);
            }
        }
    };

    const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!currentTarget) return;
        
        const targetToAnalyze = currentTarget;
        _stopEntityPicker();
        _showPatternSelectorModal(targetToAnalyze, _state.targetMode);
    };

    const onKey = (e) => {
        if (e.key === 'Escape') {
            _stopEntityPicker();
        }
    };

    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);

    _state.stopPickerFn = () => {
        overlay.removeEventListener('mousemove', onMove);
        overlay.removeEventListener('wheel', onWheel);
        overlay.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        badge.remove();
        overlay.remove();
        if (currentTarget) currentTarget.classList.remove(`${PLUGIN_ID}-picker-hover`);
        _state.isPickingEntity = false;
        _state.stopPickerFn = null;
    };
}

function _stopEntityPicker() {
    if (_state.stopPickerFn) _state.stopPickerFn();
}

function _reassignEntity(newSelector) {
    const currentEntityConf = _context.ConfModule.get('entityConfig', {});
    currentEntityConf.selector = newSelector;
    currentEntityConf.interactionPlacement = {
        position: 'inside',
        relativeTo: '' 
    };
    _context.ConfModule.updateConfig({ entityConfig: currentEntityConf });

    const anyExistingBar = document.querySelector(`.${BAR_CLASS}`);
    const realBarHTML = anyExistingBar ? anyExistingBar.innerHTML : '';

    // Eliminación absoluta de las barras originales de toda la página
    document.querySelectorAll(`.${BAR_CLASS}`).forEach(el => el.remove());
    
    document.querySelectorAll('[data-entity-ready]').forEach(el => {
        if (el.getAttribute('data-entity')?.startsWith('preview_entity_')) {
            el.removeAttribute('data-entity');
        }
        el.removeAttribute('data-entity-ready');
        el.removeAttribute('data-entity-original');
    });

    const idAttr = currentEntityConf.entityIdAttribute || 'data-entity';
    
    // Inyección manual del test bar para permitir al usuario seguir jugando.
    document.querySelectorAll(newSelector).forEach((el, index) => {
        if (!el.getAttribute(idAttr)) {
            el.setAttribute(idAttr, `preview_entity_${index}`);
        }
        
        el.setAttribute('data-entity-ready', 'true');

        const previewBar = document.createElement('div');
        previewBar.className = `${BAR_CLASS} ${PLUGIN_ID}-test-bar`;
        if (_state.bar.layout === 'vertical') {
            previewBar.classList.add(VERTICAL_CLASS);
        }
        
        if (realBarHTML) {
            previewBar.innerHTML = realBarHTML;
        } else {
            previewBar.innerHTML = `
                <div class="ql-interaction__actions">
                    <div class="ql-interaction__item" data-interaction-type="like">
                        <span class="ql-icons-outlined ql-interaction__icon">favorite_border</span>
                        <span class="ql-interaction__count">0</span>
                    </div>
                    <div class="ql-interaction__item" data-interaction-type="comment">
                        <span class="ql-icons-outlined ql-interaction__icon">chat_bubble_outline</span>
                        <span class="ql-interaction__count">0</span>
                    </div>
                    <div class="ql-interaction__item" data-interaction-type="share">
                        <span class="ql-icons-outlined ql-interaction__icon">share</span>
                        <span class="ql-interaction__count">0</span>
                    </div>
                </div>
                <span class="ql-icons-outlined ql-interaction__bookmark">bookmark_border</span>
            `;
        }
        
        previewBar.style.outline = '2px dashed #27ae60';
        previewBar.style.outlineOffset = '2px';
        
        _injectBar(el, previewBar, 'inside');
    });

    _state.targetEntity = null;
    _state.targetBar = null;
    _state.relativePath = '';
    _state.dropTarget = null;
    _state.dropPosition = 'inside';
    _state.activeTab = 'bar';
    
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';

    handleLog(`Entity selector reassigned to: ${newSelector}`, 'InteractionPlacer', 'info', '🎯');
}

function _reassignAuth(newSelector) {
    const currentAuthConf = _context.ConfModule.get('authWidget', {});
    currentAuthConf.enabled = true;
    currentAuthConf.selector = newSelector;
    currentAuthConf.position = _state.authDropPosition || 'inside';
    _context.ConfModule.updateConfig({ authWidget: currentAuthConf });

    document.querySelectorAll(`.${AUTH_PREVIEW_CLASS}`).forEach(el => el.remove());

    const container = document.querySelector(newSelector);
    if (container) {
        _state.authContainer = container;
        const authDummy = document.createElement('div');
        authDummy.className = `ql-auth-widget ${AUTH_PREVIEW_CLASS}`;
        authDummy.style.cssText = `
            outline: 2px dashed #e74c3c; 
            outline-offset: 2px;
            cursor: pointer;
            pointer-events: auto;
        `;
        authDummy.innerHTML = `
            <div class="ql-auth-widget__guest">
                <button class="ql-auth-widget__btn-login">${_t('login') || 'Sign in'}</button>
                <button class="ql-auth-widget__btn-signup">${_t('signUp') || 'Sign up'}</button>
            </div>
        `;
        
        _injectBar(container, authDummy, _state.authDropPosition);
    }

    _state.activeTab = 'auth';
    
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'none';

    handleLog(`Auth selector reassigned to: ${newSelector}`, 'InteractionPlacer', 'info', '🎯');
}

function _updateAuthPosition() {
    if (!_state.authContainer) return;
    document.querySelectorAll(`.${AUTH_PREVIEW_CLASS}`).forEach(el => el.remove());
    _reassignAuth(_context.ConfModule.get('authWidget', {}).selector);
}

// ============================================================================
// UI FACTORIES & DOM BUILDERS
// ============================================================================

function _buildDeactivateFAB() {
    if (document.getElementById(FAB_ID)) return;
    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #e74c3c;
        color: #fff;
        border: none;
        border-radius: 24px;
        padding: 12px 20px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: -apple-system, sans-serif;
        font-weight: bold;
        font-size: 14px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(231,76,60,0.4);
        z-index: 9999999;
        transition: transform 0.2s, background 0.2s;
    `;
    fab.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${ICONS.power_off_svg}</svg>
        <span class="t">${_t('disableBtn')}</span>
    `;
    
    fab.onmouseover = () => fab.style.transform = 'scale(1.05)';
    fab.onmouseout = () => fab.style.transform = 'scale(1)';
    fab.onclick = () => window.QueloraPlacer.disable();
    
    document.body.appendChild(fab);
}

function _buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    const iconBtn = (iconName, extraClass, title) => {
        const d = document.createElement('div');
        d.className = `${PLUGIN_ID}-btn${extraClass ? ` ${extraClass}` : ''}`;
        d.title = title;
        d.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${ICONS[iconName]}</svg>`;
        return d;
    };

    const tuneBtn = iconBtn('tune',           `${PLUGIN_ID}-btn--tune`, _t('tune'));
    const dragBtn = iconBtn('drag_indicator', `${PLUGIN_ID}-btn--drag`, _t('drag'));

    tuneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _toggleStyleToolbar();
        tuneBtn.classList.toggle('active', _state.isToolbarOpen);
        
        if (_state.isToolbarOpen) {
            const targetTabId = _state.targetMode === 'auth' ? 'auth' : 'bar';
            const tabBtn = document.querySelector(`.${PLUGIN_ID}-tab-btn[data-tab-target="${targetTabId}"]`);
            if (tabBtn) tabBtn.click();
        }
    });

    dragBtn.addEventListener('pointerdown', _startDrag);

    panel.append(tuneBtn, dragBtn);
    document.body.appendChild(panel);
}

function _buildStyleToolbar() {
    if (document.getElementById(TOOLBAR_ID)) return;

    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;

    const iconBtn = (iconName, extraClass, title) => {
        const d = document.createElement('div');
        d.className = `${PLUGIN_ID}-btn${extraClass ? ` ${extraClass}` : ''}`;
        if (title) d.title = title;
        d.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${ICONS[iconName]}</svg>`;
        return d;
    };

    const toggleGroup = (labelKey, options, stateObj, stateKey, onchange) => {
        const g = document.createElement('div');
        g.className = `${PLUGIN_ID}-group`;

        const lbl = document.createElement('div');
        lbl.className = `${PLUGIN_ID}-group-label`;
        lbl.textContent = _t(labelKey);

        const row = document.createElement('div');
        row.className = `${PLUGIN_ID}-row`;

        options.forEach(({ icon, value, titleKey }) => {
            const b = iconBtn(icon, '', _t(titleKey));
            b.dataset.value = value;
            b.classList.toggle('active', stateObj[stateKey] === value);
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                stateObj[stateKey] = value;
                row.querySelectorAll(`.${PLUGIN_ID}-btn`).forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                onchange(value);
            });
            row.appendChild(b);
        });

        g.append(lbl, row);
        return g;
    };

    const slider = (labelKey, stateObj, stateKey, min, max, unit, onchange) => {
        const wrap = document.createElement('div');
        wrap.className = `${PLUGIN_ID}-slider-wrap`;

        const lbl = document.createElement('label');
        lbl.textContent = _t(labelKey);
        lbl.title = 'Double-click to reset';
        lbl.style.cursor = 'pointer';

        const inp = document.createElement('input');
        inp.type  = 'range';
        inp.min   = min;
        inp.max   = max;
        inp.step  = '1';
        inp.id    = `${PLUGIN_ID}-slider-${stateKey}`;
        inp.value = stateObj[stateKey] === '' ? 0 : stateObj[stateKey];

        const valSpan = document.createElement('span');
        valSpan.textContent = `${inp.value}${unit}`;

        const updateValue = (v) => {
            inp.value = v;
            stateObj[stateKey] = v;
            valSpan.textContent = `${v}${unit}`;
            onchange();
        };

        inp.addEventListener('input', (e) => {
            e.stopPropagation();
            let parsed = parseInt(inp.value, 10);
            
            if (parsed >= -2 && parsed <= 2) {
                parsed = 0;
            }
            
            if (stateObj[stateKey] !== parsed) {
                updateValue(parsed);
            }
        });

        lbl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            updateValue(0);
        });

        wrap.append(lbl, inp, valSpan);
        return wrap;
    };

    const sep = () => {
        const s = document.createElement('div');
        s.className = `${PLUGIN_ID}-toolbar-sep`;
        return s;
    };

    const sectionHeader = (labelKey, color) => {
        const h = document.createElement('div');
        h.className = `${PLUGIN_ID}-section-header`;
        h.style.borderLeftColor = color;
        h.textContent = _t(labelKey);
        return h;
    };

    const sectionRow = (...children) => {
        const row = document.createElement('div');
        row.className = `${PLUGIN_ID}-section-row`;
        children.forEach(c => row.appendChild(c));
        return row;
    };

    const displayToggle = (stateObj, flexControlsId, onchange) => {
        const g   = document.createElement('div');
        g.className = `${PLUGIN_ID}-group`;

        const row = document.createElement('div');
        row.className = `${PLUGIN_ID}-row`;

        [
            { value: '',      label: '—',     title: 'No rule' },
            { value: 'block', label: 'block', title: 'Block' },
            { value: 'flex',  label: 'flex',  title: 'Flex' }
        ].forEach(({ value, label, title }) => {
            const b = document.createElement('div');
            b.className = `${PLUGIN_ID}-btn ${PLUGIN_ID}-btn--pill`;
            b.textContent = label;
            b.title = title;
            b.classList.toggle('active', stateObj.display === value);
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                stateObj.display = value;
                row.querySelectorAll(`.${PLUGIN_ID}-btn--pill`).forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                const fc = document.getElementById(flexControlsId);
                if (fc) fc.style.display = value === 'flex' ? 'flex' : 'none';
                onchange(value);
            });
            row.appendChild(b);
        });

        g.append(row);
        return g;
    };

    const createFlexControls = (stateObj, id, onchange) => {
        const wrapper = document.createElement('div');
        wrapper.id = id;
        wrapper.className = `${PLUGIN_ID}-flex-controls-wrapper`;
        wrapper.style.display = stateObj.display === 'flex' ? 'flex' : 'none';

        const togglesCol = document.createElement('div');
        togglesCol.className = `${PLUGIN_ID}-toggles-col`;

        togglesCol.appendChild(sectionRow(
            toggleGroup('direction', [
                { icon: 'arrow_right_alt', value: 'row',    titleKey: 'row' },
                { icon: 'arrow_downward',  value: 'column', titleKey: 'column' }
            ], stateObj, 'flexDirection', onchange),

            sep(),

            toggleGroup('justify', [
                { icon: 'format_align_left',   value: 'flex-start',    titleKey: 'start' },
                { icon: 'format_align_center', value: 'center',        titleKey: 'center' },
                { icon: 'format_align_right',  value: 'flex-end',      titleKey: 'end' },
                { icon: 'space_between',       value: 'space-between', titleKey: 'spaceBetween' },
                { icon: 'space_around',        value: 'space-around',  titleKey: 'spaceAround' },
                { icon: 'space_evenly',        value: 'space-evenly',  titleKey: 'spaceEvenly' }
            ], stateObj, 'justifyContent', onchange),

            sep(),

            toggleGroup('align', [
                { icon: 'vertical_align_top',    value: 'flex-start', titleKey: 'start' },
                { icon: 'vertical_align_center', value: 'center',     titleKey: 'center' },
                { icon: 'vertical_align_bottom', value: 'flex-end',   titleKey: 'end' },
                { icon: 'height',                value: 'stretch',    titleKey: 'stretch' },
                { icon: 'baseline',              value: 'baseline',   titleKey: 'baseline' }
            ], stateObj, 'alignItems', onchange)
        ));

        const spacingGrid = document.createElement('div');
        spacingGrid.className = `${PLUGIN_ID}-spacing-grid`;
        
        const lbl = document.createElement('div');
        lbl.className = `${PLUGIN_ID}-group-label`;
        lbl.textContent = _t('spacing') + ' (Padding)';
        lbl.style.gridColumn = '1 / -1';
        spacingGrid.appendChild(lbl);

        spacingGrid.appendChild(slider('gap', stateObj, 'gap', 0, 40, 'px', onchange));
        spacingGrid.appendChild(slider('pt',  stateObj, 'paddingTop', 0, 40, 'px', onchange));
        spacingGrid.appendChild(slider('pr',  stateObj, 'paddingRight', 0, 40, 'px', onchange));
        spacingGrid.appendChild(slider('pb',  stateObj, 'paddingBottom', 0, 40, 'px', onchange));
        spacingGrid.appendChild(slider('pl',  stateObj, 'paddingLeft', 0, 40, 'px', onchange));

        wrapper.append(togglesCol, sep(), spacingGrid);
        return wrapper;
    };

    const rebuild = () => { 
        document.querySelectorAll(`.${BAR_CLASS}`).forEach(bar => {
            if (_state.bar.layout === 'vertical') {
                bar.classList.add(VERTICAL_CLASS);
            } else {
                bar.classList.remove(VERTICAL_CLASS);
            }
        });
        _compileCSS(); 
        _showFeedback(); 
    };

    // ── Tab Navigation ────────────────────────────────────────────────────────
    const tabNav = document.createElement('div');
    tabNav.className = `${PLUGIN_ID}-tabs`;

    const tabs = [
        { id: 'bar',       labelKey: 'sectionBar' },
        { id: 'container', labelKey: 'sectionContainer' },
        { id: 'entity',    labelKey: 'sectionEntity' },
        { id: 'auth',      labelKey: 'sectionAuth' }
    ];

    tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.className = `${PLUGIN_ID}-tab-btn`;
        btn.textContent = _t(tab.labelKey);
        btn.dataset.tabTarget = tab.id;
        if (_state.activeTab === tab.id) btn.classList.add('is-active');

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            _state.activeTab = tab.id;
            
            tabNav.querySelectorAll(`.${PLUGIN_ID}-tab-btn`).forEach(b => b.classList.remove('is-active'));
            btn.classList.add('is-active');

            toolbar.querySelectorAll(`.${PLUGIN_ID}-tab-content`).forEach(content => {
                content.classList.toggle('is-active', content.id === `${PLUGIN_ID}-tab-${tab.id}`);
            });

            _showFeedback();
        });

        tabNav.appendChild(btn);
    });

    toolbar.appendChild(tabNav);

    // ── Body Context ──────────────────────────────────────────────────────────
    const body = document.createElement('div');
    body.className = `${PLUGIN_ID}-toolbar-body`;

    // TAB 1: Bar
    const barTab = document.createElement('div');
    barTab.id = `${PLUGIN_ID}-tab-bar`;
    barTab.className = `${PLUGIN_ID}-tab-content ${PLUGIN_ID}-tab-content--bar`;
    if (_state.activeTab === 'bar') barTab.classList.add('is-active');

    const injectHeaderRow = document.createElement('div');
    injectHeaderRow.className = `${PLUGIN_ID}-header-inline-row`;
    injectHeaderRow.appendChild(sectionHeader('injectPos', '#9b59b6'));
    barTab.appendChild(injectHeaderRow);

    const posWrapper = document.createElement('div');
    posWrapper.className = `${PLUGIN_ID}-flex-controls-wrapper`;
    posWrapper.style.marginBottom = '12px';
    
    const posGroup = document.createElement('div');
    posGroup.className = `${PLUGIN_ID}-group`;
    const posRow = document.createElement('div');
    posRow.className = `${PLUGIN_ID}-row`;

    ['inside', 'before', 'after', 'replace'].forEach(pos => {
        const b = document.createElement('div');
        b.className = `${PLUGIN_ID}-btn ${PLUGIN_ID}-btn--pos-pill`;
        b.textContent = _t(`placer_pos_${pos}`);
        b.title = _t(`placer_pos_${pos}`);
        b.classList.toggle('active', _state.dropPosition === pos);
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            _state.dropPosition = pos;
            posRow.querySelectorAll(`.${PLUGIN_ID}-btn--pos-pill`).forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            if (_state.dropTarget && _state.targetBar) {
                _injectBar(_state.dropTarget, _state.targetBar, _state.dropPosition);
                rebuild();
            }
        });
        posRow.appendChild(b);
    });

    posGroup.appendChild(posRow);
    posWrapper.appendChild(posGroup);
    barTab.appendChild(posWrapper);

    barTab.appendChild(sectionHeader('sectionBar', '#27ae60'));

    const barWrapper = document.createElement('div');
    barWrapper.className = `${PLUGIN_ID}-flex-controls-wrapper`;
    
    const barTogglesCol = document.createElement('div');
    barTogglesCol.className = `${PLUGIN_ID}-toggles-col`;

    const marginGroup = document.createElement('div');
    marginGroup.className = `${PLUGIN_ID}-group`;
    const marginLabel = document.createElement('div');
    marginLabel.className = `${PLUGIN_ID}-group-label`;
    marginLabel.textContent = _t('barMargin') + ' (Auto Push)';
    const marginRow = document.createElement('div');
    marginRow.className = `${PLUGIN_ID}-row`;

    [
        { key: 'marginTopAuto', label: 'MT Auto', titleKey: 'mtAuto' },
        { key: 'marginBottomAuto', label: 'MB Auto', titleKey: 'mbAuto' },
        { key: 'marginLeftAuto', label: 'ML Auto', titleKey: 'mlAuto' },
        { key: 'marginRightAuto', label: 'MR Auto', titleKey: 'mrAuto' }
    ].forEach(({ key, label, titleKey }) => {
        const b = document.createElement('div');
        b.className = `${PLUGIN_ID}-btn ${PLUGIN_ID}-btn--pill`;
        b.textContent = label;
        b.title = _t(titleKey);
        b.classList.toggle('active', _state.bar[key]);
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            _state.bar[key] = !_state.bar[key]; // Toggle
            b.classList.toggle('active', _state.bar[key]);
            
            if (_state.bar[key]) {
                const propMap = { 
                    marginTopAuto: 'marginTop', 
                    marginBottomAuto: 'marginBottom', 
                    marginLeftAuto: 'marginLeft', 
                    marginRightAuto: 'marginRight'
                };
                const marginProp = propMap[key];
                _state.bar[marginProp] = '';
                const sld = document.getElementById(`${PLUGIN_ID}-slider-${marginProp}`);
                if (sld) {
                    sld.value = 0;
                    sld.nextElementSibling.textContent = '0px';
                }
            }
            rebuild();
        });
        marginRow.appendChild(b);
    });
    marginGroup.append(marginLabel, marginRow);

    barTogglesCol.appendChild(sectionRow(
        toggleGroup('layout', [
            { icon: 'arrow_right_alt', value: 'horizontal', titleKey: 'horizontal' },
            { icon: 'arrow_downward',  value: 'vertical',   titleKey: 'vertical' }
        ], _state.bar, 'layout', rebuild),
        sep(),
        toggleGroup('alignSelf', [
            { icon: 'vertical_align_top',    value: 'auto',       titleKey: 'selfAuto' },
            { icon: 'vertical_align_top',    value: 'flex-start', titleKey: 'selfStart' },
            { icon: 'vertical_align_center', value: 'center',     titleKey: 'selfCenter' },
            { icon: 'vertical_align_bottom', value: 'flex-end',   titleKey: 'selfEnd' },
            { icon: 'height',                value: 'stretch',    titleKey: 'selfStretch' }
        ], _state.bar, 'alignSelf', rebuild),
        sep(), marginGroup, sep(),
        toggleGroup('width', [
            { icon: 'width_fit',  value: 'fit-content', titleKey: 'fitContent' },
            { icon: 'width_full', value: '100%',        titleKey: 'fullWidth' }
        ], _state.bar, 'width', rebuild)
    ));

    const barSpacingGrid = document.createElement('div');
    barSpacingGrid.className = `${PLUGIN_ID}-spacing-grid`;
    
    const barSpacingLbl = document.createElement('div');
    barSpacingLbl.className = `${PLUGIN_ID}-group-label`;
    barSpacingLbl.textContent = _t('spacing') + ' (Margin Px)';
    barSpacingLbl.style.gridColumn = '1 / -1';
    barSpacingGrid.appendChild(barSpacingLbl);

    const mtWrap = slider('MT', _state.bar, 'marginTop', -60, 60, 'px', () => { if(_state.bar.marginTopAuto) { _state.bar.marginTopAuto = false; marginRow.children[0].classList.remove('active'); } rebuild(); });
    const mrWrap = slider('MR', _state.bar, 'marginRight', -60, 60, 'px', () => { if(_state.bar.marginRightAuto) { _state.bar.marginRightAuto = false; marginRow.children[3].classList.remove('active'); } rebuild(); });
    const mbWrap = slider('MB', _state.bar, 'marginBottom', -60, 60, 'px', () => { if(_state.bar.marginBottomAuto) { _state.bar.marginBottomAuto = false; marginRow.children[1].classList.remove('active'); } rebuild(); });
    const mlWrap = slider('ML', _state.bar, 'marginLeft', -60, 60, 'px', () => { if(_state.bar.marginLeftAuto) { _state.bar.marginLeftAuto = false; marginRow.children[2].classList.remove('active'); } rebuild(); });

    barSpacingGrid.appendChild(mtWrap);
    barSpacingGrid.appendChild(mrWrap);
    barSpacingGrid.appendChild(mbWrap);
    barSpacingGrid.appendChild(mlWrap);

    barWrapper.append(barTogglesCol, sep(), barSpacingGrid);
    barTab.appendChild(barWrapper);
    body.appendChild(barTab);

    // TAB 2: Container
    const containerTab = document.createElement('div');
    containerTab.id = `${PLUGIN_ID}-tab-container`;
    containerTab.className = `${PLUGIN_ID}-tab-content ${PLUGIN_ID}-tab-content--container`;
    if (_state.activeTab === 'container') containerTab.classList.add('is-active');

    const CONTAINER_FLEX_ID = `${PLUGIN_ID}-container-flex`;
    const containerHeaderRow = document.createElement('div');
    containerHeaderRow.className = `${PLUGIN_ID}-header-inline-row`;
    containerHeaderRow.append(
        sectionHeader('sectionContainer', '#3897f0'),
        displayToggle(_state.container, CONTAINER_FLEX_ID, rebuild)
    );
    containerTab.appendChild(containerHeaderRow);
    containerTab.appendChild(createFlexControls(_state.container, CONTAINER_FLEX_ID, rebuild));
    body.appendChild(containerTab);

    // TAB 3: Entity
    const entityTab = document.createElement('div');
    entityTab.id = `${PLUGIN_ID}-tab-entity`;
    entityTab.className = `${PLUGIN_ID}-tab-content ${PLUGIN_ID}-tab-content--entity`;
    if (_state.activeTab === 'entity') entityTab.classList.add('is-active');

    const ENTITY_FLEX_ID = `${PLUGIN_ID}-entity-flex`;
    const entityHeaderRow = document.createElement('div');
    entityHeaderRow.className = `${PLUGIN_ID}-header-inline-row`;
    entityHeaderRow.append(
        sectionHeader('sectionEntity', '#f39c12'),
        displayToggle(_state.entity, ENTITY_FLEX_ID, rebuild)
    );
    entityTab.appendChild(entityHeaderRow);
    entityTab.appendChild(createFlexControls(_state.entity, ENTITY_FLEX_ID, rebuild));
    
    const reassignRow = document.createElement('div');
    reassignRow.className = `${PLUGIN_ID}-section-row`;
    reassignRow.style.marginTop = '16px';
    
    const reassignBtn = document.createElement('button');
    reassignBtn.className = `${PLUGIN_ID}-export-btn`; 
    reassignBtn.style.backgroundColor = '#e67e22'; 
    reassignBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">${ICONS.my_location}</svg>
        <span class="t">${_t('pickEntity')}</span>
    `;
    reassignBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _startEntityPicker('interactions');
    });
    
    reassignRow.appendChild(reassignBtn);
    entityTab.appendChild(reassignRow);

    body.appendChild(entityTab);

    // TAB 4: Auth
    const authTab = document.createElement('div');
    authTab.id = `${PLUGIN_ID}-tab-auth`;
    authTab.className = `${PLUGIN_ID}-tab-content ${PLUGIN_ID}-tab-content--auth`;
    if (_state.activeTab === 'auth') authTab.classList.add('is-active');

    const authHeaderRow = document.createElement('div');
    authHeaderRow.className = `${PLUGIN_ID}-header-inline-row`;
    authHeaderRow.appendChild(sectionHeader('sectionAuth', '#e74c3c'));
    authTab.appendChild(authHeaderRow);

    const authPosWrapper = document.createElement('div');
    authPosWrapper.className = `${PLUGIN_ID}-flex-controls-wrapper`;
    authPosWrapper.style.marginBottom = '12px';
    
    const authPosGroup = document.createElement('div');
    authPosGroup.className = `${PLUGIN_ID}-group`;
    const authPosRow = document.createElement('div');
    authPosRow.className = `${PLUGIN_ID}-row`;

    ['inside', 'before', 'after', 'replace'].forEach(pos => {
        const b = document.createElement('div');
        b.className = `${PLUGIN_ID}-btn ${PLUGIN_ID}-btn--pos-pill`;
        b.textContent = _t(`placer_pos_${pos}`);
        b.title = _t(`placer_pos_${pos}`);
        b.classList.toggle('active', _state.authDropPosition === pos);
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            _state.authDropPosition = pos;
            authPosRow.querySelectorAll(`.${PLUGIN_ID}-btn--pos-pill`).forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            _updateAuthPosition();
        });
        authPosRow.appendChild(b);
    });

    authPosGroup.appendChild(authPosRow);
    authPosWrapper.appendChild(authPosGroup);
    authTab.appendChild(authPosWrapper);

    const reassignAuthRow = document.createElement('div');
    reassignAuthRow.className = `${PLUGIN_ID}-section-row`;
    reassignAuthRow.style.marginTop = '16px';
    
    const reassignAuthBtn = document.createElement('button');
    reassignAuthBtn.className = `${PLUGIN_ID}-export-btn`; 
    reassignAuthBtn.style.backgroundColor = '#e74c3c'; 
    reassignAuthBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">${ICONS.security}</svg>
        <span class="t">${_t('pickAuth')}</span>
    `;
    reassignAuthBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _startEntityPicker('auth');
    });
    
    reassignAuthRow.appendChild(reassignAuthBtn);
    authTab.appendChild(reassignAuthRow);

    body.appendChild(authTab);

    toolbar.appendChild(body);

    // ── Footer strip ──────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    footer.className = `${PLUGIN_ID}-toolbar-footer`;

    const actionsGroup = document.createElement('div');
    actionsGroup.style.display = 'flex';
    actionsGroup.style.gap = '12px';
    actionsGroup.style.alignItems = 'center';

    const exportBtn = document.createElement('button');
    exportBtn.className = `${PLUGIN_ID}-export-btn`;
    exportBtn.title = _t('exportTitle');
    exportBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">${ICONS.code}</svg>
        <span class="t">${_t('exportLabel')}</span>
    `;
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _showExportModal();
    });

    const applyBtn = document.createElement('button');
    applyBtn.className = `${PLUGIN_ID}-apply-btn`;
    applyBtn.title = _t('applyAll');
    applyBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor">${ICONS.science}</svg>
        <span class="t">${_t('applyAllLabel')}</span>
    `;
    applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _applyToAll();
    });

    actionsGroup.append(exportBtn, applyBtn);
    footer.appendChild(actionsGroup);
    toolbar.appendChild(footer);

    const closeBtn = document.createElement('div');
    closeBtn.className = `${PLUGIN_ID}-btn ${PLUGIN_ID}-btn--close`;
    closeBtn.title = _t('close');
    closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${ICONS.close}</svg>`;
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _closeStyleToolbar();
    });
    toolbar.appendChild(closeBtn);

    document.body.appendChild(toolbar);
}

// ============================================================================
// EXPORT MODAL MODULE
// ============================================================================

function _showExportModal() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;

    let modal = document.getElementById(`${PLUGIN_ID}-export-modal`);
    
    const cfg = _getEntityConfig();
    const authCfg = _context.ConfModule.get('authWidget', {});
    
    const configToExport = {
        entityConfig: {
            selector: cfg.selector,
            interactionPlacement: {
                position: _state.dropPosition,
                relativeTo: _state.relativePath || cfg.interaction.relativeTo,
                deterministic: cfg.interaction.deterministic
            }
        }
    };

    if (authCfg.enabled) {
        configToExport.authWidget = {
            enabled: true,
            selector: authCfg.selector,
            position: authCfg.position || _state.authDropPosition || 'inside'
        };
    }

    const jsonStr = JSON.stringify(configToExport, null, 4);
    const cssStr = _getCurrentCSS();

    if (!modal) {
        modal = document.createElement('div');
        modal.id = `${PLUGIN_ID}-export-modal`;
        modal.className = `${PLUGIN_ID}-export-overlay`;
        
        const header = document.createElement('div');
        header.className = `${PLUGIN_ID}-export-header`;
        
        const title = document.createElement('span');
        title.textContent = _t('exportTitle');
        title.className = `${PLUGIN_ID}-export-title t`;
        
        const closeBtn = document.createElement('div');
        closeBtn.className = `${PLUGIN_ID}-btn`;
        closeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${ICONS.close}</svg>`;
        closeBtn.addEventListener('click', () => modal.style.display = 'none');
        
        header.append(title, closeBtn);

        const bodyWrap = document.createElement('div');
        bodyWrap.className = `${PLUGIN_ID}-export-body`;

        const jsonBlock = _createExportBlock(_t('exportJson'), jsonStr, 'json');
        const cssBlock = _createExportBlock(_t('exportCss'), cssStr, 'css');

        bodyWrap.append(jsonBlock, cssBlock);
        modal.append(header, bodyWrap);
        toolbar.appendChild(modal);
    } else {
        modal.querySelector(`textarea[data-type="json"]`).value = jsonStr;
        modal.querySelector(`textarea[data-type="css"]`).value = cssStr;
        modal.style.display = 'flex';
    }
}

function _createExportBlock(label, content, type) {
    const wrap = document.createElement('div');
    wrap.className = `${PLUGIN_ID}-export-block`;

    const top = document.createElement('div');
    top.className = `${PLUGIN_ID}-export-block-top`;
    
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.className = 't';

    const copyBtn = document.createElement('button');
    copyBtn.className = `${PLUGIN_ID}-copy-btn`;
    copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">${ICONS.content_copy}</svg> <span class="t">${_t('copyBtn')}</span>`;
    
    top.append(lbl, copyBtn);

    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.value = content;
    textarea.dataset.type = type;

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(textarea.value).then(() => {
            const origHTML = copyBtn.innerHTML;
            copyBtn.innerHTML = `<span class="t">${_t('copiedBtn')}</span>`;
            copyBtn.classList.add('is-copied');
            setTimeout(() => {
                copyBtn.innerHTML = origHTML;
                copyBtn.classList.remove('is-copied');
            }, 2000);
        });
    });

    wrap.append(top, textarea);
    return wrap;
}

// ============================================================================
// VISIBILITY & TRACKING
// ============================================================================

function _toggleStyleToolbar() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    _state.isToolbarOpen = !_state.isToolbarOpen;
    toolbar.classList.toggle('is-open', _state.isToolbarOpen);
    const tuneBtn = document.querySelector(`#${PANEL_ID} .${PLUGIN_ID}-btn--tune`);
    if (tuneBtn) tuneBtn.classList.toggle('active', _state.isToolbarOpen);
}

function _closeStyleToolbar() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    _state.isToolbarOpen = false;
    toolbar.classList.remove('is-open');
    const tuneBtn = document.querySelector(`#${PANEL_ID} .${PLUGIN_ID}-btn--tune`);
    if (tuneBtn) tuneBtn.classList.remove('active');
    
    const modal = document.getElementById(`${PLUGIN_ID}-export-modal`);
    if (modal) modal.style.display = 'none';
}

function _updatePanelPos() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !_state.targetBar || _state.isDragging || _state.isPickingEntity) return;

    const dragBtn = panel.querySelector(`.${PLUGIN_ID}-btn--drag`);
    if (dragBtn) {
        dragBtn.style.display = _state.targetMode === 'auth' ? 'none' : 'flex';
    }

    const rect = _state.targetBar.getBoundingClientRect();
    const ph   = panel.offsetHeight || 42;
    const pw   = panel.offsetWidth  || 120;

    panel.style.display = 'flex';
    
    let topPos = rect.top - ph - 6;
    if (topPos < 10) {
        topPos = rect.bottom + 6;
    }

    panel.style.top     = `${Math.max(4, topPos)}px`;
    panel.style.left    = `${Math.max(4, Math.min(rect.right - pw, window.innerWidth - pw - 4))}px`;
}

function _setupTracking() {
    document.addEventListener('mouseover', (e) => {
        if (_state.isDragging || _state.isToolbarOpen || _state.isPickingEntity) return;
        
        const bar = e.target.closest(BAR_SEL);
        const auth = e.target.closest(AUTH_WIDGET_SEL);
        
        if (bar) {
            const cfg = _getEntityConfig();
            const entity = bar.closest(cfg.selector);
            if (!entity) return;

            _state.targetMode   = 'interactions';
            _state.targetBar    = bar;
            _state.targetEntity = entity;

            if (_state.bar.layout === 'vertical') {
                _state.targetBar.classList.add(VERTICAL_CLASS);
            } else {
                _state.targetBar.classList.remove(VERTICAL_CLASS);
            }

            _updatePanelPos();
        } else if (auth) {
            _state.targetMode   = 'auth';
            _state.targetBar    = auth;
            _state.targetEntity = auth.parentElement;
            
            _updatePanelPos();
        }
    });

    window.addEventListener('scroll', _updatePanelPos, { passive: true });
    window.addEventListener('resize', _updatePanelPos, { passive: true });
}

// ============================================================================
// DRAG ENGINE
// ============================================================================

function _startDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!_state.targetBar || !_state.targetEntity) return;

    const handle = /** @type {Element} */ (e.currentTarget);
    handle.setPointerCapture(e.pointerId);

    _state.isDragging = true;
    document.body.classList.add(`${PLUGIN_ID}-dragging`);

    const allDescendants = Array.from(_state.targetEntity.querySelectorAll('*'));
    _state.dropZones = allDescendants.filter(el => {
        return el !== _state.targetBar && 
               !_state.targetBar.contains(el) && 
               el.tagName !== 'SCRIPT' && 
               el.tagName !== 'STYLE' && 
               el.tagName !== 'IMG' && 
               el.tagName !== 'SVG';
    });
    _state.dropZones.forEach(el => el.classList.add(`${PLUGIN_ID}-drop-zone`));

    const barRect = _state.targetBar.getBoundingClientRect();

    const clone = _state.targetBar.cloneNode(true);
    /** @type {HTMLElement} */ (clone).className += ` ${PLUGIN_ID}-drag-clone`;
    /** @type {HTMLElement} */ (clone).style.cssText = [
        `width:${barRect.width}px`,
        `height:${barRect.height}px`,
        `top:${barRect.top}px`,
        `left:${barRect.left}px`,
        `position:fixed`,
        `pointer-events:none`
    ].join(';');
    document.body.appendChild(clone);

    const badge = document.createElement('div');
    badge.className = `${PLUGIN_ID}-pos-badge`;
    badge.textContent = _state.dropPosition;
    badge.style.display = 'none';
    document.body.appendChild(badge);

    const startX = e.clientX;
    const startY = e.clientY;
    let   currentHot = null;

    const onMove = (me) => {
        /** @type {HTMLElement} */ (clone).style.transform = `translate(${me.clientX - startX}px,${me.clientY - startY}px)`;
        const under = document.elementFromPoint(me.clientX, me.clientY);
        const candidate = under ? _deepestEntityChild(under, _state.targetEntity, _state.targetBar) : null;

        if (candidate !== currentHot) {
            if (currentHot) currentHot.classList.remove(`${PLUGIN_ID}-candidate-hot`);
            currentHot = candidate;
            if (currentHot) currentHot.classList.add(`${PLUGIN_ID}-candidate-hot`);
        }

        if (currentHot) {
            const cr = currentHot.getBoundingClientRect();
            badge.style.top     = `${cr.top - 22}px`;
            badge.style.left    = `${cr.left}px`;
            badge.style.display = 'block';
        } else {
            badge.style.display = 'none';
        }
    };

    const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup',   onUp);
        handle.releasePointerCapture(e.pointerId);

        clone.remove();
        badge.remove();
        document.body.classList.remove(`${PLUGIN_ID}-dragging`);
        _state.isDragging = false;

        if (_state.dropZones) {
            _state.dropZones.forEach(el => el.classList.remove(`${PLUGIN_ID}-drop-zone`));
            _state.dropZones = [];
        }

        if (currentHot) currentHot.classList.remove(`${PLUGIN_ID}-candidate-hot`);

        if (currentHot && currentHot !== _state.targetBar) {
            _state.dropTarget   = currentHot;
            _state.relativePath = _buildRelativePath(currentHot, _state.targetEntity);

            _injectBar(_state.dropTarget, _state.targetBar, _state.dropPosition);

            const dragBtn = document.querySelector(`#${PANEL_ID} .${PLUGIN_ID}-btn--drag`);
            if (dragBtn) dragBtn.classList.add('is-set');

            _compileCSS();
        }

        _updatePanelPos();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup',   onUp);
}

function _deepestEntityChild(el, entity, excluded) {
    if (!el || !entity.contains(el)) return null;
    if (el === entity)               return null;
    if (el === excluded || excluded.contains(el)) return null;
    return el;
}

// ============================================================================
// APPLY TO ALL
// ============================================================================

function _applyToAll() {
    if (!_state.relativePath && !_state.dropTarget) {
        console.warn('%c⚠️  PLACER: drag to a target element first, then apply.', 'color:#e74c3c;');
        return;
    }

    const cfg = _getEntityConfig();
    
    const anyExistingBar = document.querySelector(BAR_SEL);
    const fallbackBarHTML = anyExistingBar ? anyExistingBar.innerHTML : '';

    document.querySelectorAll(`.${PLUGIN_ID}-test-bar`).forEach(el => el.remove());

    const entities = Array.from(document.querySelectorAll(cfg.selector));
    let   applied  = 0;

    entities.forEach(entity => {
        const container = _state.relativePath ? entity.querySelector(_state.relativePath) : entity;
        if (!container) return;

        const originalBar = entity.querySelector(BAR_SEL);
        let barContent = fallbackBarHTML;
        
        if (originalBar) {
            barContent = originalBar.innerHTML;
            originalBar.remove(); 
        }

        const previewBar = document.createElement('div');
        previewBar.className = `${BAR_CLASS} ${PLUGIN_ID}-test-bar`;
        
        if (_state.bar.layout === 'vertical') {
            previewBar.classList.add(VERTICAL_CLASS);
        }

        previewBar.innerHTML = barContent;
        previewBar.style.outline       = '2px dashed #27ae60';
        previewBar.style.outlineOffset = '2px';

        _injectBar(container, previewBar, _state.dropPosition);
        applied++;
    });

    _state.testApplied = true;
}

// ============================================================================
// REGISTRY
// ============================================================================

async function _bootUI() {
    if (_state.isBooted) return;
    _state.isBooted = true;
    
    const pickerStyleId = `${PLUGIN_ID}-picker-styles`;
    if (!document.getElementById(pickerStyleId)) {
        const s = document.createElement('style');
        s.id = pickerStyleId;
        s.textContent = `
            .${PLUGIN_ID}-picker-hover {
                outline: 3px dashed #e74c3c !important;
                outline-offset: -3px !important;
                background-color: rgba(231, 76, 60, 0.15) !important;
                cursor: crosshair !important;
            }
            .${PLUGIN_ID}-picker-badge {
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: #111;
                border: 1px solid #e74c3c;
                color: #fff;
                padding: 10px 16px;
                border-radius: 8px;
                font-family: monospace;
                font-size: 13px;
                z-index: 9999999;
                box-shadow: 0 8px 24px rgba(0,0,0,0.7);
                pointer-events: none;
                text-align: center;
                line-height: 1.4;
                max-width: 90vw;
            }
            .${PLUGIN_ID}-mouse-icon {
                width: 14px;
                height: 22px;
                border: 2px solid #aaa;
                border-radius: 8px;
                position: relative;
                display: inline-block;
                margin-right: 6px;
                box-sizing: border-box;
            }
            .${PLUGIN_ID}-mouse-wheel {
                width: 2px;
                height: 4px;
                background: #aaa;
                border-radius: 2px;
                position: absolute;
                top: 3px;
                left: 4px;
                animation: ql-scroll-wheel 1.5s infinite;
            }
            @keyframes ql-scroll-wheel {
                0% { transform: translateY(0); opacity: 1; }
                50% { transform: translateY(4px); opacity: 0; }
                51% { transform: translateY(-4px); opacity: 0; }
                100% { transform: translateY(0); opacity: 1; }
            }
        `;
        document.head.appendChild(s);
    }

    await I18n.loadModuleTranslations('placer');
    IconModule.register(ICONS);
    _buildPanel();
    _buildStyleToolbar();
    _buildDeactivateFAB();
    _setupTracking();
    
    const interactions = document.querySelectorAll(`.${BAR_CLASS}`);
    if (interactions.length === 0) {
        handleLog('No interaction bars found. Auto-opening Entity tab.', 'InteractionPlacer', 'info');
        _state.isToolbarOpen = true;
        const toolbar = document.getElementById(TOOLBAR_ID);
        if (toolbar) toolbar.classList.add('is-open');
        
        const tuneBtn = document.querySelector(`#${PANEL_ID} .${PLUGIN_ID}-btn--tune`);
        if (tuneBtn) tuneBtn.classList.add('active');

        setTimeout(() => {
            const entityTabBtn = document.querySelector(`.${PLUGIN_ID}-tab-btn[data-tab-target="entity"]`);
            if (entityTabBtn) entityTabBtn.click();
        }, 100);
    }

    handleLog('Interaction Placer UI ready.', 'InteractionPlacer', 'info', '🎯');
}

export async function register(context) {
    _context = context;

    window.QueloraPlacer = {
        disable: () => {
            StorageModule.removeLocalItem('ql_placer_active');
            ToastModule.info(ICONS.power_off_svg, _t('deactivated'), _t('deactivatedDesc'), null, 3000);
            setTimeout(() => location.reload(), 1500);
        }
    };

    if (StorageModule.getLocalItem('ql_placer_active') === '1') {
        await _bootUI();
    } else {
        handleLog('Interaction Placer is latent. Press Alt+Shift+Q to activate.', 'InteractionPlacer', 'info');
    }

    document.addEventListener('keydown', async (e) => {
        if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'q') {
            e.preventDefault();
            if (StorageModule.getLocalItem('ql_placer_active') === '1') {
                window.QueloraPlacer.disable();
            } else {
                StorageModule.setLocalItem('ql_placer_active', '1', TTL_MS);
                
                // ESPERAR primero a que _bootUI() resuelva las dependencias e hidrate el I18n
                await _bootUI(); 
                
                // LUEGO renderizar el toast, con la garantía de que `_t` tiene acceso al JSON
                ToastModule.success(ICONS.power_svg, _t('activated'), _t('activatedDesc'), null, 3000);
            }
        }
    });
}