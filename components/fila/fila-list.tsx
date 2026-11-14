// Sem componentes de components/ui nem alias @/: os testes importam este arquivo direto no Node.
import { sortQueue, urgency, visibleTo, type Front, type Task, type Urgency } from "../../lib/tasks";

export type ForgottenPatient = { id: string; name: string; phone: string; front: Front; assignedTo: string | null };

type Props = {
  tasks: Task[];
  now: Date;
  me: { userId: string; isManager: boolean };
  memberIds: string[];
  forgotten: ForgottenPatient[];
  selectedId: string | null;
  onOpen: (t: Task) => void;
  onDone: (t: Task) => void;
  onSnooze: (t: Task) => void;
  onDefineNext: (p: ForgottenPatient) => void;
};

const BADGE: Record<Urgency, { label: string; cls: string }> = {
  vencida: { label: "Vencida", cls: "border-red-500/30 bg-red-500/15 text-red-400" },
  hoje: { label: "Hoje", cls: "border-amber-500/30 bg-amber-500/15 text-amber-400" },
  futura: { label: "Futura", cls: "border-white/12 bg-white/[0.03] text-foreground/80" },
};

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function relativeDue(dueAt: string, now: Date): string {
  const min = Math.round((new Date(dueAt).getTime() - now.getTime()) / 60_000);
  if (Number.isNaN(min)) return "prazo inválido";
  const abs = Math.abs(min);
  if (abs < 60) return rtf.format(min, "minute");
  if (abs < 1440) return rtf.format(Math.round(min / 60), "hour");
  return rtf.format(Math.round(min / 1440), "day");
}

const btn = "inline-flex h-9 items-center rounded-md border border-white/12 px-3 text-sm hover:bg-muted";

function Row({ t, now, selected, p }: { t: Task; now: Date; selected: boolean; p: Props }) {
  const u = urgency(t.dueAt, now);
  return (
    <li
      data-task-id={t.id}
      aria-current={selected || undefined}
      className={`rounded-lg border p-3 ${selected ? "border-primary/60 bg-primary/5" : "border-white/8"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t.patientName || "Paciente sem nome"}</span>
        <span className={`inline-flex h-5.5 items-center rounded-full border px-2.5 text-[11px] font-semibold ${BADGE[u].cls}`}>
          {BADGE[u].label}
        </span>
        <span className="text-xs text-muted-foreground">{relativeDue(t.dueAt, now)}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t.title}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => p.onOpen(t)}>Abrir conversa</button>
        <button type="button" className={btn} onClick={() => p.onDone(t)}>Feito</button>
        <button type="button" className={btn} onClick={() => p.onSnooze(t)}>Adiar</button>
      </div>
    </li>
  );
}

function Group({ items, p }: { items: Task[]; p: Props }) {
  return (
    <ul className="space-y-2">
      {items.map((t) => <Row key={t.id} t={t} now={p.now} selected={t.id === p.selectedId} p={p} />)}
    </ul>
  );
}

// Ordem em que as linhas aparecem: com responsável primeiro, depois o bloco "Sem responsável".
export function splitQueue(p: Pick<Props, "tasks" | "now" | "me" | "memberIds">) {
  const visible = sortQueue(p.tasks.filter((t) => visibleTo(t, p.me, p.memberIds)), p.now);
  return { owned: visible.filter((t) => t.ownerId !== null), unowned: visible.filter((t) => t.ownerId === null) };
}

export function FilaList(p: Props) {
  const { owned, unowned } = splitQueue(p);
  const visible = [...owned, ...unowned];
  const forgotten = p.forgotten.filter((f) => p.me.isManager || f.assignedTo === p.me.userId);

  return (
    <div className="space-y-6">
      {visible.length === 0 && (
        <p className="rounded-lg border border-white/8 p-6 text-center text-sm text-muted-foreground">
          Nada pendente. Nenhum paciente esperando por você.
        </p>
      )}
      {owned.length > 0 && <Group items={owned} p={p} />}
      {unowned.length > 0 && (
        <section aria-label="Sem responsável" className="space-y-2">
          <h2 className="text-sm font-semibold">Sem responsável ({unowned.length})</h2>
          <Group items={unowned} p={p} />
        </section>
      )}
      {forgotten.length > 0 && (
        <section aria-label="Sem próxima ação" className="space-y-2">
          <h2 className="text-sm font-semibold">Sem próxima ação ({forgotten.length})</h2>
          <ul className="space-y-2">
            {forgotten.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/8 p-3">
                <span className="text-sm font-medium">{f.name}</span>
                <button type="button" className={btn} onClick={() => p.onDefineNext(f)}>Definir próxima ação</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
