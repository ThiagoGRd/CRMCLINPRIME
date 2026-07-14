"use client";

import { useRef, useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, X, Send } from "lucide-react";

type Msg = { role: "user" | "assistant"; text: string };

export function Copilot() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "assistant", text: "Oi! Sou a Sofia, sua copiloto. Pergunte sobre pacientes, funil, agenda ou o que precisar." },
  ]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const convId = useRef<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, open]);

  async function send() {
    const q = text.trim();
    if (!q || loading) return;
    setText("");
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setLoading(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.functions.invoke("dify-proxy", {
        body: { query: q, conversation_id: convId.current },
      });
      if (error) throw error;
      if (data?.conversation_id) convId.current = data.conversation_id;
      setMsgs((m) => [...m, { role: "assistant", text: data?.answer ?? "Não consegui responder agora." }]);
    } catch {
      setMsgs((m) => [...m, { role: "assistant", text: "Ops, tive um problema pra responder. Tente de novo." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* Botão flutuante */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet-500 text-white shadow-2xl transition-transform hover:scale-105"
          title="Copiloto Sofia"
        >
          <Sparkles className="h-6 w-6" />
        </button>
      )}

      {/* Painel */}
      {open && (
        <div className="fixed bottom-6 right-6 z-40 flex h-[520px] w-[380px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <div className="flex items-center justify-between border-b border-border bg-gradient-to-r from-primary/20 to-violet-500/10 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet-500 text-white">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="font-heading text-sm font-bold">Sofia — Copiloto</div>
            </div>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {msgs.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm ${
                  m.role === "user" ? "bg-primary text-primary-foreground" : "bg-bg-tertiary text-foreground"
                }`}>
                  {m.text}
                </div>
              </div>
            ))}
            {loading && <div className="text-xs text-muted-foreground">Sofia está pensando...</div>}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-center gap-2 border-t border-border p-3">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Pergunte à Sofia..."
            />
            <Button onClick={send} disabled={loading || !text.trim()} size="icon"><Send className="h-4 w-4" /></Button>
          </div>
        </div>
      )}
    </>
  );
}
