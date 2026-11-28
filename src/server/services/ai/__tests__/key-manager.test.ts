import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  maskApiKey,
  fingerprintKey,
  isEncryptedSecret,
} from "../../../security/crypto";
import {
  KeyManager,
  AllGeminiKeysFailedError,
  classifyGeminiError,
  probeGeminiModels,
  resolveCandidateKeys,
  verifyGeminiKey,
  PER_MINUTE_COOLDOWN_MS,
  DAILY_QUOTA_COOLDOWN_MS,
  TOTAL_REQUEST_BUDGET_MS,
} from "../key-manager";

describe("crypto (AES-256-GCM, masking, fingerprinting)", () => {
  const originalKeySecret = process.env.KEY_ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.KEY_ENCRYPTION_SECRET = "test-key-encryption-secret-32-chars!!";
  });

  afterEach(() => {
    if (originalKeySecret === undefined) {
      delete process.env.KEY_ENCRYPTION_SECRET;
    } else {
      process.env.KEY_ENCRYPTION_SECRET = originalKeySecret;
    }
  });

  it("encrypts with enc:v1: prefix and decrypts roundtrip", () => {
    const raw = "AIzaSyTestKeySecret1234567890";
    const encrypted = encryptSecret(raw);

    expect(isEncryptedSecret(encrypted)).toBe(true);
    expect(encrypted).not.toContain(raw);
    expect(decryptSecret(encrypted)).toBe(raw);
  });

  it("supports legacy plaintext keys without enc:v1: prefix", () => {
    const legacy = "AIzaSyLegacyPlaintextKey9999";
    expect(isEncryptedSecret(legacy)).toBe(false);
    expect(decryptSecret(legacy)).toBe(legacy);
  });

  it("throws on tampered enc:v1: ciphertext", () => {
    const encrypted = encryptSecret("AIzaSySensitiveKey1234");
    const parts = encrypted.split(":");
    parts[4] = "AAAA" + parts[4]!.slice(4);
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("masks API keys showing only last 4 characters", () => {
    expect(maskApiKey("AIzaSyAbcdef1234")).toBe("••••1234");
    expect(maskApiKey("  AIzaSyAbcdef5678  ")).toBe("••••5678");
    expect(maskApiKey("1234")).toBe("••••");
    expect(maskApiKey("")).toBe("••••");
  });

  it("produces deterministic HMAC-SHA256 hex fingerprints", () => {
    const fp1 = fingerprintKey("AIzaSyKeyOne1111");
    const fp2 = fingerprintKey("AIzaSyKeyOne1111");
    const fp3 = fingerprintKey("AIzaSyKeyTwo2222");

    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });
});

