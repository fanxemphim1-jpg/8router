/**
 * Image handling utilities for multimodal requests.
 *
 * Supports:
 *   - Inline base64 data URLs (data:image/png;base64,...)
 *   - HTTP/HTTPS image URL fetching with size/redirect/SSRF limits
 *
 * Security:
 *   - Private/loopback addresses are rejected (SSRF protection)
 *   - Maximum redirect depth to prevent redirect loops
 *   - Maximum image size to prevent memory exhaustion
 *
 * Output format matches what buildSendCascadeMessageRequest expects in
 * field 6 (CascadeImageAttachment): { mimeType, base64 }.
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';
import { log } from './config.js';

const MAX_SIZE = 5 * 1024 * 1024;   // 5 MB
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

// ─── SSRF protection ──────────────────────────────────────

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^fd/i,
  /^localhost$/i,
];

function isPrivateHost(hostname) {
  return PRIVATE_RANGES.some(re => re.test(hostname));
}

/**
 * Validate that a URL is safe to fetch. Throws on private addresses,
 * unsupported schemes, or suspicious hostnames.
 */
export function validateImageUrl(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Error('Invalid image URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported protocol: ${url.protocol}`);
  if (isPrivateHost(url.hostname)) throw new Error(`Private/loopback address rejected: ${url.hostname}`);
  return url;
}

// ─── Fetch image from URL ──────────────────────────────────

function fetchImageUrl(urlStr, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
    const url = validateImageUrl(urlStr);
    const mod = url.protocol === 'https:' ? https : http;

    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect without Location header'));
        res.resume();
        return resolve(fetchImageUrl(new URL(loc, url).href, redirects + 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching image`));
      }
      const contentLength = parseInt(res.headers['content-length'], 10);
      if (contentLength > MAX_SIZE) {
        res.resume();
        return reject(new Error(`Image too large: ${contentLength} bytes (max ${MAX_SIZE})`));
      }
      const buffers = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SIZE) {
          res.destroy();
          return reject(new Error(`Image exceeds ${MAX_SIZE} bytes`));
        }
        buffers.push(chunk);
      });
      res.on('end', () => {
        const data = Buffer.concat(buffers);
        const ct = (res.headers['content-type'] || '').split(';')[0].trim() || 'image/png';
        resolve({ mimeType: ct, base64: data.toString('base64') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Image fetch timeout')); });
  });
}

// ─── Parse data URL ────────────────────────────────────────

function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

// ─── Extract images from OpenAI content blocks ─────────────

/**
 * Given an OpenAI message `content` (string or content array), extract
 * all images and return { text, images }.
 *
 * Images are returned as [{ mimeType, base64 }] for proto field 6.
 * Text blocks are concatenated into a single string.
 */
export async function extractImages(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), images: [] };

  const textParts = [];
  const images = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;

    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }

    if (block.type === 'image_url' && block.image_url?.url) {
      const url = block.image_url.url;
      try {
        if (url.startsWith('data:')) {
          const parsed = parseDataUrl(url);
          if (parsed) images.push(parsed);
          else log.warn('Image: failed to parse data URL');
        } else {
          const fetched = await fetchImageUrl(url);
          images.push(fetched);
        }
      } catch (e) {
        log.warn(`Image: failed to process ${url.slice(0, 80)}: ${e.message}`);
      }
      continue;
    }

    // Anthropic-style image block (from /v1/messages translation)
    if (block.type === 'image' && block.source?.type === 'base64') {
      images.push({
        mimeType: block.source.media_type || 'image/png',
        base64: block.source.data,
      });
      continue;
    }
  }

  return { text: textParts.join('\n'), images };
}
