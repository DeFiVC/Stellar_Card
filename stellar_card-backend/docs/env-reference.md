# Environment Reference

All configuration is validated at boot by [`src/env.js`](../src/env.js)
(zod). Invalid values print the offending key and exit non-zero — a typo
fails before the server accepts traffic.

Values marked **required** have no default and must be set explicitly.
Generation hints use `openssl` or `stellar` CLI where relevant.

## Server

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | no | `4000` | HTTP listen port. Must be a positive integer string. |
| `NODE_ENV` | **yes** | — | `development` \| `production` \| `test`. No default on purpose: a missing value in a production deploy would silently downgrade security. |

## Database

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DB_PATH` | no | `./stellar_card.db` | SQLite file path. In Docker this is `/app/data/stellar_card.db`. |

## Stellar / Soroban

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STELLAR_NETWORK` | no | `mainnet` | `mainnet` \| `testnet`. |
| `STELLAR_USDC_ISSUER` | no | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` | USDC issuer account (StrKey `G…`, 56 chars). |
| `STELLAR_XLM_SECRET` | **yes** | — | Treasury wallet secret key (StrKey `S…`, 56 chars). Used for XLM refunds. |
| `RECEIVER_CONTRACT_ID` | **yes** | — | Soroban receiver contract id (StrKey `C…`, 56 chars). |
| `SOROBAN_RPC_URL` | no | — | Soroban RPC endpoint. Must be `http(s)://`. |

## VCC fulfillment

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VCC_API_BASE` | **yes** | — | VCC partner API base URL (`http(s)://` only). |
| `CARDS402_BASE_URL` | **yes** | — | Public URL of this deployment; VCC builds the callback URL from it. |
| `VCC_CALLBACK_SECRET` | **yes** | — | HMAC shared secret for VCC callbacks. Minimum 32 characters. |
| `PARTNER_WEBHOOK_SECRET` | no | — | HMAC secret for generic partner webhooks (issue #591). Min 32 chars. |
| `WEBHOOK_SIGNATURE_BYPASS` | no | — | `true` skips webhook HMAC checks. **Refused when `NODE_ENV=production`.** |

## Access control

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORS_ORIGINS` | no | — | Comma-separated allowed origins. Each entry must parse as an `http(s)` URL origin. |
| `OWNER_EMAIL` | no | — | If set, only this email may become the first owner account. |
| `CARDS402_PLATFORM_OWNER_EMAIL` | no | — | Unlocks `/dashboard/platform/*` and system-level alert rules. |
| `INTERNAL_EMAILS` | no | — | Comma-separated emails allowed on `/internal/*`. `@stellar_card.com` addresses are always allowed. |
| `ADMIN_SESSION_KEY` | no | — | 64 hex chars (32 bytes). Session key for the admin UI. |
| `CARDS402_SECRET_BOX_KEY` | no | — | 64 hex chars (32 bytes). AES-256-GCM key sealing claim payloads. **Required when `NODE_ENV=production`** — generate with `openssl rand -hex 32`. |

## SMTP (all-or-nothing)

If any of the following is set, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, and
`SMTP_FROM` must all be set (boot fails otherwise).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SMTP_HOST` | no | — | SMTP server hostname. |
| `SMTP_PORT` | no | — | SMTP port (numeric string). |
| `SMTP_USER` | no | — | SMTP username. |
| `SMTP_PASS` | no | — | SMTP password. |
| `SMTP_FROM` | no | — | From-address (must be a valid email). |

## Recovery jobs

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `STUCK_RETRY_AFTER_MS` | no | — | Retry interval for stuck fulfillments (ms). |
| `STUCK_FAIL_AFTER_MS` | no | — | Age after which a stuck order is marked failed (ms). |
| `MAX_FULFILLMENT_ATTEMPTS` | no | — | Cap on VCC fulfillment attempts per order. |

## Machine Payments Protocol (MPP)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MPP_ENABLED` | no | `false` | `true` mounts the `/v1/mpp/*` routes. Off by default. |
| `MPP_CHALLENGE_TTL_MS` | no | `600000` | Challenge lifetime (ms). Default 10 minutes. |
| `MPP_SYNC_WAIT_MS` | no | `10000` | Max seconds a 402 retry blocks before handing off to a receipt URL. |

## Sentry (optional)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SENTRY_DSN` | no | — | `https://<publicKey>@<host>/<projectId>`. Omit to disable. |
| `SENTRY_ENVIRONMENT` | no | `NODE_ENV` | Override the Sentry environment tag (canary, region, …). |
| `SENTRY_RELEASE` | no | — | Git SHA or semver tag; needed to attribute regressions to a deploy. |
| `SENTRY_TRACES_SAMPLE_RATE` | no | `0.1` | Performance sampling, `0`–`1`. |
| `SENTRY_PROFILES_SAMPLE_RATE` | no | `0` | CPU profiling sampling, `0`–`1`. |

## Cross-field rules enforced at boot

1. `WEBHOOK_SIGNATURE_BYPASS=true` is rejected when `NODE_ENV=production`.
2. `CARDS402_SECRET_BOX_KEY` is required when `NODE_ENV=production`.
3. Partial SMTP configuration is rejected (set all or none).
4. An `https://` `CARDS402_BASE_URL` on a non-local host requires
   `NODE_ENV=production` (guards against a production deploy running in
   dev mode). Local hostnames: `localhost`, `127.0.0.1`, `::1`, `*.local`,
   `*.localhost`, `*.test`.
