import { z } from "zod";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin";
import { parseJsonSafe } from "../shared";

const cryptoBotApiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().optional(),
      name: z.string().optional(),
    })
    .optional(),
});

const cryptoBotInvoiceSchema = z.object({
  invoice_id: z.number().int().positive(),
  status: z.string(),
  bot_invoice_url: z.string().min(1).optional(),
  pay_url: z.string().min(1).optional(),
  hash: z.string().min(1).optional(),
});

const cryptoBotDbInvoiceSchema = z.object({
  internal_uuid: z.uuid(),
  invoice_id: z.number().int().positive(),
  tg_id: z.string(),
  months: z.number().int().positive(),
  amount_usd: z.union([z.number(), z.string()]),
  status: z.string(),
  bot_invoice_url: z.string(),
});

export type CryptoBotInvoiceStatus =
  | "active"
  | "processing"
  | "paid"
  | "expired"
  | "failed"
  | "cancelled";

export interface CryptoBotInvoiceRecord {
  internalUuid: string;
  invoiceId: number;
  tgId: string;
  months: number;
  amountUsd: number;
  status: CryptoBotInvoiceStatus;
  botInvoiceUrl: string;
}

export interface CryptoBotRemoteInvoice {
  invoiceId: number;
  status: string;
  botInvoiceUrl: string;
  raw: unknown;
}

interface CreateCryptoBotSubscriptionInvoiceInput {
  tgId: string;
  months: number;
  amountUsd: number;
}

const cryptoBotDebugLogsEnabled =
  process.env.CRYPTO_BOT_DEBUG_LOGS?.trim().toLowerCase() === "true";

function logCryptoBotDebug(event: string, data?: Record<string, unknown>): void {
  if (!cryptoBotDebugLogsEnabled) {
    return;
  }

  if (data === undefined) {
    console.log("[cryptobot-debug]", event);
    return;
  }

  console.log("[cryptobot-debug]", event, JSON.stringify(data));
}

function getCryptoBotApiToken(): string {
  const token = process.env.CRYPTO_BOT_API?.trim();

  if (token === undefined || token.length === 0) {
    throw new Error("CRYPTO_BOT_API is not configured.");
  }

  return token;
}

function getCryptoBotApiBaseUrl(): string {
  return (process.env.CRYPTO_BOT_API_BASE_URL ?? "https://pay.crypt.bot/api").replace(/\/+$/u, "");
}

function parseAmountUsd(rawAmount: number | string): number {
  const parsedAmount = typeof rawAmount === "number" ? rawAmount : Number.parseFloat(rawAmount);

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    throw new Error("Invalid amount_usd value in crypto_bot_invoices row.");
  }

  return Math.round(parsedAmount * 100) / 100;
}

function normalizeStatus(rawStatus: string): CryptoBotInvoiceStatus {
  if (rawStatus === "active") {
    return "active";
  }

  if (rawStatus === "processing") {
    return "processing";
  }

  if (rawStatus === "paid") {
    return "paid";
  }

  if (rawStatus === "expired") {
    return "expired";
  }

  if (rawStatus === "cancelled" || rawStatus === "canceled") {
    return "cancelled";
  }

  return "failed";
}

function buildInvoiceUrl(rawInvoice: z.infer<typeof cryptoBotInvoiceSchema>): string {
  if (rawInvoice.bot_invoice_url !== undefined && rawInvoice.bot_invoice_url.length > 0) {
    return rawInvoice.bot_invoice_url;
  }

  if (rawInvoice.pay_url !== undefined && rawInvoice.pay_url.length > 0) {
    return rawInvoice.pay_url;
  }

  if (rawInvoice.hash !== undefined && rawInvoice.hash.length > 0) {
    return "https://t.me/CryptoBot?start=" + rawInvoice.hash;
  }

  return "";
}

const getInvoicesResultSchema = z.union([
  z.array(cryptoBotInvoiceSchema),
  z.object({
    items: z.array(cryptoBotInvoiceSchema),
  }),
  z.object({
    invoices: z.array(cryptoBotInvoiceSchema),
  }),
]);

