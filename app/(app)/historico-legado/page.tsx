import { Suspense } from 'react';
import { LegacyHistoryClient } from '@/components/legacy-history/legacy-history-client';

export default function LegacyHistoryPage() {
  return <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">Carregando histórico legado...</p>}><LegacyHistoryClient /></Suspense>;
}
