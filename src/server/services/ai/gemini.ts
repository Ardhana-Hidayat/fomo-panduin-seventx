import "server-only";
import crypto from "node:crypto";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import { env } from "../../config/env";
import { getConceptIndex } from "../catalog";
import {
  AllGeminiKeysFailedError,
  defaultKeyManager,
  resolveCandidateKeys,
} from "./key-manager";
import {
  generatedLessonSchema,
  lessonV2Schema,
  type GeneratedLesson,
  type GenerateLessonOptions,
  type GenerateLessonResult,
} from "./types";
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from "./prompts";
import { getFallbackLesson } from "./fallback";
import { planLessonContent, type LessonPlan } from "./planner";
import {
  sanitizeAndValidateLesson,
  type SanitizeLessonOptions,
} from "./validator";

export type { SanitizeLessonOptions };

const SchemaType = Type ?? {
  OBJECT: "OBJECT" as Type,
  ARRAY: "ARRAY" as Type,
  STRING: "STRING" as Type,
  BOOLEAN: "BOOLEAN" as Type,
  INTEGER: "INTEGER" as Type,
};

export const LESSON_V2_RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING },
    lesson_kind: {
      type: SchemaType.STRING,
      enum: ["langkah", "konsep", "kosakata", "cerita"],
    },
    cards: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          text: { type: SchemaType.STRING },
          key_terms: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
          },
          concept: { type: SchemaType.STRING, nullable: true },
          quote: { type: SchemaType.STRING },
        },
        required: ["text", "key_terms", "concept"],
      },
    },
  },
  required: ["title", "lesson_kind", "cards"],
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

interface CacheEntry {
  result: GenerateLessonResult;
  expiresAt: number;
}

const generationCache = new Map<string, CacheEntry>();

export function clearGenerationCache(): void {
  generationCache.clear();
}

function computeCacheKey(
  options: GenerateLessonOptions,
  plan: LessonPlan,
  catalogCount: number
): string {
  const payload = JSON.stringify({
    sourceType: options.sourceType,
    topic: (options.topic ?? "").trim(),
    source: plan.selectedText || plan.normalizedText || "",
    subject: plan.subject,
    level: options.level ?? "sdlb",
    languageComplexity: options.languageComplexity ?? "sederhana",
    cardCount: plan.recommendedCardCount,
    questionCount: options.questionCount ?? 4,
    exerciseType: options.exerciseType ?? "both",
    optionCount: options.optionCount ?? 3,
    teacherNotes: (options.teacherNotes ?? "").trim(),
    catalogVersion: `c-${catalogCount}`,
    promptVersion: PROMPT_VERSION,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function logSafeGeneration(meta: {
  sourceType: string;
  subject: string;
  level: string;
  generatedBy: "ai" | "fallback";
  cacheHit: boolean;
  cardCount: number;
  questionCount: number;
  visualGapsCount: number;
  durationMs: number;
  keySource?: string;
}): void {
  console.info("[ai-generate]", JSON.stringify(meta));
}

export function sanitizeGeneratedLesson(
  lesson: GeneratedLesson,
  sanitizeOptions: SanitizeLessonOptions = {}
): GeneratedLesson {
  return sanitizeAndValidateLesson(lesson, sanitizeOptions).lesson;
}

function cleanJsonResponse(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/, "")
    .trim();
}

function parseAiLessonJson(rawText: string): {
  ok: true;
  lesson: GeneratedLesson;
} | {
  ok: false;
  issueSummary: string;
} {
  const cleaned = cleanJsonResponse(rawText);
  const parsedJson: unknown = JSON.parse(cleaned);

  const hasLegacyVisual =
    parsedJson !== null &&
    typeof parsedJson === "object" &&
    Array.isArray((parsedJson as { cards?: unknown[] }).cards) &&
    (parsedJson as { cards: Array<Record<string, unknown>> }).cards.some(
      (c) => c && typeof c === "object" && "visual" in c && !("concept" in c)
    );

  if (hasLegacyVisual) {
    const legacy = generatedLessonSchema.safeParse(parsedJson);
    if (legacy.success) {
      return { ok: true, lesson: legacy.data };
    }
  }

  const v2 = lessonV2Schema.safeParse(parsedJson);
  if (v2.success) {
    return {
      ok: true,
      lesson: {
        title: v2.data.title,
        lesson_kind: v2.data.lesson_kind,
        cards: v2.data.cards.map((c) => ({
          text: c.text,
          key_terms: c.key_terms,
          concept: c.concept,
          quote: c.quote,
          image: { keyword_id: "", keyword_en: "", alt: "" },
        })),
        questions: v2.data.questions ?? [],
      },
    };
  }

  const legacy = generatedLessonSchema.safeParse(parsedJson);
  if (legacy.success) {
    return { ok: true, lesson: legacy.data };
  }

  const issueSummary = v2.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { ok: false, issueSummary };
}

async function callGeminiStructured(
  ai: GoogleGenAI,
  modelName: string,
  systemPrompt: string,
  contents: Array<string | { inlineData: { mimeType: string; data: string } }>,
  parentSignal: AbortSignal,
  timeoutMs = 35_000
): Promise<string> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
  const response = await ai.models.generateContent({
    model: modelName,
    contents,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseSchema: LESSON_V2_RESPONSE_SCHEMA,
      temperature: 0.3,
      abortSignal: signal,
    },
  });
  return response.text?.trim() || "";
}

