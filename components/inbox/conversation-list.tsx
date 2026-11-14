"use client";

import { awaitingReply, listTime, parseMediaContent, type LastMessage, type MediaKind } from "@/lib/inbox";
import { formatPhoneDisplay } from "@/lib/format";
import { Camera, FileText, Mic, Video } from "lucide-react";
import { ContactAvatar } from "./contact-avatar";

export type ConversationSummary = { id: string; name: string; phone: string | null; tags: string[] | null };
export type PanelTag = { label: string; color: string } | null;

const KIND_ICON: Partial<Record<MediaKind, typeof Camera>> = { image: Camera, audio: Mic, document: FileText, video: Video };
const KIND_LABEL: Partial<Record<MediaKind, string>> = { image: "Foto", audio: "Áudio", document: "Documento", video: "Vídeo" };

export function ConversationRow({ conv, last, now, selected, panel, compact, onSelect }: {
  conv: ConversationSummary; last?: LastMessage; now: Date | null; selected: boolean;
  panel?: PanelTag; compact?: boolean; onSelect: () => void;
}) {
  const parsed = last ? parseMediaContent(last.content, last.message_type ?? null) : null;
  const Icon = parsed ? KIND_ICON[parsed.kind] : undefined;
  const preview = parsed ? (parsed.text || KIND_LABEL[parsed.kind] || "") : formatPhoneDisplay(conv.phone);
  const awaiting = last ? awaitingReply(last) : false;
  const outbound = last?.direction === "outbound";
  const name = conv.name || formatPhoneDisplay(conv.phone) || "Sem nome";

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected || undefined}
      className={`group relative flex w-full items-center gap-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
        compact ? "px-3 py-2" : "px-3 py-2.5"
      } ${selected ? "bg-primary/[0.13] hover:bg-primary/[0.16]" : "hover:bg-white/[0.035]"}`}
    >
      {selected && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" />}
      <ContactAvatar name={name} seed={conv.id} size={compact ? 38 : 46} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className={`truncate ${compact ? "text-sm" : "text-[15px]"} ${awaiting ? "font-semibold text-foreground" : "font-medium text-foreground/90"}`}>
            {name}
          </span>
          <span className={`shrink-0 text-[11px] tabular-nums ${awaiting ? "font-semibold text-emerald-400" : "text-muted-foreground"}`}>
            {last && now ? listTime(last.created_at, now) : ""}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span className={`flex min-w-0 flex-1 items-center gap-1 text-[13px] ${awaiting ? "text-foreground/75" : "text-muted-foreground"}`}>
            {outbound && <span className="shrink-0 text-foreground/45">Você:</span>}
            {Icon && <Icon aria-hidden className="size-3.5 shrink-0 opacity-80" />}
            <span className="truncate">{preview}</span>
          </span>
          {panel && (
            <span className="inline-flex max-w-[110px] shrink-0 items-center gap-1 rounded-full bg-white/[0.05] px-1.5 py-px text-[10px] text-foreground/70">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: panel.color }} />
              <span className="truncate">{panel.label}</span>
            </span>
          )}
          {awaiting && (
            <span className="relative flex size-2.5 shrink-0">
              <span aria-hidden className="absolute inset-0 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.16)]" />
              <span className="sr-only">Aguardando resposta</span>
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

export function ConversationList({ items, lastBy, now, activeId, onSelect, panelOf, compact, empty }: {
  items: ConversationSummary[]; lastBy: Map<string, LastMessage>; now: Date | null; activeId: string | null;
  onSelect: (id: string) => void; panelOf?: (id: string) => PanelTag; compact?: boolean; empty: string;
}) {
  if (items.length === 0) {
    return <p className="px-6 py-10 text-center text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-white/[0.045]">
      {items.map((c) => (
        <li key={c.id}>
          <ConversationRow
            conv={c} last={lastBy.get(c.id)} now={now} selected={activeId === c.id}
            panel={panelOf?.(c.id)} compact={compact} onSelect={() => onSelect(c.id)}
          />
        </li>
      ))}
    </ul>
  );
}
