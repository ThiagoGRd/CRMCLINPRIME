"use client";

import { useMemo, useState } from "react";
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
      className={`cursor-grab rounded-xl border border-border bg-bg-tertiary p-4 transition-colors hover:border-primary/30 ${
        isDragging ? "opacity-40" : ""
      } ${lead.ccStatus === "APPROVED" ? "border-l-[3px] border-l-emerald-500" : ""}`}
    >
      <div className="text-sm font-semibold leading-snug text-foreground">
        {lead.name}
      </div>
      <span className="mt-1 inline-block rounded-md bg-white/[.06] px-2 py-[2px] text-[10px] font-semibold tracking-wide text-muted-foreground">
        {lead.source}
      </span>
      {ccBadge(lead)}
      <div className="mt-3 flex items-center justify-between border-t border-white/5 pt-2.5 text-xs text-muted-foreground">
        <span className="font-bold text-emerald-400">{val > 0 ? formatCurrency(val) : ""}</span>
        <span>{formatPhoneDisplay(lead.phone)}</span>
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
      className={`flex max-h-[calc(100vh-220px)] w-[300px] shrink-0 flex-col rounded-xl border bg-card p-4 ${
        isOver ? "border-primary/50" : "border-border"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 font-heading text-sm font-semibold">
          <span style={{ color }}>●</span> {stage.name}
        </span>
        <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {leads.length}
        </span>
      </div>
      <div className="mt-1 text-[11px] font-medium text-muted-foreground">
        {total > 0 ? formatCurrency(total) : "—"}
      </div>
      <div className="my-2 border-t border-white/5" />
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pb-4">
        {shown.map((l) => (
          <Card key={l.id} lead={l} onOpen={onOpen} />
        ))}
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

    const stageName = stages.find((s) => s.id === targetStageId)?.name ?? "";
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, stageId: targetStageId } : l)));

    const supabase = createClient();
    try {
      if (lead.dealId) {
        await supabase.from("deals").update({ stage_id: targetStageId, moved_at: new Date().toISOString() }).eq("id", lead.dealId);
      } else {
        const { data } = await supabase
          .from("deals")
          .insert({ patient_id: leadId, stage_id: targetStageId, org_id: org.id, position: 0, moved_at: new Date().toISOString() })
          .select("id")
          .single();
        if (data) setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, dealId: data.id } : l)));
      }
      toast.success(`Movido para: ${stageName}`);
    } catch {
      toast.error("Erro ao mover no servidor");
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
