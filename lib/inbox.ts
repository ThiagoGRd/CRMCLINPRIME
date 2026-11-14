// Regras puras da tela Conversas. Sem alias @/ nem dependências: os testes importam direto no Node.

export type MediaKind = "text" | "image" | "audio" | "document" | "video";

export type InboxMessage = {
  id: string;
  patient_id: string;
  channel_id?: string | null;
  direction: string;
  content: string;
  created_at: string;
  message_type?: string | null;
  whatsapp_message_id?: string | null;
};

export type LastMessage = Pick<InboxMessage, "patient_id" | "direction" | "content" | "created_at" | "message_type">;

export const MESSAGE_COLUMNS ="id,patient_id,channel_id,direction,content,created_at,message_type,whatsapp_message_id";

// Prefixos que o sincronizador grava no conteúdo das mensagens de mídia (o emoji pode vir com U+FE0F).
const PREFIXES: [RegExp, MediaKind][] = [
  [/^(?:📷️?\s*)?\[Foto\]\s*/u, "image"],
  [/^(?:🎤️?\s*)?\[Áudio recebido\]\s*/u, "audio"],
  [/^(?:🎤️?\s*)?\[Áudio\]:?\s*/u, "audio"],
  [/^(?:📄️?\s*)?\[Documento\]\s*/u, "document"],
  [/^(?:🎥️?\s*)?\[Vídeo\]\s*/u, "video"],
];

const MEDIA_KINDS: MediaKind[] = ["image", "audio", "document", "video"];

export function parseMediaContent(content: string | null, messageType: string | null): { kind: MediaKind; text: string } {
  const raw = content ?? "";
  for (const [re, kind] of PREFIXES) {
    if (re.test(raw)) return { kind, text: raw.replace(re, "").trim() };
  }
  const kind = MEDIA_KINDS.find((k) => k === messageType) ?? "text";
  return { kind, text: raw };
}

// Só foto, áudio e documento têm arquivo guardado; o id com ":" é o que a função wa-media sabe buscar.
export function hasFetchableMedia(m: { message_type?: string | null; whatsapp_message_id?: string | null }): boolean {
  return (m.message_type === "image" || m.message_type === "audio" || m.message_type === "document")
    && (m.whatsapp_message_id ?? "").includes(":");
}

// rows já vêm do mais novo para o mais velho
export function lastByPatient<T extends { patient_id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of rows) if (!out.has(r.patient_id)) out.set(r.patient_id, r);
  return out;
}

export function awaitingReply(last: { direction: string }): boolean {
  return last.direction !== "outbound";
}

const TZ = "America/Sao_Paulo";
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });
const clockFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const shortFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" });
const fullFmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });

function yesterdayKey(now: Date): string {
  const [y, m, d] = dayKeyFmt.format(now).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function relativeDay(iso: string, now: Date): "today" | "yesterday" | "older" {
  const key = dayKeyFmt.format(new Date(iso));
  if (key === dayKeyFmt.format(now)) return "today";
  return key === yesterdayKey(now) ? "yesterday" : "older";
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : clockFmt.format(d);
}

export function listTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const rel = relativeDay(iso, now);
  return rel === "today" ? clockFmt.format(d) : rel === "yesterday" ? "ontem" : shortFmt.format(d);
}

export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const rel = relativeDay(iso, now);
  return rel === "today" ? "Hoje" : rel === "yesterday" ? "Ontem" : fullFmt.format(d);
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dayKeyFmt.format(d);
}

export const AVATAR_PALETTE = ["#4f46e5", "#0e7490", "#047857", "#b45309", "#be185d", "#6d28d9", "#1d4ed8", "#0f766e", "#c2410c", "#7e22ce"];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}
