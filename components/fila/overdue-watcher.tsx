"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useOrg } from "@/components/org-context";
import { newlyOverdue, visibleTo, warnKey, warningsFor } from "@/lib/tasks";
import { listOpenTasks } from "@/lib/tasks-data";

const MAX_INDIVIDUAL = 3;

export function OverdueWatcher() {
  const org = useOrg();
  const router = useRouter();
  const warned = useRef<Set<string>>(new Set());
  const seeded = useRef(false);
  const [now, setNow] = useState(() => new Date());
  const { data } = useQuery({
    queryKey: ["tasks", org.id],
    queryFn: () => listOpenTasks(createClient(), org.id),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data) return;
    const mine = data.filter((t) => visibleTo(t, { userId: org.userId, isManager: org.isManager }, []));
    const toWarn = warningsFor(mine, warned.current, now, seeded.current);
    for (const t of newlyOverdue(mine, warned.current, now)) warned.current.add(warnKey(t));
    seeded.current = true;
    const action = { label: "Abrir fila", onClick: () => router.push("/fila") };
    if (toWarn.length > MAX_INDIVIDUAL) toast.warning(`${toWarn.length} prazos estouraram agora.`, { action });
    else for (const t of toWarn) toast.warning(`Prazo estourado: ${t.title} — ${t.patientName}`, { action });
  }, [data, now, org.userId, org.isManager, router]);

  return null;
}
