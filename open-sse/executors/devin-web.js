import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

// Devin web app endpoints (ported from
// https://github.com/Cassandranapolo/devin-claude-gateway).
//
// The Devin web app is not an official Anthropic API surface — it is the
// internal endpoint used by the React frontend at app.devin.ai. We
// authenticate using the user's own browser session (cookie + bearer)
// and create a new "devin session" for every chat completion request,
// then poll for Devin's first reply and stream it back as if it were a
// regular OpenAI chat completion. One Devin account = one connection.
const DEVIN_BASE_URL = "https://app.devin.ai";

const DEVIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Map exposed model id → Devin's internal devin_version_override id.
// Aliases like claude-opus-4-7 are kept so that clients that hit the
// gateway with their existing Claude-style model names still work.
const MODEL_MAP = {
  "devin-opus-4-7": "devin-opus-4-7",
  "devin-2-5": "devin-2-5",
  "devin-0929-brocade": "devin-0929-brocade",
  "claude-opus-4-7": "devin-opus-4-7",
  "claude-opus-4-6": "devin-opus-4-7",
  "claude-sonnet-4-7": "devin-2-5",
  "claude-sonnet-4-6": "devin-2-5",
  "claude-3-5-sonnet": "devin-2-5",
};

const DEFAULT_MODEL = "devin-opus-4-7";
const DEFAULT_REPLY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 2_000;

// Per-process auth state cache. Keyed by cookie fingerprint so we don't
// re-resolve org_id on every request, and so cookie changes invalidate
// the cached value automatically.
const stateCache = new Map();

function getCachedState(fingerprint) {
  return stateCache.get(fingerprint) || null;
}

function setCachedState(fingerprint, patch) {
  const prev = stateCache.get(fingerprint) || {};
  stateCache.set(fingerprint, { ...prev, ...patch });
}

// === Cookie / JWT helpers (ported from devin-claude-gateway/src) ===
function parseCookieString(raw) {
  const out = {};
  if (!raw || typeof raw !== "string") return out;
  for (const part of raw.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function serializeCookies(map) {
  return Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function decodeJsonCookie(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
}

function fnv1aHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function cookieFingerprint(map) {
  const keys = Object.keys(map).sort();
  const blob = keys.map((k) => `${k}=${map[k]}`).join("|");
  return fnv1aHex(blob);
}

function decodeJwt(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4;
    const fixed = pad ? padded + "=".repeat(4 - pad) : padded;
    const json = Buffer.from(fixed, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isOpaqueAuth1(token) {
  return typeof token === "string" && token.startsWith("auth1_") && !token.includes(".");
}

function jwtExpiryMs(token) {
  const payload = decodeJwt(token);
  return payload?.exp ? payload.exp * 1000 : null;
}

function isJwtFresh(token, leewaySec = 60) {
  const exp = jwtExpiryMs(token);
  if (!exp) return false;
  return exp - Date.now() > leewaySec * 1000;
}

function extractBearerFromCookies(map) {
  // Highest priority: explicit override jar.
  for (const k of ["__devin_bearer", "devin_bearer", "__devin_auth1_token", "devin_auth1_token"]) {
    const v = map[k];
    if (v) return v.replace(/^Bearer\s+/i, "");
  }

  // Devin's localStorage stores auth as JSON `{ token, userId, ... }`.
  // The cookie is set by the React app on login — historically the key
  // was `storage_auth1_session`, but after the Dec-2025 unscoped-auth0
  // migration it became `auth1_session`.
  const session = decodeJsonCookie(map.auth1_session ?? map.storage_auth1_session);
  if (session?.token) return session.token;

  // Fallback: scan any cookie value that looks like a JWT.
  for (const value of Object.values(map)) {
    const match = String(value || "").match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/);
    if (match && decodeJwt(match[0])) return match[0];
  }

  // Fallback: any value starting with `auth1_` is a Devin opaque session token.
  for (const value of Object.values(map)) {
    const match = String(value || "").match(/auth1_[A-Za-z0-9]{16,}/);
    if (match) return match[0];
  }
  return null;
}

// Parse user-supplied credential. Accept either:
//   * a raw cookie header string (key=value; key=value; ...)
//   * a raw bearer token (auth1_xxx or JWT)
// Returns { cookies, bearer, fingerprint }.
function parseCredential(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    throw new Error(
      "Missing Devin credential — paste either your full app.devin.ai cookie header or just the auth1_session token.",
    );
  }

  // If it's a bare token (single token, no '=' or no ';'), treat as bearer.
  const looksLikeCookieHeader = trimmed.includes("=") && /\b[a-zA-Z0-9_.-]+=/.test(trimmed);
  if (!looksLikeCookieHeader) {
    const bearer = trimmed.replace(/^Bearer\s+/i, "");
    const map = { __devin_bearer: bearer };
    return { cookies: map, bearer, fingerprint: cookieFingerprint(map) };
  }

  const map = parseCookieString(trimmed);
  const bearer = extractBearerFromCookies(map);
  if (!bearer) {
    throw new Error(
      "Could not find a Devin bearer in the pasted cookie. Make sure auth1_session (or storage_auth1_session on older builds) is included.",
    );
  }
  return { cookies: map, bearer, fingerprint: cookieFingerprint(map) };
}

function preflightAuth(auth) {
  // Opaque auth1_* tokens carry no exp, so we can't validate them locally.
  // Trust the upstream to reject if the token is stale.
  if (!isOpaqueAuth1(auth.bearer) && !isJwtFresh(auth.bearer, 60)) {
    const exp = jwtExpiryMs(auth.bearer);
    const reason = exp
      ? `Bearer token already expired at ${new Date(exp).toISOString()}.`
      : "Bearer token has no parseable exp and is not a recognized opaque format (auth1_*).";
    throw new Error(
      `${reason} Re-extract Devin auth from a freshly logged-in tab on app.devin.ai.`,
    );
  }
}

function buildHeaders(auth, orgId) {
  const cookieHeader = serializeCookies(auth.cookies);
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: DEVIN_BASE_URL,
    Referer: `${DEVIN_BASE_URL}/`,
    "User-Agent": DEVIN_USER_AGENT,
    Authorization: `Bearer ${auth.bearer}`,
    ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    ...(orgId
      ? {
          "x-cog-org-id": orgId,
          "X-Org-Id": orgId,
          "X-Organization-Id": orgId,
          "X-Devin-Org-Id": orgId,
        }
      : {}),
  };
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function readJsonBody(res) {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 200) };
  }
}

