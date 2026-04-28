/**
 * Windsurf executor — calls the vendored Windsurf engine in-process.
 *
 * Unlike all other executors which fetch() a remote URL, this one invokes
 * runWindsurfChat() directly. The vendored handler manages account selection,
 * Language Server lifecycle, gRPC framing, tool emulation, and Cascade vs
 * RawGetChatMessage routing internally — so this class is mostly a shim that
 * shapes the result into the { response, url, headers, transformedBody }
 * envelope chatCore expects.
 */

import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  runWindsurfChat,
  addAccountByToken,
  getAccountList,
  ensureInitialized,
} from "../windsurf/index.js";

export class WindsurfExecutor extends BaseExecutor {
  constructor() {
    super("windsurf", PROVIDERS.windsurf);
    this.noAuth = true;
  }

  // No outbound HTTP — fabricate a placeholder URL for logging.
  buildUrl() {
    return "internal://windsurf";
  }

  buildHeaders() {
    return { "Content-Type": "application/json" };
  }

  shouldRetry() {
    // The vendored handler already retries across pool accounts internally.
    return false;
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    await ensureInitialized();

    // Lazy-register: if the 9router connection carries a Windsurf auth token
    // in providerSpecificData.token (the raw ott$… value the user pasted) and
    // the vendored pool doesn't yet have an account derived from it, register
    // it now. The vendored addAccountByToken is idempotent.
    const rawToken = credentials?.providerSpecificData?.windsurfToken
      || credentials?.providerSpecificData?.token
      || null;
    const knownApiKey = credentials?.apiKey || null;
    const pool = getAccountList();

    if (rawToken && !pool.some(a => a.apiKey === knownApiKey)) {
      try {
        const account = await addAccountByToken(rawToken);
        log?.info?.("WINDSURF", `registered account ${account.id} (${account.email}) from connection ${credentials?.id?.slice(0, 8) || "?"}`);
      } catch (err) {
        log?.warn?.("WINDSURF", `lazy register failed: ${err?.message}`);
      }
    } else if (!rawToken && pool.length === 0) {
      log?.warn?.("WINDSURF", "no Windsurf accounts in pool — request will fail with 503");
    }

    const transformedBody = { ...body, model, stream };
    const response = await runWindsurfChat(transformedBody, {
      callerKey: credentials?.id || "9router",
      context: { connectionId: credentials?.id, signal },
    });

    return {
      response,
      url: "internal://windsurf",
      headers: this.buildHeaders(),
      transformedBody,
    };
  }
}
