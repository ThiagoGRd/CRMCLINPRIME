"use client";

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Archive, ChevronLeft, ChevronRight, LockKeyhole, RefreshCw, Search } from 'lucide-react';
import { useOrg } from '@/components/org-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createClient } from '@/lib/supabase/client';
import { formatPhoneDisplay } from '@/lib/format';
import { LEGACY_PAGE_SIZE, fetchLegacyMessages, fetchLegacyPatient, fetchLegacyPatients } from '@/lib/legacy-history';

export function LegacyHistoryClient() {
  const org = useOrg();
  const params = useSearchParams();
  const patientId = params.get('p');
  // Navigation and organization changes reset selection and pagination together.
  return <LegacyHistoryWorkspace key={`${org.id}:${patientId ?? ''}`} orgId={org.id} initialPatientId={patientId} />;
}

function LegacyHistoryWorkspace({orgId, initialPatientId}: {orgId: string; initialPatientId: string | null}) {
  const supabase = useMemo(() => createClient(), []);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [patientPage, setPatientPage] = useState(0);
  const [selectedId, setSelectedId] = useState(initialPatientId);
  const [messagePage, setMessagePage] = useState(0);

  const patients = useQuery({
    queryKey: ['legacy-patients', orgId, search, patientPage],
    queryFn: ({signal}) => fetchLegacyPatients(supabase, {orgId, search, page: patientPage, signal}),
  });
  const selectedPatient = useQuery({
    queryKey: ['legacy-patient', orgId, selectedId],
    enabled: !!selectedId,
    queryFn: ({signal}) => fetchLegacyPatient(supabase, orgId, selectedId!, signal),
  });
  const patient = selectedPatient.data;
  const messages = useQuery({
    queryKey: ['legacy-messages', orgId, selectedId, messagePage],
    enabled: !!patient && patient.id === selectedId,
    queryFn: ({signal}) => fetchLegacyMessages(supabase, {orgId, patientId: selectedId!, page: messagePage, signal}),
  });

  function selectPatient(id: string) {
    setSelectedId(id);
    setMessagePage(0);
  }

  return (
    <div className="min-w-0 space-y-4">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold"><Archive className="size-5" aria-hidden="true" />Histórico legado</h1>
        <p className="mt-1 text-sm text-muted-foreground">Consulta de mensagens antigas sem canal identificado.</p>
      </header>
      <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 text-sm" role="note">
        <p className="flex items-center gap-2 font-semibold"><LockKeyhole className="size-4 shrink-0" aria-hidden="true" />Somente leitura · Canal desconhecido / não atribuído</p>
        <p className="mt-2">Estas mensagens não pertencem às caixas Recepção, Comercial ou CRC. Nenhum número de origem foi presumido. Este histórico não permite responder, editar ou atribuir mensagens a um canal.</p>
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <aside className="min-w-0 self-start rounded-xl border bg-card p-4" aria-label="Selecionar paciente para consulta">
          <h2 className="font-semibold">Buscar paciente</h2>
          <p className="mt-1 text-xs text-muted-foreground">Pacientes desta organização. O histórico pode estar vazio.</p>
          <form className="mt-3 space-y-2" onSubmit={event => {event.preventDefault(); setSearch(searchInput.trim()); setPatientPage(0);}}>
            <label htmlFor="legacy-patient-search" className="text-sm">Nome ou telefone</label>
            <div className="flex gap-2">
              <Input id="legacy-patient-search" value={searchInput} onChange={event => setSearchInput(event.target.value)} placeholder="Nome ou telefone" className="min-w-0" />
              <Button type="submit" variant="outline" className="min-h-11 min-w-11" aria-label="Buscar pacientes"><Search aria-hidden="true" /></Button>
            </div>
            {search && <p className="break-words text-xs text-muted-foreground">Busca aplicada: {search}</p>}
          </form>
          <div className="mt-4" aria-live="polite" aria-busy={patients.isFetching}>
            {patients.isLoading ? <p className="py-4 text-sm text-muted-foreground" role="status">Carregando pacientes...</p> : patients.isError ? (
              <ReadError label="Não foi possível carregar os pacientes." retry={() => void patients.refetch()} />
            ) : patients.data?.rows.length ? (
              <ul className="max-h-64 space-y-1 overflow-y-auto lg:max-h-96">
                {patients.data.rows.map(row => (
                  <li key={row.id}>
                    <button type="button" onClick={() => selectPatient(row.id)} aria-pressed={selectedId === row.id}
                      className={`min-h-14 w-full rounded-lg border p-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring ${selectedId === row.id ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted'}`}>
                      <span className="block break-words font-medium">{row.name || 'Paciente sem nome'}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{row.phone ? formatPhoneDisplay(row.phone) : 'Telefone não informado'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="py-4 text-sm text-muted-foreground">Nenhum paciente encontrado nesta organização para a busca.</p>}
          </div>
          {patients.data && !patients.isError && <Pagination label="Pacientes" page={patients.data.page} total={patients.data.total} busy={patients.isFetching} onChange={setPatientPage} />}
        </aside>
        <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5" aria-label="Mensagens legadas" aria-busy={selectedPatient.isFetching || messages.isFetching}>
          {!selectedId ? <p className="py-10 text-center text-sm text-muted-foreground">Selecione um paciente para consultar as mensagens sem canal identificado.</p>
            : selectedPatient.isLoading ? <p role="status" className="py-6 text-sm text-muted-foreground">Carregando paciente...</p>
            : selectedPatient.isError ? <ReadError label="Não foi possível conferir o paciente nesta organização." retry={() => void selectedPatient.refetch()} />
            : !patient ? <p role="status" className="py-6 text-sm text-muted-foreground">Paciente não encontrado nesta organização. Escolha um paciente na busca.</p>
            : <>
              <header className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b pb-4">
                <div className="min-w-0">
                  <h2 className="break-words text-lg font-semibold">{patient.name || 'Paciente sem nome'}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{patient.phone ? formatPhoneDisplay(patient.phone) : 'Telefone não informado'}</p>
                  <p className="mt-2 text-xs font-medium">Canal desconhecido / não atribuído · Somente leitura</p>
                </div>
                <Button variant="outline" className="min-h-11" disabled={messages.isFetching} onClick={() => void messages.refetch()}><RefreshCw aria-hidden="true" />Atualizar histórico</Button>
              </header>
              <p className="mb-3 text-xs text-muted-foreground">Ordem: mais antigas primeiro. Horários no fuso deste dispositivo. Registros sem data aparecem ao final.</p>
              <div aria-live="polite">
                {messages.isLoading ? <p role="status" className="py-6 text-sm text-muted-foreground">Carregando mensagens legadas...</p>
                  : messages.isError ? <ReadError label="Não foi possível carregar o histórico legado." retry={() => void messages.refetch()} />
                  : !messages.data?.rows.length ? <p role="status" className="py-10 text-center text-sm text-muted-foreground">Este paciente não possui mensagens legadas sem canal identificado.</p>
                  : <ol className="space-y-3">
                    {messages.data.rows.map(row => {
                      const date = row.created_at ? new Date(row.created_at) : null;
                      const validDate = date && !Number.isNaN(date.getTime());
                      return <li key={row.id} className="min-w-0 rounded-lg border bg-background p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="rounded bg-muted px-2 py-1 font-medium text-foreground">{row.direction === 'inbound' ? 'Recebida' : row.direction === 'outbound' ? 'Enviada' : 'Direção não informada'}</span>
                          {validDate ? <time dateTime={row.created_at!}>{date.toLocaleString('pt-BR', {timeZoneName: 'short'})}</time> : <span>Data não informada</span>}
                        </div>
                        <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{row.content?.trim() ? row.content : 'Mensagem sem conteúdo de texto.'}</p>
                      </li>;
                    })}
                  </ol>}
              </div>
              {messages.data && !messages.isError && <Pagination label="Mensagens" page={messages.data.page} total={messages.data.total} busy={messages.isFetching} onChange={setMessagePage} />}
            </>}
        </section>
      </div>
    </div>
  );
}

function ReadError({label, retry}: {label: string; retry: () => void}) {
  return <div role="alert" className="space-y-2 py-4 text-sm"><p className="text-destructive">{label}</p><Button variant="outline" className="min-h-11" onClick={retry}>Tentar novamente</Button></div>;
}

function Pagination({label, page, total, busy, onChange}: {label: string; page: number; total: number; busy: boolean; onChange: (page: number) => void}) {
  const lastPage = Math.max(0, Math.ceil(total / LEGACY_PAGE_SIZE) - 1);
  return <nav aria-label={`Paginação de ${label.toLocaleLowerCase('pt-BR')}`} className="mt-4 space-y-2 border-t pt-3">
    <p className="text-xs text-muted-foreground">{label}: {total}. Página {page + 1} de {lastPage + 1}.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" className="min-h-11" disabled={busy || page === 0} onClick={() => onChange(page - 1)} aria-label={`Página anterior de ${label.toLocaleLowerCase('pt-BR')}`}><ChevronLeft aria-hidden="true" />Anterior</Button>
      <Button variant="outline" className="min-h-11" disabled={busy || page >= lastPage} onClick={() => onChange(page + 1)} aria-label={`Próxima página de ${label.toLocaleLowerCase('pt-BR')}`}>Próxima<ChevronRight aria-hidden="true" /></Button>
    </div>
  </nav>;
}
