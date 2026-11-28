import "server-only";
import { GoogleGenAI } from "@google/genai";
import { env } from "../../config/env";
import {
  decryptSecret,
  fingerprintKey,
  maskApiKey,
} from "../../security/crypto";

export const MAX_ATTEMPTS_PER_REQUEST = 6;
export const TOTAL_REQUEST_BUDGET_MS = 50_000;
export const PER_MINUTE_COOLDOWN_MS = 60_000;
export const DAILY_QUOTA_COOLDOWN_MS = 15 * 60_000;
export const TRANSIENT_BACKOFF_BASE_MS = [1_500, 4_000, 9_000] as const;

export type GeminiErrorCategory =
  | "quota"
  | "invalid_key"
  | "model_unavailable"
  | "timeout"
  | "bad_json"
  | "blocked"
  | "transient";

export type KeySource = "system" | "teacher";

export interface ManagedKey {
  apiKey: string;
  source: KeySource;
  fingerprint: string;
  masked: string;
}

export interface ClassifiedGeminiError {
  category: GeminiErrorCategory;
  isDailyQuota: boolean;
  modelFallbackReason?: "model_not_found" | "overloaded";
  statusCode?: number;
  safeMessage: string;
}

export interface KeyRuntimeStatus {
  status: "active" | "cooldown" | "invalid";
  cooldownUntil?: number;
  isDailyQuota?: boolean;
  reason?: string;
}

export interface KeyAttemptLog {
  source: KeySource;
  fingerprint: string;
  masked: string;
  model: string;
  attempt: number;
  ok: boolean;
  category?: GeminiErrorCategory;
}

export interface ExecuteWithKeyManagerParams<T> {
  teacherEncryptedKeys?: string[];
  systemKeysOverride?: string[];
  primaryModel?: string;
  maxAttempts?: number;
  totalBudgetMs?: number;
  run: (ctx: {
    apiKey: string;
    model: string;
    signal: AbortSignal;
    attempt: number;
    source: KeySource;
    fingerprint: string;
  }) => Promise<T>;
}

export interface ExecuteWithKeyManagerResult<T> {
  value: T;
  model: string;
  source: KeySource;
  fingerprint: string;
  attempts: KeyAttemptLog[];
}

export class AllGeminiKeysFailedError extends Error {
  readonly attempts: KeyAttemptLog[];
  readonly invalidTeacherFingerprints: string[];
  readonly quotaFingerprints: string[];
  readonly lastCategory?: GeminiErrorCategory;

  constructor(
    message: string,
    details: {
      attempts: KeyAttemptLog[];
      invalidTeacherFingerprints: string[];
      quotaFingerprints: string[];
      lastCategory?: GeminiErrorCategory;
    }
  ) {
    super(message);
    this.name = "AllGeminiKeysFailedError";
    this.attempts = details.attempts;
    this.invalidTeacherFingerprints = details.invalidTeacherFingerprints;
    this.quotaFingerprints = details.quotaFingerprints;
    this.lastCategory = details.lastCategory;
  }
}

function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as Record<string, unknown>;
  for (const field of ["status", "statusCode", "code"]) {
    const val = record[field];
    if (typeof val === "number" && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === "string" && /^\d{3}$/.test(val)) {
      return Number(val);
    }
  }
  return undefined;
}

function extractSafeErrorMessage(err: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message;
  } else if (
    err &&
    typeof err === "object" &&
    typeof (err as Record<string, unknown>).message === "string"
  ) {
    raw = (err as Record<string, unknown>).message as string;
  } else {
    raw = String(err ?? "Unknown error");
  }
  // Redact any Google AIza... key fragments if an upstream SDK ever echoes them
  return raw.replace(/AIza[0-9A-Za-z_-]{10,}/g, "AIza••••");
}

/**
 * Classifies Gemini SDK / HTTP / parsing errors into actionable categories.
 */
