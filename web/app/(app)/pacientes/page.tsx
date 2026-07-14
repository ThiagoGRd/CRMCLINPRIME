import { Suspense } from "react";
import { PacientesTable } from "@/components/pacientes/pacientes-table";

export default function PacientesPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Carregando...</div>}>
      <PacientesTable />
    </Suspense>
  );
}
