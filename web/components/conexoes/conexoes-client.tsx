"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Smartphone, RefreshCw, Plus } from "lucide-react";
import { toast } from "sonner";

type Channel = { id: string; type: string; instance_name: string; display_name: string; status: string };

const STATUS: Record<string, { txt: string; color: string }> = {
  connected: { txt: "Conectado", color: "#10b981" },
  connecting: { txt: "Conectando", color: "#f59e0b" },
  disconnected: { txt: "Desconectado", color: "#ef4444" },
};

export function ConexoesClient() {
  const org = useOrg();
  const qc = useQueryClient();
  const supabase = useMemo(() => createClient(), []);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data } = await supabase.from("channels").select("id,type,instance_name,display_name,status").order("created_at", { ascending: true });
      return (data ?? []) as Channel[];
    },
  });
  const channels = data ?? [];

  async function refreshStatus(ch: Channel) {
    const { data, error } = await supabase.functions.invoke("evolution-proxy", { body: { action: "status", payload: { channel_id: ch.id, org_id: org.id } } });
    if (error) toast.error("Erro ao consultar status");
    else { toast.success(`Status: ${STATUS[data?.status]?.txt ?? data?.status}`); qc.invalidateQueries({ queryKey: ["channels"] }); }
  }

  async function connect() {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("evolution-proxy", { body: { action: "create_instance", payload: { display_name: "WhatsApp ClinPrime", org_id: org.id } } });
    setBusy(false);
    if (error || data?.error) { toast.error("Falha ao criar instância", { description: data?.error ?? error?.message }); return; }
    qc.invalidateQueries({ queryKey: ["channels"] });
    if (data?.qr) setQr(data.qr);
    else toast.message("Instância criada. Use 'Atualizar status' e escaneie o QR quando disponível.");
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">Conecte o WhatsApp da clínica escaneando o QR Code.</div>
        <Button onClick={connect} disabled={busy}><Plus className="h-4 w-4" /> Conectar WhatsApp</Button>
      </div>

      {channels.length === 0 && (
        <div className="rounded-xl border border-dashed border-border py-10 text-center text-muted-foreground">
          Nenhum canal conectado ainda.
        </div>
      )}

      {channels.map((ch) => {
        const st = STATUS[ch.status] ?? { txt: ch.status, color: "#9ca3af" };
        return (
          <Card key={ch.id} className="flex flex-row items-center gap-4 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
              <Smartphone className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{ch.display_name}</div>
              <div className="truncate text-xs text-muted-foreground">{ch.instance_name}</div>
            </div>
            <span className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: st.color }}>
              <span className="h-2 w-2 rounded-full" style={{ background: st.color }} /> {st.txt}
            </span>
            <Button variant="ghost" size="icon" title="Atualizar status" onClick={() => refreshStatus(ch)}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </Card>
        );
      })}

      <Dialog open={!!qr} onOpenChange={(o) => !o && setQr(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-heading">Escaneie o QR Code</DialogTitle></DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {qr && <img src={qr} alt="QR Code WhatsApp" className="h-64 w-64 rounded-lg bg-white p-2" />}
            <div className="text-center text-sm text-muted-foreground">
              WhatsApp → Aparelhos conectados → Conectar aparelho
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
