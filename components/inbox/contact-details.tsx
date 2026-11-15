"use client";

import { formatPhoneDisplay, formatCurrency, formatDateBR } from "@/lib/format";
import { CC_BADGE } from "@/lib/funil";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { ContactAvatar } from "./contact-avatar";

type Patient = {
  id: string; name: string; phone: string | null; tags: string[] | null; assigned_to: string | null;
  treatment_interest: string | null; source: string | null; clinicorp_status: string | null;
  clinicorp_amount: number | null; created_at: string | null;
};
type Member = { user_id: string; display_name: string | null };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs">{value}</span>
    </div>
  );
}

export function ContactDetails({ className, onClose, patient, members, memberName, tagInput, setTagInput, onAddTag, onRemoveTag, onAssign }: {
  className: string; onClose: () => void; patient: Patient; members: Member[]; memberName: (uid: string | null) => string;
  tagInput: string; setTagInput: (v: string) => void; onAddTag: () => void; onRemoveTag: (t: string) => void; onAssign: (uid: string) => void;
}) {
  const cc = patient.clinicorp_status ? CC_BADGE[patient.clinicorp_status] : null;
  return (
    <aside aria-label="Detalhes do paciente" className={`${className} relative min-h-0 w-full min-w-0 shrink-0 flex-col gap-5 overflow-y-auto rounded-2xl border border-white/[0.07] bg-card p-4 lg:absolute lg:inset-y-0 lg:right-0 lg:z-20 lg:w-[340px] lg:shadow-[-24px_0_60px_-20px_rgba(0,0,0,0.85)] xl:static xl:z-auto xl:w-[320px] xl:shadow-none motion-safe:lg:animate-in motion-safe:lg:slide-in-from-right-4 motion-safe:lg:fade-in-0 xl:animate-none`}>
      <Button variant="ghost" size="icon-sm" aria-label="Fechar detalhes" onClick={onClose} className="absolute top-2 right-2 xl:hidden">
        <X className="h-4 w-4" />
      </Button>
      <div className="flex flex-col items-center gap-2 border-b border-white/[0.06] pb-4 text-center">
        <ContactAvatar name={patient.name} seed={patient.id} size={72} />
        <div className="min-w-0 max-w-full">
          <div className="truncate font-heading text-base font-semibold">{patient.name}</div>
          <div className="text-xs text-muted-foreground">{formatPhoneDisplay(patient.phone)}</div>
        </div>
      </div>

      <div>
        <div className="font-heading text-sm font-bold">Paciente</div>
        <div className="mt-2.5 space-y-2">
          <Row label="WhatsApp" value={formatPhoneDisplay(patient.phone)} />
          <Row label="Interesse" value={patient.treatment_interest || patient.source || "—"} />
          <Row
            label="Orçamento"
            value={
              cc ? (
                <span style={{ color: cc.color }} className="font-semibold">
                  {cc.label.replace(/^[✓↻•✕] /u, "")}{patient.clinicorp_amount ? ` · ${formatCurrency(patient.clinicorp_amount)}` : ""}
                </span>
              ) : "—"
            }
          />
          <Row label="Entrou em" value={formatDateBR(patient.created_at)} />
        </div>
      </div>

      <div>
        <div className="mb-2 font-heading text-sm font-bold">Atendente responsável</div>
        <Select value={patient.assigned_to ?? "none"} onValueChange={(v) => onAssign(v ?? "none")}>
          <SelectTrigger className="w-full">
            <SelectValue>{memberName(patient.assigned_to)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Sem atendente</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.user_id} value={m.user_id}>
                {m.display_name ?? m.user_id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <div className="mb-2 font-heading text-sm font-bold">Tags</div>
        <div className="flex flex-wrap gap-1.5">
          {(patient.tags ?? []).map((t) => (
            <Badge key={t} variant="secondary" className="gap-1">
              {t}
              <button type="button" aria-label={`Remover tag ${t}`} onClick={() => onRemoveTag(t)} className="text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
          {(patient.tags ?? []).length === 0 && <span className="text-xs text-muted-foreground">Nenhuma tag</span>}
        </div>
        <Input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAddTag(); } }}
          placeholder="+ tag e Enter"
          aria-label="Nova tag"
          className="mt-2 h-8 text-sm"
        />
      </div>
    </aside>
  );
}