export function classifyGeminiError(err: unknown): ClassifiedGeminiError {
  const statusCode = extractStatusCode(err);
  const safeMessage = extractSafeErrorMessage(err);
  const lower = safeMessage.toLowerCase();
  const errName = err instanceof Error ? err.name.toLowerCase() : "";

  // Timeout / Abort
  if (
    errName === "aborterror" ||
    lower.includes("aborted") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("etimedout")
  ) {
    return {
      category: "timeout",
      isDailyQuota: false,
      statusCode,
      safeMessage,
    };
  }

  // Bad JSON / Schema
  if (
    err instanceof SyntaxError ||
    lower.includes("json") ||
    lower.includes("skema") ||
    lower.includes("respons kosong")
  ) {
    return {
      category: "bad_json",
      isDailyQuota: false,
      statusCode,
      safeMessage,
    };
  }

  // Safety / Content blocked
  if (
    lower.includes("safety") ||
    lower.includes("blocked") ||
    lower.includes("prohibited_content") ||
    lower.includes("recitation") ||
    lower.includes("candidate was blocked")
  ) {
    return {
      category: "blocked",
      isDailyQuota: false,
      statusCode,
      safeMessage,
    };
  }

  // Quota (429)
  if (
    statusCode === 429 ||
    lower.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    const isDailyQuota =
      lower.includes("daily") ||
      lower.includes("per day") ||
      lower.includes("perday") ||
      lower.includes("rpd") ||
      lower.includes("requestsperday");
    return {
      category: "quota",
      isDailyQuota,
      statusCode: statusCode ?? 429,
      safeMessage,
    };
  }

  // Invalid key (400/401/403)
  if (
    statusCode === 400 ||
    statusCode === 401 ||
    statusCode === 403 ||
    lower.includes("api_key_invalid") ||
    lower.includes("api key not valid") ||
    lower.includes("invalid api key") ||
    lower.includes("permission_denied") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return {
      category: "invalid_key",
      isDailyQuota: false,
      statusCode,
      safeMessage,
    };
  }

  // Model not found / permanently unavailable (404) -> immediate fallback model, no retry/cooldown
  if (
    statusCode === 404 ||
    lower.includes("model_not_found") ||
    lower.includes("model not found") ||
    (lower.includes("not_found") && lower.includes("model")) ||
    lower.includes("no longer available")
  ) {
    return {
      category: "model_unavailable",
      isDailyQuota: false,
      modelFallbackReason: "model_not_found",
      statusCode: statusCode ?? 404,
      safeMessage,
    };
  }

  // Overloaded / 503
  if (
    statusCode === 503 ||
    lower.includes("overloaded") ||
    lower.includes("unavailable") ||
    lower.includes("high demand")
  ) {
    return {
      category: "transient",
      isDailyQuota: false,
      modelFallbackReason: "overloaded",
      statusCode: statusCode ?? 503,
      safeMessage,
    };
  }

  // Other 5xx / network errors -> transient
  return {
    category: "transient",
    isDailyQuota: false,
    statusCode,
    safeMessage,
  };
}

/**
 * Collects system keys first (`GEMINI_API_KEY` + comma-separated `GEMINI_API_KEYS`),
 * then decrypted teacher keys in saved order, deduplicated by key value.
 */
export function resolveCandidateKeys(
  teacherEncryptedKeys: string[] = [],
  systemKeysOverride?: string[]
): ManagedKey[] {
  const systemRaw =
    systemKeysOverride !== undefined
      ? systemKeysOverride
      : [
          env.GEMINI_API_KEY ?? "",
          ...(process.env.GEMINI_API_KEYS ?? "").split(","),
        ];

  const seenFingerprints = new Set<string>();
  const result: ManagedKey[] = [];

  const pushKey = (raw: string, source: KeySource) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const fp = fingerprintKey(trimmed);
    if (seenFingerprints.has(fp)) return;
    seenFingerprints.add(fp);
    result.push({
      apiKey: trimmed,
      source,
      fingerprint: fp,
      masked: maskApiKey(trimmed),
    });
  };

  for (const sysKey of systemRaw) {
    pushKey(sysKey, "system");
  }

  for (const encKey of teacherEncryptedKeys) {
    if (!encKey || typeof encKey !== "string") continue;
    try {
      const plain = decryptSecret(encKey);
      pushKey(plain, "teacher");
    } catch {
      // Skip corrupted/undecryptable key without crashing
    }
  }

  return result;
}

