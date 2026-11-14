"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { countOverdue } from "@/lib/tasks";
import { listOpenTasks } from "@/lib/tasks-data";

export function OverdueBadge() {
  const org = useOrg();
  const { data } = useQuery({
    queryKey: ["tasks", org.id],
    queryFn: () => listOpenTasks(createClient(), org.id),
    refetchInterval: 60_000,
  });
  const n = data ? countOverdue(data, { userId: org.userId, isManager: org.isManager }, new Date()) : 0;
  if (n === 0) return null;
  return (
    <span aria-label={`${n} tarefas vencidas`} className="ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white tabular-nums">
      {n > 99 ? "99+" : n}
    </span>
  );
}