function extractInvoicesFromGetInvoicesResult(
  rawResult: unknown,
): z.infer<typeof cryptoBotInvoiceSchema>[] {
  const parsedResult = getInvoicesResultSchema.safeParse(rawResult);

  if (!parsedResult.success) {
    throw new Error(JSON.stringify(parsedResult.error.issues));
  }

  if (Array.isArray(parsedResult.data)) {
    return parsedResult.data;
  }

  if ("items" in parsedResult.data) {
    return parsedResult.data.items;
  }

  return parsedResult.data.invoices;
}

function mapDbInvoice(rawRow: unknown): CryptoBotInvoiceRecord {
  const parsedRow = cryptoBotDbInvoiceSchema.parse(rawRow);

  return {
    internalUuid: parsedRow.internal_uuid,
    invoiceId: parsedRow.invoice_id,
    tgId: parsedRow.tg_id,
    months: parsedRow.months,
    amountUsd: parseAmountUsd(parsedRow.amount_usd),
    status: normalizeStatus(parsedRow.status),
    botInvoiceUrl: parsedRow.bot_invoice_url,
  };
}

async function postCryptoBotApi(
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  logCryptoBotDebug("api_request", { method, payloadKeys: Object.keys(payload) });
  const response = await fetch(getCryptoBotApiBaseUrl() + "/" + method, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "crypto-pay-api-token": getCryptoBotApiToken(),
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  const parsedResponse = responseText.length > 0 ? parseJsonSafe(responseText) : null;
  logCryptoBotDebug("api_response", {
    method,
    status: response.status,
    ok: response.ok,
    bodySample: responseText.slice(0, 300),
  });

  if (!response.ok) {
    throw new Error("CryptoBot API HTTP error " + String(response.status) + ": " + responseText);
  }

  const parsedApiResponse = cryptoBotApiResponseSchema.safeParse(parsedResponse);

  if (!parsedApiResponse.success) {
    throw new Error("Invalid CryptoBot API response shape.");
  }

  if (!parsedApiResponse.data.ok) {
    const errorName = parsedApiResponse.data.error?.name ?? "UNKNOWN";
    const errorCode =
      parsedApiResponse.data.error?.code !== undefined
        ? String(parsedApiResponse.data.error.code)
        : "UNKNOWN";

    throw new Error("CryptoBot API error " + errorName + " (" + errorCode + ").");
  }

  return parsedApiResponse.data.result;
}

export async function createCryptoBotSubscriptionInvoice(
  input: CreateCryptoBotSubscriptionInvoiceInput,
): Promise<{ invoiceId: number; botInvoiceUrl: string }> {
  if (!Number.isInteger(input.months) || input.months <= 0) {
    throw new Error("Invalid months value for CryptoBot invoice.");
  }

  if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    throw new Error("Invalid amountUsd value for CryptoBot invoice.");
  }

  const amountUsdRounded = Math.round(input.amountUsd * 100) / 100;
  logCryptoBotDebug("create_invoice_start", {
    tgId: input.tgId,
    months: input.months,
    amountUsd: amountUsdRounded,
  });
  const result = await postCryptoBotApi("createInvoice", {
    currency_type: "fiat",
    fiat: "USD",
    amount: amountUsdRounded.toFixed(2),
    description:
      "VPN subscription for " + String(input.months) + " month" + (input.months === 1 ? "" : "s"),
    payload: JSON.stringify({
      action: "subscription",
      tgId: input.tgId,
      months: input.months,
    }),
  });

  const parsedInvoice = cryptoBotInvoiceSchema.parse(result);
  const invoiceUrl = buildInvoiceUrl(parsedInvoice);

  if (invoiceUrl.length === 0) {
    throw new Error("CryptoBot createInvoice returned invoice without URL.");
  }
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase.from("crypto_bot_invoices").upsert(
    {
      invoice_id: parsedInvoice.invoice_id,
      tg_id: input.tgId,
      months: input.months,
      amount_usd: amountUsdRounded,
      status: normalizeStatus(parsedInvoice.status),
      bot_invoice_url: invoiceUrl,
      raw_payload: result,
      last_error: null,
      paid_at: null,
    },
    {
      onConflict: "invoice_id",
    },
  );

  if (error !== null) {
    throw new Error("Failed to save CryptoBot invoice to DB: " + error.message);
  }

  logCryptoBotDebug("create_invoice_saved", {
    tgId: input.tgId,
    invoiceId: parsedInvoice.invoice_id,
    status: normalizeStatus(parsedInvoice.status),
  });

  return {
    invoiceId: parsedInvoice.invoice_id,
    botInvoiceUrl: invoiceUrl,
  };
}

