#!/usr/bin/env node
/*
 * Devin auth1 bearer auto-refresher for 8router.
 *
 *   node scripts/devin-refresh.cjs --bootstrap   # one-time interactive login
 *   node scripts/devin-refresh.cjs               # cron-friendly headless refresh
 *
 * Bootstrap launches a real Chromium window so you can log in to Devin once
 * (email + verification code). When you land on /sessions or /orgs the script
 * saves cookies + localStorage to <DATA_DIR>/devin-state.json.
 * Refresh re-uses that file headlessly, reads the rotated auth1 token, and
 * patches the apiKey of every active devin-web connection in 8router's local
 * lowdb (db.json).
 *
 * Ported from devin-claude-gateway (Cassandranapolo). Linux-only.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const lockfile = require("proper-lockfile");

const APP_NAME = "9router";
function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      APP_NAME,
    );
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

const DATA_DIR = getDataDir();
const STATE_PATH = process.env.DEVIN_STATE_FILE || path.join(DATA_DIR, "devin-state.json");
const DB_PATH = path.join(DATA_DIR, "db.json");
const LOGIN_URL = "https://app.devin.ai/auth/login";
const SESSIONS_URL = "https://app.devin.ai/sessions";

const argv = process.argv.slice(2);
const args = new Set(argv);
const isBootstrap = args.has("--bootstrap");
const isDryRun = args.has("--dry-run");
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const manualToken = flagValue("--token");

function ts() {
  return new Date().toISOString();
}
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}
function err(msg) {
  console.error(`[${ts()}] ${msg}`);
}

async function readAuth(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem("auth1_session");
    if (!raw) return { error: "auth1_session missing from localStorage" };
    try {
      const parsed = JSON.parse(raw);
      const orgId =
        localStorage.getItem("last-internal-org-for-external-org-v1-null") ||
        null;
      return { token: parsed.token || null, orgId };
    } catch (e) {
      return { error: "auth1_session parse error: " + e.message };
    }
  });
}

async function patchDb(token) {
  if (!fs.existsSync(DB_PATH)) {
    err(`db.json not found at ${DB_PATH}. Open the 8router dashboard once so the file is initialized.`);
    process.exit(5);
  }

  let release;
  try {
    release = await lockfile.lock(DB_PATH, { retries: { retries: 5, minTimeout: 200 } });
  } catch (e) {
    err(`Could not acquire lock on ${DB_PATH}: ${e.message}`);
    process.exit(6);
  }

  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const db = JSON.parse(raw);
    const conns = Array.isArray(db.providerConnections) ? db.providerConnections : [];
    let updated = 0;
    const now = new Date().toISOString();
    for (const c of conns) {
      if (c.provider !== "devin-web") continue;
      if (c.apiKey === token) continue;
      c.apiKey = token;
      c.updatedAt = now;
      // Clear stale failure state so the connection is retried promptly.
      c.lastError = null;
      c.errorCode = null;
      c.lastErrorAt = null;
      c.backoffLevel = 0;
      c.testStatus = "active";
      updated++;
    }
    if (updated === 0) {
      log("No devin-web connections needed an update (token unchanged or no connections found).");
      return;
    }
    if (isDryRun) {
      log(`[dry-run] Would update ${updated} devin-web connection(s).`);
      return;
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
    log(`Updated ${updated} devin-web connection(s) in db.json`);
  } finally {
    await release();
  }
}

async function bootstrap() {
  const { chromium } = require("playwright");
  log("Starting bootstrap (headed Chromium)...");
  log("Log in to Devin: enter email -> get code from email -> enter code -> land on /sessions.");
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  log("Waiting for you to land on /sessions or /orgs (timeout 10 minutes)...");
  await page.waitForURL(
    (u) => /app\.devin\.ai\/(sessions|orgs)/.test(u.toString()) && !u.toString().includes("/auth/"),
    { timeout: 10 * 60 * 1000 },
  );
  await page.waitForTimeout(4000);

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  await ctx.storageState({ path: STATE_PATH });
  fs.chmodSync(STATE_PATH, 0o600);
  log(`Saved state to ${STATE_PATH}`);

  const result = await readAuth(page);
  if (!result.token) {
    err(`Could not read auth1_session from localStorage: ${result.error || "unknown"}`);
    await browser.close();
    process.exit(3);
  }
  log(`Extracted bearer (length=${result.token.length}).`);
  await patchDb(result.token);

  await browser.close();
  log("Bootstrap done. From now on, run `node scripts/devin-refresh.cjs` (no args) on a 15-minute cron.");
}

async function refresh() {
  const { chromium } = require("playwright");
  if (!fs.existsSync(STATE_PATH)) {
    err(`State file ${STATE_PATH} missing. Run \`node scripts/devin-refresh.cjs --bootstrap\` first.`);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: STATE_PATH });
  const page = await ctx.newPage();

  log(`Navigating to ${SESSIONS_URL} ...`);
  await page.goto(SESSIONS_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(2000);

  if (/\/auth\//.test(page.url())) {
    err(`State file STALE (browser redirected to ${page.url()}).`);
    err("Re-run bootstrap on a machine with a GUI: node scripts/devin-refresh.cjs --bootstrap");
    await browser.close();
    process.exit(2);
  }

  const result = await readAuth(page);
  if (!result.token) {
    err(`Could not read bearer from localStorage: ${result.error || "unknown"}`);
    err("Re-run bootstrap (auth1_session may have expired or been invalidated).");
    await browser.close();
    process.exit(3);
  }

  log(`Extracted bearer (length=${result.token.length}); patching db.json`);
  await patchDb(result.token);

  // Persist refreshed cookies for next run.
  await ctx.storageState({ path: STATE_PATH });
  fs.chmodSync(STATE_PATH, 0o600);
  await browser.close();
  log("Refresh done.");
}

(async () => {
  try {
    if (manualToken) {
      log(`Manual token mode: patching db.json with provided --token (length=${manualToken.length}).`);
      await patchDb(manualToken);
      return;
    }
    if (isBootstrap) {
      await bootstrap();
    } else {
      await refresh();
    }
  } catch (e) {
    err(`Fatal: ${e && e.stack ? e.stack : e}`);
    process.exit(99);
  }
})();
