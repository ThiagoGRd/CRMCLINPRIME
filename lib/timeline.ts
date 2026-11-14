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

// Data sem hora vale 12h00 de Brasília.
const day = (d: string, time = "12:00") => new Date(`${d.slice(0, 10)}T${time}:00-03:00`).toISOString();

export function buildTimeline(i: {
  messages: { created_at: string; direction: string; content: string | null; message_type: string | null }[];
  attendances: { appt_date: string; from_time: string | null; status: string; category: string | null }[];
  estimates: { est_date: string; status: string; amount: number | null }[];
  tasks: { dueAt: string; title: string; status: string }[];
}): TimelineItem[] {
  const items: TimelineItem[] = [
    ...i.messages.map((m): TimelineItem => ({
      at: new Date(m.created_at).toISOString(), kind: "mensagem", tone: "neutro",
      title: m.content?.trim() ? m.content.trim().slice(0, 140) : MSG_TYPE[m.message_type ?? ""] ?? m.message_type ?? "Mensagem",
      detail: m.direction === "inbound" ? "Recebida" : "Enviada",
    })),
    ...i.attendances.map((a): TimelineItem => ({
      at: day(a.appt_date, a.from_time ? a.from_time.slice(0, 5) : "12:00"), kind: "consulta",
      tone: a.status === "faltou" ? "ruim" : a.status === "compareceu" ? "bom" : "neutro",
      title: `Consulta: ${a.category ?? "Consulta"}`, detail: APPT[a.status] ?? a.status,
    })),
    ...i.estimates.map((e): TimelineItem => ({
      at: day(e.est_date), kind: "orcamento",
      tone: e.status === "APPROVED" ? "bom" : e.status === "REJECTED" ? "ruim" : "neutro",
      title: "Orçamento", detail: [EST[e.status] ?? e.status, e.amount != null ? brl.format(e.amount) : null].filter(Boolean).join(" · "),
    })),
    ...i.tasks.map((t): TimelineItem => ({
      at: new Date(t.dueAt).toISOString(), kind: "tarefa", tone: "neutro", title: t.title, detail: TASK[t.status] ?? t.status,
    })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
