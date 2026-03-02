# VPS Xray Types, Secrets, and Storage Policy

## Scope

This document defines:

1. Canonical backend types for Xray Trojan config and user credential state.
2. Which data belongs in `ENV`, database (`Supabase`), VPS config file, or static code.
3. Request flow for issuing/revoking per-user credentials across multiple VPS nodes.

Canonical code types live in:

- `src/shared/lib/xray-config/index.ts`

## Multi-VPS Storage Policy

### `ENV` (global app/runtime settings only)

Keep only values shared by the backend process, not per-VPS rows:

- `XRAY_CONFIG_PATH` (default `/etc/xray/config.json`)
- `XRAY_TROJAN_DIRECT_TAG` (default `trojan-direct`)
- `XRAY_TROJAN_OBFS_TAG` (default `trojan-obfs`)
- `XRAY_TROJAN_DIRECT_PORT` (optional default fallback)
- `XRAY_TROJAN_OBFS_PORT` (optional default fallback)
- `XRAY_TLS_CERTIFICATE_FILE` (global fallback only)
- `XRAY_TLS_KEY_FILE` (global fallback only)
- `XRAY_CREDENTIAL_ROTATE_INTERVAL_MS` (optional scheduler)

### `DB` (per-VPS and per-user mutable state)

Store per-node, per-user, and business state in database:

- VPS identity:
  - `internal_uuid`, `country`, `country_emoji`, `domain`, `api_address`, `nickname`
- VPS connection/auth metadata:
  - `ssh_key` (ssh user/host key reference)
  - `password` / `optional_passsword` (should be encrypted at rest)
- Per-user credentials on each VPS:
  - `users_kv_map[userInternalUuid] = { passwordBase64, directUrl, obfsUrl, createdAt, active }`
- User subscription state:
  - `subscription_active`, `subscription_status`, `subscription_untill`

### VPS file (`/etc/xray/config.json`)

Operational runtime source for Xray:

- `inbounds[].settings.clients[]` (real active Trojan clients)
- `tlsSettings.certificates[]` concrete file paths used by Xray process

### Static code

Safe defaults and parsing logic:

- Xray schema validators (`zod`)
- URL rendering format
- deterministic tag mapping (`trojan-direct` / `trojan-obfs`)

## Sensitive Data Classification

### Highly sensitive (never log, avoid plaintext persistence where possible)

- Telegram secrets (`x-telegram-secret`, `x-telegram-bot-api-secret-token`)
- Admin secret (`x-admin-secret`)
- Supabase service role key
- Per-user generated Trojan password (raw value)
- VPS ssh password/private key material

### Medium sensitivity

- Generated Trojan URLs (equivalent to credentials for active period)
- `users_kv_map` content
- `reffered_by`, payouts, and referral balance data

### Low sensitivity

- Country, emoji, nickname, non-secret menu labels
- Public domains and non-secret ports

## Explicit Recommendation: do not randomize service ports at restart

Randomizing inbound ports every service restart breaks already-issued user URLs.
For production, keep inbound tags/ports stable per VPS and rotate only credentials.

## Target Flows

### Issue credentials when user requests VPS config

Preconditions:

- user has active subscription
- user has no active credentials for selected VPS in `users_kv_map`

Ordered steps:

1. Generate secure random password.
2. Add/update client in Xray config for **both** inbounds (`direct` + `obfs`) with:
   - `password`: generated password
   - `email`: `userInternalUuid`
3. Reload/restart Xray safely.
4. Generate two Trojan URLs (direct + obfs) using VPS domain and inbound ports.
5. Upsert `users_kv_map[userInternalUuid]`.
6. Optionally persist generated URLs into `config_list` if business requires it.
7. Return the two URLs to Telegram user.

### Revoke credentials when subscription expires

Preconditions:

- user is expired/inactive

Ordered steps:

1. Remove matching client (`email = userInternalUuid`) from both inbounds.
2. Reload/restart Xray safely.
3. Remove or mark inactive in `users_kv_map[userInternalUuid]`.
4. Remove user URLs from `config_list` if they were persisted there.

## API Contracts (proposed)

- `POST /api/vps/:internalUuid/credentials/issue`
  - body: `{ userInternalUuid }`
  - result: `{ directUrl, obfsUrl, created }`

- `POST /api/vps/credentials/revoke-expired`
  - trigger: cron/admin
  - result: summary counters (`checkedUsers`, `revokedCredentials`, `failed`).

- `POST /api/vps/:internalUuid/xray/sync`
  - admin-only reconciliation from DB state to VPS config state.

## Current Legacy Single-VPS ENV Keys

The following keys are legacy single-node assumptions and should be retired from runtime flow:

- `VPS_SSH_HOST`
- `VPS_SSH_PORT`
- `VPS_SSH_PASSWORD`
- `VPS_DOMAIN`
- `VPS_SYNC_TARGET_DOMAIN`

Multi-VPS path should resolve node-specific host/domain/auth from `public.vps`.
