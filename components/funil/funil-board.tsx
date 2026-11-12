"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { CC_BADGE, STAGE_FALLBACK_COLORS, type Lead, type Stage } from "@/lib/funil";
import { formatCurrency, formatPhoneDisplay, MES_ABREV } from "@/lib/format";
import { moveLeadStage } from "@/lib/funil-move";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PatientFichaDialog } from "@/components/funil/patient-ficha-dialog";
import { toast } from "sonner";

const RENDER_CAP = 250;

function ccBadge(lead: Lead) {
  const info = lead.ccStatus ? CC_BADGE[lead.ccStatus] : null;
  if (!info) return null;
  const val = lead.ccAmount ? " · " + formatCurrency(lead.ccAmount) : "";
  const extra = lead.ccCount > 1 ? ` (${lead.ccCount})` : "";
  return (
    <div
      className="mt-1.5 inline-flex items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-semibold"
      style={{ background: info.bg, color: info.color }}
    >
      {info.label}{val}{extra}
    </div>
  );
}

function Card({ lead, onOpen }: { lead: Lead; onOpen: (l: Lead) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: lead.id });
  const val = lead.ccAmount || 0;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={() => onOpen(lead)}
      className={`group/lead cursor-grab rounded-xl border border-white/[0.08] bg-bg-tertiary/90 p-3.5 shadow-[0_4px_14px_-4px_rgba(0,0,0,0.45)] transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-bg-tertiary hover:shadow-[0_8px_20px_-6px_rgba(0,0,0,0.6)] active:cursor-grabbing ${
        isDragging ? "scale-95 opacity-40" : ""
      } ${lead.ccStatus === "APPROVED" ? "border-l-[3px] border-l-emerald-500" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold leading-snug text-foreground group-hover/lead:text-white">
          {lead.name}
        </div>
        <span className="shrink-0 rounded-md border border-white/[0.08] bg-white/[0.05] px-2 py-[2px] text-[10px] font-semibold tracking-wide text-muted-foreground">
          {lead.source || "Geral"}
        </span>
      </div>
      {ccBadge(lead)}
      <div className="mt-3 flex items-center justify-between border-t border-white/[0.06] pt-2.5 text-xs text-muted-foreground">
        <span className="font-bold tabular-nums text-emerald-400">
          {val > 0 ? formatCurrency(val) : "Sem orçamento"}
        </span>
        <span className="tabular-nums text-[11px]">{formatPhoneDisplay(lead.phone)}</span>
      </div>
    </div>
  );
}

function Column({
  stage, leads, color, onOpen,
}: { stage: Stage; leads: Lead[]; color: string; onOpen: (l: Lead) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = leads.reduce((a, l) => a + (l.ccAmount || 0), 0);
  const shown = leads.slice(0, RENDER_CAP);
  return (
    <div
      ref={setNodeRef}
      className={`relative flex max-h-[calc(100vh-220px)] w-[308px] shrink-0 flex-col overflow-hidden rounded-xl border bg-card/95 p-4 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] transition-colors ${
        isOver ? "border-primary/60 bg-primary/[0.04]" : "border-white/[0.08]"
      }`}
    >
      <div className="absolute inset-x-0 top-0 h-1 opacity-80" style={{ background: color }} />
      <div className="mt-0.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-heading text-sm font-semibold text-foreground">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
          {stage.name}
        </span>
        <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-foreground/85">
          {leads.length}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
        <span>Volume na etapa</span>
        <span className="font-semibold tabular-nums text-emerald-400/90">
          {total > 0 ? formatCurrency(total) : "R$ 0,00"}
        </span>
      </div>
      <div className="my-3 border-t border-white/[0.07]" />
      <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto pr-0.5 pb-3">
        {shown.map((l) => (
          <Card key={l.id} lead={l} onOpen={onOpen} />
        ))}
        {shown.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.07] py-8 text-center text-xs text-muted-foreground/70">
            Nenhum lead nesta etapa
          </div>
        )}
        {leads.length > RENDER_CAP && (
          <div className="py-2 text-center text-xs text-muted-foreground">
            +{leads.length - RENDER_CAP} lead(s) — use a busca em Pacientes
          </div>
        )}
      </div>
    </div>
  );
}

export function FunilBoard({
  stages, initialLeads,
}: { stages: Stage[]; initialLeads: Lead[] }) {
  const org = useOrg();
  const router = useRouter();
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [month, setMonth] = useState("all");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ficha, setFicha] = useState<Lead | null>(null);
  const pendingMoves = useRef(new Set<string>());

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const firstStageId = stages[0]?.id;

  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const l of leads) if (l.createdAt) set.add(l.createdAt.slice(0, 7));
    return Array.from(set).sort().reverse();
  }, [leads]);

  const filtered = useMemo(
    () => (month === "all" ? leads : leads.filter((l) => (l.createdAt ?? "").slice(0, 7) === month)),
    [leads, month]
  );

  const byStage = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const s of stages) map.set(s.id, []);
    for (const l of filtered) {
      const sid = l.stageId && map.has(l.stageId) ? l.stageId : firstStageId;
      if (sid) map.get(sid)!.push(l);
    }
    return map;
  }, [filtered, stages, firstStageId]);

  const totalOrc = filtered.reduce((a, l) => a + (l.ccAmount || 0), 0);

  async function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const leadId = String(e.active.id);
    const targetStageId = e.over ? String(e.over.id) : null;
    if (!targetStageId) return;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stageId === targetStageId) return;

    const targetStage = stages.find((stage) => stage.id === targetStageId);
    if (!targetStage) return;

    const result = await moveLeadStage({
      client: createClient(), orgId: org.id, lead, targetStageId,
      pendingMoves: pendingMoves.current, setLeads,
    });
    if (result.status === "moved") {
      toast.success(`Movido para: ${targetStage.name}`);
    } else if (result.status === "failed") {
      toast.error("Não foi possível confirmar a mudança de etapa. Confira o funil antes de tentar novamente.");
    } else {
      toast.info("Aguarde a mudança de etapa em andamento.");
    }
  }

  const activeLead = activeId ? leads.find((l) => l.id === activeId) : null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="text-sm text-muted-foreground">Mês de entrada</span>
          <Select value={month} onValueChange={(v) => setMonth(v ?? "all")}>
            <SelectTrigger className="w-[170px]">
              <SelectValue>
                {month === "all"
                  ? "Todos os meses"
                  : `${MES_ABREV[parseInt(month.split("-")[1], 10) - 1]}/${month.split("-")[0]}`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os meses</SelectItem>
              {monthOptions.map((m) => {
                const [y, mm] = m.split("-");
                return <SelectItem key={m} value={m}>{MES_ABREV[parseInt(mm, 10) - 1]}/{y}</SelectItem>;
              })}
            </SelectContent>
          </Select>
        </div>
        <div className="text-sm text-muted-foreground">
          <strong className="text-foreground">{filtered.length}</strong> leads ·{" "}
          <strong className="text-emerald-400">{formatCurrency(totalOrc)}</strong> em orçamentos
        </div>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex items-start gap-4 overflow-x-auto pb-4">
          {stages.map((s, i) => (
            <Column
              key={s.id}
              stage={s}
              leads={byStage.get(s.id) ?? []}
              color={s.color || STAGE_FALLBACK_COLORS[Math.min(i, STAGE_FALLBACK_COLORS.length - 1)]}
              onOpen={setFicha}
            />
          ))}
        </div>
        <DragOverlay>
          {activeLead ? (
            <div className="w-[268px] rounded-xl border border-primary bg-bg-tertiary p-4 shadow-2xl">
              <div className="text-sm font-semibold">{activeLead.name}</div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <PatientFichaDialog
        lead={ficha}
        stages={stages}
        onClose={() => setFicha(null)}
        onAtender={(id) => router.push(`/inbox?p=${id}`)}
      />
    </div>
  );
}
