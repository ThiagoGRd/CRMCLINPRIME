"use client";

import { urgency, type Task } from "@/lib/tasks";
import { relativeDue } from "@/components/fila/fila-list";
import { formatPhoneDisplay } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowLeft, CalendarClock, PanelRight, RefreshCw } from "lucide-react";
import { ContactAvatar } from "./contact-avatar";

export function ChatHeader({ patient, nextTask, now, onBack, onOpenPatient, onDefineNext, onSync, onToggleDetails, children }: {
  patient: { id: string; name: string; phone: string | null }; nextTask: Task | null; now: Date | null;
  onBack: () => void; onOpenPatient: () => void; onDefineNext: () => void; onSync: () => void; onToggleDetails: () => void;
  children?: React.ReactNode;
}) {
  const overdue = !!nextTask && !!now && urgency(nextTask.dueAt, now) === "vencida";
  const phone = formatPhoneDisplay(patient.phone);
  const action = nextTask
    ? `Próxima ação: ${nextTask.title}${now ? ` · ${relativeDue(nextTask.dueAt, now)}` : ""}`
    : "Sem próxima ação";
  const line2 = `${phone} · ${action}`;
  return (
    <div className="flex items-center gap-2 border-b border-white/[0.07] bg-[#151827] px-2 py-2.5 sm:gap-3 sm:px-4">
      <Button variant="ghost" size="icon-sm" aria-label="Voltar para conversas" onClick={onBack} className="lg:hidden">
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <ContactAvatar name={patient.name} seed={patient.id} size={42} />
      <div className="min-w-0 flex-1">
        <button
          type="button" onClick={onOpenPatient}
          className="block max-w-full truncate rounded text-left font-heading text-base leading-tight font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {patient.name}
        </button>
        {/* segunda linha única: telefone + próxima ação; o texto inteiro fica no title */}
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <p title={line2} className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap ${nextTask ? (overdue ? "text-red-400" : "text-muted-foreground") : "text-amber-400"}`}>
            <span className="shrink-0 text-muted-foreground">{phone}</span>
            <span aria-hidden className="shrink-0 text-muted-foreground/50">·</span>
            {nextTask && !overdue
              ? <CalendarClock aria-hidden className="size-3.5 shrink-0" />
              : <AlertTriangle aria-hidden className="size-3.5 shrink-0" />}
            <span className="truncate">{action}</span>
          </p>
          {!nextTask && (
            <Button variant="outline" size="xs" onClick={onDefineNext} className="h-6 shrink-0 border-amber-400/30 px-2 text-[11px] text-amber-300 hover:bg-amber-400/10">
              Definir
            </Button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        <Button variant="outline" size="sm" onClick={onSync} title="Puxar histórico completo da VPS" aria-label="Histórico">
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="hidden lg:inline">Histórico</span>
        </Button>
        {children}
        <Button variant="outline" size="icon-sm" title="Painel do paciente" aria-label="Painel do paciente" onClick={onToggleDetails}>
          <PanelRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
