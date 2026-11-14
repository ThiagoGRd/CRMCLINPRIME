export type Front = "recepcao" | "crc_leads" | "comercial" | "pos_venda";
export type TaskKind = "demanda" | "proxima_acao" | "passo_cadencia";
export type Task = {
  id: string; patientId: string; patientName: string; patientPhone: string;
  front: Front; kind: TaskKind; title: string; ownerId: string | null;
  dueAt: string; status: "aberta" | "feita" | "cancelada"; draft: string | null;
};
export type Urgency = "vencida" | "hoje" | "futura";

export const FRONTS: { key: Front; label: string }[] = [
  { key: "recepcao", label: "Recepção" },
  { key: "crc_leads", label: "CRC Leads" },
  { key: "comercial", label: "Comercial" },
  { key: "pos_venda", label: "Pós-venda" },
];

export const DEFAULT_SLA_MIN: Record<Front, number> = { recepcao: 30, crc_leads: 60, comercial: 120, pos_venda: 1440 };

const TZ = "America/Sao_Paulo";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ });

export function slaMinutes(front: Front, settings: Record<string, unknown> | null): number {
  const sla = settings?.sla;
  const v = sla && typeof sla === "object" ? (sla as Record<string, unknown>)[front] : undefined;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_SLA_MIN[front];
}

export function demandDueAt(now: Date, front: Front, settings: Record<string, unknown> | null): Date {
  return new Date(now.getTime() + slaMinutes(front, settings) * 60_000);
}

export function urgency(dueAt: string, now: Date): Urgency {
  const due = new Date(dueAt);
  // data inválida cai em vencida para aparecer no topo em vez de sumir
  if (Number.isNaN(due.getTime()) || due < now) return "vencida";
  return dayFmt.format(due) === dayFmt.format(now) ? "hoje" : "futura";
}

const RANK: Record<Urgency, number> = { vencida: 0, hoje: 1, futura: 2 };

export function sortQueue(tasks: Task[], now: Date): Task[] {
  return [...tasks].sort(
    (a, b) => RANK[urgency(a.dueAt, now)] - RANK[urgency(b.dueAt, now)] || new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime(),
  );
}

export function demandTitle(messageContent: string | null, patientName: string): string {
  const text = (messageContent ?? "").trim();
  return text ? text.slice(0, 80) : `Demanda de ${patientName}`;
}

export function validateCompletion(i: { nextTitle: string; nextDue: string; closeReason: string }, now: Date): string | null {
  if (i.closeReason.trim() && !i.nextTitle.trim()) return null;
  if (!i.nextTitle.trim()) return "Informe a próxima ação ou encerre o paciente com um motivo.";
  const due = new Date(i.nextDue);
  return due.getTime() > now.getTime() ? null : "O prazo da próxima ação precisa ser no futuro.";
}

export function visibleTo(task: Task, me: { userId: string; isManager: boolean }, memberIds: string[]): boolean {
  void memberIds; // gestor vê tudo, inclusive tarefa de quem saiu da organização
  return me.isManager || task.ownerId === me.userId;
}
