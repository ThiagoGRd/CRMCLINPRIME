import { Suspense } from "react";
import { FilaClient } from "@/components/fila/fila-client";

export default function FilaPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Carregando...</div>}>
      <FilaClient />
    </Suspense>
  );
}
