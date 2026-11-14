"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NAV, navByHref } from "@/lib/nav";
import { useOrg } from "@/components/org-context";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ShieldCheck, LogOut, Plus } from "lucide-react";
import { OverdueBadge } from "@/components/fila/overdue-badge";
import { Copilot } from "@/components/copilot/copilot";

export function AppShell({
  userEmail,
  children,
}: {
  userEmail: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const org = useOrg();
  const active = navByHref(pathname);

  async function logout() {
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const groups: { key: string; label: string; items: typeof NAV }[] = [
    { key: "main", label: "Atendimento", items: NAV.filter((n) => n.group === "main") },
    { key: "ops", label: "Gestão", items: NAV.filter((n) => n.group === "ops") },
    { key: "config", label: "Sistema", items: NAV.filter((n) => n.group === "config") },
  ];

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar/95 backdrop-blur-xl">
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-primary via-indigo-500 to-emerald-500 text-white shadow-[0_4px_14px_rgba(99,102,241,0.35)]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <span className="font-heading text-lg font-bold tracking-tight text-foreground">
              ClinPrime
            </span>
            <span className="block text-[10px] font-medium tracking-wider text-emerald-400/90 uppercase">
              Odontologia & IA
            </span>
          </div>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {groups.map((g, gi) => (
            <div key={g.key}>
              {gi > 0 && <div className="mx-2 mb-3 border-t border-sidebar-border" />}
              <div className="mb-1.5 px-3 text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
                {g.label}
              </div>
              <div className="space-y-1">
                {g.items.map((item) => {
                  const isActive = active?.href === item.href;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150",
                        isActive
                          ? "border border-primary/25 bg-gradient-to-r from-primary/20 to-primary/5 text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
                          : "border border-transparent text-sidebar-foreground hover:bg-white/[0.05] hover:text-foreground"
                      )}
                    >
                      {isActive && (
                        <span className="absolute left-0 h-5 w-1 rounded-r-full bg-primary shadow-[0_0_8px_rgba(99,102,241,0.8)]" />
                      )}
                      <Icon
                        className={cn(
                          "h-[18px] w-[18px] transition-colors",
                          isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                        )}
                      />
                      {item.label}
                      {item.badge === "overdue" && <OverdueBadge />}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex items-start gap-3 border-t border-sidebar-border bg-black/20 px-4 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-500 text-xs font-bold text-white shadow-sm">
            {(org.displayName ?? "DR").slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{org.displayName ?? "Usuário"}</div>
            <div className="truncate text-xs text-muted-foreground">{org.name ?? userEmail}</div>
            <dl className="mt-2 text-xs">
              <dt className="text-[10px] font-medium tracking-wider text-muted-foreground/80 uppercase">Conta em uso</dt>
              <dd className="mt-0.5 text-[11px] text-foreground/85 select-text whitespace-normal [overflow-wrap:anywhere]">
                {userEmail || "E-mail não identificado"}
              </dd>
            </dl>
          </div>
          <button
            onClick={logout}
            title="Sair"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-all hover:border-white/10 hover:bg-white/5 hover:text-foreground"
          >
            <LogOut className="h-[17px] w-[17px]" />
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-20 shrink-0 items-center justify-between border-b border-border bg-background/75 px-8 backdrop-blur-xl">
          <div>
            <h1 className="font-heading text-2xl font-bold leading-tight tracking-tight">
              {active?.label ?? "ClinPrime"}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{active?.subtitle ?? ""}</p>
          </div>
          {active?.addLead && (
            <Button onClick={() => router.push("/pacientes?novo=1")}>
              <Plus className="h-4 w-4" /> Cadastrar Paciente
            </Button>
          )}
        </header>
        <main className="flex-1 overflow-y-auto p-6 lg:p-8">{children}</main>
      </div>
      <Copilot />
    </div>
  );
}
