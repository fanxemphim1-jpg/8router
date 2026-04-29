# Devin Web auto-refresh (Linux)

The `devin-web` provider authenticates with an opaque `auth1_*` bearer that
Devin rotates roughly every 15–30 minutes. Without auto-refresh you have to
re-paste the bearer in the dashboard whenever it expires.

This repo ships a Playwright-based refresher that keeps the bearer fresh by
re-extracting it from `localStorage` of a logged-in Chromium session. Linux
only — the script needs a real GUI for the one-time bootstrap.

## One-time bootstrap

```bash
# from the repo root
node scripts/devin-refresh.cjs --bootstrap
```

A Chromium window opens at https://app.devin.ai/auth/login. Log in (email +
verification code). When the page lands on `/sessions` (or `/orgs`) the script
saves the browser state to `~/.9router/devin-state.json`, extracts the current
`auth1_session.token`, and patches the `apiKey` of every active `devin-web`
connection in the local lowdb (`~/.9router/db.json`).

Add at least one `devin-web` connection in the dashboard first (Providers →
Add → Devin Web) so the script has a row to update. The placeholder value can
be anything; the bootstrap will overwrite it.

## Headless refresh (cron)

```bash
bash scripts/install-devin-refresh.sh
```

This installs a 15-minute crontab entry that runs:

```
*/15 * * * * cd <repo> && /usr/bin/node scripts/devin-refresh.cjs >> ~/.9router/devin-refresh.log 2>&1
```

To remove it later:

```bash
bash scripts/install-devin-refresh.sh --uninstall
```

## Manual one-shot patch (no Playwright)

If you have a fresh bearer extracted by another means, you can patch the DB
directly without spinning up Chromium:

```bash
node scripts/devin-refresh.cjs --token "auth1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Use `--dry-run` alongside `--token` to preview without writing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `state file ... missing` | Run `node scripts/devin-refresh.cjs --bootstrap` first. |
| `state file STALE (browser redirected to /auth/...)` | The saved session expired. Re-bootstrap. |
| `db.json not found` | Open the 8router dashboard once so it initializes the lowdb file. |
| Cron job not running | Check `~/.9router/devin-refresh.log` and verify `crontab -l` contains the entry. |

The script never touches connections whose `provider` is not `devin-web`. Each
run also clears `lastError` / `errorCode` / `backoffLevel` for the patched
connections so a previously-failed connection is retried promptly with the
new token.
