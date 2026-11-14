"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2 } from "lucide-react";

type QuickReply = { id: string; shortcut: string; content: string };
type Form = { shortcut: string; content: string };

export function QuickRepliesDialog({ open, onOpenChange, replies, form, setForm, onSave, onDelete }: {
  open: boolean; onOpenChange: (o: boolean) => void; replies: QuickReply[];
  form: Form; setForm: (f: Form) => void; onSave: () => void; onDelete: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="font-heading">Respostas rápidas</DialogTitle>
        </DialogHeader>
        <div className="max-h-[42vh] space-y-2 overflow-y-auto px-6 py-4">
          {replies.length === 0 && (
            <div className="text-sm text-muted-foreground">Nenhuma resposta rápida ainda. Crie a primeira abaixo — depois use digitando “/” no chat.</div>
          )}
          {replies.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-3 rounded-lg bg-bg-tertiary p-3">
              <div className="min-w-0 text-sm">
                <div className="font-semibold">/{r.shortcut}</div>
                <div className="text-muted-foreground">{r.content}</div>
              </div>
              <button type="button" aria-label={`Excluir /${r.shortcut}`} onClick={() => onDelete(r.id)} className="shrink-0 text-muted-foreground hover:text-red-400">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-3 border-t border-border px-6 py-4">
          <div className="grid grid-cols-[110px_1fr] gap-3 sm:grid-cols-[130px_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="qr-shortcut">Atalho</Label>
              <Input id="qr-shortcut" value={form.shortcut} onChange={(e) => setForm({ ...form, shortcut: e.target.value })} placeholder="ola" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="qr-content">Mensagem</Label>
              <Textarea id="qr-content" rows={2} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Olá! Como posso ajudar?" />
            </div>
          </div>
        </div>
        <DialogFooter className="border-t border-border px-6 py-4">
          <Button onClick={onSave}><Plus className="h-4 w-4" /> Adicionar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
