"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

/** Último dia do mês — NUNCA fixar em 28, senão os dias 29-31 nunca sincronizam. */
export function monthRange(year: number, month: number) {
  const last = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, "0");
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` };
}

/**
 * Dispara o sync_month do Clinicorp e SÓ ENTÃO atualiza a tela
 * (router.refresh para server components + invalidate das queries do client).
 */
export function SyncClinicorpButton({
  year, month, label = "Atualizar dados",
}: {
  year: number;
  month: number;
  label?: string;
}) {
  const org = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function sync() {
    setBusy(true);
    const { from, to } = monthRange(year, month);
    const t = toast.loading("Sincronizando com o Clinicorp...");
    try {
      const supabase = createClient();
      const { data, error } = await supabase.functions.invoke("clinicorp-agenda", {
        body: { action: "sync_month", from, to, org_id: org.id },
      });
      if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "falha no sync");

      // só depois do sync terminar é que os dados na tela são recarregados
      await qc.invalidateQueries();
      router.refresh();
      toast.success(
        `Atualizado: ${data?.vendas ?? 0} vendas, ${data?.agendamentos ?? 0} agendamentos`,
        { id: t }
      );
    } catch (e) {
      toast.error("Não consegui sincronizar", { id: t, description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="outline" onClick={sync} disabled={busy}>
      <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      {busy ? "Sincronizando..." : label}
    </Button>
  );
}
