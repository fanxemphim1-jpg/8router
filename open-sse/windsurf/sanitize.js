/**
 * Strip server-internal filesystem paths from model output before it reaches
 * the API caller.
 *
 * Background: Cascade's baked-in system context tells the model its workspace
 * lives at /tmp/windsurf-workspace. Even after we removed CascadeToolConfig
 * .run_command (see windsurf.js buildCascadeConfig) the model still
 *   (a) narrates "I'll look at /tmp/windsurf-workspace/config.yaml" in plain
 *       text, and
 *   (b) occasionally emits built-in edit_file / view_file / list_directory
 *       trajectory steps whose argumentsJson references these paths.
 * Both routes leak the proxy's internal filesystem layout to API callers.
 *
 * This module provides two scrubbers:
 *   - sanitizeText(s)        — one-shot, use on accumulated buffers
 *   - PathSanitizeStream     — incremental, use on streaming chunks
 *
 * The streaming version holds back any tail that could be an incomplete
 * prefix of a sensitive literal OR a match-in-progress whose path-tail hasn't
 * hit a terminator yet, so a path cannot slip through by straddling a chunk
 * boundary.
 */

// Detect the actual project root from this module's path so the sanitizer
// covers deployments outside /root/WindsurfAPI.
const _repoRoot = (() => {
  try {
    const thisFile = new URL(import.meta.url).pathname;
    return thisFile.replace(/\/src\/sanitize\.js$/, '');
  } catch { return '/root/WindsurfPoolAPI'; }
})();

const PATTERNS = [
  [/\/tmp\/windsurf-workspace(\/[^\s"'`<>)}\],*;]*)?/g, '.$1'],
  // Cascade sandbox workspace (per-account wsId). The model sees this path
  // in its context and suggests it in tool calls — Claude Code then runs
  // Read/Glob against a path that doesn't exist on the user's machine (#38).
  [/\/home\/user\/projects\/workspace-[a-z0-9]+(\/[^\s"'`<>)}\],*;]*)?/g, '.$1'],
  [/\/opt\/windsurf(?:\/[^\s"'`<>)}\],*;]*)?/g, '[internal]'],
];
// Dynamic repo-root pattern — only when the path is long enough to avoid
// overly-broad matches (e.g. root "/" or "/tmp").
if (_repoRoot.length > 10 && _repoRoot !== '/root/WindsurfPoolAPI') {
  PATTERNS.push([new RegExp(_repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\/[^\\s"\'`<>)}\\],*;]*)?', 'g'), '[internal]']);
}
// /root/WindsurfPoolAPI is always redacted regardless of auto-detection
PATTERNS.push([/\/root\/WindsurfPoolAPI(?:\/[^\s"'`<>)}\],*;]*)?/g, '[internal]']);

// Bare literals (no path tail) used by the streaming cut-point finder.
const SENSITIVE_LITERALS = [
  '/tmp/windsurf-workspace',
  '/home/user/projects/workspace-',
  '/opt/windsurf',
  '/root/WindsurfPoolAPI',
];
if (_repoRoot.length > 10 && _repoRoot !== '/root/WindsurfPoolAPI') {
  SENSITIVE_LITERALS.push(_repoRoot);
}

// Character class that counts as part of a path body. Mirrors the PATTERNS
// regex char class so cut-point detection matches replacement behaviour.
const PATH_BODY_RE = /[^\s"'`<>)}\],*;]/;

/**
 * Apply all path redactions to `s` in one pass. Safe to call on any string;
 * non-strings and empty strings are returned unchanged.
 */
export function sanitizeText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * Incremental sanitizer for streamed deltas.
 *
 * Usage:
 *   const stream = new PathSanitizeStream();
 *   for (const chunk of deltas) emit(stream.feed(chunk));
 *   emit(stream.flush());
 *
 * The returned string from feed()/flush() is guaranteed to contain no
 * sensitive literal. Any trailing text that COULD extend into a sensitive
 * literal (either as a partial prefix or as an unterminated path tail) is
 * held internally until the next feed or the flush.
 */
export class PathSanitizeStream {
  constructor() {
    this.buffer = '';
  }

  feed(delta) {
    if (!delta) return '';
    this.buffer += delta;
    const cut = this._safeCutPoint();
    if (cut === 0) return '';
    const safeRegion = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return sanitizeText(safeRegion);
  }

  // Largest index into this.buffer such that buffer[0:cut] contains no
  // match that could extend past `cut`. Two conditions back off the cut:
  //   (1) a full sensitive literal was found but its path body ran to the
  //       end of the buffer — the next delta might append more path chars,
  //       in which case the fully-rendered path would differ. Hold from the
  //       literal's start.
  //   (2) the buffer tail is itself a proper prefix of a sensitive literal
  //       (e.g., ends with "/tmp/win") — the next delta might complete it.
  //       Hold from that tail start.
  _safeCutPoint() {
    const buf = this.buffer;
    const len = buf.length;
    let cut = len;

    // (1) unterminated full literal
    for (const lit of SENSITIVE_LITERALS) {
      let searchFrom = 0;
      while (searchFrom < len) {
        const idx = buf.indexOf(lit, searchFrom);
        if (idx === -1) break;
        let end = idx + lit.length;
        while (end < len && PATH_BODY_RE.test(buf[end])) end++;
        if (end === len) {
          if (idx < cut) cut = idx;
          break;
        }
        searchFrom = end + 1;
      }
    }

    // (2) partial-prefix tail
    for (const lit of SENSITIVE_LITERALS) {
      const maxLen = Math.min(lit.length - 1, len);
      for (let plen = maxLen; plen > 0; plen--) {
        if (buf.endsWith(lit.slice(0, plen))) {
          const start = len - plen;
          if (start < cut) cut = start;
          break;
        }
      }
    }

    return cut;
  }

  flush() {
    const out = sanitizeText(this.buffer);
    this.buffer = '';
    return out;
  }
}

/**
 * Sanitize a native Cascade tool call (built-in tools like edit_file /
 * view_file) before surfacing to the client. Scrubs argumentsJson and
 * result. Not used on the hot path today — handlers/chat.js drops all
 * native tool calls in non-emulation mode rather than risking leakage —
 * but kept here for opt-in use.
 */
export function sanitizeToolCall(tc) {
  if (!tc) return tc;
  const out = { ...tc };
  if (typeof tc.argumentsJson === 'string') out.argumentsJson = sanitizeText(tc.argumentsJson);
  if (typeof tc.result === 'string') out.result = sanitizeText(tc.result);
  if (tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input)) {
    const safe = {};
    for (const [k, v] of Object.entries(tc.input)) {
      safe[k] = typeof v === 'string' ? sanitizeText(v) : v;
    }
    out.input = safe;
  }
  return out;
}
