"use client";

import type { RefObject } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Zap } from "lucide-react";

type QuickReply = { id: string; shortcut: string; content: string };

export function ChatComposer({ inputRef, text, setText, onSend, sending, suggestions, onOpenQuickReplies, channels, channelId, onChannel }: {
  inputRef: RefObject<HTMLInputElement | null>; text: string; setText: (t: string) => void; onSend: () => void; sending: boolean;
  suggestions: QuickReply[]; onOpenQuickReplies: () => void;
  channels: { id: string; label: string; color: string }[]; channelId: string; onChannel: (id: string) => void;
}) {
  const current = channels.find((c) => c.id === channelId);
  return (
    <div className="border-t border-white/[0.07] bg-[#151827]">
      {/* Popup de respostas rápidas ao digitar "/" */}
      {suggestions.length > 0 && (
        <div className="mx-3 mt-2 overflow-hidden rounded-xl border border-white/[0.08] bg-popover shadow-xl">
          {suggestions.map((r) => (
            <button
              key={r.id} type="button"
              className="flex w-full items-start gap-2 border-b border-white/[.04] px-3 py-2 text-left text-sm outline-none last:border-0 hover:bg-white/[.04] focus-visible:bg-white/[.06]"
              onClick={() => { setText(r.content); inputRef.current?.focus(); }}
            >
              <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span><strong>/{r.shortcut}</strong> — <span className="text-muted-foreground">{r.content.slice(0, 70)}{r.content.length > 70 ? "…" : ""}</span></span>
            </button>
          ))}
        </div>
      )}
      <div className="px-2 pt-2 pb-2.5 sm:px-3">
        {channels.length > 0 && (
          <div className="mb-1.5 flex items-center gap-2 pl-1 text-[11px] text-muted-foreground">
            <span>Enviar por</span>
            <Select value={channelId} onValueChange={(v) => onChannel(v ?? "")}>
              <SelectTrigger size="sm" aria-label="Canal de envio" className="h-7 gap-1.5 rounded-full border-white/[0.08] bg-white/[0.03] px-2.5 text-xs">
                <SelectValue placeholder="Canal de envio">
                  <span aria-hidden className="size-1.5 rounded-full" style={{ background: current?.color ?? "#9ca3af" }} />
                  {current?.label ?? "Canal de envio"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {channels.map((ch) => <SelectItem key={ch.id} value={ch.id}>{ch.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <Button variant="ghost" size="icon" title="Respostas rápidas" aria-label="Respostas rápidas" onClick={onOpenQuickReplies} className="rounded-full">
            <Zap className="h-4 w-4 text-amber-400" />
          </Button>
          <Input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && suggestions.length === 0) { e.preventDefault(); onSend(); } }}
            placeholder="Digite uma mensagem ( / para respostas rápidas)"
            aria-label="Mensagem"
            className="h-10 min-w-0 flex-1 rounded-full border-transparent bg-[#1f2236] px-4 text-[14px]"
          />
          <Button onClick={onSend} disabled={sending || !text.trim()} size="icon" aria-label="Enviar mensagem" className="size-10 rounded-full">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