// === OpenAI message → Devin prompt transcript ===
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && (p.type === undefined || p.type === "text"))
    .map((p) => p.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function transcriptFromMessages(messages) {
  const turns = [];
  const systemParts = [];
  for (const msg of messages || []) {
    const role = msg?.role || "user";
    const text = flattenContent(msg?.content).trim();
    if (!text) continue;
    if (role === "system") {
      systemParts.push(text);
    } else if (role === "user" || role === "assistant") {
      turns.push({ role, content: text });
    } else {
      // Tool / function output: fold into the user transcript so Devin sees the context.
      turns.push({ role: "user", content: `[tool:${msg?.name ?? "unknown"}]\n${text}` });
    }
  }
  const lines = [];
  if (systemParts.length) lines.push(`[SYSTEM]\n${systemParts.join("\n\n").trim()}`);
  for (const t of turns) {
    if (t.role === "system") lines.push(`[SYSTEM]\n${t.content.trim()}`);
    else if (t.role === "assistant") lines.push(`[ASSISTANT]\n${t.content.trim()}`);
    else lines.push(`[USER]\n${t.content.trim()}`);
  }
  return lines.join("\n\n");
}

// === Devin session lifecycle ===
async function resolveOrgId(auth, devinId, fetchImpl) {
  const cached = getCachedState(auth.fingerprint);
  if (cached?.orgId) return cached.orgId;

  // Try cheap path first: post-auth response is sometimes echoed back as a cookie.
  for (const [key, value] of Object.entries(auth.cookies)) {
    if (!key.toLowerCase().includes("post-auth")) continue;
    const parsed = decodeJsonCookie(value);
    const orgId =
      parsed?.internalOrgId ??
      parsed?.result?.org_id ??
      parsed?.org_id;
    if (orgId) {
      setCachedState(auth.fingerprint, {
        orgId,
        userId: parsed?.userId ?? parsed?.user_id ?? null,
        orgName: parsed?.orgName ?? parsed?.result?.org_name ?? parsed?.org_name ?? null,
      });
      return orgId;
    }
  }

  // Round-trip post-auth.
  const res = await fetchImpl(`${DEVIN_BASE_URL}/api/users/post-auth`, {
    method: "POST",
    headers: buildHeaders(auth, null),
    body: JSON.stringify({ devin_id: devinId }),
  });
  const json = await readJsonBody(res);
  if (!res.ok) {
    const code = res.status === 401 ? "DEVIN_UNAUTHORIZED" : "DEVIN_POST_AUTH_FAILED";
    throw new Error(`Devin /api/users/post-auth failed (${res.status}, ${code}): ${JSON.stringify(json)}`);
  }
  if (!isObj(json) || typeof json.org_id !== "string") {
    throw new Error("Devin /api/users/post-auth did not return org_id; aborting.");
  }
  setCachedState(auth.fingerprint, {
    orgId: json.org_id,
    userId: typeof json.user_id === "string" ? json.user_id : null,
    orgName: typeof json.org_name === "string" ? json.org_name : null,
  });
  return json.org_id;
}

function randomDevinId() {
  // Match the gateway's id format: `devin-` + 32 hex chars.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `devin-${hex}`;
}

async function createDevinSession(auth, prompt, model, options, fetchImpl) {
  const devinId = randomDevinId();
  const cached = getCachedState(auth.fingerprint) || {};
  const orgIdHint = cached.orgId || null;
  const userIdHint = cached.userId || null;

  const body = {
    devin_id: devinId,
    user_message: prompt,
    username: options.username,
    ...(orgIdHint ? { org_id: orgIdHint, organization_id: orgIdHint } : {}),
    ...(userIdHint ? { user_id: userIdHint } : {}),
    rich_content: [{ text: prompt }],
    repos: [],
    snapshot_id: null,
    tags: [],
    from_spaces: "false",
    planner_type: options.plannerType,
    planning_mode: options.planningMode,
    bypass_approval: false,
    "devin-rs": "true",
    devin_version_override: model,
    additional_args: {
      planning_mode: options.planningMode,
      planner_type: options.plannerType,
      from_spaces: "false",
      bypass_approval: false,
      "devin-rs": "true",
      devin_version_override: model,
    },
  };

  const res = await fetchImpl(`${DEVIN_BASE_URL}/api/sessions`, {
    method: "POST",
    headers: buildHeaders(auth, orgIdHint),
    body: JSON.stringify(body),
  });
  const json = await readJsonBody(res);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Devin /api/sessions returned ${res.status}. The auth1 bearer likely expired — re-extract DEVIN cookie from a freshly logged-in tab on app.devin.ai.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Devin /api/sessions failed (${res.status}): ${JSON.stringify(json)}`);
  }
  if (isObj(json) && typeof json.devin_id === "string") return json.devin_id;
  return devinId;
}

async function pollDevinSessionOnce(auth, orgId, devinId, startedAt, fetchImpl) {
  const params = new URLSearchParams({
    include_pinned: "true",
    group_children: "true",
    limit: "30",
    order_by: "updated_at",
    sort_direction: "desc",
    is_archived: "false",
    session_type: "devin",
    updated_date_from: new Date(startedAt - 60_000).toISOString(),
  });
  const userId = getCachedState(auth.fingerprint)?.userId;
  if (userId) params.set("creators", userId);

  const url = `${DEVIN_BASE_URL}/api/${encodeURIComponent(orgId)}/v2sessions?${params}`;
  const res = await fetchImpl(url, { headers: buildHeaders(auth, orgId) });
  const json = await readJsonBody(res);
  if (res.status === 401) {
    throw new Error("Devin v2sessions returned 401 — bearer or session likely rotated mid-poll.");
  }
  if (!res.ok) {
    throw new Error(`Devin v2sessions failed (${res.status}): ${JSON.stringify(json)}`);
  }
  const list = isObj(json) && Array.isArray(json.result) ? json.result : [];
  const item = list.find((entry) => isObj(entry) && entry.devin_id === devinId);
  if (!isObj(item)) return { message: null, status: null };

  const contents = item.latest_message_contents;
  let message = null;
  if (isObj(contents) && contents.type === "devin_message" && typeof contents.message === "string") {
    const trimmed = contents.message.trim();
    if (trimmed) message = trimmed;
  }
  const statusContents = item.latest_status_contents;
  const status = isObj(statusContents) && typeof statusContents.enum === "string" ? statusContents.enum : null;
  return { message, status };
}

async function waitForDevinReply(auth, orgId, devinId, startedAt, signal, timeoutMs, fetchImpl) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Aborted while waiting for Devin reply");
    const { message, status } = await pollDevinSessionOnce(auth, orgId, devinId, startedAt, fetchImpl);
    if (message) return message;
    if (status === "failed" || status === "errored") {
      throw new Error(`Devin session ${devinId} ended with status="${status}" before sending any message.`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out after ${timeoutMs / 1000}s waiting for Devin to send first message in session ${devinId}.`,
  );
}

