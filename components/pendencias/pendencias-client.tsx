"use client";

import { useOrg } from "@/components/org-context";
import { PendingItemsWorkspace } from "./pending-items-panel";

export function PendenciasClient() {
  const org = useOrg();
  return <div className="mx-auto max-w-4xl"><PendingItemsWorkspace key={org.id} /></div>;
}
