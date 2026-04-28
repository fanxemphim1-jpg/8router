/**
 * Public entrypoint for the vendored Windsurf engine.
 *
 * 9router calls these functions directly from its executor — no HTTP hop,
 * no subprocess. The original WindsurfPoolAPI HTTP server (`src/server.js`)
 * is intentionally NOT vendored: 9router supplies its own routing layer.
 *
 * Surface:
 *   - runWindsurfChat(body, opts) → Promise<Response>
 *   - runWindsurfMessages(body, opts) → Promise<Response>     (Anthropic format)
 *   - runWindsurfResponses(body, opts) → Promise<Response>    (OpenAI Responses)
 *   - runWindsurfModels() → Response
 *   - addAccountByToken / addAccountByKey / addAccountByRefreshToken
 *   - listAccounts / removeAccount / probeAccount
 *   - initAuth / shutdownAll
 */

import { handleChatCompletions } from './handlers/chat.js';
import { handleMessages } from './handlers/messages.js';
import { handleResponses } from './handlers/responses.js';
import { handleModels } from './handlers/models.js';
import {
  initAuth,
  addAccountByKey,
  addAccountByToken,
  addAccountByRefreshToken,
  addAccountByEmail,
  removeAccount,
  setAccountBlockedModels,
  setAccountStatus,
  setAccountTokens,
  resetAccountErrors,
  updateAccountLabel,
  probeAccount,
  refreshCredits,
  refreshAllCredits,
  getAccountList,
  getAccountCount,
  fetchAndMergeModelCatalog,
} from './auth.js';
import { config, log } from './config.js';
import { stopLanguageServer as shutdownLanguageServers } from './langserver.js';

let _initialized = false;
let _initPromise = null;

/**
 * Idempotent init. Called automatically by run* helpers but exposed for
 * eager warm-up from 9router boot.
 */
export async function ensureInitialized() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    await initAuth();
    _initialized = true;
  })();
  return _initPromise;
}

// ── Adapter: convert WindsurfPoolAPI handler result → Web Response ────────
//
// Existing handlers return one of:
//   { status, body, headers? }                         non-streaming JSON
//   { status, headers?, stream: true, handler(res) }   streaming SSE
//
// 9router (Next.js / Cloudflare Worker) speaks the standard `Response` API.
// We bridge by converting the legacy `handler(res)` callback into a
// `ReadableStream` controller. The legacy callback does `res.write(chunk)`
// and `res.end()`; we map those to controller.enqueue / .close.
function adaptResult(result) {
  if (!result.stream) {
    const headers = { 'Content-Type': 'application/json', ...(result.headers || {}) };
    return new Response(JSON.stringify(result.body ?? null), {
      status: result.status || 200,
      headers,
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const fakeRes = {
        write(chunk) {
          if (closed) return false;
          try {
            const buf = typeof chunk === 'string' ? encoder.encode(chunk)
              : (chunk instanceof Uint8Array ? chunk : encoder.encode(String(chunk)));
            controller.enqueue(buf);
          } catch (err) {
            log.warn('windsurf adapter: enqueue failed:', err?.message);
          }
          return true;
        },
        end(chunk) {
          if (closed) return;
          if (chunk !== undefined) fakeRes.write(chunk);
          closed = true;
          try { controller.close(); } catch {}
        },
        // The handler may call setHeader/flushHeaders/setTimeout/socket.* —
        // ignore them safely. Headers are already on the outer Response.
        setHeader() {}, getHeader() {}, removeHeader() {},
        flushHeaders() {}, setTimeout() {},
        socket: { setNoDelay() {}, setKeepAlive() {} },
        on() {}, once() {}, off() {}, removeListener() {},
        // Some code paths check writable*; expose conservative defaults.
        writable: true,
        writableEnded: false,
        writableFinished: false,
      };
      Promise.resolve()
        .then(() => result.handler(fakeRes))
        .catch(err => {
          log.error('windsurf adapter: handler threw:', err?.message);
          if (!closed) {
            try { controller.error(err); } catch {}
          }
        })
        .finally(() => {
          if (!closed) {
            closed = true;
            try { controller.close(); } catch {}
          }
        });
    },
  });

  const headers = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    ...(result.headers || {}),
  };
  return new Response(stream, { status: result.status || 200, headers });
}

/** Run an OpenAI /v1/chat/completions request. */
export async function runWindsurfChat(body, opts = {}) {
  await ensureInitialized();
  const result = await handleChatCompletions(body, {
    callerKey: opts.callerKey || '',
    context: opts.context || {},
  });
  return adaptResult(result);
}

/** Run an Anthropic /v1/messages request. */
export async function runWindsurfMessages(body, opts = {}) {
  await ensureInitialized();
  const result = await handleMessages(body, {
    callerKey: opts.callerKey || '',
    context: opts.context || {},
  });
  return adaptResult(result);
}

/** Run an OpenAI Responses /v1/responses request. */
export async function runWindsurfResponses(body, opts = {}) {
  await ensureInitialized();
  const result = await handleResponses(body, {
    callerKey: opts.callerKey || '',
    context: opts.context || {},
  });
  return adaptResult(result);
}

/** Return /v1/models (synchronous, no auth required). */
export function runWindsurfModels() {
  // handleModels() returns the body directly, not a {status, body} envelope.
  return new Response(JSON.stringify(handleModels()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Account management surface ────────────────────────────────────────────
export {
  addAccountByKey,
  addAccountByToken,
  addAccountByRefreshToken,
  addAccountByEmail,
  removeAccount,
  setAccountBlockedModels,
  setAccountStatus,
  setAccountTokens,
  resetAccountErrors,
  updateAccountLabel,
  probeAccount,
  refreshCredits,
  refreshAllCredits,
  getAccountList,
  getAccountCount,
  fetchAndMergeModelCatalog,
  shutdownLanguageServers,
  config,
  log,
};
