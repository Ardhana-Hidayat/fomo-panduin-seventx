import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

export const maxDuration = 60;
import {
  generateLessonContent,
  sanitizeAndValidateLesson,
  type CognitiveLevel,
} from "@/server/services/ai";
import { enforceQuestionVisualRule } from "@/server/services/ai/quiz-builder";
import {
  extractPromptImageUrl,
  sanitizeQuizPayloadVisualRule,
} from "@/shared/lib/quiz/visual-rule";
import { getCurrentTeacher } from "@/features/auth";
import {
  createLesson,
  type CreateCardInput,
  type CreateQuestionInput,
} from "@/server/repos/lessons";
import {
  findOrFetchPictogram,
  resolveCatalogAssetToDb,
} from "@/server/services/media/arasaac";
import { db } from "@/server/db/client";
import { rateLimits } from "@/server/db/schema";

const AI_RATE_LIMIT_MAX = 20;
const AI_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

async function checkAiRateLimit(key: string): Promise<{ allowed: boolean }> {
  if (process.env.NODE_ENV === "test") {
    return { allowed: true };
  }

  const windowStart =
    Math.floor(Date.now() / AI_RATE_LIMIT_WINDOW_MS) * AI_RATE_LIMIT_WINDOW_MS;

  try {
    const rows = await db
      .insert(rateLimits)
      .values({ key, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.key, rateLimits.windowStart],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });

    const currentCount = rows[0]?.count ?? 1;
    return { allowed: currentCount <= AI_RATE_LIMIT_MAX };
  } catch (err) {
    console.warn("Rate limit check skipped (DB error):", err);
    return { allowed: true };
  }
}

