"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Smartphone, RefreshCw, Plus, Unplug, Trash2, QrCode } from "lucide-react";
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
  const [qr, setQr] = useState<{ img: string | null; channelId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data } = await supabase.from("channels").select("id,type,instance_name,display_name,status").order("created_at", { ascending: true });
      return (data ?? []) as Channel[];
    },
  });
  const channels = data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ["channels"] });

  const invoke = async (action: string, payload: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke("evolution-proxy", {
      body: { action, payload: { ...payload, org_id: org.id } },
    });
    if (error || data?.error) throw new Error(data?.error ?? error?.message ?? "erro");
    return data;
  };

  // Polling enquanto o dialog do QR está aberto: status a cada 5s (fecha ao conectar) + QR novo a cada 20s
  useEffect(() => {
    if (!qr?.channelId) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    let tick = 0;
    pollRef.current = setInterval(async () => {
      tick++;
      try {
        const st = await invoke("status", { channel_id: qr.channelId });
        if (st?.status === "connected") {
          toast.success("WhatsApp conectado 🎉");
          setQr(null);
          refresh();
          return;
        }
        if (tick % 4 === 0) {
          const r = await invoke("get_qr", { channel_id: qr.channelId });
          if (r?.qr) setQr((prev) => (prev ? { ...prev, img: r.qr } : prev));
        }
      } catch { /* mantém polling */ }
    }, 5000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr?.channelId]);

  async function connect() {
    setBusy(true);
    try {
      const data = await invoke("create_instance", { display_name: "WhatsApp ClinPrime" });
      refresh();
      setQr({ img: data?.qr ?? null, channelId: data?.channel?.id ?? null });
    } catch (e) {
      toast.error("Falha ao criar instância", { description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function showQr(ch: Channel) {
    try {
      const r = await invoke("get_qr", { channel_id: ch.id });
      setQr({ img: r?.qr ?? null, channelId: ch.id });
      if (!r?.qr) toast.message("QR ainda não disponível — aguardando a Evolution gerar...");
    } catch (e) {
      toast.error("Erro ao buscar QR", { description: String((e as Error).message) });
    }
  }

  async function refreshStatus(ch: Channel) {
    try {
      const data = await invoke("status", { channel_id: ch.id });
      toast.success(`Status: ${STATUS[data?.status]?.txt ?? data?.status}`);
      refresh();
    } catch { toast.error("Erro ao consultar status"); }
  }

  async function disconnect(ch: Channel) {
    if (!confirm(`Desconectar o WhatsApp "${ch.display_name}"? O número para de receber/enviar pelo CRM até reconectar.`)) return;
    try {
      await invoke("disconnect", { channel_id: ch.id });
      toast.success("Canal desconectado");
      refresh();
    } catch { toast.error("Erro ao desconectar"); }
  }

  async function removeChannel(ch: Channel) {
    if (!confirm(`Remover a instância "${ch.display_name}" definitivamente? Essa ação apaga o canal da Evolution.`)) return;
    try {
      await invoke("delete_instance", { channel_id: ch.id });
      toast.success("Instância removida");
      refresh();
    } catch { toast.error("Erro ao remover"); }
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
            <div className="flex shrink-0 gap-0.5">
              {ch.status !== "connected" && (
                <Button variant="ghost" size="icon" title="Mostrar QR Code" onClick={() => showQr(ch)}>
                  <QrCode className="h-4 w-4" />
                </Button>
              )}
              <Button variant="ghost" size="icon" title="Atualizar status" onClick={() => refreshStatus(ch)}>
                <RefreshCw className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" title="Desconectar" onClick={() => disconnect(ch)}>
                <Unplug className="h-4 w-4 text-amber-400" />
              </Button>
              <Button variant="ghost" size="icon" title="Remover instância" onClick={() => removeChannel(ch)}>
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          </Card>
        );
      })}

      <Dialog open={!!qr} onOpenChange={(o) => !o && setQr(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle className="font-heading">Escaneie o QR Code</DialogTitle></DialogHeader>
          <div className="flex flex-col items-center gap-3 py-2">
            {qr?.img ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qr.img} alt="QR Code WhatsApp" className="h-64 w-64 rounded-lg bg-white p-2" />
            ) : (
              <div className="flex h-64 w-64 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
                Gerando QR...
              </div>
            )}
            <div className="text-center text-sm text-muted-foreground">
              WhatsApp → Aparelhos conectados → Conectar aparelho
              <br />
              <span className="text-xs">Atualizo o QR automaticamente e fecho ao conectar.</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
