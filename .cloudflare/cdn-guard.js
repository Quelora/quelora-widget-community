/*
 * Quelora — quelora-widget-community
 * Copyright (C) 2026 Germán Zelaya — https://quelora.org
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * This file is part of Quelora. See the LICENSE file for terms.
 */

/**
 * @file cdn-guard.js
 * @description Cloudflare Worker — CDN access control for Quelora widget.
 *
 * Responsibilities:
 * - Serves all widget files from the bound R2 bucket (CDN_BUCKET).
 * - Protects /v*/enterprise/* paths: only allows requests whose Origin
 *   is registered in the ALLOWED_DOMAINS KV namespace.
 * - Adds correct Cache-Control and CORS headers.
 *
 * Bindings required in wrangler.toml:
 *   CDN_BUCKET      — R2 bucket
 *   ALLOWED_DOMAINS — KV namespace  (key: hostname, value: any truthy string)
 */

const ENTERPRISE_PATTERN = /^\/v[\d.]+\/enterprise\//;

export default {
    /**
     * @param {Request} request
     * @param {{ CDN_BUCKET: R2Bucket, ALLOWED_DOMAINS: KVNamespace }} env
     * @returns {Promise<Response>}
     */
    async fetch(request, env) {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }

        const url      = new URL(request.url);
        const pathname = url.pathname;

        // Validate access for enterprise paths
        if (ENTERPRISE_PATTERN.test(pathname)) {
            const originHeader = request.headers.get('Origin') || request.headers.get('Referer');

            if (!originHeader) {
                return new Response('Unauthorized', { status: 401 });
            }

            let hostname;
            try {
                hostname = new URL(originHeader).hostname;
            } catch {
                return new Response('Bad Request', { status: 400 });
            }

            const isAllowed = await env.ALLOWED_DOMAINS.get(hostname);
            if (!isAllowed) {
                return new Response('Forbidden', { status: 403 });
            }
        }

        // Strip leading slash to form the R2 key
        const key = pathname.slice(1);
        if (!key) {
            return new Response('Not Found', { status: 404 });
        }

        const object = await env.CDN_BUCKET.get(key);
        if (!object) {
            return new Response('Not Found', { status: 404 });
        }

        const isEnterprise = ENTERPRISE_PATTERN.test(pathname);

        return new Response(object.body, {
            status: 200,
            headers: {
                'Content-Type':  object.httpMetadata?.contentType ?? 'application/octet-stream',
                'Cache-Control': isEnterprise
                    ? 'private, max-age=3600'
                    : 'public, max-age=31536000, immutable',
                ...corsHeaders(request),
            },
        });
    },
};

/**
 * Builds CORS response headers.
 * Public files allow any origin; enterprise files echo the request origin.
 * @param {Request} request
 * @returns {Record<string, string>}
 */
function corsHeaders(request) {
    const origin = request.headers.get('Origin') ?? '*';
    return {
        'Access-Control-Allow-Origin':  origin,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
    };
}
