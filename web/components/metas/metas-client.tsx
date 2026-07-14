"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { formatCurrency, formatDateBR, MES_FULL, MES_ABREV } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";

type Metrics = {
  leads: number; agendamentos: number; comparecimentos: number; vendas: number;
  faturamento: number; ticket_medio: number;
  taxa_lead_agend: number; taxa_agend_comp: number; taxa_comp_venda: number;
};
type Goal = Record<string, number | null | undefined>;
type Finance = { credit: number; debit: number; net: number } | null;

const NOW = new Date();

export function MetasClient() {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const profId = String((org.settings?.clinicorp_professional_id as string) ?? "");
  const [year, setYear] = useState(NOW.getFullYear());
  const [month, setMonth] = useState(NOW.getMonth() + 1);
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalForm, setGoalForm] = useState<Goal>({});
  const [detail, setDetail] = useState<{ metric: string; title: string } | null>(null);

  const { data, refetch } = useQuery({
    queryKey: ["metas", year, month],
    queryFn: async () => {
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const [m, g, f, ys] = await Promise.all([
        supabase.rpc("get_month_metrics", { p_org: org.id, p_year: year, p_month: month }),
        supabase.from("crm_goals").select("*").eq("org_id", org.id).eq("year", year).eq("month", month).maybeSingle(),
        supabase.from("crm_finance").select("credit,debit,net").eq("org_id", org.id).eq("month_start", start).maybeSingle(),
        supabase.rpc("get_year_summary", { p_org: org.id, p_year: year }),
      ]);
      // sync em background pra manter fresco
      supabase.functions.invoke("clinicorp-agenda", {
        body: { action: "sync_month", from: start, to: `${year}-${String(month).padStart(2, "0")}-28` },
      }).catch(() => {});
      return {
        m: (m.data ?? {}) as Metrics,
        goal: (g.data ?? {}) as Goal,
        finance: (f.data ?? null) as Finance,
        year: (ys.data ?? []) as Metrics[],
      };
    },
  });

  const m = data?.m ?? ({} as Metrics);
  const goal = data?.goal ?? {};
  const finance = data?.finance ?? null;
  const yearData = data?.year ?? [];

  async function saveGoal() {
    const payload = {
      org_id: org.id, year, month,
      meta_faturamento: num(goalForm.meta_faturamento),
      meta_vendas: num(goalForm.meta_vendas),
      meta_comparecimentos: num(goalForm.meta_comparecimentos),
      meta_ticket_medio: num(goalForm.meta_ticket_medio),
    };
    const { error } = await supabase
      .from("crm_goals")
      .upsert(payload, { onConflict: "org_id,year,month" });
    if (error) toast.error("Erro ao salvar metas");
    else { toast.success("Metas salvas 🎯"); setGoalOpen(false); refetch(); }
  }

  const funnel = [
    { key: "leads", label: "Leads", value: m.leads ?? 0, rate: null as string | null },
    { key: "agendamentos", label: "Agendamentos", value: m.agendamentos ?? 0, rate: pct(m.taxa_lead_agend) },
    { key: "comparecimentos", label: "Comparecimentos", value: m.comparecimentos ?? 0, rate: pct(m.taxa_agend_comp) },
    { key: "vendas", label: "Vendas", value: m.vendas ?? 0, rate: pct(m.taxa_comp_venda) },
  ];

  const goals = [
    { label: "Faturamento", real: m.faturamento ?? 0, meta: num(goal.meta_faturamento), fmt: formatCurrency },
    { label: "Vendas", real: m.vendas ?? 0, meta: num(goal.meta_vendas), fmt: (v: number) => String(Math.round(v)) },
    { label: "Comparecimentos", real: m.comparecimentos ?? 0, meta: num(goal.meta_comparecimentos), fmt: (v: number) => String(Math.round(v)) },
    { label: "Ticket médio", real: m.ticket_medio ?? 0, meta: num(goal.meta_ticket_medio), fmt: formatCurrency },
  ];

  return (
    <div className="space-y-6">
      {/* Período */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
          <SelectTrigger className="w-[150px]"><SelectValue>{MES_FULL[month - 1]}</SelectValue></SelectTrigger>
          <SelectContent>{MES_FULL.map((mm, i) => <SelectItem key={i} value={String(i + 1)}>{mm}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-[110px]"><SelectValue /></SelectTrigger>
          <SelectContent>{[NOW.getFullYear(), NOW.getFullYear() - 1].map((y) => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex-1" />
        <Button variant="outline" onClick={() => { setGoalForm(goal); setGoalOpen(true); }}>Definir metas</Button>
      </div>

      {/* Funil */}
      <div>
        <div className="mb-3 font-heading text-[15px] font-bold">Funil do mês</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {funnel.map((f) => (
            <Card key={f.key} className="cursor-pointer gap-0 p-5 transition-colors hover:border-primary/40"
              onClick={() => setDetail({ metric: f.key, title: f.label })}>
              <div className="text-sm text-muted-foreground">{f.label}</div>
              <div className="mt-2 font-heading text-3xl font-extrabold">{f.value}</div>
              {f.rate && <div className="mt-1 text-xs text-emerald-400">{f.rate} do anterior</div>}
            </Card>
          ))}
        </div>
      </div>

      {/* Metas */}
      <div>
        <div className="mb-3 font-heading text-[15px] font-bold">Metas do mês</div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {goals.map((g) => {
            const p = g.meta > 0 ? Math.min(100, Math.round((g.real / g.meta) * 100)) : 0;
            const color = p >= 100 ? "#10b981" : p >= 60 ? "#f59e0b" : "#6366f1";
            return (
              <Card key={g.label} className="gap-0 p-5">
                <div className="text-sm text-muted-foreground">{g.label}</div>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="font-heading text-xl font-extrabold">{g.fmt(g.real)}</span>
                  <span className="text-xs text-muted-foreground">meta {g.meta > 0 ? g.fmt(g.meta) : "—"}</span>
                </div>
                <div className="mt-3 h-[7px] overflow-hidden rounded-full bg-bg-tertiary">
                  <div className="h-full rounded-full" style={{ width: `${p}%`, background: color }} />
                </div>
                <div className="mt-1.5 text-[11px]" style={{ color }}>
                  {g.meta > 0 ? `${p}% da meta` : "defina a meta"}
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Financeiro */}
      <div>
        <div className="mb-3 font-heading text-[15px] font-bold">Financeiro (Clinicorp)</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FinCard label="Entradas" value={finance?.credit ?? 0} color="#10b981" />
          <FinCard label="Saídas" value={finance?.debit ?? 0} color="#ef4444" />
          <FinCard label="Saldo" value={finance?.net ?? 0} color={(finance?.net ?? 0) >= 0 ? "#10b981" : "#ef4444"} />
        </div>
      </div>

      {/* Resumo do ano */}
      <div>
        <div className="mb-3 font-heading text-[15px] font-bold">Resumo do ano</div>
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Mês</th>
                <th className="px-4 py-3 font-semibold">Leads</th>
                <th className="px-4 py-3 font-semibold">Compar.</th>
                <th className="px-4 py-3 font-semibold">Vendas</th>
                <th className="px-4 py-3 font-semibold">Faturamento</th>
              </tr>
            </thead>
            <tbody>
              {yearData.map((r, i) => (
                <tr key={i} className={`border-b border-white/[.04] last:border-0 ${i + 1 === month ? "bg-primary/5" : ""}`}>
                  <td className="px-4 py-2.5 font-medium">{MES_ABREV[i]}/{year}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.leads ?? 0}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.comparecimentos ?? 0}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.vendas ?? 0}</td>
                  <td className="px-4 py-2.5 font-medium text-emerald-400">{formatCurrency(r.faturamento ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dialog metas */}
      <Dialog open={goalOpen} onOpenChange={setGoalOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-heading">Metas de {MES_FULL[month - 1]}/{year}</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <GoalInput label="Faturamento (R$)" k="meta_faturamento" form={goalForm} setForm={setGoalForm} />
            <GoalInput label="Vendas" k="meta_vendas" form={goalForm} setForm={setGoalForm} />
            <GoalInput label="Comparecimentos" k="meta_comparecimentos" form={goalForm} setForm={setGoalForm} />
            <GoalInput label="Ticket médio (R$)" k="meta_ticket_medio" form={goalForm} setForm={setGoalForm} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGoalOpen(false)}>Cancelar</Button>
            <Button onClick={saveGoal}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Drill-down */}
      <DetailDialog detail={detail} year={year} month={month} profId={profId} onClose={() => setDetail(null)} />
    </div>
  );
}

function FinCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Card className="gap-0 p-5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 font-heading text-2xl font-extrabold" style={{ color }}>{formatCurrency(value)}</div>
    </Card>
  );
}

function GoalInput({ label, k, form, setForm }: { label: string; k: string; form: Goal; setForm: (g: Goal) => void }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input type="number" value={form[k] != null ? String(form[k]) : ""} onChange={(e) => setForm({ ...form, [k]: e.target.value === "" ? null : Number(e.target.value) })} placeholder="0" />
    </div>
  );
}

function DetailDialog({ detail, year, month, profId, onClose }: {
  detail: { metric: string; title: string } | null; year: number; month: number; profId: string; onClose: () => void;
}) {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const { data, isLoading } = useQuery({
    queryKey: ["metas-detail", detail?.metric, year, month],
    enabled: !!detail,
    queryFn: async () => {
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
      const metric = detail!.metric;
      if (metric === "leads") {
        const { data } = await supabase.from("patients").select("name,phone,source,created_at").gte("created_at", start).lt("created_at", end).order("created_at", { ascending: false }).limit(2000);
        return (data ?? []).map((r) => ({ a: r.name, b: r.phone, c: r.source, d: formatDateBR(r.created_at) }));
      }
      if (metric === "vendas") {
        let q = supabase.from("crm_sales").select("patient_name,amount,sale_date").gte("sale_date", start).lt("sale_date", end).order("sale_date", { ascending: false }).limit(2000);
        if (profId) q = q.eq("professional_id", profId);
        const { data } = await q;
        return (data ?? []).map((r) => ({ a: r.patient_name, b: formatCurrency(r.amount), c: "", d: formatDateBR(r.sale_date) }));
      }
      // agendamentos / comparecimentos
      let q = supabase.from("crm_attendances").select("patient_name,phone,category,appt_date,status").eq("in_funnel", true).gte("appt_date", start).lt("appt_date", end).order("appt_date", { ascending: false }).limit(2000);
      if (metric === "comparecimentos") q = q.eq("status", "compareceu");
      const { data } = await q;
      return (data ?? []).map((r) => ({ a: r.patient_name, b: r.phone, c: r.category, d: formatDateBR(r.appt_date) }));
    },
  });
  const rows = data ?? [];
  return (
    <Dialog open={!!detail} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle className="font-heading">{detail?.title} — {MES_FULL[month - 1]}/{year}</DialogTitle></DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading ? <div className="py-6 text-center text-muted-foreground">Carregando...</div> :
            rows.length === 0 ? <div className="py-6 text-center text-muted-foreground">Nenhum registro.</div> :
              <table className="w-full text-sm">
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-white/[.04]">
                      <td className="py-2 pr-3 font-medium">{r.a}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.b}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.c}</td>
                      <td className="py-2 text-right text-muted-foreground">{r.d}</td>
                    </tr>
                  ))}
                </tbody>
              </table>}
        </div>
        <div className="text-xs text-muted-foreground">{rows.length} registro(s)</div>
      </DialogContent>
    </Dialog>
  );
}

function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pct(v: number | undefined): string { return `${Math.round((v ?? 0) * 100)}%`; }
