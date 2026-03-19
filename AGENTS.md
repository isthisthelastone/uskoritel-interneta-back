BACKEND AGENT GUIDE

Scope:

- This file documents the live backend behavior for sync jobs, protocols, payments, and SSH/Xray integration.
- Keep this file updated when changing runtime logic.

Runtime Entry

- File: `src/server.ts`
- Startup order:
  1. `startVpsConnectionsSyncJob()`
  2. `startCryptoBotPaymentsSyncJob()`
  3. `startUserSyncJob()`
  4. Express listen

Core Services Map

- `src/services/vpsConnectionsSyncService.ts`
  - Main VPS telemetry sync.
  - Updates VPS health/speed/current connections.
  - Aggregates user connections/traffic across VPS.
- `src/services/userSyncService.ts`
  - Subscription lifecycle sync.
  - Marks users `live/ending/expired`, removes expired users from Xray+DB mappings, drops over-limit live IPs.
- `src/services/cryptoBotPaymentsSyncService.ts`
  - Polls active CryptoBot invoices and finalizes paid subscriptions.
- `src/services/vpsXrayService.ts`
  - Reads/modifies `/etc/xray/config.json` over SSH.
  - Adds/removes clients per protocol and reloads/restarts Xray.
- `src/services/vpsCatalogService.ts`
  - Generates/reuses user URLs per selected protocol.
  - Stores per-user protocol secrets/urls in `vps.users_kv_map`.
- `src/services/vpsSshService.ts`
  - SSH transport layer with password and private-key modes, binary fallback, timeouts, max buffer.

Protocols and Credential Model

Supported protocol IDs:

- `trojan`
- `trojan_obfuscated`
- `vless_ws`
- `shadowsocks`

Protocol routing/model details:

- Normal nodes: user chooses protocol; only selected protocol secret is created/ensured.
- Unblock nodes (`vps.isUnblock=true`): only `vless_ws` allowed.
- URL templates are taken from `vps.config_list`.
- User protocol secrets are persisted in `vps.users_kv_map`.

`users_kv_map` normalized model (effective):

- per user UUID key
- `protocols.<protocol>.secretBase64`
- `protocols.<protocol>.url`
- legacy compatibility still supported:
  - `passwordBase64`, `directUrl`, `obfsUrl`

Important cleanup rule:

- Trojan cleanup must handle clients with and without `email`.
- Current implementation removes Trojan by:
  - `email == userInternalUuid`
  - or matching known Trojan passwords from `users_kv_map`

Xray Removal Logic (critical)

- `removeVpsXrayUserFromAllProtocols` scans inbounds by protocol, not only fixed tags.
- Protocol mapping for deletion:
  - `protocol: trojan` => Trojan remover
  - `protocol: vless` => VLESS remover
  - `protocol: shadowsocks` => SS remover
- Config write path always runs Xray reload/restart fallback:
  - `systemctl reload xray || systemctl restart xray`
  - or `service xray ...`

VPS Sync Job (`vps-sync`)

File:

- `src/services/vpsConnectionsSyncService.ts`

Main responsibilities:

- Collect per VPS:
  - live socket snapshot (`ss`/`netstat`)
  - `xray api statsquery` traffic counters
  - Xray access logs/journal for user UUID + source IP
  - speed test (`iperf3` then `curl` fallback)
- Update `vps`:
  - `number_of_connections`
  - `current_speed`
  - `connection`
  - `disabled=false` on success
- Update `users`:
  - `number_of_connections`
  - `number_of_connections_last_month`
  - `connections_by_server`
  - `traffic_consumed_mb`
- Persist monthly deltas in:
  - `user_vps_traffic_monthly_state`

Connection counting behavior:

- VPS-level current connections:
  - uses unique socket keys `IP:local_port` from established sockets
  - counts same IP on different protocol ports separately
  - fallback with parsed log IP count via `effectiveActiveIps = max(socket_count, log_count)`
- User-level current connections:
  - primary: unique live IPs parsed from logs in current window
  - fallback: if stats delta indicates activity but no parsable IPs, use active-server count to avoid zeros
- `connections_by_server`:
  - primary value: per-server unique current IP count
  - fallback: set server value `1` if stats delta proves recent activity and logs are not parsable

Traffic robustness:

- `statsquery` parser supports:
  - multiline text output
  - inline text fallback regex
  - JSON `stat[]` fallback
- Monthly traffic uses monotonic delta state per `(vps,user)` key.

Abuse limiter:

- If unique live IPs exceed limit, drops matching socket connections via `ss -K`.

Env knobs:

- `VPS_CONNECTION_SYNC_ENABLED` (`false` disables)
- `VPS_CONNECTION_SYNC_INTERVAL_MS` (default `300000`)
- `VPS_USER_MAX_UNIQUE_IPS` (default `5`)
- `VPS_USER_IP_CURRENT_WINDOW_MINUTES` (default `20`)
- `XRAY_STATS_SERVER` (default `127.0.0.1:10085`)
- `XRAY_ACCESS_LOG_PATH` (default `/var/log/xray/access.log`)
- `XRAY_ACCESS_LOG_TAIL_LINES` (default `5000`)
- `VPS_SYNC_SPEEDTEST_TARGET_HOST` (default `speedtest.myloc.de`)
- `VPS_SYNC_SPEEDTEST_TARGET_URL` (default `http://speedtest.myloc.de/files/100mb.bin`)
- `VPS_SYNC_SPEEDTEST_IPERF_PORT` (default `5200`)
- `VPS_SYNC_SPEEDTEST_IPERF_DURATION_SECONDS` (default `5`)
- `VPS_SYNC_VERBOSE` (`true` enables debug logs)
- `VPS_UNBLOCK_SSH_USER` (default `unluckypleasure`)

