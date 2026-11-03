import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OrgProvider } from '../../components/org-context';
import { InboxClient } from '../../components/inbox/inbox-client';
import { Toaster } from 'sonner';
const org = {id: 'org-a', role: 'admin', displayName: 'Equipe de teste', name: 'Clínica de teste', contactLabel: null, logoUrl: null, settings: null};
const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><OrgProvider org={org}><main className="p-5"><h1 className="mb-4 text-xl font-semibold">ClinPrime · ambiente sintético</h1><InboxClient/></main><Toaster/></OrgProvider></QueryClientProvider>);
