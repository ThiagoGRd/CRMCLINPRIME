-- Conferência da migração 20261114000000_crm_tasks.sql (não é migração). Cada consulta deve devolver ok = true.
select count(*) = 18 as ok from information_schema.columns where table_schema = 'public' and table_name = 'crm_tasks';
select bool_and(relrowsecurity) as ok from pg_class where relnamespace = 'public'::regnamespace and relname = 'crm_tasks';
select count(*) = 1 as ok from pg_policies where schemaname = 'public' and tablename = 'crm_tasks' and qual = 'is_org_member(org_id)';
select count(*) = 3 as ok from information_schema.columns where table_schema = 'public' and table_name = 'patients' and column_name in ('front','care_status','care_closed_reason');
select count(*) = 1 as ok from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crm_tasks';
