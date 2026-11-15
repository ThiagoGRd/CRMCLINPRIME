"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { clockTime, dayKey, dayLabel, parseMediaContent, type InboxMessage } from "@/lib/inbox";
import { Button } from "@/components/ui/button";
import { ArrowDown, ClipboardList } from "lucide-react";
import { BubbleText, MediaContent } from "./media-content";

export type SenderLabel = { label: string; color: string } | null;

// Enviada: cor da marca misturada ao cartão; recebida: superfície neutra.
const OUT_BG = "color-mix(in oklab, #6366f1 34%, #121420)";
const IN_BG = "#1d2032";

function Tail({ out, color }: { out: boolean; color: string }) {
  return (
    <svg aria-hidden viewBox="0 0 8 13" width="8" height="13" className={`absolute top-0 ${out ? "-right-[7px]" : "-left-[7px] -scale-x-100"}`}>
      <path d="M0 0h5.2C7.4 0 8.3 1.5 7.1 3.1L0 12.6z" fill={color} />
    </svg>
  );
}

export function MessageBubble({ message, first, sender, contactName, onDemand, demandDisabled, afterSeparator }: {
  message: InboxMessage; first: boolean; sender: SenderLabel; contactName: string;
  onDemand: (id: string) => void; demandDisabled: boolean; afterSeparator?: boolean;
}) {
  const out = message.direction === "outbound";
  const { kind, text } = parseMediaContent(message.content, message.message_type ?? null);
  const bg = out ? OUT_BG : IN_BG;
  const who = out ? sender?.label ?? "equipe" : contactName;
  return (
    <div className={`group flex items-center gap-1 ${out ? "justify-end pl-8 sm:pl-16" : "justify-start pr-8 sm:pr-16"} ${afterSeparator ? "" : first ? "mt-3" : "mt-[3px]"}`}>
      <div
        className={`relative max-w-[min(100%,520px)] min-w-[88px] rounded-xl px-2.5 pt-1.5 pb-1.5 text-[14px] leading-[1.42] text-foreground shadow-[0_1px_1px_rgba(0,0,0,0.35)] ${
          first ? (out ? "rounded-tr-[3px]" : "rounded-tl-[3px]") : ""
        } ${out ? "" : "ring-1 ring-white/[0.04]"}`}
        style={{ backgroundColor: bg }}
      >
        {first && <Tail out={out} color={bg} />}
        {out && first && sender && (
          <p className="mb-0.5 text-[12px] font-semibold" style={{ color: sender.color }}>{sender.label}</p>
        )}
        {kind === "text"
          ? <BubbleText text={text} />
          : <MediaContent message={message} kind={kind} text={text} alt={`Foto enviada por ${who}`} outbound={out} />}
        <span className={`pointer-events-none absolute right-2 bottom-1 text-[10.5px] tabular-nums ${out ? "text-white/55" : "text-foreground/45"}`}>
          {clockTime(message.created_at)}
        </span>
      </div>
      {!out && (
        <Button
          variant="ghost" size="icon-sm" aria-label="Virar demanda" title="Virar demanda"
          disabled={demandDisabled} onClick={() => onDemand(message.id)}
          className="text-muted-foreground md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <ClipboardList className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function MessageThread({ messages, loading, now, contactName, senderOf, onDemand, demandDisabled }: {
  messages: InboxMessage[]; loading: boolean; now: Date | null; contactName: string;
  senderOf: (channelId?: string | null) => SenderLabel; onDemand: (id: string) => void; demandDisabled: boolean;
}) {
  // montado de novo a cada conversa (key no pai): o primeiro lote pula direto para o fim
  const scrollRef = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const nearBottom = useRef(true);
  const [away, setAway] = useState(false);
  const [countWhenLeft, setCountWhenLeft] = useState(0);

  // Mensagem nova só desce a lista se a pessoa já estava perto do fim (~120px).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    if (!placed.current) { placed.current = true; el.scrollTop = el.scrollHeight; return; }
    if (nearBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [messages.length]);

  function onScroll(el: HTMLDivElement) {
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
    nearBottom.current = near;
    if (near === !away) return;
    setAway(!near);
    if (!near) setCountWhenLeft(messages.length);
  }
  const toBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  const hasNew = away && messages.length > countWhenLeft;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-chat-scroll
        onScroll={(e) => onScroll(e.currentTarget)}
        className="h-full overflow-y-auto overscroll-contain [overflow-anchor:none]"
        style={{
          backgroundColor: "#0c0e17",
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), radial-gradient(120% 60% at 50% 0%, rgba(99,102,241,0.07), transparent 70%)",
          backgroundSize: "20px 20px, 100% 100%",
        }}
      >
        <div className="flex min-h-full flex-col justify-end px-3 py-4 sm:px-[5%]">
          {loading ? (
            <p role="status" className="mx-auto mb-6 rounded-lg bg-[#1a1d30]/90 px-4 py-2 text-center text-xs text-muted-foreground motion-safe:animate-pulse">
              Carregando mensagens...
            </p>
          ) : messages.length === 0 && (
            <p className="mx-auto mb-6 rounded-lg bg-[#1a1d30]/90 px-4 py-2 text-center text-xs text-muted-foreground">
              Nenhuma mensagem ainda.
            </p>
          )}
          {!loading && messages.map((m, i) => {
            const prev = messages[i - 1];
            const day = dayKey(m.created_at);
            const newDay = !prev || dayKey(prev.created_at) !== day;
            const first = newDay || prev.direction !== m.direction
              || (m.direction === "outbound" && (prev.channel_id ?? null) !== (m.channel_id ?? null));
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <div className="mt-5 mb-2 flex justify-center first:mt-0">
                    <span className="rounded-full bg-[#1a1d30]/90 px-3 py-1 text-[11px] font-medium text-foreground/70 shadow-[0_1px_2px_rgba(0,0,0,0.4)] ring-1 ring-white/[0.05]">
                      {now ? dayLabel(m.created_at, now) : ""}
                    </span>
                  </div>
                )}
                <MessageBubble
                  message={m} first={first} sender={m.direction === "outbound" ? senderOf(m.channel_id) : null}
                  contactName={contactName} onDemand={onDemand} demandDisabled={demandDisabled} afterSeparator={newDay}
                />
              </Fragment>
            );
          })}
        </div>
      </div>
      {away && (
        hasNew ? (
          <button
            type="button" onClick={toBottom}
            className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2"
          >
            <ArrowDown className="size-3.5" /> Novas mensagens
          </button>
        ) : (
          <button
            type="button" aria-label="Ir para a última mensagem" onClick={toBottom}
            className="absolute right-4 bottom-4 grid size-10 place-items-center rounded-full bg-[#1d2032] text-foreground/80 shadow-lg ring-1 ring-white/10 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90"
          >
            <ArrowDown className="size-4" />
          </button>
        )
      )}
    </div>
  );
}
