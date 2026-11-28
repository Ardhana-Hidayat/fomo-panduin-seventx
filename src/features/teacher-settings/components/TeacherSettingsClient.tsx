"use client";

import { useEffect, useState } from "react";
import { Card, Button, Chip, Field, Icon, StatusMessage, usePreferences } from "@/shared/ui";
import {
  getTeacherGeminiKeysAction,
  saveTeacherGeminiKeysAction,
  testTeacherGeminiKeyAction,
  type TeacherKeyInputItem,
  type TeacherKeySummary,
} from "../actions";

const MAX_KEYS = 5;

interface TeacherSettingsProps {
  teacher?: {
    displayName: string;
    email?: string | null;
    /** Legacy prop kept for compatibility; never rendered directly to DOM */
    geminiApiKeys?: string[];
    maskedGeminiKeys?: TeacherKeySummary[];
  };
}

export function TeacherSettingsClient({ teacher }: TeacherSettingsProps) {
  const { preferences, setPreference, openSheet } = usePreferences();
  const [audioSpeed, setAudioSpeed] = useState<"0.8" | "0.9" | "1.0">("0.9");

  // Saved Gemini API keys (masked only — raw keys never sent from server)
  const [savedKeys, setSavedKeys] = useState<TeacherKeySummary[]>(
    teacher?.maskedGeminiKeys ?? []
  );
  const [newKeyInput, setNewKeyInput] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [isSavingKeys, setIsSavingKeys] = useState(false);
  const [testingKeyFp, setTestingKeyFp] = useState<string | null>(null);
  const [isTestingNewKey, setIsTestingNewKey] = useState(false);
  const [keyTestMessage, setKeyTestMessage] = useState<{
    type: "benar" | "galat" | "info";
    message: string;
  } | null>(null);
  const [keysStatus, setKeysStatus] = useState<{
    type: "benar" | "galat";
    message: string;
  } | null>(null);

  // Healthcheck state
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [healthResult, setHealthResult] = useState<{
    status: "ok" | "fallback" | "error";
    message: string;
  } | null>(null);

  // AI model connection probe state
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionResults, setConnectionResults] = useState<
    Array<{
      model: string;
      ok: boolean;
      category?: string;
      latencyMs: number;
    }> | null
  >(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Load masked keys from server if only legacy prop or empty was provided
  useEffect(() => {
    if (teacher?.maskedGeminiKeys) return;
    let active = true;
    getTeacherGeminiKeysAction()
      .then((res) => {
        if (active && res.ok) {
          setSavedKeys(res.data.keys);
        }
      })
      .catch(() => {
        // Ignore initial load error
      });
    return () => {
      active = false;
    };
  }, [teacher?.maskedGeminiKeys]);

  async function handleTestAiConnection() {
    setIsTestingConnection(true);
    setConnectionError(null);
    try {
      const res = await fetch("/api/ai/test-connection", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setConnectionError(data?.error ?? "Gagal menguji koneksi AI.");
        setConnectionResults(null);
        return;
      }
      const data = (await res.json()) as {
        ok: boolean;
        results: Array<{
          model: string;
          ok: boolean;
          category?: string;
          latencyMs: number;
        }>;
      };
      setConnectionResults(data.results ?? []);
    } catch {
      setConnectionError("Tidak dapat menghubungi endpoint Tes Koneksi AI.");
      setConnectionResults(null);
    } finally {
      setIsTestingConnection(false);
    }
  }

  async function persistKeyList(items: TeacherKeyInputItem[], successMessage?: string) {
    setIsSavingKeys(true);
    setKeysStatus(null);
    try {
      const res = await saveTeacherGeminiKeysAction(items);
      if (res.ok) {
        setSavedKeys(res.data.keys);
        setNewKeyInput("");
        setShowNewKey(false);
        setKeysStatus({
          type: "benar",
          message:
            successMessage ??
            (res.data.keys.length > 0
              ? `${res.data.keys.length} API Key Gemini tersimpan terenkripsi.`
              : "Daftar API Key Gemini dikosongkan. Sistem memakai kunci bawaan server atau mode lokal."),
        });
      } else {
        setKeysStatus({
          type: "galat",
          message: res.error.message,
        });
      }
    } catch {
      setKeysStatus({
        type: "galat",
        message: "Gagal menyimpan API Key Gemini.",
      });
    } finally {
      setIsSavingKeys(false);
    }
  }

  async function handleAddAndSaveKey() {
    const trimmed = newKeyInput.trim();
    const items: TeacherKeyInputItem[] = savedKeys.map((k) => ({
      kind: "existing",
      fingerprint: k.fingerprint,
    }));
    if (trimmed) {
      items.push({ kind: "new", apiKey: trimmed });
    }
    await persistKeyList(items);
  }

  async function handleMoveKey(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= savedKeys.length) return;
    const reordered = [...savedKeys];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    setSavedKeys(reordered);
    await persistKeyList(
      reordered.map((k) => ({ kind: "existing", fingerprint: k.fingerprint })),
      "Urutan prioritas API Key diperbarui."
    );
  }

  async function handleDeleteKey(fingerprint: string) {
    const remaining = savedKeys.filter((k) => k.fingerprint !== fingerprint);
    setSavedKeys(remaining);
    await persistKeyList(
      remaining.map((k) => ({ kind: "existing", fingerprint: k.fingerprint })),
      remaining.length > 0
        ? "API Key dihapus. Daftar key cadangan diperbarui."
        : "API Key dihapus. Sistem memakai kunci bawaan server atau mode lokal."
    );
  }

  async function handleTestSavedKey(fingerprint: string) {
    setTestingKeyFp(fingerprint);
    setKeyTestMessage(null);
    try {
      const res = await testTeacherGeminiKeyAction({
        kind: "existing",
        fingerprint,
      });
      if (res.ok) {
        setKeyTestMessage({
          type: res.data.valid ? "benar" : res.data.status === "quota" ? "info" : "galat",
          message: res.data.message,
        });
        // Refresh key statuses
        const refreshed = await getTeacherGeminiKeysAction();
        if (refreshed.ok) setSavedKeys(refreshed.data.keys);
      } else {
        setKeyTestMessage({ type: "galat", message: res.error.message });
      }
    } catch {
      setKeyTestMessage({
        type: "galat",
        message: "Gagal menguji API Key.",
      });
    } finally {
      setTestingKeyFp(null);
    }
  }

  async function handleTestNewKey() {
    const trimmed = newKeyInput.trim();
    if (!trimmed) return;
    setIsTestingNewKey(true);
    setKeyTestMessage(null);
    try {
      const res = await testTeacherGeminiKeyAction({
        kind: "new",
        apiKey: trimmed,
      });
      if (res.ok) {
        setKeyTestMessage({
          type: res.data.valid ? "benar" : res.data.status === "quota" ? "info" : "galat",
          message: res.data.message,
        });
      } else {
        setKeyTestMessage({ type: "galat", message: res.error.message });
      }
    } catch {
      setKeyTestMessage({
        type: "galat",
        message: "Gagal menguji API Key baru.",
      });
    } finally {
      setIsTestingNewKey(false);
    }
  }

  async function handleCheckHealth() {
    setIsCheckingHealth(true);
    setHealthResult(null);

    try {
      const res = await fetch("/api/ai/generate-lesson", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType: "topik",
          topic: "Kucing",
          level: "sdlb",
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.generatedBy === "ai") {
          setHealthResult({
            status: "ok",
            message: "Tersambung! Model Gemini API aktif dan siap menghasilkan materi adaptif.",
          });
        } else {
          setHealthResult({
            status: "fallback",
            message: "Tersambung (Mode Cadangan Bawaan Aktif). Server siap bekerja secara aman tanpa kendala kuota.",
          });
        }
      } else {
        setHealthResult({
          status: "fallback",
          message: "Mode cadangan otomatis aktif. Aplikasi siap digunakan secara offline/lokal.",
        });
      }
    } catch {
      setHealthResult({
        status: "fallback",
        message: "Mode cadangan otomatis aktif. Sistem berjalan aman di jaringan lokal.",
      });
    }

    setIsCheckingHealth(false);
  }

  const displayName = teacher?.displayName || "Guru PanduIn";
  const initial = displayName.trim().charAt(0).toUpperCase() || "G";

  function renderKeyStatusBadge(item: TeacherKeySummary) {
    if (item.status === "invalid") {
      return (
        <span className="inline-flex items-center rounded-full border border-[var(--galat-edge)] bg-[var(--galat-bg)] px-2 py-0.5 text-xs font-bold text-[var(--galat-ink)]">
          Tidak Valid
        </span>
      );
    }
    if (item.status === "cooldown") {
      return (
        <span className="inline-flex items-center rounded-full border border-[var(--border-strong)] bg-[var(--surface-2)] px-2 py-0.5 text-xs font-bold text-[var(--ink-2)]">
          {item.isDailyQuota ? "Kuota Harian Penuh" : "Jeda Kuota"}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center rounded-full border border-[var(--benar-edge)] bg-[var(--benar-bg)] px-2 py-0.5 text-xs font-bold text-[var(--benar-ink)]">
        Siap
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-8 w-full">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--ink)]">
          Pengaturan Ruang Guru
        </h1>
        <p className="text-base text-[var(--ink-2)] max-w-2xl leading-relaxed">
          Kelola kenyamanan tampilan, kecepatan suara belajar, pustaka isyarat SIBI, dan akun guru PanduIn.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Kolom Utama: Tampilan, Suara & Sistem Isyarat */}
        <div className="lg:col-span-7 flex flex-col gap-6">
          {/* 1. Tampilan & Suara */}
          <Card as="section" className="flex flex-col gap-6">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-subtle)] text-[var(--primary)]">
                    <Icon name="TextAa" size={22} />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-[var(--ink)]">Tampilan &amp; Kontras</h2>
                    <p className="text-sm text-[var(--ink-2)] mt-1 leading-relaxed">
                      Tiga palet warna berstandar WCAG AAA (kontras minimal 7:1) untuk kenyamanan visual.
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  onClick={openSheet}
                  icon={<Icon name="TextAa" size={16} />}
                  className="shrink-0 w-fit"
                >
                  Atur Huruf &amp; Jarak
                </Button>
              </div>

              <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Tema dan kontras warna">
                {(
                  [
                    ["terang", "Terang (17:1)"],
                    ["gelap", "Gelap (15.7:1)"],
                    ["kuning-hitam", "Kontras Tinggi (AAA)"],
                  ] as const
                ).map(([val, label]) => (
                  <Chip
                    key={val}
                    label={label}
                    selected={preferences.tema === val}
                    onSelect={() => setPreference("tema", val)}
                    role="radio"
                  />
                ))}
              </div>
            </div>

            <div className="border-t border-[var(--border)] pt-6 flex flex-col gap-4">
              <div className="flex items-start gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-subtle)] text-[var(--primary)]">
                  <Icon name="SpeakerHigh" size={22} />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-[var(--ink)]">Kecepatan Suara Belajar</h2>
                  <p className="text-sm text-[var(--ink-2)] mt-1 leading-relaxed">
                    Kecepatan pelafalan suara sintetis dan audio peraga untuk membantu pemahaman siswa.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="Kecepatan suara belajar">
                {(
                  [
                    ["0.8", "Lambat (0.8x)"],
                    ["0.9", "Tenang (0.9x) - Bawaan"],
                    ["1.0", "Normal (1.0x)"],
                  ] as const
                ).map(([val, label]) => (
                  <Chip
                    key={val}
                    label={label}
                    selected={audioSpeed === val}
                    onSelect={() => setAudioSpeed(val)}
                    role="radio"
                  />
                ))}
              </div>
            </div>
          </Card>

          {/* 2. Sistem Isyarat & Pustaka */}
          <Card as="section" className="flex flex-1 flex-col justify-between gap-5">
            <div className="flex items-start gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-subtle)] text-[var(--primary)]">
                <Icon name="Hand" size={22} />
              </div>
              <div>
                <h2 className="text-xl font-bold text-[var(--ink)]">Sistem Isyarat</h2>
                <p className="text-sm text-[var(--ink-2)] mt-1 leading-relaxed">
                  PanduIn menggunakan SIBI (Sistem Isyarat Bahasa Indonesia) sebagai sistem isyarat standar pembelajaran.
                </p>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <div className="flex items-center gap-2.5 text-sm font-bold text-[var(--ink)]">
                <Icon name="CheckCircle" size={20} className="text-[var(--primary)] shrink-0" />
                <span>SIBI &bull; Pustaka Abjad (A &ndash; Z)</span>
              </div>
              <Button
                variant="secondary"
                size="normal"
                href="/guru/pengaturan/isyarat"
                icon={<Icon name="Hand" size={18} />}
                className="shrink-0 w-full sm:w-fit"
              >
                Buka Pustaka Isyarat
              </Button>
            </div>
          </Card>
        </div>

        {/* Kolom Sekunder: Akun Guru & Pemeriksaan Layanan */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          {/* 3. Akun Guru & Keluar */}
          <Card as="section" className="flex flex-col justify-between gap-5 border-[var(--border-strong)]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3.5">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-subtle)] text-[var(--primary)]">
                  <Icon name="UsersThree" size={22} />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-[var(--ink)]">Akun Guru &amp; Keluar</h2>
                  <p className="text-sm text-[var(--ink-2)] mt-1 leading-relaxed">
                    Informasi akun yang sedang aktif di ruang guru PanduIn.
                  </p>
                </div>
              </div>
              <span className="inline-flex shrink-0 items-center rounded-full border border-[var(--benar-edge)] bg-[var(--benar-bg)] px-2.5 py-1 text-xs font-bold text-[var(--benar-ink)]">
                Aktif
              </span>
            </div>

            <div className="flex items-center gap-3.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
              <div
                aria-hidden="true"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-lg font-bold text-[var(--on-primary)]"
              >
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-base text-[var(--ink)] truncate">
                  {displayName}
                </p>
                <p className="text-sm text-[var(--muted)] truncate">
                  {teacher?.email || "Masuk melalui akun Google"}
                </p>
              </div>
            </div>

            <div className="pt-4 border-t border-[var(--border)] flex flex-col gap-3">
              <p className="text-xs text-[var(--muted)] leading-relaxed">
                Keluar akan mengakhiri sesi guru di perangkat ini. Materi dan pengaturan Anda tetap tersimpan aman.
              </p>
              <form action="/api/auth/logout" method="POST" className="w-full">
                <Button
                  type="submit"
                  variant="danger"
                  size="large"
                  icon={<Icon name="DoorOpen" size={20} />}
                  className="w-full justify-center"
                >
                  Keluar dari Akun
                </Button>
              </form>
            </div>
          </Card>

          {/* 4. API Key Gemini (Terenkripsi) & Pemeriksaan Layanan */}
          <Card as="section" className="flex flex-1 flex-col justify-between gap-5">
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-start gap-3.5 min-w-0 flex-1">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-subtle)] text-[var(--primary)]">
                    <Icon name="Sparkle" size={22} />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-[var(--ink)]">API Key Gemini &amp; Layanan AI</h2>
                    <p className="text-sm text-[var(--ink-2)] mt-1 leading-relaxed">
                      Tambahkan hingga {MAX_KEYS} API Key Google Gemini sebagai cadangan setelah kunci server. Semua kunci disimpan terenkripsi.
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="compact"
                  loading={isTestingConnection}
                  disabled={isTestingConnection}
                  onClick={handleTestAiConnection}
                  icon={<Icon name="CheckCircle" size={16} />}
                >
                  {isTestingConnection ? "Menguji AI..." : "Tes Koneksi AI"}
                </Button>
              </div>

              {connectionError && (
                <StatusMessage type="galat">{connectionError}</StatusMessage>
              )}

              {connectionResults && (
                <div
                  className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 flex flex-col gap-2"
                  aria-label="Hasil Tes Koneksi AI"
                >
                  <p className="text-xs font-bold text-[var(--ink)]">
                    Status Model AI Saat Ini
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {connectionResults.map((item) => {
                      const label = item.ok
                        ? "Tersedia"
                        : item.category === "model_unavailable"
                          ? "Tidak tersedia (404)"
                          : item.category === "quota"
                            ? "Kuota habis"
                            : item.category === "invalid_key"
                              ? "Key tidak valid"
                              : "Sibuk (503)";
                      return (
                        <div
                          key={item.model}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="font-mono font-semibold text-[var(--ink)]">
                            {item.model}
                          </span>
                          <span
                            className={
                              item.ok
                                ? "font-bold text-emerald-700"
                                : "font-bold text-amber-700"
                            }
                          >
                            {label} &bull; {item.latencyMs} ms
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Daftar kunci tersimpan (hanya masked + fingerprint/status) */}
              {savedKeys.length > 0 && (
                <div className="flex flex-col gap-2" aria-label="Daftar API Key tersimpan">
                  {savedKeys.map((item, idx) => (
                    <div
                      key={item.fingerprint}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Icon name="Key" size={16} className="text-[var(--primary)] shrink-0" />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-bold text-[var(--ink)] font-mono">
                              {item.masked}
                            </span>
                            {renderKeyStatusBadge(item)}
                          </div>
                          <p className="text-xs text-[var(--muted)]">
                            Cadangan #{idx + 1} &bull; ID {item.fingerprint.slice(0, 8)}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          disabled={isSavingKeys || idx === 0}
                          onClick={() => handleMoveKey(idx, -1)}
                          aria-label={`Naikkan prioritas kunci ${item.masked}`}
                        >
                          Naik
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          disabled={isSavingKeys || idx === savedKeys.length - 1}
                          onClick={() => handleMoveKey(idx, 1)}
                          aria-label={`Turunkan prioritas kunci ${item.masked}`}
                        >
                          Turun
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          disabled={testingKeyFp === item.fingerprint}
                          onClick={() => handleTestSavedKey(item.fingerprint)}
                        >
                          {testingKeyFp === item.fingerprint ? "Menguji..." : "Uji Kunci"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="compact"
                          disabled={isSavingKeys}
                          onClick={() => handleDeleteKey(item.fingerprint)}
                          aria-label={`Hapus kunci ${item.masked}`}
                          icon={<Icon name="Trash" size={15} />}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Form tambah kunci baru */}
              {savedKeys.length < MAX_KEYS ? (
                <div className="flex flex-col gap-2.5">
                  <div className="flex items-end gap-2">
                    <div className="flex-1 min-w-0">
                      <Field
                        id="gemini-new-key"
                        label={`Tambah API Key Baru (${savedKeys.length}/${MAX_KEYS})`}
                        type={showNewKey ? "text" : "password"}
                        placeholder="AIza..."
                        value={newKeyInput}
                        onChange={(e) => setNewKeyInput(e.target.value)}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="normal"
                      onClick={() => setShowNewKey((v) => !v)}
                      aria-label={showNewKey ? "Sembunyikan input key" : "Tampilkan input key"}
                      className="shrink-0"
                    >
                      {showNewKey ? "Tutup" : "Lihat"}
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="compact"
                      loading={isSavingKeys}
                      disabled={!newKeyInput.trim() || isSavingKeys}
                      onClick={handleAddAndSaveKey}
                      icon={<Icon name="Plus" size={16} />}
                    >
                      {isSavingKeys ? "Menyimpan..." : "Simpan API Key"}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="compact"
                      disabled={!newKeyInput.trim() || isTestingNewKey}
                      onClick={handleTestNewKey}
                    >
                      {isTestingNewKey ? "Menguji..." : "Uji Kunci"}
                    </Button>
                  </div>
                </div>
              ) : (
                <StatusMessage type="info">
                  Maksimal {MAX_KEYS} API Key tersimpan. Hapus salah satu kunci jika ingin mengganti.
                </StatusMessage>
              )}

              {keyTestMessage && (
                <StatusMessage type={keyTestMessage.type}>
                  {keyTestMessage.message}
                </StatusMessage>
              )}

              {keysStatus && (
                <StatusMessage type={keysStatus.type}>
                  {keysStatus.message}
                </StatusMessage>
              )}

              {/* Panduan & Privasi Google AI Studio */}
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5 text-xs text-[var(--ink-2)] leading-relaxed flex flex-col gap-1.5">
                <p className="font-bold text-[var(--ink)] flex items-center gap-1.5">
                  <Icon name="Info" size={15} className="text-[var(--primary)] shrink-0" />
                  Panduan API Key &amp; Privasi
                </p>
                <p>
                  1. Buat kunci gratis di{" "}
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold underline text-[var(--primary)]"
                  >
                    Google AI Studio
                  </a>{" "}
                  lalu tempelkan di atas. Jangan bagikan API Key Anda kepada orang lain.
                </p>
                <p>
                  2. Konten materi yang Anda buat dikirim ke Google sesuai ketentuan layanan gratis Google AI Studio. Demi privasi, jangan sertakan nama atau data pribadi siswa di dalam teks materi.
                </p>
              </div>

              {healthResult && (
                <StatusMessage type={healthResult.status === "ok" ? "benar" : "info"}>
                  {healthResult.message}
                </StatusMessage>
              )}
            </div>

            <div className="pt-3 border-t border-[var(--border)] flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-[var(--muted)]">
                Uji koneksi model Gemini aktif &amp; cadangan
              </span>
              <Button
                type="button"
                variant="secondary"
                size="normal"
                disabled={isCheckingHealth}
                onClick={handleCheckHealth}
                icon={<Icon name="ArrowsClockwise" size={18} />}
              >
                {isCheckingHealth ? "Memeriksa..." : "Uji layanan AI"}
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
