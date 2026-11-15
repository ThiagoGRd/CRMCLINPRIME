"use client";

import { awaitingReply, type LastMessage } from "@/lib/inbox";
import { Columns3, MessagesSquare } from "lucide-react";
import { ConversationList, type ConversationSummary } from "./conversation-list";

export const SHORT_CHANNEL_LABEL: Record<string, string> = {
  recepcao: "Recepção",
  layla: "CRC (Layla)",
  diana: "Comercial (Diana)",
  thiago: "Dr. Thiago",
};
const PANEL_COLOR: Record<string, string> = { recepcao: "#38bdf8", layla: "#a78bfa", diana: "#fbbf24" };
const EXTRA_COLORS = ["#34d399", "#f472b6", "#60a5fa", "#fb923c"];

export type ChannelLike = { id: string; instance_name: string; display_name: string; status: string; config: { display_phone?: string } | null };
export type TeamPanel<C extends ConversationSummary = ConversationSummary> = {
  id: string; label: string; color: string; connected: boolean; phone: string | null; convs: C[]; awaiting: number;
};

export const channelLabel = (ch: ChannelLike) => SHORT_CHANNEL_LABEL[ch.instance_name] ?? ch.display_name;

export function countAwaiting(convs: ConversationSummary[], lastBy: Map<string, LastMessage>): number {
  return convs.reduce((n, c) => { const l = lastBy.get(c.id); return l && awaitingReply(l) ? n + 1 : n; }, 0);
}

// Um painel por canal conectado; a conversa entra no painel de cada canal por onde já trocou mensagem.
export function buildPanels<C extends ConversationSummary>(
  channels: ChannelLike[], convs: C[], patientChannels: Record<string, string[]>, lastBy: Map<string, LastMessage>,
): TeamPanel<C>[] {
  let extra = 0;
  return channels.map((ch) => {
    const inPanel = convs.filter((c) => (patientChannels[c.id] ?? []).includes(ch.id));
    return {
      id: ch.id,
      label: channelLabel(ch),
      color: PANEL_COLOR[ch.instance_name] ?? EXTRA_COLORS[extra++ % EXTRA_COLORS.length],
      connected: ch.status === "connected",
      phone: ch.config?.display_phone ?? null,
      convs: inPanel,
      awaiting: countAwaiting(inPanel, lastBy),
    };
  });
}

function CountBadge({ n }: { n: number }) {
  return (
    <span className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums ${
      n > 0 ? "bg-emerald-400 text-[#03140d]" : "bg-white/[0.07] text-muted-foreground"
    }`}>
      {n}
    </span>
  );
}

export function PanelSelector({ panels, allAwaiting, value, onChange, board, onBoardChange }: {
  panels: TeamPanel[]; allAwaiting: number; value: string; onChange: (id: string) => void;
  board: boolean; onBoardChange: (board: boolean) => void;
}) {
  const options = [...panels.map((p) => ({ id: p.id, label: p.label, color: p.color, awaiting: p.awaiting })), { id: "all", label: "Todos", color: "#9ca3af", awaiting: allAwaiting }];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div role="group" aria-label="Painéis da equipe" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
        {options.map((o) => {
          const on = !board && value === o.id;
          return (
            <button
              key={o.id} type="button" aria-pressed={on}
              aria-label={`${o.label}: ${o.awaiting} aguardando resposta`}
              onClick={() => { onChange(o.id); onBoardChange(false); }}
              className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-full border pr-1.5 pl-3 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                on ? "text-foreground" : "border-white/[0.08] bg-white/[0.02] text-foreground/70 hover:bg-white/[0.05] hover:text-foreground"
              }`}
              style={on ? { borderColor: `color-mix(in oklab, ${o.color} 55%, transparent)`, background: `color-mix(in oklab, ${o.color} 16%, transparent)` } : undefined}
            >
              <span aria-hidden className="size-2 rounded-full" style={{ background: o.color }} />
              {o.label}
              <CountBadge n={o.awaiting} />
            </button>
          );
        })}
      </div>
      {panels.length > 0 && (
        <button
          type="button" aria-pressed={board} onClick={() => onBoardChange(!board)}
          className={`hidden h-9 shrink-0 items-center gap-2 rounded-full border px-3.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring lg:inline-flex ${
            board ? "border-primary/60 bg-primary/15 text-foreground" : "border-white/[0.08] text-foreground/70 hover:bg-white/[0.05] hover:text-foreground"
          }`}
        >
          <Columns3 className="size-4" /> Lado a lado
        </button>
      )}
    </div>
  );
}

export function TeamBoard({ panels, lastBy, now, onOpen }: {
  panels: TeamPanel[]; lastBy: Map<string, LastMessage>; now: Date | null; onOpen: (convId: string, panelId: string) => void;
}) {
  return (
    <div className="hidden min-h-0 flex-1 auto-cols-[minmax(300px,1fr)] grid-flow-col gap-4 overflow-x-auto lg:grid">
      {panels.map((p, i) => {
        const pct = p.convs.length ? Math.round((p.awaiting / p.convs.length) * 100) : 0;
        return (
          <section
            key={p.id}
            aria-label={`${p.label}: ${p.awaiting} aguardando resposta`}
            className="relative flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-card shadow-[0_10px_40px_-20px_rgba(0,0,0,0.8)] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-3 motion-safe:duration-500"
            style={{ animationDelay: `${i * 80}ms`, animationFillMode: "both" }}
          >
            <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-44" style={{ background: `radial-gradient(85% 100% at 50% 0%, color-mix(in oklab, ${p.color} 20%, transparent), transparent 72%)` }} />
            <div aria-hidden className="h-[3px]" style={{ background: `linear-gradient(90deg, transparent, ${p.color}, transparent)` }} />
            <header className="relative px-4 pt-4 pb-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl ring-1"
                  style={{ background: `color-mix(in oklab, ${p.color} 18%, transparent)`, color: p.color, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${p.color} 35%, transparent)` }}
                >
                  <MessagesSquare className="size-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="truncate font-heading text-[15px] font-semibold">{p.label}</h3>
                  <p className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                    <span aria-hidden className={`size-1.5 rounded-full ${p.connected ? "bg-emerald-400" : "bg-red-400"}`} />
                    {p.connected ? "Conectado" : "Desconectado"}{p.phone ? ` · ${p.phone}` : ""}
                  </p>
                </div>
              </div>
              <div className="mt-5 flex items-end justify-between gap-3">
                <div>
                  <div className="font-heading text-[40px] leading-none font-semibold tabular-nums" style={{ color: p.awaiting ? p.color : undefined }}>
                    {p.awaiting}
                  </div>
                  <div className="mt-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">aguardando resposta</div>
                </div>
                <div className="text-right">
                  <div className="text-base font-semibold tabular-nums">{p.convs.length}</div>
                  <div className="text-[11px] text-muted-foreground">conversas</div>
                </div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]" role="presentation">
                <div className="h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${pct}%`, background: p.color }} />
              </div>
            </header>
            <div className="relative min-h-0 flex-1 overflow-y-auto border-t border-white/[0.06]">
              <ConversationList
                compact items={p.convs} lastBy={lastBy} now={now} activeId={null}
                onSelect={(id) => onOpen(id, p.id)} empty="Nenhuma conversa neste painel."
              />
            </div>
          </section>
        );
      })}
    </div>
  );
}
