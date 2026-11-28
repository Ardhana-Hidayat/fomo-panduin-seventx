import { NextResponse } from "next/server";
import { getCurrentTeacher } from "@/features/auth";
import { probeGeminiModels } from "@/server/services/ai/key-manager";

export async function POST() {
  const teacherSession = await getCurrentTeacher();
  if (!teacherSession) {
    return NextResponse.json(
      { ok: false, error: "Sesi guru tidak ditemukan." },
      { status: 401 }
    );
  }

  const teacherApiKeys = teacherSession.teacher.settings?.geminiApiKeys ?? [];
  const results = await probeGeminiModels({
    teacherEncryptedKeys: teacherApiKeys,
  });

  return NextResponse.json({
    ok: results.every((r) => r.ok),
    results,
  });
}
