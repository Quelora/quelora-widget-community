/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/* filepath: js/modules/anchorModule.js */
/**
 * Module for generating anchor links based on provided data.
 * @module AnchorModule
 */

/**
 * Generates a formatted link based on the input data type and IDs.
 * @param {Object} data - Data containing type and IDs for link generation.
 * @param {string} data.type - Type of link ('mention', 'follower', 'reply', 'comment', 'like', 'entity').
 * @param {Object} data.ids - Object containing relevant IDs.
 * @param {string} [data.ids.entity] - Entity ID for comments, replies, or likes.
 * @param {string} [data.ids.commentId] - Comment ID for comments, replies, or likes.
 * @param {string} [data.ids.replyId] - Reply ID for replies or likes.
 * @param {string} [data.ids.follow] - Follow ID for follower links.
 * @param {string} [data.ids.mention] - Mention ID for mention links.
 * @returns {string} Formatted link or '#' if invalid data.
 */
function generateLink(data) {
  const { entity, commentId, replyId, follow, mention } = data.ids;

  switch (data.type) {
    case 'mention':
      return mention ? `#QUELORA-R-${mention}` : '#';
    case 'follower':
      return follow ? `#QUELORA-U-${follow}` : '#';
    case 'reply':
      return entity && commentId && replyId
        ? `#QUELORA-Q-${entity}-${commentId}-${replyId}`
        : '#';
    case 'comment':
      return entity && commentId ? `#QUELORA-Q-${entity}-${commentId}` : '#';
    case 'like':
      if (!entity) return '#';
      if (commentId && replyId) return `#QUELORA-L-${entity}-${commentId}-${replyId}`;
      if (commentId) return `#QUELORA-L-${entity}-${commentId}`;
      return `#QUELORA-E-${entity}`;
    case 'entity':
      return entity ? `#QUELORA-E-${entity}` : '#';
    default:
      return '#';
  }
}

const AnchorModule = { generateLink };

export default AnchorModule;