describe("key-manager (ordering, cooldown, classification, limits)", () => {
  beforeEach(() => {
    process.env.KEY_ENCRYPTION_SECRET = "test-key-encryption-secret-32-chars!!";
  });

  it("orders system keys first, then decrypted teacher keys in saved order", () => {
    const teacher1 = encryptSecret("AIzaTeacherOne1111");
    const teacher2Legacy = "AIzaTeacherTwo2222";
    const teacher3DupSystem = encryptSecret("AIzaSystemMain0001");

    const resolved = resolveCandidateKeys(
      [teacher1, teacher2Legacy, teacher3DupSystem],
      ["AIzaSystemMain0001", "AIzaSystemBackup0002"]
    );

    expect(resolved.map((k) => ({ source: k.source, masked: k.masked }))).toEqual([
      { source: "system", masked: "••••0001" },
      { source: "system", masked: "••••0002" },
      { source: "teacher", masked: "••••1111" },
      { source: "teacher", masked: "••••2222" },
    ]);
  });

  it("classifies quota, invalid_key, timeout, bad_json, blocked, and transient errors", () => {
    expect(classifyGeminiError({ status: 429, message: "Rate limit" }).category).toBe("quota");
    expect(
      classifyGeminiError({ status: 429, message: "GenerateRequestsPerDay exceeded" })
    ).toMatchObject({ category: "quota", isDailyQuota: true });

    expect(classifyGeminiError({ status: 400, message: "API_KEY_INVALID" }).category).toBe(
      "invalid_key"
    );
    expect(classifyGeminiError({ status: 403, message: "PERMISSION_DENIED" }).category).toBe(
      "invalid_key"
    );

    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    expect(classifyGeminiError(abortErr).category).toBe("timeout");

    expect(classifyGeminiError(new SyntaxError("Unexpected token")).category).toBe("bad_json");
    expect(classifyGeminiError(new Error("Candidate was blocked by SAFETY")).category).toBe(
      "blocked"
    );
    expect(classifyGeminiError({ status: 500, message: "Internal error" }).category).toBe(
      "transient"
    );
    expect(classifyGeminiError({ status: 404, message: "MODEL_NOT_FOUND" })).toMatchObject({
      category: "model_unavailable",
      modelFallbackReason: "model_not_found",
    });
  });

  it("applies 60s and 15m cooldowns on 429 using fake clock", async () => {
    let nowMs = 1_000_000;
    const km = new KeyManager({
      now: () => nowMs,
      sleep: async () => { },
      random: () => 0.5,
    });

    const sysKey = "AIzaSystemKey0001";
    const teacherKey = encryptSecret("AIzaTeacherKey0002");

    // 1st call: system key hits per-minute 429, falls back to teacher key and succeeds
    const callKeys: string[] = [];
    const res1 = await km.execute({
      systemKeysOverride: [sysKey],
      teacherEncryptedKeys: [teacherKey],
      primaryModel: "gemini-2.5-flash",
      run: async ({ apiKey }) => {
        callKeys.push(apiKey);
        if (apiKey === sysKey) {
          throw Object.assign(new Error("Too many requests"), { status: 429 });
        }
        return "ok-from-teacher";
      },
    });

    expect(res1.value).toBe("ok-from-teacher");
    expect(callKeys).toEqual([sysKey, "AIzaTeacherKey0002"]);

    // 2nd call at +30s: system key is still in 60s cooldown, skipped directly to teacher key
    nowMs += 30_000;
    const callKeys2: string[] = [];
    await km.execute({
      systemKeysOverride: [sysKey],
      teacherEncryptedKeys: [teacherKey],
      primaryModel: "gemini-2.5-flash",
      run: async ({ apiKey }) => {
        callKeys2.push(apiKey);
        return "ok";
      },
    });
    expect(callKeys2).toEqual(["AIzaTeacherKey0002"]);

    // 3rd call at +61s total: system key cooldown expired, tried first again
    nowMs += 31_000;
    const callKeys3: string[] = [];
    await km.execute({
      systemKeysOverride: [sysKey],
      teacherEncryptedKeys: [teacherKey],
      primaryModel: "gemini-2.5-flash",
      run: async ({ apiKey }) => {
        callKeys3.push(apiKey);
        return "ok";
      },
    });
    expect(callKeys3).toEqual([sysKey]);

    // Daily quota -> 15m cooldown
    await km.execute({
      systemKeysOverride: [sysKey],
      teacherEncryptedKeys: [teacherKey],
      primaryModel: "gemini-2.5-flash",
      run: async ({ apiKey }) => {
        if (apiKey === sysKey) {
          throw Object.assign(new Error("Daily quota RPD exhausted"), { status: 429 });
        }
        return "ok";
      },
    });

    const sysFp = fingerprintKey(sysKey);
    expect(km.getKeyStatus(sysFp)).toMatchObject({
      status: "cooldown",
      isDailyQuota: true,
    });

    nowMs += PER_MINUTE_COOLDOWN_MS + 1000;
    expect(km.getKeyStatus(sysFp).status).toBe("cooldown");

    nowMs += DAILY_QUOTA_COOLDOWN_MS;
    expect(km.getKeyStatus(sysFp).status).toBe("active");
  });

  it("marks 400/403 keys invalid and reports invalidTeacherFingerprints", async () => {
    const km = new KeyManager({
      now: () => 1_000_000,
      sleep: async () => { },
    });

    const badTeacher = "AIzaBadTeacherKey9999";
    const badEnc = encryptSecret(badTeacher);

    await expect(
      km.execute({
        systemKeysOverride: [],
        teacherEncryptedKeys: [badEnc],
        primaryModel: "gemini-2.5-flash",
        run: async () => {
          throw Object.assign(new Error("API_KEY_INVALID"), { status: 400 });
        },
      })
    ).rejects.toBeInstanceOf(AllGeminiKeysFailedError);

    const fp = fingerprintKey(badTeacher);
    expect(km.getKeyStatus(fp).status).toBe("invalid");

    // Subsequent request does not even invoke run() for the invalid key
    const runSpy = vi.fn();
    try {
      await km.execute({
        systemKeysOverride: [],
        teacherEncryptedKeys: [badEnc],
        primaryModel: "gemini-2.5-flash",
        run: runSpy,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AllGeminiKeysFailedError);
    }
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("enforces max 6 attempts limit across keys and retries", async () => {
    const km = new KeyManager({
      now: () => 1_000_000,
      sleep: async () => { },
      random: () => 0.5,
    });

    const keys = [
      "AIzaKey1111111111",
      "AIzaKey2222222222",
      "AIzaKey3333333333",
      "AIzaKey4444444444",
      "AIzaKey5555555555",
    ];

    let callCount = 0;
    let caught: unknown;

    try {
      await km.execute({
        systemKeysOverride: keys,
        primaryModel: "gemini-2.5-flash",
        run: async () => {
          callCount += 1;
          throw Object.assign(new Error("Internal server error"), { status: 500 });
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(callCount).toBe(6);
    expect(caught).toBeInstanceOf(AllGeminiKeysFailedError);
    expect((caught as AllGeminiKeysFailedError).attempts).toHaveLength(6);
  });

  it("classifies 404 NOT_FOUND as model_unavailable without retry or key cooldown", async () => {
    const classified = classifyGeminiError(
      Object.assign(
        new Error("This model models/gemini-2.5-flash is no longer available"),
        { status: 404 }
      )
    );
    expect(classified.category).toBe("model_unavailable");
    expect(classified.modelFallbackReason).toBe("model_not_found");

    const km = new KeyManager({
      now: () => 1_000_000,
      sleep: async () => { },
      random: () => 0.5,
    });

    const sysKey = "AIzaSysKey1234";
    const seenModels: string[] = [];
    const res = await km.execute({
      systemKeysOverride: [sysKey],
      primaryModel: "gemini-2.5-flash",
      run: async ({ model }) => {
        seenModels.push(model);
        if (model === "gemini-2.5-flash") {
          throw Object.assign(new Error("Model not found"), { status: 404 });
        }
        return "recovered";
      },
    });

    expect(res.value).toBe("recovered");
    expect(seenModels).toEqual(["gemini-2.5-flash", "gemini-3.5-flash-lite"]);
    expect(km.getKeyStatus(res.fingerprint).status).toBe("active");
  });

  it("retries 503 overloaded with exponential backoff (1.5s -> 4s -> 9s) before falling back", async () => {
    let nowMs = 1_000_000;
    const sleeps: number[] = [];
    const km = new KeyManager({
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      random: () => 0.5, // exact base delays: 1500, 4000, 9000
    });

    const seenModels: string[] = [];
    const res = await km.execute({
      systemKeysOverride: ["AIzaSysKey1234"],
      primaryModel: "gemini-3.8-flash",
      run: async ({ model, attempt }) => {
        seenModels.push(model);
        if (attempt <= 4) {
          throw Object.assign(
            new Error("This model is currently experiencing high demand"),
            { status: 503 }
          );
        }
        return "recovered-after-backoff";
      },
    });

    expect(res.value).toBe("recovered-after-backoff");
    expect(seenModels).toEqual([
      "gemini-3.8-flash",
      "gemini-3.8-flash",
      "gemini-3.8-flash",
      "gemini-3.8-flash",
      "gemini-3.5-flash-lite",
    ]);
    expect(sleeps).toEqual([1500, 4000, 9000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      TOTAL_REQUEST_BUDGET_MS
    );
  });

  it("never exceeds TOTAL_REQUEST_BUDGET_MS during backoff and skips backoff on 429", async () => {
    let nowMs = 1_000_000;
    const sleeps: number[] = [];
    const km = new KeyManager({
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      random: () => 0.5,
    });

    await expect(
      km.execute({
        systemKeysOverride: ["AIzaSysKey1234"],
        primaryModel: "gemini-3.8-flash",
        totalBudgetMs: 3_000,
        run: async () => {
          throw Object.assign(new Error("Service unavailable"), { status: 503 });
        },
      })
    ).rejects.toBeInstanceOf(AllGeminiKeysFailedError);

    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3_000);

    // 429 triggers immediate cooldown without backoff sleep
    const sleeps429: number[] = [];
    const km429 = new KeyManager({
      now: () => 1_000_000,
      sleep: async (ms) => {
        sleeps429.push(ms);
      },
      random: () => 0.5,
    });
    await expect(
      km429.execute({
        systemKeysOverride: ["AIzaSysKeyQuota"],
        primaryModel: "gemini-3.8-flash",
        run: async () => {
          throw Object.assign(new Error("Too many requests"), { status: 429 });
        },
      })
    ).rejects.toBeInstanceOf(AllGeminiKeysFailedError);
    expect(sleeps429).toEqual([]);
  });

  it("probes all models in chain and classifies 404 as model_unavailable", async () => {
    const okResults = await probeGeminiModels({
      systemKeysOverride: ["AIzaProbeKey1111"],
      primaryModel: "gemini-3.8-flash",
      clientFactory: () => ({
        models: {
          generateContent: async () => ({ text: "ok" }),
        },
      }),
    });
    expect(okResults.map((r) => ({ model: r.model, ok: r.ok }))).toEqual([
      { model: "gemini-3.8-flash", ok: true },
      { model: "gemini-3.5-flash-lite", ok: true },
    ]);

    const mixedResults = await probeGeminiModels({
      systemKeysOverride: ["AIzaProbeKey1111"],
      primaryModel: "gemini-missing-model",
      clientFactory: () => ({
        models: {
          generateContent: async ({ model }) => {
            if (model === "gemini-missing-model") {
              throw Object.assign(new Error("Model not found"), { status: 404 });
            }
            return { text: "ok" };
          },
        },
      }),
    });
    expect(mixedResults[0]).toMatchObject({
      model: "gemini-missing-model",
      ok: false,
      category: "model_unavailable",
    });
    expect(mixedResults[1]).toMatchObject({
      model: "gemini-3.5-flash-lite",
      ok: true,
    });
  });

  it("verifies a single key via fake client without exposing raw key", async () => {
    const km = new KeyManager({ now: () => 1_000_000 });
    const rawKey = "AIzaVerifyTestKey8888";

    const okRes = await verifyGeminiKey(rawKey, {
      keyManager: km,
      model: "gemini-2.5-flash",
      clientFactory: () => ({
        models: {
          generateContent: async () => ({ text: "OK" }),
        },
      }),
    });

    expect(okRes.valid).toBe(true);
    expect(okRes.status).toBe("valid");
    expect(okRes.masked).toBe("••••8888");
    expect(JSON.stringify(okRes)).not.toContain(rawKey);

    const badRes = await verifyGeminiKey(rawKey, {
      keyManager: km,
      model: "gemini-2.5-flash",
      clientFactory: () => ({
        models: {
          generateContent: async () => {
            throw Object.assign(new Error("API_KEY_INVALID"), { status: 403 });
          },
        },
      }),
    });

    expect(badRes.valid).toBe(false);
    expect(badRes.status).toBe("invalid_key");
  });
});