export async function generateWithGemini(
  options: GenerateLessonOptions,
  extractedText?: string,
  isScannedNotice?: boolean,
  existingPlan?: LessonPlan
): Promise<GenerateLessonResult> {
  const startedAt = Date.now();
  const plan =
    existingPlan ??
    planLessonContent(
      options,
      extractedText
        ? {
          text: extractedText,
          totalPages: 1,
          isScanned: Boolean(isScannedNotice),
          preview: extractedText.slice(0, 300),
        }
        : undefined
    );

  // Scanned/empty PDF: never send empty text to AI
  if (plan.isScannedOrEmpty && options.sourceType === "pdf") {
    throw new Error(
      plan.errorMessage ||
      "PDF terlihat seperti hasil pindai atau tidak memiliki teks yang dapat dibaca."
    );
  }

  const index = getConceptIndex();
  const hasIntellectual =
    options.needs?.includes("intelektual") ||
    options.needs?.includes("hambatan_intelektual");
  const targetOptionCount = options.optionCount ?? (hasIntellectual ? 2 : 3);
  const sanitizeOpts: SanitizeLessonOptions = {
    optionCount: targetOptionCount,
    questionCount: options.questionCount,
    exerciseType: options.exerciseType,
    sourceText: plan.selectedText || plan.normalizedText || undefined,
    subject: plan.subject,
    lessonId: options.lessonId,
    preferDomains: plan.domains,
    conceptIndex: index,
    rebuildQuiz: true,
  };

  // Check generation cache (skip for image/foto uploads)
  const canCache = options.sourceType !== "foto" && !options.fileBuffer;
  const cacheKey = canCache
    ? computeCacheKey(options, plan, index.concepts.length)
    : null;
  if (cacheKey) {
    const cached = generationCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      logSafeGeneration({
        sourceType: options.sourceType,
        subject: plan.subject,
        level: options.level ?? "sdlb",
        generatedBy: cached.result.generatedBy,
        cacheHit: true,
        cardCount: cached.result.lesson.cards.length,
        questionCount: cached.result.lesson.questions.length,
        visualGapsCount: cached.result.visualGaps?.length ?? 0,
        durationMs: Date.now() - startedAt,
      });
      return { ...cached.result, cacheHit: true };
    }
  }

  // Separate encrypted teacher keys from plaintext test keys
  const rawApiKeys = options.apiKeys ?? [];
  const encryptedTeacherKeys = rawApiKeys.filter((k) => k.includes(":"));
  const plaintextTestKeys =
    process.env.NODE_ENV === "test"
      ? rawApiKeys.filter((k) => k.trim().length > 0 && !k.includes(":"))
      : [];

  const availableKeys = resolveCandidateKeys(
    encryptedTeacherKeys,
    plaintextTestKeys.length > 0 ? plaintextTestKeys : undefined
  );

  if (availableKeys.length === 0) {
    if (!plan.hasSourceText) {
      throw new Error(
        "AI Gemini belum tersedia (API key belum diatur). Masukkan teks materi sumber atau tambahkan API key Gemini di Pengaturan."
      );
    }
    const fallback = getFallbackLesson(options, extractedText, undefined, plan);
    const validatedFallback = sanitizeAndValidateLesson(fallback, sanitizeOpts);
    logSafeGeneration({
      sourceType: options.sourceType,
      subject: plan.subject,
      level: options.level ?? "sdlb",
      generatedBy: "fallback",
      cacheHit: false,
      cardCount: validatedFallback.lesson.cards.length,
      questionCount: validatedFallback.lesson.questions.length,
      visualGapsCount: validatedFallback.visualGaps.length,
      durationMs: Date.now() - startedAt,
    });
    return {
      lesson: validatedFallback.lesson,
      generatedBy: "fallback",
      badge: "Dibuat dari cadangan ekstraktif (tambahkan API key Gemini di Pengaturan untuk AI)",
      sourceText: extractedText || options.text,
      isScannedNotice,
      visualGaps: validatedFallback.visualGaps,
      warnings: Array.from(
        new Set([...plan.warnings, ...validatedFallback.warnings])
      ),
    };
  }

  const systemPrompt = buildSystemPrompt(options, plan);
  const userPromptText = buildUserPrompt(options, extractedText, plan);

  const contents: Array<
    string | { inlineData: { mimeType: string; data: string } }
  > = [];

  if (options.fileBuffer && options.mimeType?.startsWith("image/")) {
    contents.push({
      inlineData: {
        mimeType: options.mimeType,
        data: Buffer.from(options.fileBuffer).toString("base64"),
      },
    });
    contents.push(
      "Bacalah foto catatan/halaman buku ini dan jadikan materi pembelajaran terstruktur sesuai aturan."
    );
  }
  contents.push(userPromptText);

  try {
    const kmResult = await defaultKeyManager.execute({
      teacherEncryptedKeys: encryptedTeacherKeys,
      systemKeysOverride:
        plaintextTestKeys.length > 0 ? plaintextTestKeys : undefined,
      primaryModel: env.GEMINI_MODEL,
      run: async ({ apiKey, model, signal }) => {
        const ai = new GoogleGenAI({ apiKey });
        const rawText = await callGeminiStructured(
          ai,
          model,
          systemPrompt,
          contents,
          signal,
          35_000
        );
        if (!rawText) {
          throw new Error("Respons kosong dari Gemini");
        }

        let parsed = parseAiLessonJson(rawText);

        // 1x targeted repair on Zod failure
        if (!parsed.ok) {
          const repairPrompt = `Perbaiki JSON berikut agar valid sesuai skema (title, lesson_kind, cards[]). Kesalahan: ${parsed.issueSummary}\n\nJSON:\n${cleanJsonResponse(rawText).slice(0, 6000)}`;
          const repairedText = await callGeminiStructured(
            ai,
            model,
            systemPrompt,
            [repairPrompt],
            signal,
            25_000
          );
          if (repairedText) {
            parsed = parseAiLessonJson(repairedText);
          }
        }

        if (!parsed.ok) {
          throw new Error(`Skema JSON tidak valid: ${parsed.issueSummary}`);
        }

        return parsed.lesson;
      },
    });

    const validated = sanitizeAndValidateLesson(kmResult.value, sanitizeOpts);
    const result: GenerateLessonResult = {
      lesson: validated.lesson,
      generatedBy: "ai",
      badge: `Disusun oleh Gemini (${kmResult.model})`,
      sourceText: extractedText || options.text,
      isScannedNotice,
      cacheHit: false,
      visualGaps: validated.visualGaps,
      warnings: Array.from(new Set([...plan.warnings, ...validated.warnings])),
    };

    if (cacheKey) {
      if (generationCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = generationCache.keys().next().value;
        if (firstKey) generationCache.delete(firstKey);
      }
      generationCache.set(cacheKey, {
        result,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
    }

    logSafeGeneration({
      sourceType: options.sourceType,
      subject: plan.subject,
      level: options.level ?? "sdlb",
      generatedBy: "ai",
      cacheHit: false,
      cardCount: result.lesson.cards.length,
      questionCount: result.lesson.questions.length,
      visualGapsCount: validated.visualGaps.length,
      durationMs: Date.now() - startedAt,
      keySource: kmResult.source,
    });

    return result;
  } catch (err) {
    if (err instanceof AllGeminiKeysFailedError) {
      const chainSummary =
        err.attempts.length > 0
          ? err.attempts
              .map(
                (a) =>
                  `${a.model}:${a.ok ? "ok" : a.category ?? "err"}(${a.source})`
              )
              .join(" -> ")
          : "none";
      console.warn(
        `All Gemini keys/models failed: lastCategory=${err.lastCategory ?? "unknown"} chain=[${chainSummary}] msg=${err.message}`
      );
    } else {
      console.warn(
        "All Gemini keys/models failed:",
        err instanceof Error ? err.message : "unknown"
      );
    }

    if (!plan.hasSourceText) {
      throw new Error(
        "Gagal menghubungi AI Gemini dan tidak ada teks materi sumber untuk cadangan. Coba lagi nanti atau tempelkan teks materi."
      );
    }

    const fallback = getFallbackLesson(options, extractedText, undefined, plan);
    const validatedFallback = sanitizeAndValidateLesson(fallback, sanitizeOpts);

    logSafeGeneration({
      sourceType: options.sourceType,
      subject: plan.subject,
      level: options.level ?? "sdlb",
      generatedBy: "fallback",
      cacheHit: false,
      cardCount: validatedFallback.lesson.cards.length,
      questionCount: validatedFallback.lesson.questions.length,
      visualGapsCount: validatedFallback.visualGaps.length,
      durationMs: Date.now() - startedAt,
    });

    const failureCategory =
      err instanceof AllGeminiKeysFailedError
        ? err.lastCategory ?? (err.quotaFingerprints.length > 0 ? "quota" : "transient")
        : "transient";

    const badgeReasonByCategory: Record<string, string> = {
      quota: "seluruh kuota API Gemini sedang penuh",
      model_unavailable: "model AI yang dikonfigurasi tidak tersedia",
      invalid_key: "API key Gemini tidak valid",
      transient: "layanan AI Gemini sedang sibuk sementara",
      timeout: "layanan AI Gemini sedang sibuk sementara",
      blocked: "layanan AI Gemini sedang sibuk sementara",
      bad_json: "layanan AI Gemini sedang sibuk sementara",
    };

    const badgeReason =
      badgeReasonByCategory[failureCategory] ??
      "layanan AI Gemini sedang sibuk sementara";

    return {
      lesson: validatedFallback.lesson,
      generatedBy: "fallback",
      badge: `Dibuat dari cadangan ekstraktif (${badgeReason})`,
      sourceText: extractedText || options.text,
      isScannedNotice,
      visualGaps: validatedFallback.visualGaps,
      warnings: Array.from(
        new Set([...plan.warnings, ...validatedFallback.warnings])
      ),
    };
  }
}
