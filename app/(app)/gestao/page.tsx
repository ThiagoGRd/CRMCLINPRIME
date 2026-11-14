import { LinkTabs } from "@/components/link-tabs";
import { DashboardOverview } from "@/components/dashboard/dashboard-overview";
import { MetasClient } from "@/components/metas/metas-client";
import { ResultadosClient } from "@/components/resultados/resultados-client";

const TABS = [
  { key: "visao", label: "Visão geral" },
  { key: "metas", label: "Metas" },
  { key: "roi", label: "ROI por origem" },
];

export default async function GestaoPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const { aba } = await searchParams;
  const current = aba === "metas" || aba === "roi" ? aba : "visao";
  return (
    <>
      <LinkTabs base="/gestao" tabs={TABS} current={current} />
      {current === "metas" ? <MetasClient /> : current === "roi" ? <ResultadosClient /> : <DashboardOverview />}
    </>
  );
}