function parseLevel(raw: unknown): CognitiveLevel {
  const valid: CognitiveLevel[] = [
    "sdlb",
    "sdlb_awal",
    "sdlb_menengah",
    "sdlb_lanjut",
    "smplb",
    "smalb",
  ];
  return typeof raw === "string" && valid.includes(raw as CognitiveLevel)
    ? (raw as CognitiveLevel)
    : "sdlb";
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";

    let topic = "";
    let text = "";
    let subject = "Otomatis";
    let sourceType: "topik" | "teks" | "pdf" | "foto" = "topik";
    let level: CognitiveLevel = "sdlb";
    let needs: string[] = ["campuran"];
    let languageComplexity: "sangat_sederhana" | "sederhana" | "biasa" = "sederhana";
    let cardCount = 6;
    let questionCount = 4;
    let exerciseType: "match" | "order" | "both" = "both";
    let optionCount = 3;
    let teacherNotes = "";
    let fileBuffer: Buffer | undefined;
    let mimeType: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      topic = (formData.get("topic") as string) || "";
      text = (formData.get("text") as string) || "";
      subject = (formData.get("subject") as string) || "Otomatis";
      sourceType = ((formData.get("sourceType") as string) || "topik") as typeof sourceType;
      level = parseLevel(formData.get("level"));
      const rawComplexity = formData.get("languageComplexity") as string | null;
      if (
        rawComplexity === "sangat_sederhana" ||
        rawComplexity === "sederhana" ||
        rawComplexity === "biasa"
      ) {
        languageComplexity = rawComplexity;
      }
      teacherNotes = (formData.get("teacherNotes") as string) || "";
      const rawCardCount = formData.get("cardCount");
      if (rawCardCount) cardCount = Math.min(15, Math.max(3, Number(rawCardCount) || 6));
      const rawQuestionCount = formData.get("questionCount");
      if (rawQuestionCount !== null && rawQuestionCount !== "") {
        questionCount = Math.min(10, Math.max(0, Number(rawQuestionCount)));
      }
      const rawExerciseType = formData.get("exerciseType") as string | null;
      if (rawExerciseType === "match" || rawExerciseType === "order" || rawExerciseType === "both") {
        exerciseType = rawExerciseType;
      }
      const rawOptionCount = formData.get("optionCount");
      if (rawOptionCount) optionCount = Math.min(4, Math.max(2, Number(rawOptionCount) || 3));

      const file = formData.get("file") as File | null;
      if (file && file.size > 0) {
        const arrayBuffer = await file.arrayBuffer();
        fileBuffer = Buffer.from(arrayBuffer);
        mimeType = file.type;
      }
    } else {
      const body = await request.json();
      topic = body.topic || "";
      text = body.text || "";
      subject = body.subject || "Otomatis";
      sourceType = body.sourceType || "topik";
      level = parseLevel(body.level);
      needs = body.needs || ["campuran"];
      languageComplexity = body.languageComplexity || "sederhana";
      cardCount = body.cardCount ? Math.min(15, Math.max(3, Number(body.cardCount) || 6)) : 6;
      questionCount =
        body.questionCount !== undefined && body.questionCount !== ""
          ? Math.min(10, Math.max(0, Number(body.questionCount)))
          : 4;
      if (
        body.exerciseType === "match" ||
        body.exerciseType === "order" ||
        body.exerciseType === "both"
      ) {
        exerciseType = body.exerciseType;
      }
      if (body.optionCount) {
        optionCount = Math.min(4, Math.max(2, Number(body.optionCount) || 3));
      }
      teacherNotes = body.teacherNotes || "";
    }

    if (!topic.trim() && !text.trim() && !fileBuffer) {
      return NextResponse.json(
        {
          success: false,
          error: "Mohon masukkan topik, teks, atau unggah dokumen.",
        },
        { status: 400 }
      );
    }

    // Periksa sesi guru terautentikasi sekaligus pulihkan baris guru di DB bila perlu
    const teacherSession = await getCurrentTeacher();
    if (!teacherSession) {
      return NextResponse.json(
        {
          success: false,
          error: "Sesi guru tidak valid atau telah berakhir. Silakan masuk kembali.",
        },
        { status: 401 }
      );
    }

    // Rate limit per guru atau IP
    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
    const rateKey = `ai_gen:${teacherSession.teacher.id ?? clientIp}`;
    const rateRes = await checkAiRateLimit(rateKey);
    if (!rateRes.allowed) {
      return NextResponse.json(
        {
          success: false,
          error: "Terlalu banyak permintaan pembuatan materi. Silakan tunggu sebentar.",
        },
        { status: 429 }
      );
    }

    const questionTypes =
      exerciseType === "order"
        ? ["urutkan"]
        : exerciseType === "match"
          ? ["pilih_kata", "pilih_gambar", "benar_salah"]
          : ["pilih_kata", "pilih_gambar", "urutkan", "benar_salah"];

    // Panggil layanan AI dengan fallback multi-key Gemini (kunci guru -> env server)
    const teacherApiKeys = teacherSession?.teacher.settings?.geminiApiKeys ?? [];
    const aiResult = await generateLessonContent({
      sourceType,
      topic,
      text,
      subject,
      fileBuffer,
      mimeType,
      level,
      needs,
      languageComplexity,
      cardCount,
      questionTypes,
      questionCount,
      exerciseType,
      optionCount,
      teacherNotes,
      apiKeys: teacherApiKeys,
    });

    const validation = sanitizeAndValidateLesson(aiResult.lesson, {
      optionCount,
      questionCount,
      exerciseType,
      subject,
      skipRecordVisualGap: true,
    });
    const finalLesson = {
      ...validation.lesson,
      questions: validation.lesson.questions.map(enforceQuestionVisualRule),
    };
    const warnings = Array.from(
      new Set([...(aiResult.warnings ?? []), ...validation.warnings])
    );

    let createdLessonId: string | undefined;

    if (teacherSession?.teacher) {
      const teacher = teacherSession.teacher;

      // Resolusi aset visual terverifikasi (atau null bila tidak ada gambar yang cocok)
      const assetResults = await Promise.allSettled(
        finalLesson.cards.map(async (c) => {
          if (c.visual === null) {
            return null;
          }
          if (c.visual?.asset_id) {
            const res = await resolveCatalogAssetToDb(c.visual.asset_id, c.visual.alt);
            return res.ok ? res.data.id : undefined;
          }
          if (c.image?.keyword_id || c.image?.keyword_en) {
            const res = await findOrFetchPictogram(
              c.image.keyword_id || c.key_terms[0] || topic || "belajar",
              c.image.keyword_en || undefined
            );
            return res.ok ? res.data.id : undefined;
          }
          return undefined;
        })
      );

      // Otomatis simpan sebagai DRAFT di database
      const cardsToInsert: CreateCardInput[] = finalLesson.cards.map((c, i) => {
        const assetRes = assetResults[i];
        const imageAssetId =
          assetRes?.status === "fulfilled" && assetRes.value
            ? assetRes.value
            : undefined;

        return {
          position: i + 1,
          text: c.text,
          keyTerms: c.key_terms,
          cardType: "instruction",
          imageSource: imageAssetId ? "pictogram" : "none",
          imageAlt: c.visual?.alt || c.image?.alt || undefined,
          imageAssetId,
          audioSource: "none",
        };
      });

      const questionsToInsert: CreateQuestionInput[] =
        questionCount === 0
          ? []
          : finalLesson.questions.slice(0, questionCount).map((q, i) => {
              const promptImageUrl = extractPromptImageUrl(
                q as unknown as Record<string, unknown>
              );
              const rawPayload: Record<string, unknown> = {
                ...(q.variant ? { variant: q.variant } : {}),
                ...(promptImageUrl ? { promptImageUrl } : {}),
                options: q.options?.slice(0, optionCount).map((opt, optIdx) => ({
                  id: opt.id || String.fromCharCode(97 + optIdx),
                  text: opt.text,
                  correct: opt.correct,
                  visual: opt.visual ?? null,
                  imageUrl: opt.visual?.url ?? opt.image?.url,
                  image: opt.visual
                    ? {
                        keyword_en: opt.image?.keyword_en,
                        alt: opt.visual.alt,
                        url: opt.visual.url,
                      }
                    : opt.image,
                })),
                steps: q.steps?.map((step, stepIdx) => ({
                  id: step.id || `step-${stepIdx + 1}`,
                  text: step.text,
                  visual: step.visual ?? null,
                  imageUrl: step.visual?.url ?? step.image?.url,
                  image: step.visual
                    ? {
                        keyword_en: step.image?.keyword_en,
                        alt: step.visual.alt,
                        url: step.visual.url,
                      }
                    : step.image,
                })),
                answer: q.answer,
              };

              const normalizedType = q.type === "order" ? "arrange_steps" : q.type;

              return {
                position: i + 1,
                type: normalizedType,
                prompt: q.prompt,
                payload: sanitizeQuizPayloadVisualRule(normalizedType, rawPayload),
                linkedCardId: undefined,
              };
            });

      const dbRes = await createLesson(teacher.id, {
        title: finalLesson.title || topic || "Materi Baru",
        topic: topic || finalLesson.title || "",
        level,
        sourceType,
        status: "draft",
        exerciseType,
        optionCount,
        generatedBy: aiResult.generatedBy,
        cards: cardsToInsert,
        questions: questionsToInsert,
      });

      if (!dbRes.ok) {
        console.error(
          "Gagal menyimpan materi ke DB pada /api/ai/generate-lesson:",
          dbRes.error
        );
        return NextResponse.json(
          {
            success: false,
            error: dbRes.error.message || "Gagal menyimpan materi pembelajaran.",
          },
          { status: 500 }
        );
      }

      createdLessonId = dbRes.data.id;
    }

    return NextResponse.json({
      success: true,
      data: {
        lesson: finalLesson,
        badge: aiResult.badge,
        generatedBy: aiResult.generatedBy,
        isScannedNotice: aiResult.isScannedNotice,
        warnings,
        lessonId: createdLessonId,
      },
    });
  } catch (error) {
    console.error("Error pada /api/ai/generate-lesson:", error);
    const msg = error instanceof Error ? error.message : "";
    const isClientError =
      msg.includes("PDF terlihat") ||
      msg.includes("tidak memiliki teks") ||
      msg.includes("API key") ||
      msg.includes("tidak ada teks materi sumber");
    return NextResponse.json(
      {
        success: false,
        error: isClientError
          ? msg
          : "Gagal menyusun materi pembelajaran. Coba gunakan topik yang lebih sederhana.",
      },
      { status: isClientError ? 400 : 500 }
    );
  }
}
