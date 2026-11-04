-- SYNTHETIC predecessor only. This is NOT the missing production baseline or a
-- sanitized production dump. Only tests/postgres can apply it, after its guard.
-- Actual migration files 300 -> 700 are loaded unchanged after this fixture.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table public.organizations(id uuid primary key);
create table public.org_members(
  org_id uuid references organizations, user_id uuid, role text default 'admin',
  primary key(org_id,user_id)
);
create table public.crm_patients(
  id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations,
  last_message_at timestamptz, name text, phone text, source text, channel text,
  created_at timestamptz default now()
);
create table public.channels(
  id uuid primary key, org_id uuid not null references organizations,
  type text, status text, phone_number_id text
);
create table public.crm_messages(
  id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations,
  patient_id uuid references crm_patients, channel_id uuid references channels on delete set null,
  whatsapp_message_id text unique, created_at timestamptz default now(),
  direction text, content text, message_type text, status text, sent_by uuid
);
create function public.phone_canon(phone text) returns text language sql immutable as $$
  select substring(regexp_replace(phone,'\D','','g') from 1 for 2)||right(regexp_replace(phone,'\D','','g'),8)
$$;
create table public.crm_pipeline_stages(id uuid primary key default gen_random_uuid(),org_id uuid,position integer);
create table public.crm_deals(id uuid primary key default gen_random_uuid(),org_id uuid,patient_id uuid,stage_id uuid);
grant usage on schema public,auth to authenticated,service_role;
grant select on org_members to authenticated;
-- Required predecessor conditions for migration 400; these are synthetic policies.
alter table public.crm_messages enable row level security;
create policy synthetic_message_read on public.crm_messages for select to authenticated using (
  exists(select 1 from public.org_members m where m.org_id=crm_messages.org_id and m.user_id=auth.uid())
);
create publication supabase_realtime;
insert into organizations values ('00000000-0000-0000-0000-000000000001');
insert into org_members(org_id,user_id) values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011');
insert into crm_patients(id,org_id,name) values ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','Synthetic patient');
insert into channels values ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000001','whatsapp_cloud','connected','synthetic-phone-id');
insert into crm_pipeline_stages(org_id,position) values ('00000000-0000-0000-0000-000000000001',1);
