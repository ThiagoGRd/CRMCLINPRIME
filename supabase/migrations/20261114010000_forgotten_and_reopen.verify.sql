-- Conferência da migração 20261114010000_forgotten_and_reopen.sql (não é migração). Cada consulta deve devolver ok = true.
select pg_get_viewdef('public.crm_forgotten_patients'::regclass) like '%created_at%' as ok;
select count(*) = 1 as ok from pg_trigger where tgname = 'crm_messages_reopen_patient' and tgrelid = 'public.crm_messages'::regclass and tgenabled <> 'D';
select count(*) = 1 as ok from pg_proc where pronamespace = 'public'::regnamespace and proname = 'reopen_patient_on_inbound' and prosecdef and proconfig @> array['search_path=public'];
