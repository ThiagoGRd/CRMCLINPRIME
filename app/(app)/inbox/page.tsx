import { Suspense } from "react";
import { InboxClient } from "@/components/inbox/inbox-client";

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Carregando...</div>}>
      <InboxClient />
    </Suspense>
  );
}
