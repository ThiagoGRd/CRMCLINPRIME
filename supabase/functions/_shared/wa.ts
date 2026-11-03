// Helpers puros do WhatsApp Cloud API (sem dependência de Deno, testáveis no Node).

/** wa_id da Meta ("5582991212108" ou sem o 9: "558291212108") → formato salvo no CRM ("82991212108"). */
export function waIdToLocal(waId: string): string {
  let d = String(waId ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  // Celular antigo sem o 9º dígito: DDD + 8 dígitos começando em 6-9.
  if (d.length === 10 && /^[6-9]$/.test(d[2])) d = d.slice(0, 2) + "9" + d.slice(2);
  return d;
}

/** Telefone do CRM → destinatário da Cloud API (só dígitos, com 55). */
export function localToWa(phone: string): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.startsWith("55") && d.length >= 12 ? d : "55" + d;
}

/** Mesmo critério do phone_canon() do banco: DDD + 8 últimos dígitos. */
export function phoneCanon(phone: string): string | null {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  return d.length < 10 ? null : d.slice(0, 2) + d.slice(-8);
}

type WaMessage = Record<string, any>;

/** Converte uma mensagem do webhook em { type, content, mediaId, mime }. */
export function parseMessage(m: WaMessage): { type: string; content: string; mediaId: string | null; mime: string | null } {
  const t = m.type as string;
  const media = ["image", "audio", "video", "document", "sticker"].includes(t) ? m[t] : null;
  const label: Record<string, string> = {
    image: "[imagem]", audio: "[áudio]", video: "[vídeo]", document: "[documento]", sticker: "[figurinha]",
    location: "[localização]", contacts: "[contato]", reaction: "[reação]",
  };
  let content = "";
  if (t === "text") content = m.text?.body ?? "";
  else if (t === "button") content = m.button?.text ?? "";
  else if (t === "interactive") content = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "";
  else if (t === "reaction") content = m.reaction?.emoji ? `[reação ${m.reaction.emoji}]` : label.reaction;
  else if (media) content = media.caption || (t === "document" && media.filename ? `[documento] ${media.filename}` : label[t]);
  else content = label[t] ?? `[${t}]`;
  return { type: t === "button" || t === "interactive" ? "text" : t, content, mediaId: media?.id ?? null, mime: media?.mime_type ?? null };
}
