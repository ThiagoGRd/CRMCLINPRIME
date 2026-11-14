// Sem imports: os testes carregam este arquivo direto no Node (sem alias @/).
export type TimelineItem = {
  at: string;
  kind: "mensagem" | "consulta" | "orcamento" | "tarefa";
  title: string;
  detail: string | null;
  tone: "neutro" | "bom" | "ruim";
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const APPT: Record<string, string> = { agendado: "Agendada", compareceu: "Compareceu", faltou: "Faltou" };
const EST: Record<string, string> = { APPROVED: "Aprovado", FOLLOWUP: "Em follow-up", OPEN: "Em aberto", REJECTED: "Reprovado" };
const TASK: Record<string, string> = { feita: "Concluída", aberta: "Aberta", cancelada: "Cancelada" };
const MSG_TYPE: Record<string, string> = { audio: "Áudio", image: "Imagem", document: "Documento", video: "Vídeo", sticker: "Figurinha" };

type MaybeItem = Omit<TimelineItem, "at"> & { at: string | null };

const iso = (s: string | null | undefined): string | null => {
  const t = s ? new Date(s).getTime() : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
// Data sem hora vale 12h00 de Brasília; hora ilegível também. Data ausente ou inválida: null (item some).
const day = (d: string | null | undefined, time?: string | null): string | null => {
  const date = typeof d === "string" ? d.slice(0, 10) : "";
  const hm = time && /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : "12:00";
  return iso(`${date}T${hm}:00-03:00`) ?? iso(`${date}T12:00:00-03:00`);
};

/** Mantém só as linhas cujo telefone tem o mesmo canon do paciente (canonFn = phoneCanon). */
export function matchByPhone<T extends { phone: string | null }>(rows: T[], canon: string | null, canonFn: (p: string) => string | null): T[] {
  return canon ? rows.filter((r) => r.phone != null && canonFn(r.phone) === canon) : [];
}

export function buildTimeline(i: {
  messages: { created_at: string; direction: string; content: string | null; message_type: string | null }[];
  attendances: { appt_date: string; from_time: string | null; status: string; category: string | null }[];
  estimates: { est_date: string; status: string; amount: number | null }[];
  tasks: { dueAt: string; title: string; status: string }[];
}): TimelineItem[] {
  const items = [
    ...i.messages.map((m): MaybeItem => ({
      at: iso(m.created_at), kind: "mensagem", tone: "neutro",
      title: m.content?.trim() ? m.content.trim().slice(0, 140) : MSG_TYPE[m.message_type ?? ""] ?? m.message_type ?? "Mensagem",
      detail: m.direction === "inbound" ? "Recebida" : "Enviada",
    })),
    ...i.attendances.map((a): MaybeItem => ({
      at: day(a.appt_date, a.from_time), kind: "consulta",
      tone: a.status === "faltou" ? "ruim" : a.status === "compareceu" ? "bom" : "neutro",
      title: `Consulta: ${a.category ?? "Consulta"}`, detail: APPT[a.status] ?? a.status,
    })),
    ...i.estimates.map((e): MaybeItem => ({
      at: day(e.est_date), kind: "orcamento",
      tone: e.status === "APPROVED" ? "bom" : e.status === "REJECTED" ? "ruim" : "neutro",
      title: "Orçamento", detail: [EST[e.status] ?? e.status, e.amount != null ? brl.format(e.amount) : null].filter(Boolean).join(" · "),
    })),
    ...i.tasks.map((t): MaybeItem => ({
      at: iso(t.dueAt), kind: "tarefa", tone: "neutro", title: t.title, detail: TASK[t.status] ?? t.status,
    })),
  ].filter((x): x is TimelineItem => x.at !== null);
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