export async function listActiveCryptoBotInvoices(limit = 100): Promise<CryptoBotInvoiceRecord[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("crypto_bot_invoices")
    .select("internal_uuid, invoice_id, tg_id, months, amount_usd, status, bot_invoice_url")
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(safeLimit);

  if (error !== null) {
    throw new Error("Failed to fetch active CryptoBot invoices: " + error.message);
  }

  return data.map((rawRow) => mapDbInvoice(rawRow));
}

export async function getActiveCryptoBotInvoiceByTgId(
  tgId: string,
): Promise<CryptoBotInvoiceRecord | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("crypto_bot_invoices")
    .select("internal_uuid, invoice_id, tg_id, months, amount_usd, status, bot_invoice_url")
    .eq("tg_id", tgId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch active CryptoBot invoice by tg_id: " + error.message);
  }

  if (data === null) {
    logCryptoBotDebug("active_invoice_lookup", { tgId, found: false });
    return null;
  }

  logCryptoBotDebug("active_invoice_lookup", { tgId, found: true, invoiceId: data.invoice_id });
  return mapDbInvoice(data);
}

export async function getCryptoBotInvoiceByInvoiceId(
  invoiceId: number,
): Promise<CryptoBotInvoiceRecord | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("crypto_bot_invoices")
    .select("internal_uuid, invoice_id, tg_id, months, amount_usd, status, bot_invoice_url")
    .eq("invoice_id", invoiceId)
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to fetch CryptoBot invoice by invoice_id: " + error.message);
  }

  if (data === null) {
    return null;
  }

  return mapDbInvoice(data);
}

export async function claimCryptoBotInvoiceProcessing(internalUuid: string): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("crypto_bot_invoices")
    .update({
      status: "processing",
      last_error: null,
    })
    .eq("internal_uuid", internalUuid)
    .eq("status", "active")
    .select("internal_uuid")
    .maybeSingle();

  if (error !== null) {
    throw new Error("Failed to claim CryptoBot invoice for processing: " + error.message);
  }

  return data !== null;
}

export async function updateCryptoBotInvoiceAfterPaid(params: {
  internalUuid: string;
  rawPayload: unknown;
}): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("crypto_bot_invoices")
    .update({
      status: "paid",
      raw_payload: params.rawPayload,
      last_error: null,
      paid_at: new Date().toISOString(),
    })
    .eq("internal_uuid", params.internalUuid);

  if (error !== null) {
    throw new Error("Failed to set CryptoBot invoice as paid: " + error.message);
  }
}

export async function updateCryptoBotInvoiceStatus(params: {
  internalUuid: string;
  status: CryptoBotInvoiceStatus;
  rawPayload: unknown;
  lastError?: string | null;
}): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("crypto_bot_invoices")
    .update({
      status: params.status,
      raw_payload: params.rawPayload,
      last_error: params.lastError ?? null,
      paid_at: params.status === "paid" ? new Date().toISOString() : null,
    })
    .eq("internal_uuid", params.internalUuid);

  if (error !== null) {
    throw new Error("Failed to update CryptoBot invoice status: " + error.message);
  }
}

export async function getRemoteCryptoBotInvoicesByIds(
  invoiceIds: number[],
): Promise<CryptoBotRemoteInvoice[]> {
  if (invoiceIds.length === 0) {
    return [];
  }

  const result = await postCryptoBotApi("getInvoices", {
    invoice_ids: invoiceIds.join(","),
  });
  const parsedInvoices = extractInvoicesFromGetInvoicesResult(result);

  return parsedInvoices.map((invoice) => ({
    invoiceId: invoice.invoice_id,
    status: invoice.status,
    botInvoiceUrl: buildInvoiceUrl(invoice),
    raw: invoice,
  }));
}

export async function cancelRemoteCryptoBotInvoice(invoiceId: number): Promise<unknown> {
  logCryptoBotDebug("cancel_invoice_start", { invoiceId });
  return postCryptoBotApi("deleteInvoice", {
    invoice_id: invoiceId,
  });
}
