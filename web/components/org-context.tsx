"use client";

import { createContext, useContext } from "react";
import type { Org } from "@/lib/org";

const OrgContext = createContext<Org | null>(null);

export function OrgProvider({
  org,
  children,
}: {
  org: Org;
  children: React.ReactNode;
}) {
  return <OrgContext.Provider value={org}>{children}</OrgContext.Provider>;
}

export function useOrg(): Org {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg deve ser usado dentro de OrgProvider");
  return ctx;
}
