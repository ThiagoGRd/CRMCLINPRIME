"use client";

import { urgency, type Task } from "@/lib/tasks";
import { relativeDue } from "@/components/fila/fila-list";
import { formatPhoneDisplay } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowLeft, CalendarClock, PanelRight, RefreshCw } from "lucide-react";
import { ContactAvatar } from "./contact-avatar";

export function ChatHeader({ patient, attendant, nextTask, now, onBack, onOpenPatient, onDefineNext, onSync, onToggleDetails, children }: {
  patient: { id: string; name: string; phone: string | null }; attendant: string; nextTask: Task | null; now: Date | null;
  onBack: () => void; onOpenPatient: () => void; onDefineNext: () => void; onSync: () => void; onToggleDetails: () => void;
  children?: React.ReactNode;
}) {
  const overdue = !!nextTask && !!now && urgency(nextTask.dueAt, now) === "vencida";
  return (
    <div className="flex items-center gap-2 border-b border-white/[0.07] bg-[#151827] px-2 py-2.5 sm:gap-3 sm:px-4">
      <Button variant="ghost" size="icon-sm" aria-label="Voltar para conversas" onClick={onBack} className="lg:hidden">
        <ArrowLeft className="h-4 w-4" />
      </Button>
      <ContactAvatar name={patient.name} seed={patient.id} size={42} />
      <div className="min-w-0 flex-1">
        <button
          type="button" onClick={onOpenPatient}
          className="block max-w-full truncate rounded text-left font-heading text-[15px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {patient.name}
        </button>
        <p className="truncate text-xs text-muted-foreground">{formatPhoneDisplay(patient.phone)} · {attendant}</p>
        {nextTask ? (
          <p className={`mt-0.5 flex min-w-0 items-center gap-1.5 text-xs ${overdue ? "text-red-400" : "text-muted-foreground"}`}>
            {overdue ? <AlertTriangle aria-hidden className="size-3.5 shrink-0" /> : <CalendarClock aria-hidden className="size-3.5 shrink-0" />}
            <span className="truncate">
              Próxima ação: {nextTask.title}{now ? ` · ${relativeDue(nextTask.dueAt, now)}` : ""}
            </span>
          </p>
        ) : (
          <p className="mt-0.5 flex items-center gap-2 text-xs text-amber-400">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
            Sem próxima ação
            <Button variant="outline" size="xs" onClick={onDefineNext} className="h-6 border-amber-400/30 px-2 text-[11px] text-amber-300 hover:bg-amber-400/10">
              Definir
            </Button>
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
        <Button variant="outline" size="sm" onClick={onSync} title="Puxar histórico completo da VPS" aria-label="Histórico">
          <RefreshCw className="h-3.5 w-3.5" />
          <span className="hidden xl:inline">Histórico</span>
        </Button>
        {children}
        <Button variant="outline" size="icon-sm" title="Painel do paciente" aria-label="Painel do paciente" onClick={onToggleDetails}>
          <PanelRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
