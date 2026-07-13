"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NAV, navByHref } from "@/lib/nav";
import { useOrg } from "@/components/org-context";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ShieldCheck, LogOut, Plus } from "lucide-react";

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

  const groups: { key: string; items: typeof NAV }[] = [
    { key: "main", items: NAV.filter((n) => n.group === "main") },
    { key: "ops", items: NAV.filter((n) => n.group === "ops") },
    { key: "config", items: NAV.filter((n) => n.group === "config") },
  ];

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-emerald-500 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <span className="font-heading text-lg font-bold">ClinPrime</span>
        </div>

        <nav className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
          {groups.map((g, gi) => (
            <div key={g.key}>
              {gi > 0 && <div className="mx-2 mb-3 border-t border-sidebar-border" />}
              <div className="space-y-1">
                {g.items.map((item) => {
                  const isActive = active?.href === item.href;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/15 text-foreground"
                          : "text-sidebar-foreground hover:bg-white/5 hover:text-foreground"
                      )}
                    >
                      <Icon className={cn("h-[18px] w-[18px]", isActive && "text-primary")} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-primary to-emerald-500 text-xs font-bold text-white">
            {(org.displayName ?? "DR").slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{org.displayName ?? "Usuário"}</div>
            <div className="truncate text-xs text-muted-foreground">{org.name ?? userEmail}</div>
          </div>
          <button
            onClick={logout}
            title="Sair"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            <LogOut className="h-[18px] w-[18px]" />
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-20 items-center justify-between border-b border-border bg-background/60 px-8 backdrop-blur">
          <div>
            <h1 className="font-heading text-2xl font-bold leading-tight">
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
        <main className="flex-1 overflow-y-auto p-8">{children}</main>
      </div>
    </div>
  );
}