/**
 * Kebijakan model terverifikasi: hanya model yang pernah menjawab 200 OK
 * dengan key produksi yang boleh masuk rantai (`gemini-3.8-flash` -> `gemini-3.5-flash-lite`).
 * Dilarang menambahkan model berdasarkan asumsi ketersediaan.
 */
function getFallbackModel(primaryModel: string): string | null {
  if (primaryModel !== "gemini-3.5-flash-lite") {
    return "gemini-3.5-flash-lite";
  }
  return null;
}

export function getModelChain(primaryModel = env.GEMINI_MODEL): string[] {
  const fallback = getFallbackModel(primaryModel);
  return fallback ? [primaryModel, fallback] : [primaryModel];
}

export interface KeyManagerOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class KeyManager {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly cooldowns = new Map<
    string,
    { until: number; isDailyQuota: boolean }
  >();
  private readonly invalidKeys = new Map<string, string>();

  constructor(options: KeyManagerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? (() => Math.random());
  }

  getKeyStatus(fingerprint: string): KeyRuntimeStatus {
    const invalidReason = this.invalidKeys.get(fingerprint);
    if (invalidReason !== undefined) {
      return { status: "invalid", reason: invalidReason };
    }
    const cd = this.cooldowns.get(fingerprint);
    if (cd && cd.until > this.now()) {
      return {
        status: "cooldown",
        cooldownUntil: cd.until,
        isDailyQuota: cd.isDailyQuota,
      };
    }
    if (cd) {
      this.cooldowns.delete(fingerprint);
    }
    return { status: "active" };
  }

  markInvalid(fingerprint: string, reason = "API key tidak valid"): void {
    this.invalidKeys.set(fingerprint, reason);
  }

  markCooldown(fingerprint: string, isDailyQuota: boolean): number {
    const duration = isDailyQuota
      ? DAILY_QUOTA_COOLDOWN_MS
      : PER_MINUTE_COOLDOWN_MS;
    const until = this.now() + duration;
    this.cooldowns.set(fingerprint, { until, isDailyQuota });
    return until;
  }

  clearKeyState(fingerprint: string): void {
    this.invalidKeys.delete(fingerprint);
    this.cooldowns.delete(fingerprint);
  }

