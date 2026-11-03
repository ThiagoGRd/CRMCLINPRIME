import type { SupabaseClient } from '@supabase/supabase-js';

export const LEGACY_PAGE_SIZE = 40;
export type LegacyPatient = {id: string; name: string | null; phone: string | null};
export type LegacyMessage = {
  id: string;
  patient_id: string;
  channel_id: null;
  conversation_id: null;
  direction: string | null;
  content: string | null;
  created_at: string | null;
};
export type LegacyPage<T> = {rows: T[]; total: number; page: number};
type PageScope = {orgId: string; page: number; signal?: AbortSignal};
type PageRange = {page: number; from: number; to: number};

export function legacyPageRange(requestedPage: number): PageRange {
  const maxSafePage = Math.floor((Number.MAX_SAFE_INTEGER - LEGACY_PAGE_SIZE + 1) / LEGACY_PAGE_SIZE);
  const page = Number.isSafeInteger(requestedPage) && requestedPage >= 0 && requestedPage <= maxSafePage ? requestedPage : 0;
  return {page, from: page * LEGACY_PAGE_SIZE, to: page * LEGACY_PAGE_SIZE + LEGACY_PAGE_SIZE - 1};
}

function requireScope(...ids: string[]) {
  if (ids.some(id => !id.trim())) throw new Error('Organização e paciente precisam estar identificados para consultar o histórico.');
}

async function readPage<T>(requestedPage: number, read: (range: PageRange) => PromiseLike<{
  data: unknown[] | null; count: number | null; error: {message: string; code?: string} | null;
}>): Promise<LegacyPage<T>> {
  const range = legacyPageRange(requestedPage);
  const result = await read(range);
  // Exact-count requests beyond the remaining rows fail with PGRST103 (HTTP 416).
  // Reset once to offset zero; an error there cannot enter this branch again.
  if (result.error?.code === 'PGRST103' && range.page > 0) return readPage<T>(0, read);
  if (result.error) throw new Error(result.error.message);
  const total = result.count ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / LEGACY_PAGE_SIZE) - 1);
  // A stale page (for example after a search/refetch) must never strand the user.
  if (range.page > lastPage) return readPage<T>(lastPage, read);
  return {rows: (result.data ?? []) as T[], total, page: range.page};
}

export async function fetchLegacyPatients(client: SupabaseClient, scope: PageScope & {search: string}): Promise<LegacyPage<LegacyPatient>> {
  requireScope(scope.orgId);
  // Only literal letters/numbers and phone separators enter the OR expression.
  // PostgREST operators, wildcards and grouping characters cannot be injected.
  const search = scope.search.replace(/[^\p{L}\p{N}\s+-]/gu, ' ').replace(/\s+/g, ' ').trim();
  const phoneSearch = /^\+?[\d\s-]+$/.test(search) ? search.replace(/\D/g, '') : search;
  return readPage<LegacyPatient>(scope.page, ({from, to}) => {
    let query = client.from('crm_patients').select('id,name,phone', {count: 'exact'})
      .eq('org_id', scope.orgId).order('name').order('id').range(from, to);
    if (search) query = query.or(`name.ilike.*${search}*,phone.ilike.*${phoneSearch}*`);
    if (scope.signal) query = query.abortSignal(scope.signal);
    return query;
  });
}

export async function fetchLegacyPatient(client: SupabaseClient, orgId: string, patientId: string, signal?: AbortSignal): Promise<LegacyPatient | null> {
  requireScope(orgId, patientId);
  let query = client.from('crm_patients').select('id,name,phone').eq('org_id', orgId).eq('id', patientId).limit(1);
  if (signal) query = query.abortSignal(signal);
  const {data, error} = await query;
  if (error) throw new Error(error.message);
  return (data?.[0] ?? null) as LegacyPatient | null;
}

export async function fetchLegacyMessages(client: SupabaseClient, scope: PageScope & {patientId: string}): Promise<LegacyPage<LegacyMessage>> {
  requireScope(scope.orgId, scope.patientId);
  return readPage<LegacyMessage>(scope.page, ({from, to}) => {
    let query = client.from('crm_messages')
      .select('id,patient_id,channel_id,conversation_id,direction,content,created_at', {count: 'exact'})
      .eq('org_id', scope.orgId).eq('patient_id', scope.patientId)
      .is('channel_id', null).is('conversation_id', null)
      .order('created_at', {ascending: true, nullsFirst: false}).order('id').range(from, to);
    if (scope.signal) query = query.abortSignal(scope.signal);
    return query;
  });
}
