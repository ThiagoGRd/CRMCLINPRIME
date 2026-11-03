"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { formatCurrency } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Row = {
  source: string; leads: number; agendados: number; compareceram: number;
  orcamentos: number; aprovados: number; receita: number;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const NOW = new Date();
// Padrão: últimos 3 meses fechados + o atual.
const DEFAULT_FROM = iso(new Date(NOW.getFullYear(), NOW.getMonth() - 3, 1));
const DEFAULT_TO = iso(new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1));

const STAGES: { key: keyof Row; label: string }[] = [
  { key: "leads", label: "Leads" },
  { key: "agendados", label: "Agendados" },
  { key: "compareceram", label: "Compareceram" },
  { key: "orcamentos", label: "Orçamento" },
  { key: "aprovados", label: "Aprovados" },
];

const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "—");

export function ResultadosClient() {
  const org = useOrg();
  const supabase = useMemo(() => createClient(), []);
  const [from, setFrom] = useState(DEFAULT_FROM);
  const [to, setTo] = useState(DEFAULT_TO);

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ["source-funnel", org.id, from, to],
    enabled: !!from && !!to,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_source_funnel", { p_org: org.id, p_from: from, p_to: to });
      if (error) throw error;
      return ((data ?? []) as Row[]).map((r) => ({ ...r, receita: Number(r.receita) || 0 }));
    },
  });

  const total = rows.reduce<Row>(
    (t, r) => ({
      source: "Total",
      leads: t.leads + r.leads, agendados: t.agendados + r.agendados,
      compareceram: t.compareceram + r.compareceram, orcamentos: t.orcamentos + r.orcamentos,
      aprovados: t.aprovados + r.aprovados, receita: t.receita + r.receita,
    }),
    { source: "Total", leads: 0, agendados: 0, compareceram: 0, orcamentos: 0, aprovados: 0, receita: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="res-from">Leads criados de</Label>
          <Input id="res-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[160px]" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="res-to">até (exclusive)</Label>
          <Input id="res-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[160px]" />
        </div>
        <p className="max-w-md text-xs text-muted-foreground">
          Acompanha os leads criados no período até o resultado final: agenda e orçamentos do Clinicorp,
          cruzados pelo telefone.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
        {STAGES.map((s, i) => (
          <Card key={s.key} className="gap-0 p-5">
            <div className="text-sm text-muted-foreground">{s.label}</div>
            <div className="mt-2 font-heading text-3xl font-extrabold">{total[s.key] as number}</div>
            {i > 0 && (
              <div className="mt-1 text-xs text-emerald-400">
                {pct(total[s.key] as number, total[STAGES[i - 1].key] as number)} do anterior
              </div>
            )}
          </Card>
        ))}
        <Card className="gap-0 p-5">
          <div className="text-sm text-muted-foreground">Receita aprovada</div>
          <div className="mt-2 font-heading text-xl font-extrabold">{formatCurrency(total.receita)}</div>
        </Card>
      </div>

      <div>
        <div className="mb-3 font-heading text-[15px] font-bold">Por origem</div>
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Origem</th>
                {STAGES.map((s) => <th key={s.key} className="px-4 py-3 font-semibold">{s.label}</th>)}
                <th className="px-4 py-3 font-semibold">Lead → Aprovado</th>
                <th className="px-4 py-3 font-semibold">Receita</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">Carregando...</td></tr>
              )}
              {error && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-red-400">Erro ao carregar o relatório.</td></tr>
              )}
              {!isLoading && !error && rows.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-6 text-center text-muted-foreground">Nenhum lead no período.</td></tr>
              )}
              {[...rows, ...(rows.length > 1 ? [total] : [])].map((r) => (
                <tr key={r.source} className={`border-b border-white/[.04] last:border-0 ${r === total ? "font-semibold" : ""}`}>
                  <td className="px-4 py-3">{r.source}</td>
                  {STAGES.map((s, i) => (
                    <td key={s.key} className="px-4 py-3">
                      {r[s.key] as number}
                      {i > 0 && (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          {pct(r[s.key] as number, r[STAGES[i - 1].key] as number)}
                        </span>
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-3">{pct(r.aprovados, r.leads)}</td>
                  <td className="px-4 py-3">{formatCurrency(r.receita)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