User Sync Job (`user-sync`)

File:

- `src/services/userSyncService.ts`

Main responsibilities:

- Update subscription state from `subscription_untill`:
  - expired (`< today UTC`): `subscription_active=false`, `subscription_status=null`
  - <=3 days left: `subscription_status=ending`
  - otherwise: `subscription_status=live`
- Remove expired users from all VPS:
  - remove from Xray all protocols
  - remove from `vps.users_kv_map`
  - remove generated URLs from `vps.config_list`
  - drop live sockets for the user
- Enforce live IP limit (`USER_SYNC_MAX_UNIQUE_IPS`) by dropping sockets.
- Update live user connection stats only for users seen in current live map (prevents false zeroing).

Env knobs:

- `USER_SYNC_ENABLED` (`false` disables)
- `USER_SYNC_TIMING` (default `3600000`)
- `USER_SYNC_MAX_UNIQUE_IPS` (default `5`)
- `USER_SYNC_CURRENT_WINDOW_MINUTES` (default `20`)
- `USER_SYNC_VERBOSE` (`true` enables debug logs)
- `XRAY_ACCESS_LOG_PATH` / `XRAY_ACCESS_LOG_TAIL_LINES` shared with VPS sync
- `VPS_UNBLOCK_SSH_USER` shared

CryptoBot Sync Job (`cryptobot-sync`)

Files:

- `src/services/cryptoBotService.ts`
- `src/services/cryptoBotPaymentsSyncService.ts`

Main responsibilities:

- Create invoices in CryptoBot API and save to `crypto_bot_invoices`.
- Poll active invoices in batches and normalize statuses:
  - `active`, `paid`, `expired`, `cancelled`, `failed`
- On paid:
  - finalize subscription via `finalizeTelegramPaidSubscriptionPurchase`
  - apply referral reward
  - update invoice row to paid
  - notify user in Telegram
- Supports manual check/cancel paths from Telegram webhook flow.

Env knobs:

- `CRYPTO_BOT_API` (required to enable sync)
- `CRYPTO_BOT_API_BASE_URL` (default `https://pay.crypt.bot/api`)
- `CRYPTO_BOT_SYNC_ENABLED` (`false` disables)
- `CRYPTO_BOT_SYNC_INTERVAL_MS` (default `60000`, min `10000`)
- `CRYPTO_BOT_DEBUG_LOGS` (`true` enables debug logs)

SSH Layer Notes

File:

- `src/services/vpsSshService.ts`

Capabilities:

- Supports password auth and private key auth.
- Accepts:
  - private key path
  - inline OpenSSH private key
  - base64-encoded private key
- Detects and rejects public key in private-key field.
- SSH binary fallback order:
  - `VPS_SSH_BINARY_PATH` (if set)
  - `ssh`, `/usr/bin/ssh`, `/bin/ssh`, `/usr/local/bin/ssh`
- Throws explicit error if SSH client missing in runtime image.

Key env knobs:

- `VPS_SSH_BINARY_PATH`
- `VPS_SSH_CONNECT_TIMEOUT_SECONDS` (default `30`)
- `VPS_SSH_EXEC_TIMEOUT_MS` (default `30000`)
- `VPS_SSH_MAX_BUFFER_BYTES` (default `33554432`)

Production Invariants (Do Not Break)

- Do not reset `users.number_of_connections` / `connections_by_server` to zero when logs are temporarily empty.
- Keep dual-source strategy for user activity:
  - log parsing for IP fidelity
  - stats delta fallback for resilience
- Keep Trojan deletion by both UUID/email and password (legacy + mixed configs).
- Keep Xray API stats components (`api`, `policy`, `stats`) on nodes where traffic sync is expected.
- Do not remove monthly state logic (`user_vps_traffic_monthly_state`) unless replaced with equivalent delta-safe mechanism.

When adding/changing protocol behavior

Update all of:

- `vpsCatalogService` protocol enum/template pickers/URL builders
- `vpsXrayService` ensure/remove logic
- `userSyncService` cleanup extraction for secrets
- `vpsConnectionsSyncService` log/stats parsing assumptions (if protocol tags/fields differ)

Quick Verification Checklist After Deploy

1. Startup logs show:

- `[vps-sync] starting ...`
- `[cryptobot-sync] starting ...`
- `[user-sync] starting ...`

2. `vps.number_of_connections` changes from sync cycles.
3. `users.number_of_connections`, `users.number_of_connections_last_month`, `users.connections_by_server` are no longer all zero/empty.
4. Expired user loses all protocol access (Trojan/VLESS/SS).
5. Paid CryptoBot invoice moves out of active and updates subscription.
