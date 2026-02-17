# uskoritel-interneta-back

Backend for Uskoritel Interneta VPN service.  
Stack: Bun + Express + TypeScript + Zod + Supabase + Telegram Bot webhook.

## Main Workflow

1. `index.ts` loads env from `src/config/.env` using `loadEnvFromConfigFile()`.
2. `createApp()` builds Express app with:
   - `helmet`
   - `cors`
   - `express-rate-limit`
   - `pino`/`pino-http`
3. API routes are registered and server starts from `src/server.ts`.

## Current Routes

- `GET /health`
  - Basic health check.
- `GET /api/telegram/menu`
  - Protected with Telegram secret header.
  - Returns current menu payload JSON.
- `POST /api/telegram/menu`
  - Telegram webhook endpoint.
  - Handles `/start` and `/menu`.
  - Sends inline keyboard to Telegram user.
  - Handles callback queries and updates menu message.
- `GET /api/vps/ssh/test`
  - Protected with `x-admin-secret` (must match `AUTH_JWT_SECRET`).
  - Tests backend SSH connection to VPS (`hostname` + `whoami`).

## Telegram Flow

### Security gates

- Webhook secret is required:
  - `x-telegram-bot-api-secret-token` (Telegram standard) or `x-telegram-secret`.
- Commands are sanitized:
  - malformed command rejection
  - command args rejection
  - suspicious ID-injection pattern rejection
  - optional bot mention validation via `BOT_USERNAME`
- Only private chats are handled.
- Callback ownership is validated for private chat callbacks.

### User sync with database

On `/start` and `/menu`:

1. Read Telegram user identity (`from.id`, `from.username`).
2. `ensureTelegramUser()` in `src/services/telegramUserService.ts`:
   - if user missing: insert into `public.users`
   - if user exists: fetch and refresh nickname when changed
3. Subscription state from DB maps to menu status:
   - `live` -> `active`
   - `ending` -> `trial`
   - no subscription -> `expired`

## Supabase Workflow

### Migrations

All SQL migrations are under `../supabase/migrations`.

Current migrations:

- `20260217123000_create_users_table.sql`
- `20260217131000_create_vps_table.sql`

### Tables in use

- `public.users`
  - Telegram identity + subscription + traffic/connections counters.
- `public.vps`
  - VPS metadata (country, domain, API address, ssh/password fields, config templates).

### Supabase admin client

- `src/lib/supabaseAdmin.ts`
- Uses:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`

## SSH / VPS Workflow

### Backend SSH config envs

- `VPS_SSH_HOST`
- `VPS_SSH_PORT` (default 22)
- `VPS_SSH_USER`
- `VPS_SSH_PASSWORD` (for password auth via `sshpass`)
- `VPS_SSH_PRIVATE_KEY_PATH` (preferred for key auth)
- `VPS_DOMAIN`

### Backend SSH service

- `src/services/vpsSshService.ts`
- Executes remote commands through:
  - `sshpass + ssh` when password is configured
  - plain `ssh` when key auth is configured
- Enforces connection timeout and basic options.

### VPS command toolkit

Operational scripts are in `../vps-commands`:

- SSH key generation/install
- Xray/Trojan bootstrap
- Add/rotate/remove Trojan users
- Traffic stats and sharing heuristics

## Local Development

Install deps:

```bash
bun install
```

Run backend:

```bash
bun run index.ts
```

Run strict checks + lint + prettier fix:

```bash
bun run fix
```

## Supabase Types Generation

Generate TS types from current remote Supabase project:

```bash
set -a
. ./src/config/.env
set +a
supabase gen types typescript --project-id "$SUPABASE_PROJECT_ID" --schema public > src/types/supabase.generated.ts
```

If `supabase` CLI is not installed, use one-off runner:

```bash
set -a
. ./src/config/.env
set +a
bunx supabase gen types typescript --project-id "$SUPABASE_PROJECT_ID" --schema public > src/types/supabase.generated.ts
```
