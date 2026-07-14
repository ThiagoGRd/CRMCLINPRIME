"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { CC_BADGE } from "@/lib/funil";
import { formatPhoneDisplay, formatDateBR } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { MessageSquare, Pencil, Plus, Search } from "lucide-react";
import { toast } from "sonner";

const PAGE_SIZE = 40;

type Row = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  treatment_interest: string | null;
  treatment_value: number | null;
  source: string | null;
  channel: string | null;
  tags: string[] | null;
  created_at: string | null;
  clinicorp_status: string | null;
};

type FormState = {
  id?: string;
  name: string;
  phone: string;
  email: string;
  treatment_interest: string;
  treatment_value: string;
};

const EMPTY: FormState = { name: "", phone: "", email: "", treatment_interest: "", treatment_value: "" };

export function PacientesTable() {
  const org = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(0);
  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    const t = setTimeout(() => { setDebounced(search); setPage(0); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (searchParams.get("novo") === "1") setForm({ ...EMPTY });
  }, [searchParams]);

  const queryKey = useMemo(() => ["patients", debounced, page], [debounced, page]);
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const supabase = createClient();
      let q = supabase
        .from("patients")
        .select(
          "id,name,phone,email,treatment_interest,treatment_value,source,channel,tags,created_at,clinicorp_status",
          { count: "exact" }
        )
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (debounced.trim()) {
        // dentro de .or() o coringa do PostgREST é "*", não "%"
        const s = debounced.replace(/[*(),]/g, "").trim();
        q = q.or(`name.ilike.*${s}*,phone.ilike.*${s}*`);
      }
      const { data, count, error } = await q;
      if (error) throw error;
      return { rows: (data ?? []) as Row[], count: count ?? 0 };
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.count ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  async function save() {
    if (!form) return;
    if (!form.name.trim()) { toast.error("Informe o nome"); return; }
    const supabase = createClient();
    const payload = {
      name: form.name.trim(),
      phone: form.phone.replace(/\D/g, "") || null,
      email: form.email.trim() || null,
      treatment_interest: form.treatment_interest.trim() || null,
      treatment_value: form.treatment_value ? Number(form.treatment_value) : null,
    };
    try {
      if (form.id) {
        const { error } = await supabase.from("patients").update(payload).eq("id", form.id);
        if (error) throw error;
        toast.success("Paciente atualizado");
      } else {
        const { error } = await supabase
          .from("patients")
          .insert({ ...payload, org_id: org.id, source: "manual", channel: "manual" });
        if (error) throw error;
        toast.success("Paciente cadastrado");
      }
      setForm(null);
      qc.invalidateQueries({ queryKey: ["patients"] });
    } catch (e) {
      toast.error("Erro ao salvar", { description: String((e as Error).message) });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome ou telefone..."
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{total} pacientes</span>
          <Button onClick={() => setForm({ ...EMPTY })}>
            <Plus className="h-4 w-4" /> Cadastrar
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-4 py-3 font-semibold">Paciente</th>
              <th className="px-4 py-3 font-semibold">Telefone</th>
              <th className="px-4 py-3 font-semibold">Interesse</th>
              <th className="px-4 py-3 font-semibold">Clinicorp</th>
              <th className="px-4 py-3 font-semibold">Entrou em</th>
              <th className="px-4 py-3 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Carregando...</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Nenhum paciente encontrado.</td></tr>
            )}
            {rows.map((r) => {
              const cc = r.clinicorp_status ? CC_BADGE[r.clinicorp_status] : null;
              return (
                <tr key={r.id} className="border-b border-white/[.04] last:border-0 hover:bg-white/[.02]">
                  <td className="px-4 py-3 font-medium">{r.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatPhoneDisplay(r.phone)}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.treatment_interest || r.source || "—"}
                  </td>
                  <td className="px-4 py-3">
                    {cc ? (
                      <span style={{ color: cc.color }} className="text-xs font-semibold">{cc.label}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDateBR(r.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" title="Editar"
                        onClick={() => setForm({
                          id: r.id, name: r.name, phone: r.phone ?? "", email: r.email ?? "",
                          treatment_interest: r.treatment_interest ?? "",
                          treatment_value: r.treatment_value ? String(r.treatment_value) : "",
                        })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" title="Atender"
                        onClick={() => router.push(`/inbox?p=${r.id}`)}>
                        <MessageSquare className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {maxPage > 0 && (
        <div className="flex items-center justify-end gap-3">
          <span className="text-sm text-muted-foreground">Página {page + 1} de {maxPage + 1}</span>
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
          <Button variant="outline" size="sm" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
        </div>
      )}

      {/* Modal add/edit */}
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-heading">{form?.id ? "Editar Paciente" : "Novo Paciente"}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Nome</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Maria Oliveira" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>WhatsApp</Label>
                  <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="82999999999" />
                </div>
                <div className="space-y-2">
                  <Label>E-mail</Label>
                  <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@exemplo.com" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Interesse / Tratamento</Label>
                  <Input value={form.treatment_interest} onChange={(e) => setForm({ ...form, treatment_interest: e.target.value })} placeholder="Ex: Implante" />
                </div>
                <div className="space-y-2">
                  <Label>Valor (R$)</Label>
                  <Input type="number" value={form.treatment_value} onChange={(e) => setForm({ ...form, treatment_value: e.target.value })} placeholder="8000" />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)}>Cancelar</Button>
            <Button onClick={save}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
