import Link from "next/link";
import { cn } from "@/lib/utils";

export function LinkTabs({ base, tabs, current }: { base: string; tabs: { key: string; label: string }[]; current: string }) {
  return (
    <nav aria-label="Seções" className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-border px-1">
      {tabs.map((t, i) => (
        <Link
          key={t.key}
          href={i === 0 ? base : `${base}?aba=${t.key}`}
          aria-current={t.key === current ? "page" : undefined}
          className={cn(
            "-mb-px shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
            t.key === current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
