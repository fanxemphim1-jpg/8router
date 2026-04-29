# Test plan — devin-web provider (PR #4)

## What changed (user-visible)
A new provider entry **"Devin Web (Claude Opus 4.7)"** (id `devin-web`, alias `dw`) is registered in 8router's Web Cookie Providers category. Users can add a connection by pasting their `app.devin.ai` cookie/`auth1_*` bearer, then call models like `dw/claude-opus-4-7`, `dw/devin-2-5`, etc.

## Out of scope
- Real chat completion against `app.devin.ai` — requires user's logged-in Devin cookie. Will explicitly mark this as **untested** in the report.

## Primary flow

### Test 1: Provider visible on dashboard (UI)
**Steps:**
1. Open `http://localhost:20128/dashboard/providers`.
2. Scroll to the **Web Cookie Providers** section (or whichever section renders `WEB_COOKIE_PROVIDERS`).

**Pass criteria:**
- A card with name **"Devin Web (Claude Opus 4.7)"** is rendered.
- The textIcon "DW" is shown.
- Adversarial check: a stale build before this PR would NOT show this card → broken implementation produces visibly different result.

### Test 2: Add Connection modal placeholder (UI)
**Steps:**
1. From the card in Test 1, click the **Add** / **+** button.
2. Observe the credential input field placeholder.

**Pass criteria:**
- Placeholder text reads: `auth1_xxxxx... or paste the full app.devin.ai cookie header`
- The label says "Cookie Value" (not "API Key") because authType is `cookie`.
- Adversarial: if `AddApiKeyModal.js` placeholder branch is wrong, placeholder would default to `eyJhbGciOi...`.

### Test 3: Validate endpoint rejects bad credential (HTTP)
**Steps:**
- Run: `curl -s -X POST http://localhost:20128/api/providers/validate -H "Content-Type: application/json" -d '{"provider":"devin-web","apiKey":"auth1_DEFINITELY_INVALID_TOKEN_FOR_TEST"}'`

**Pass criteria:**
- Response JSON has `valid: false` AND `error` containing the substring `"Invalid Devin credential"`.
- Status code 200 (not 400/500).
- Adversarial: if the new `case "devin-web":` block were missing, the route would fall through to `default` and return `Provider validation not supported` (status 400) → visibly different.

### Test 4: Models listing exposes devin-web ids (HTTP)
**Steps:**
- Run: `curl -s http://localhost:20128/api/v1/models | python3 -c 'import json,sys; d=json.load(sys.stdin); ids=[m["id"] for m in d.get("data",[])]; print("\n".join(i for i in ids if "devin" in i.lower() or "dw/" in i))'`

**Pass criteria:**
- Output contains all four entries (provider-prefixed): `devin-web/claude-opus-4-7`, `devin-web/devin-opus-4-7`, `devin-web/devin-2-5`, `devin-web/devin-0929-brocade` (or `dw/...` alias form).
- Adversarial: missing entries in `providerModels.js` would not appear → visibly different.

### Test 5 (optional sanity): No regression on existing providers
**Steps:**
- Same dashboard page — verify Grok Web and Perplexity Web cards still render unchanged.

**Pass criteria:** both cards still show. Labelled **Regression**.

## Files cited
- `open-sse/executors/devin-web.js` (new)
- `src/shared/constants/providers.js:115` (WEB_COOKIE_PROVIDERS entry)
- `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js:12-18` (placeholder branch)
- `src/app/api/providers/validate/route.js:516-549` (devin-web validate case)
- `open-sse/config/providerModels.js:523-528` (model list)