  async execute<T>(
    params: ExecuteWithKeyManagerParams<T>
  ): Promise<ExecuteWithKeyManagerResult<T>> {
    const maxAttempts = params.maxAttempts ?? MAX_ATTEMPTS_PER_REQUEST;
    const totalBudgetMs = params.totalBudgetMs ?? TOTAL_REQUEST_BUDGET_MS;
    const primaryModel = params.primaryModel ?? env.GEMINI_MODEL;
    const startedAt = this.now();

    const allKeys = resolveCandidateKeys(
      params.teacherEncryptedKeys,
      params.systemKeysOverride
    );

    const eligibleKeys = allKeys.filter(
      (k) => this.getKeyStatus(k.fingerprint).status === "active"
    );

    const attempts: KeyAttemptLog[] = [];
    const invalidTeacherFingerprints: string[] = [];
    const quotaFingerprints: string[] = [];
    let lastCategory: GeminiErrorCategory | undefined;

    if (eligibleKeys.length === 0) {
      throw new AllGeminiKeysFailedError(
        allKeys.length === 0
          ? "Tidak ada API key Gemini yang tersedia."
          : "Semua API key Gemini sedang dalam masa tunggu kuota atau tidak valid.",
        {
          attempts,
          invalidTeacherFingerprints,
          quotaFingerprints,
          lastCategory: allKeys.length > 0 ? "quota" : undefined,
        }
      );
    }

    let attemptCount = 0;

    for (const keyEntry of eligibleKeys) {
      if (attemptCount >= maxAttempts) break;
      const elapsed = this.now() - startedAt;
      if (elapsed >= totalBudgetMs) break;

      let currentModel = primaryModel;
      let transientRetriesForKey = 0;
      let modelFallbackUsedForKey = false;

      while (attemptCount < maxAttempts) {
        const remainingBudget = totalBudgetMs - (this.now() - startedAt);
        if (remainingBudget <= 0) break;

        attemptCount += 1;
        const controller = new AbortController();
        const budgetTimer = setTimeout(() => controller.abort(), remainingBudget);

        try {
          const value = await params.run({
            apiKey: keyEntry.apiKey,
            model: currentModel,
            signal: controller.signal,
            attempt: attemptCount,
            source: keyEntry.source,
            fingerprint: keyEntry.fingerprint,
          });
          clearTimeout(budgetTimer);

          attempts.push({
            source: keyEntry.source,
            fingerprint: keyEntry.fingerprint,
            masked: keyEntry.masked,
            model: currentModel,
            attempt: attemptCount,
            ok: true,
          });

          return {
            value,
            model: currentModel,
            source: keyEntry.source,
            fingerprint: keyEntry.fingerprint,
            attempts,
          };
        } catch (err) {
          clearTimeout(budgetTimer);
          const classified = classifyGeminiError(err);
          lastCategory = classified.category;

          attempts.push({
            source: keyEntry.source,
            fingerprint: keyEntry.fingerprint,
            masked: keyEntry.masked,
            model: currentModel,
            attempt: attemptCount,
            ok: false,
            category: classified.category,
          });

          console.warn(
            `Gemini attempt #${attemptCount} failed (${keyEntry.source} ${keyEntry.masked}, model=${currentModel}, category=${classified.category}):`,
            classified.safeMessage
          );

          if (classified.category === "quota") {
            this.markCooldown(keyEntry.fingerprint, classified.isDailyQuota);
            quotaFingerprints.push(keyEntry.fingerprint);
            break; // Move to next key
          }

          if (classified.category === "invalid_key") {
            this.markInvalid(keyEntry.fingerprint, classified.safeMessage);
            if (keyEntry.source === "teacher") {
              invalidTeacherFingerprints.push(keyEntry.fingerprint);
            }
            break; // Move to next key
          }

          // Model unavailable (404) -> never retry same model, never cooldown key; switch immediately
          if (classified.category === "model_unavailable") {
            if (!modelFallbackUsedForKey) {
              const fallback = getFallbackModel(currentModel);
              if (fallback && attemptCount < maxAttempts) {
                modelFallbackUsedForKey = true;
                currentModel = fallback;
                continue;
              }
            }
            break;
          }

          // Transient / overloaded (503, 5xx, timeout) -> exponential backoff (1.5s -> 4s -> 9s ±25%)
          if (
            (classified.category === "transient" ||
              classified.category === "timeout") &&
            transientRetriesForKey < TRANSIENT_BACKOFF_BASE_MS.length &&
            attemptCount < maxAttempts
          ) {
            const baseDelay = TRANSIENT_BACKOFF_BASE_MS[transientRetriesForKey]!;
            const jitterFactor = 0.75 + this.random() * 0.5;
            const waitMs = Math.round(baseDelay * jitterFactor);
            const left = totalBudgetMs - (this.now() - startedAt);
            if (left > waitMs) {
              transientRetriesForKey += 1;
              await this.sleep(waitMs);
              continue;
            }
          }

          // After retries (or insufficient budget), fall back model if overloaded
          if (classified.modelFallbackReason && !modelFallbackUsedForKey) {
            const fallback = getFallbackModel(currentModel);
            if (fallback && attemptCount < maxAttempts) {
              modelFallbackUsedForKey = true;
              currentModel = fallback;
              continue;
            }
          }

          // timeout, bad_json, blocked, or exhausted retries for this key -> next key
          break;
        }
      }
    }

    throw new AllGeminiKeysFailedError(
      "Seluruh percobaan Gemini API gagal atau melewati batas waktu.",
      {
        attempts,
        invalidTeacherFingerprints,
        quotaFingerprints,
        lastCategory,
      }
    );
  }
}

export const defaultKeyManager = new KeyManager();

export interface VerifyGeminiKeyResult {
  valid: boolean;
  status: "valid" | "quota" | "invalid_key" | "error";
  message: string;
  fingerprint: string;
  masked: string;
}

/**
 * Tests a single Gemini API key with a minimal request and updates runtime key state.
 * Never returns or logs the raw key.
 */
