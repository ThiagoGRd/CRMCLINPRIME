"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { formatPhoneDisplay, MES_FULL } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Check, X } from "lucide-react";
import { toast } from "sonner";

type Appt = {
  clinicorp_id: string; date: string; from: string; to: string;
  patient: string; phone: string; category: string; color: string;
  status: string; attendance_id: string | null; confirmed?: boolean;
};

const ST: Record<string, { txt: string; color: string }> = {
  compareceu: { txt: "Compareceu", color: "#10b981" },
  faltou: { txt: "Faltou", color: "#ef4444" },
  agendado: { txt: "Agendado", color: "#9ca3af" },
};

export function AgendaClient() {
  const org = useOrg();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const [ref, setRef] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; });

  const from = `${ref.y}-${String(ref.m).padStart(2, "0")}-01`;
  const to = `${ref.y}-${String(ref.m).padStart(2, "0")}-${new Date(ref.y, ref.m, 0).getDate()}`;

  const { data, isLoading } = useQuery({
    queryKey: ["agenda", from, to],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("clinicorp-agenda", { body: { from, to, org_id: org.id } });
      if (error) throw error;
      return (data?.appointments ?? []) as Appt[];
    },
  });
  const appts = data ?? [];

  const byDate = useMemo(() => {
    const map = new Map<string, Appt[]>();
    for (const a of appts) { if (!map.has(a.date)) map.set(a.date, []); map.get(a.date)!.push(a); }
    return Array.from(map.entries()).sort((x, y) => x[0].localeCompare(y[0]));
  }, [appts]);

  async function mark(a: Appt, status: string) {
    if (!a.attendance_id) return;
    const { error } = await supabase.functions.invoke("clinicorp-agenda", {
      body: { action: "mark", attendance_id: a.attendance_id, status, org_id: org.id },
    });
    if (error) toast.error("Erro ao marcar");
    else { toast.success(ST[status]?.txt ?? "Atualizado"); qc.invalidateQueries({ queryKey: ["agenda"] }); }
  }

  function move(delta: number) {
    setRef((r) => { let m = r.m + delta, y = r.y; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } return { y, m }; });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" onClick={() => move(-1)}><ChevronLeft className="h-4 w-4" /></Button>
        <div className="font-heading text-lg font-bold">{MES_FULL[ref.m - 1]} / {ref.y}</div>
        <Button variant="outline" size="icon" onClick={() => move(1)}><ChevronRight className="h-4 w-4" /></Button>
        <div className="flex-1" />
        <span className="text-sm text-muted-foreground">{appts.length} consultas</span>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-muted-foreground">Carregando agenda do Clinicorp...</div>
      ) : byDate.length === 0 ? (
        <div className="py-10 text-center text-muted-foreground">Nenhuma consulta nesse mês.</div>
      ) : (
        <div className="space-y-5">
          {byDate.map(([date, list]) => (
            <div key={date}>
              <div className="mb-2 text-sm font-semibold text-muted-foreground">
                {date.split("-").reverse().join("/")}
              </div>
              <div className="space-y-2">
                {list.sort((a, b) => a.from.localeCompare(b.from)).map((a) => {
                  const st = ST[a.status] ?? ST.agendado;
                  return (
                    <Card key={a.clinicorp_id} className="flex flex-row items-center gap-4 p-3.5">
                      <div className="w-14 shrink-0 text-center">
                        <div className="font-heading text-sm font-bold">{a.from}</div>
                      </div>
                      <div className="h-8 w-1 rounded-full" style={{ background: a.color || "#6366f1" }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{a.patient}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {a.category || "—"} · {formatPhoneDisplay(a.phone)}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs font-semibold" style={{ color: st.color }}>{st.txt}</span>
                      <div className="flex shrink-0 gap-1">
                        <Button variant="ghost" size="icon" title="Compareceu" onClick={() => mark(a, "compareceu")}>
                          <Check className="h-4 w-4 text-emerald-400" />
                        </Button>
                        <Button variant="ghost" size="icon" title="Faltou" onClick={() => mark(a, "faltou")}>
                          <X className="h-4 w-4 text-red-400" />
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