// === SSE / JSON response helpers ===
function approxTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function chunkString(text, size = 64) {
  if (!text) return [];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function buildStreamingResponse(content, model, cid, created) {
  const encoder = new TextEncoder();
  const sse = (data) => `data: ${JSON.stringify(data)}\n\n`;
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode(
            sse({
              id: cid,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            }),
          ),
        );
        for (const piece of chunkString(content)) {
          controller.enqueue(
            encoder.encode(
              sse({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
              }),
            ),
          );
        }
        controller.enqueue(
          encoder.encode(
            sse({
              id: cid,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }),
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });
}

function buildNonStreamingResponse(content, model, cid, created, promptText) {
  const promptTokens = approxTokens(promptText);
  const completionTokens = approxTokens(content);
  return new Response(
    JSON.stringify({
      id: cid,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function errorResponse(message, status, code) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: "upstream_error",
        code: code || `HTTP_${status}`,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export class DevinWebExecutor extends BaseExecutor {
  constructor() {
    super("devin-web", PROVIDERS["devin-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const url = `${DEVIN_BASE_URL}/api/sessions`;
    const fetchImpl = (u, init) => proxyAwareFetch(u, { ...init, signal }, proxyOptions);

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return {
        response: errorResponse("Missing or empty messages array", 400, "INVALID_REQUEST"),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    const prompt = transcriptFromMessages(body.messages);
    if (!prompt.trim()) {
      return {
        response: errorResponse("Refusing to start a Devin session with an empty prompt.", 400, "EMPTY_PROMPT"),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    const devinModel = MODEL_MAP[model] || model || DEFAULT_MODEL;
    const psd = credentials?.providerSpecificData || {};
    const username = (psd.devinUsername || process.env.DEVIN_USERNAME || "User").toString();
    const plannerType = (psd.devinPlannerType || process.env.DEVIN_PLANNER_TYPE || "fast").toString();
    const planningMode = (psd.devinPlanningMode || process.env.DEVIN_PLANNING_MODE || "automatic").toString();
    const timeoutSec = Number(psd.devinReplyTimeoutS || process.env.DEVIN_REPLY_TIMEOUT_S || 180);
    const timeoutMs = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : DEFAULT_REPLY_TIMEOUT_MS;

    let auth;
    try {
      auth = parseCredential(credentials?.apiKey || credentials?.accessToken || "");
      preflightAuth(auth);
    } catch (err) {
      log?.warn?.("DEVIN-WEB", `Auth error: ${err.message}`);
      return {
        response: errorResponse(err.message, 401, "DEVIN_AUTH_INVALID"),
        url,
        headers: {},
        transformedBody: body,
      };
    }

    const cid = `chatcmpl-devin-${Math.random().toString(36).slice(2, 14)}`;
    const created = Math.floor(Date.now() / 1000);
    const startedAt = Date.now();

    log?.info?.("DEVIN-WEB", `Creating Devin session (model=${devinModel}, prompt_chars=${prompt.length})`);

    let devinId;
    let orgId;
    let content;
    try {
      devinId = await createDevinSession(
        auth,
        prompt,
        devinModel,
        { username, plannerType, planningMode },
        fetchImpl,
      );
      orgId = await resolveOrgId(auth, devinId, fetchImpl);
      log?.debug?.("DEVIN-WEB", `Created session ${devinId} | org=${orgId}`);
      content = await waitForDevinReply(auth, orgId, devinId, startedAt, signal, timeoutMs, fetchImpl);
      log?.info?.("DEVIN-WEB", `Session ${devinId} replied (${content.length} chars)`);
    } catch (err) {
      const message = err?.message || String(err);
      const status = /401|expired|unauthorized|invalid/i.test(message) ? 401 : 502;
      log?.error?.("DEVIN-WEB", `Devin upstream failed: ${message}`);
      return {
        response: errorResponse(message, status, "DEVIN_UPSTREAM_ERROR"),
        url,
        headers: { Authorization: "Bearer ***" },
        transformedBody: body,
      };
    }

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingResponse(content, model, cid, created);
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    } else {
      finalResponse = buildNonStreamingResponse(content, model, cid, created, prompt);
    }

    return {
      response: finalResponse,
      url,
      headers: { Authorization: "Bearer ***" },
      transformedBody: { devin_id: devinId, org_id: orgId, model: devinModel, prompt_chars: prompt.length },
    };
  }
}
