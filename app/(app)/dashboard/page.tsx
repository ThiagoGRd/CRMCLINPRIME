import { createClient } from "@/lib/supabase/server";
import { getMyOrg } from "@/lib/org";
import { formatCurrency, MES_FULL, formatDateBR } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { LeadsChart } from "@/components/dashboard/leads-chart";
import { SyncClinicorpButton } from "@/components/sync-clinicorp-button";
import { DollarSign, ShoppingBag, UserCheck, Receipt } from "lucide-react";

type Metrics = {
  faturamento: number;
  vendas: number;
  comparecimentos: number;
  agendamentos: number;
  ticket_medio: number;
};

function computeWeekly(rows: { created_at: string }[], now: Date) {
  const weeks = 6;
  const out: { label: string; novos: number }[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = new Date(now);
    end.setDate(now.getDate() - i * 7);
    const start = new Date(end);
    start.setDate(end.getDate() - 7);
    const novos = rows.filter((r) => {
      const d = new Date(r.created_at);
      return d > start && d <= end;
    }).length;
    out.push({ label: i === 0 ? "Esta sem." : `${weeks - i}ª sem`, novos });
  }
  return out;
}

export default async function DashboardPage() {
  const supabase = await createClient();
  const org = await getMyOrg(supabase);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const [{ data: mRaw }, { data: weekRows }, { data: events }, { data: recent }] = await Promise.all([
    supabase.rpc("get_month_metrics", { p_org: org!.id, p_year: year, p_month: month }),
    supabase
      .from("patients")
      .select("created_at")
      .gte("created_at", new Date(now.getTime() - 42 * 24 * 3600 * 1000).toISOString())
      .limit(5000),
    supabase
      .from("activity_logs")
      .select("action, details, created_at, patient:patients(name)")
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("patients")
      .select("name, source, created_at")
      .order("created_at", { ascending: false })
      .limit(8),
  ]);

  const m = (mRaw ?? {}) as Metrics;
  const series = computeWeekly((weekRows ?? []) as { created_at: string }[], now);
  const recentLeads = (recent ?? []) as { name: string; source: string; created_at: string }[];

  type EventRow = { action: string; details: Record<string, unknown> | null; created_at: string; patient: { name: string } | { name: string }[] | null };
  const recentEvents = ((events ?? []) as EventRow[]).map((e) => {
    const p = Array.isArray(e.patient) ? e.patient[0] : e.patient;
    const name = p?.name ?? "Paciente";
    let text = "";
    if (e.action === "message_sent") text = `Mensagem enviada para ${name}`;
    else if (e.action === "stage_moved") text = `${name}: ${e.details?.from_stage ?? "?"} → ${e.details?.to_stage ?? "?"}`;
    else text = `${e.action} — ${name}`;
    return { text, date: e.created_at };
  });

  const kpis = [
    { label: "Faturamento do mês", value: formatCurrency(m.faturamento ?? 0), hint: `em ${MES_FULL[month - 1]}`, icon: DollarSign },
    { label: "Vendas do mês", value: String(m.vendas ?? 0), hint: "orçamentos aprovados", icon: ShoppingBag },
    { label: "Comparecimentos", value: String(m.comparecimentos ?? 0), hint: `${m.agendamentos ?? 0} agendados no mês`, icon: UserCheck },
    { label: "Ticket médio", value: formatCurrency(m.ticket_medio ?? 0), hint: "por venda (Dr. Thiago)", icon: Receipt },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Números de {MES_FULL[month - 1]} — sincronizados do Clinicorp.
        </div>
        <SyncClinicorpButton year={year} month={month} />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <Card key={k.label} className="gap-0 p-5">
              <div className="flex items-start justify-between">
                <span className="text-sm text-muted-foreground">{k.label}</span>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Icon className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-3 font-heading text-3xl font-extrabold">{k.value}</div>
              <div className="mt-2 text-xs text-emerald-400">↗ {k.hint}</div>
            </Card>
          );
        })}
      </div>

      {/* Gráfico + atividade */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="p-6 lg:col-span-2">
          <div className="mb-4">
            <div className="font-heading text-base font-bold">Entrada de leads</div>
            <div className="text-sm text-muted-foreground">
              Novos leads por semana (últimas 6 semanas)
            </div>
          </div>
          <LeadsChart data={series} />
        </Card>

        <Card className="p-6">
          <div className="mb-4 font-heading text-base font-bold">
            {recentEvents.length > 0 ? "Eventos recentes" : "Leads recentes"}
          </div>
          <div className="space-y-1">
            {recentEvents.length > 0
              ? recentEvents.map((e, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3 border-b border-white/5 py-2.5 last:border-0"
                  >
                    <div className="min-w-0 truncate text-sm">{e.text}</div>
                    <div className="shrink-0 text-xs text-muted-foreground">{formatDateBR(e.date)}</div>
                  </div>
                ))
              : recentLeads.map((l, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between border-b border-white/5 py-2.5 last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{l.name}</div>
                      <div className="text-xs text-muted-foreground">{l.source || "Geral"}</div>
                    </div>
                    <div className="shrink-0 text-xs text-muted-foreground">
                      {formatDateBR(l.created_at)}
                    </div>
                  </div>
                ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
