"use client";

import { useEffect, useState } from "react";
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
  // O refetch não re-renderiza quando os dados vêm iguais; o relógio precisa andar sozinho.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const n = data ? countOverdue(data, { userId: org.userId, isManager: org.isManager }, now) : 0;
  if (n === 0) return null;
  return (
    <span role="status" aria-label={`${n} ${n === 1 ? "tarefa vencida" : "tarefas vencidas"}`} className="ml-auto rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white tabular-nums">
      {n > 99 ? "99+" : n}
    </span>
  );
}
