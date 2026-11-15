import type { TimelineItem } from "@/lib/timeline";

const TONE = { neutro: "bg-white/30", bom: "bg-emerald-500", ruim: "bg-red-500" } as const;
const KIND = { mensagem: "Mensagem", consulta: "Consulta", orcamento: "Orçamento", tarefa: "Tarefa" } as const;

const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });

export function PatientTimeline({ items }: { items: TimelineItem[] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">Nada registrado para este paciente ainda.</p>;
  return (
    <ol className="space-y-3">
      {items.map((it, i) => (
        <li key={`${it.kind}-${it.at}-${i}`} className="flex gap-3">
          <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${TONE[it.tone]}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
              <span className="font-semibold uppercase tracking-wide">{KIND[it.kind]}</span>
              <time dateTime={it.at}>{(it.kind === "orcamento" ? fmtDay : fmt).format(new Date(it.at))}</time>
            </div>
            <p className="break-words text-sm">{it.title}</p>
            {it.detail && <p className="text-xs text-muted-foreground">{it.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
