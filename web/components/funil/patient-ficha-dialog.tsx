"use client";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CC_BADGE, type Lead, type Stage } from "@/lib/funil";
import { formatCurrency, formatPhoneDisplay, formatDateBR } from "@/lib/format";
import { MessageSquare } from "lucide-react";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/5 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}

export function PatientFichaDialog({
  lead, stages, onClose, onAtender,
}: {
  lead: Lead | null;
  stages: Stage[];
  onClose: () => void;
  onAtender: (id: string) => void;
}) {
  const cc = lead?.ccStatus ? CC_BADGE[lead.ccStatus] : null;
  const stageName = lead ? stages.find((s) => s.id === lead.stageId)?.name ?? stages[0]?.name : "";

  return (
    <Dialog open={!!lead} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {lead && (
          <>
            <DialogHeader>
              <DialogTitle className="font-heading">{lead.name}</DialogTitle>
            </DialogHeader>
            <div>
              <Row label="Telefone" value={formatPhoneDisplay(lead.phone)} />
              <Row label="Etapa no funil" value={stageName} />
              <Row
                label="Status Clinicorp"
                value={
                  cc ? (
                    <span style={{ color: cc.color }} className="font-semibold">
                      {cc.label}{lead.ccAmount ? " · " + formatCurrency(lead.ccAmount) : ""}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Sem orçamento no Clinicorp</span>
                  )
                }
              />
              <Row label="Interesse / Tratamento" value={lead.source} />
              <Row label="Origem" value={lead.channel} />
              <Row label="Etiquetas" value={lead.tags?.join(", ")} />
              <Row label="Entrou em" value={formatDateBR(lead.createdAt)} />
              {lead.notes && (
                <div className="mt-3">
                  <div className="mb-1.5 text-sm text-muted-foreground">Anotações</div>
                  <div className="rounded-lg bg-bg-tertiary p-3 text-sm leading-relaxed">
                    {lead.notes}
                  </div>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button onClick={() => onAtender(lead.id)}>
                <MessageSquare className="h-4 w-4" /> Atender no CRM
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