export async function verifyGeminiKey(
  apiKey: string,
  options: {
    model?: string;
    keyManager?: KeyManager;
    clientFactory?: (key: string) => {
      models: {
        generateContent: (args: {
          model: string;
          contents: string;
          config?: Record<string, unknown>;
        }) => Promise<{ text?: string }>;
      };
    };
  } = {}
): Promise<VerifyGeminiKeyResult> {
  const trimmed = apiKey.trim();
  const fingerprint = fingerprintKey(trimmed);
  const masked = maskApiKey(trimmed);
  const km = options.keyManager ?? defaultKeyManager;

  if (!trimmed) {
    return {
      valid: false,
      status: "invalid_key",
      message: "API key kosong.",
      fingerprint,
      masked,
    };
  }

  const model = options.model ?? env.GEMINI_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);

  try {
    const ai = options.clientFactory
      ? options.clientFactory(trimmed)
      : new GoogleGenAI({ apiKey: trimmed });

    await ai.models.generateContent({
      model,
      contents: "Balas dengan satu kata: OK",
      config: {
        maxOutputTokens: 8,
        temperature: 0,
        abortSignal: controller.signal,
      },
    });

    km.clearKeyState(fingerprint);
    return {
      valid: true,
      status: "valid",
      message: `Kunci ${masked} aktif dan terhubung ke ${model}.`,
      fingerprint,
      masked,
    };
  } catch (err) {
    const classified = classifyGeminiError(err);
    if (classified.category === "quota") {
      km.markCooldown(fingerprint, classified.isDailyQuota);
      return {
        valid: false,
        status: "quota",
        message: classified.isDailyQuota
          ? `Kuota harian kunci ${masked} habis. Coba lagi nanti.`
          : `Kuota per menit kunci ${masked} penuh. Tunggu sekitar 1 menit.`,
        fingerprint,
        masked,
      };
    }
    if (classified.category === "invalid_key") {
      km.markInvalid(fingerprint, classified.safeMessage);
      return {
        valid: false,
        status: "invalid_key",
        message: `Kunci ${masked} tidak valid atau ditolak oleh Google AI Studio.`,
        fingerprint,
        masked,
      };
    }
    return {
      valid: false,
      status: "error",
      message: `Kunci ${masked} belum bisa diuji saat ini (${classified.category}).`,
      fingerprint,
      masked,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface GeminiModelProbeResult {
  model: string;
  ok: boolean;
  category?: GeminiErrorCategory;
  latencyMs: number;
}

/**
 * Probes every model in the configured chain once (no retry, no backoff, 10s timeout)
 * using the first resolved key so teachers/operators can verify AI health from Settings.
 */
export async function probeGeminiModels(options: {
  teacherEncryptedKeys?: string[];
  systemKeysOverride?: string[];
  primaryModel?: string;
  timeoutMs?: number;
  now?: () => number;
  clientFactory?: (key: string) => {
    models: {
      generateContent: (args: {
        model: string;
        contents: string;
        config?: Record<string, unknown>;
      }) => Promise<{ text?: string }>;
    };
  };
} = {}): Promise<GeminiModelProbeResult[]> {
  const models = getModelChain(options.primaryModel);
  const keys = resolveCandidateKeys(
    options.teacherEncryptedKeys,
    options.systemKeysOverride
  );
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 10_000;

  if (keys.length === 0) {
    return models.map((model) => ({
      model,
      ok: false,
      category: "invalid_key",
      latencyMs: 0,
    }));
  }

  const keyEntry = keys[0]!;

  return Promise.all(
    models.map(async (model): Promise<GeminiModelProbeResult> => {
      const startedAt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const ai = options.clientFactory
          ? options.clientFactory(keyEntry.apiKey)
          : new GoogleGenAI({ apiKey: keyEntry.apiKey });

        await ai.models.generateContent({
          model,
          contents: "ok",
          config: {
            maxOutputTokens: 8,
            temperature: 0,
            abortSignal: controller.signal,
          },
        });

        return {
          model,
          ok: true,
          latencyMs: Math.max(0, now() - startedAt),
        };
      } catch (err) {
        const classified = classifyGeminiError(err);
        return {
          model,
          ok: false,
          category: classified.category,
          latencyMs: Math.max(0, now() - startedAt),
        };
      } finally {
        clearTimeout(timer);
      }
    })
  );
}
