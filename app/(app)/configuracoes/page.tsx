import { LinkTabs } from "@/components/link-tabs";
import { ConfiguracoesClient } from "@/components/configuracoes/configuracoes-client";
import { ConexoesClient } from "@/components/conexoes/conexoes-client";

const TABS = [
  { key: "geral", label: "Geral" },
  { key: "conexoes", label: "Conexões" },
];

export default async function ConfiguracoesPage({ searchParams }: { searchParams: Promise<{ aba?: string }> }) {
  const { aba } = await searchParams;
  const current = aba === "conexoes" ? "conexoes" : "geral";
  return (
    <>
      <LinkTabs base="/configuracoes" tabs={TABS} current={current} />
      {current === "conexoes" ? <ConexoesClient /> : <ConfiguracoesClient />}
    </>
  );
}
