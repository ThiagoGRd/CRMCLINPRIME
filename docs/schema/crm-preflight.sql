-- Read-only staging preflight. Run the complete file in a fresh session against
-- an authorized, sanitized schema/data copy. It neither repairs nor migrates.
-- Results: catalog result sets plus CRM_PREFLIGHT JSON NOTICEs with counts only.
-- Missing columns skip dependent counts; permission/RLS failures are BLOCKED,
-- never a zero/clean count. Keep both results and NOTICEs when reviewing.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '3s';
SET LOCAL client_min_messages = notice;
SET LOCAL row_security = off;

SELECT 'environment' AS section, 'audit_context' AS check_id, 'review' AS status,
  jsonb_build_object('server_version',current_setting('server_version'),
    'transaction_read_only',current_setting('transaction_read_only'),
    'wal_level',current_setting('wal_level'),
    'role',current_user) AS details;

-- Required predecessor and operational columns used by migrations 300–700.
-- New operational tables/columns are expected to be absent before their migration.
-- Types are reported rather than silently coerced; review_type is not a pass.
WITH expected(table_name,column_name,expected_type) AS (VALUES
  ('organizations','id','uuid'),
  ('org_members','org_id','uuid'),('org_members','user_id','uuid'),('org_members','role','text'),
  ('crm_patients','id','uuid'),('crm_patients','org_id','uuid'),
  ('crm_patients','name','text'),('crm_patients','phone','text'),
  ('crm_patients','source','text'),('crm_patients','channel','text'),
  ('crm_patients','created_at','timestamp with time zone'),
  ('crm_patients','last_message_at','timestamp with time zone'),
  ('channels','id','uuid'),('channels','org_id','uuid'),
  ('channels','type','text'),('channels','status','text'),('channels','phone_number_id','text'),('channels','waba_id','text'),
  ('crm_messages','id','uuid'),('crm_messages','org_id','uuid'),
  ('crm_messages','patient_id','uuid'),('crm_messages','channel_id','uuid'),
  ('crm_messages','whatsapp_message_id','text'),('crm_messages','created_at','timestamp with time zone'),
  ('crm_messages','direction','text'),('crm_messages','content','text'),
  ('crm_messages','message_type','text'),('crm_messages','status','text'),('crm_messages','sent_by','uuid'),
  ('crm_pipeline_stages','id','uuid'),('crm_pipeline_stages','org_id','uuid'),('crm_pipeline_stages','position','integer'),
  ('crm_deals','id','uuid'),('crm_deals','org_id','uuid'),('crm_deals','patient_id','uuid'),('crm_deals','stage_id','uuid'),
  ('crm_outbound_requests','message_kind','text'),('crm_outbound_requests','template_payload','jsonb'),
  ('crm_outbound_cancellations','request_id','uuid'),('crm_outbound_cancellations','org_id','uuid'),
  ('crm_outbound_cancellations','conversation_id','uuid'),('crm_outbound_cancellations','cancelled_by','uuid'),
  ('crm_outbound_cancellations','created_at','timestamp with time zone'),
  ('crm_outbound_reconciliations','id','uuid'),('crm_outbound_reconciliations','request_id','uuid'),
  ('crm_outbound_reconciliations','org_id','uuid'),('crm_outbound_reconciliations','conversation_id','uuid'),
  ('crm_outbound_reconciliations','actor_id','uuid'),('crm_outbound_reconciliations','operation','text'),
  ('crm_outbound_reconciliations','evidence','text'),('crm_outbound_reconciliations','previous_state','text'),
  ('crm_outbound_reconciliations','resulting_state','text'),('crm_outbound_reconciliations','provider_message_id','text'),
  ('crm_outbound_reconciliations','message_id','uuid'),('crm_outbound_reconciliations','created_at','timestamp with time zone')
)
SELECT 'predecessor_columns' AS section, e.table_name||'.'||e.column_name AS check_id,
  CASE WHEN a.attname IS NULL THEN 'missing'
    WHEN format_type(a.atttypid,a.atttypmod)<>e.expected_type THEN 'review_type' ELSE 'present' END AS status,
  jsonb_build_object('expected_type',e.expected_type,'actual_type',format_type(a.atttypid,a.atttypmod),
    'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) AS details
FROM expected e
LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||e.table_name)
LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
ORDER BY check_id;

WITH expected(schema_name,function_name,argument_types) AS (VALUES
  ('auth','uid',''),('public','phone_canon','text')
)
SELECT 'predecessor_functions' AS section,
  e.schema_name||'.'||e.function_name||'('||e.argument_types||')' AS check_id,
  CASE WHEN p.oid IS NULL THEN 'missing' ELSE 'present' END AS status,
  jsonb_build_object('security_definer',p.prosecdef,'settings',p.proconfig) AS details
FROM expected e
LEFT JOIN pg_namespace n ON n.nspname=e.schema_name
LEFT JOIN pg_proc p ON p.pronamespace=n.oid AND p.proname=e.function_name
  AND oidvectortypes(p.proargtypes)=e.argument_types
ORDER BY check_id;

WITH expected(role_name) AS (VALUES ('anon'),('authenticated'),('service_role'))
SELECT 'roles' AS section,e.role_name AS check_id,
  CASE WHEN r.oid IS NULL THEN 'missing' ELSE 'review' END AS status,
  jsonb_build_object('superuser',r.rolsuper,'bypass_rls',r.rolbypassrls,'inherits',r.rolinherit,
    'member_of',COALESCE((SELECT jsonb_agg(parent.rolname ORDER BY parent.rolname)
      FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member=r.oid),'[]'::jsonb)) AS details
FROM expected e LEFT JOIN pg_roles r ON r.rolname=e.role_name ORDER BY check_id;

WITH expected(table_name) AS (VALUES ('organizations'),('org_members'),('channels'),('channel_secrets'),
  ('crm_patients'),('crm_messages'),('crm_pipeline_stages'),('crm_deals'),('crm_conversations'),('crm_pending_items'),('crm_outbound_requests'),('crm_outbound_cancellations'),('crm_outbound_reconciliations'))
SELECT 'rls' AS section,e.table_name||'.rls' AS check_id,
  CASE WHEN c.oid IS NULL THEN 'missing' WHEN c.relrowsecurity THEN 'enabled' ELSE 'disabled' END AS status,
  jsonb_build_object('forced',c.relforcerowsecurity,'owner',pg_get_userbyid(c.relowner),
    'table_kind',c.relkind,'replica_identity',c.relreplident) AS details
FROM expected e LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||e.table_name) ORDER BY check_id;

SELECT 'policies' AS section,tablename||'.'||policyname AS check_id,'review' AS status,
  jsonb_build_object('table',tablename,'policy',policyname,'roles',roles,'command',cmd,
    'permissive',permissive,'using',qual,'with_check',with_check) AS details
FROM pg_policies WHERE schemaname='public' AND tablename IN
  ('organizations','org_members','channels','channel_secrets','crm_patients','crm_messages',
   'crm_pipeline_stages','crm_deals','crm_conversations','crm_pending_items','crm_outbound_requests','crm_outbound_cancellations','crm_outbound_reconciliations') ORDER BY check_id;

WITH tables(table_name) AS (VALUES ('organizations'),('org_members'),('channels'),('channel_secrets'),
  ('crm_patients'),('crm_messages'),('crm_pipeline_stages'),('crm_deals'),('crm_conversations'),('crm_pending_items'),('crm_outbound_requests'),('crm_outbound_cancellations'),('crm_outbound_reconciliations')),
roles(role_name) AS (VALUES ('anon'),('authenticated'),('service_role'))
SELECT 'privileges' AS section,t.table_name||'.'||r.role_name AS check_id,
  CASE WHEN c.oid IS NULL OR pr.oid IS NULL THEN 'missing' ELSE 'review' END AS status,
  jsonb_build_object('select',has_table_privilege(pr.oid,c.oid,'SELECT'),
    'insert',has_table_privilege(pr.oid,c.oid,'INSERT'),'update',has_table_privilege(pr.oid,c.oid,'UPDATE'),
    'delete',has_table_privilege(pr.oid,c.oid,'DELETE'),'truncate',has_table_privilege(pr.oid,c.oid,'TRUNCATE'),
    'references',has_table_privilege(pr.oid,c.oid,'REFERENCES'),'trigger',has_table_privilege(pr.oid,c.oid,'TRIGGER')) AS details
FROM tables t CROSS JOIN roles r
LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||t.table_name)
LEFT JOIN pg_roles pr ON pr.rolname=r.role_name ORDER BY check_id;

-- Table SELECT can be false while sensitive column grants remain effective.
-- Include inherited table/column grants, not only explicit ACL entries.
SELECT 'column_privileges' AS section,c.relname||'.'||a.attname||'.'||r.rolname AS check_id,
  'review' AS status,jsonb_build_object('select',has_column_privilege(r.oid,c.oid,a.attnum,'SELECT'),
    'insert',has_column_privilege(r.oid,c.oid,a.attnum,'INSERT'),
    'update',has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE'),
    'references',has_column_privilege(r.oid,c.oid,a.attnum,'REFERENCES')) AS details
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN pg_roles r
WHERE n.nspname='public' AND r.rolname IN ('anon','authenticated','service_role') AND c.relname IN
  ('org_members','channels','channel_secrets','crm_patients','crm_messages','crm_conversations',
   'crm_pending_items','crm_outbound_requests','crm_outbound_cancellations','crm_outbound_reconciliations') ORDER BY check_id;

SELECT 'default_privileges' AS section,pg_get_userbyid(d.defaclrole)||'.'||d.defaclobjtype::text AS check_id,'review' AS status,
  jsonb_build_object('schema',COALESCE(n.nspname,'all schemas'),'acl',d.defaclacl::text) AS details
FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
WHERE n.nspname='public' OR d.defaclnamespace=0 ORDER BY check_id;

SELECT 'constraints' AS section,c.relname||'.'||k.conname AS check_id,
  CASE WHEN k.convalidated THEN 'validated' ELSE 'not_validated' END AS status,
  jsonb_build_object('definition',pg_get_constraintdef(k.oid),'type',k.contype) AS details
FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('org_members','channels','crm_patients','crm_messages',
  'crm_pipeline_stages','crm_deals','crm_conversations','crm_pending_items','crm_outbound_requests','crm_outbound_cancellations','crm_outbound_reconciliations') ORDER BY check_id;

SELECT 'indexes' AS section,i.relname AS check_id,
  CASE WHEN x.indisvalid AND x.indisready THEN 'valid' ELSE 'invalid' END AS status,
  jsonb_build_object('table',c.relname,'unique',x.indisunique,'primary',x.indisprimary,
    'definition',pg_get_indexdef(i.oid)) AS details
FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class c ON c.oid=x.indrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('org_members','channels','crm_patients','crm_messages',
  'crm_pipeline_stages','crm_deals','crm_conversations','crm_pending_items','crm_outbound_requests','crm_outbound_cancellations','crm_outbound_reconciliations') ORDER BY check_id;

SELECT 'function_privileges' AS section,p.proname||'('||oidvectortypes(p.proargtypes)||').' || r.rolname AS check_id,
  'review' AS status,jsonb_build_object('execute',has_function_privilege(r.oid,p.oid,'EXECUTE'),
    'security_definer',p.prosecdef,'owner',pg_get_userbyid(p.proowner),'settings',p.proconfig) AS details
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN pg_roles r
WHERE n.nspname='public' AND r.rolname IN ('anon','authenticated','service_role') AND p.proname IN
  ('crm_is_org_member','resolve_pending_item','ensure_whatsapp_patient','crm_guard_conversation_identity',
   'crm_guard_pending_item','crm_guard_pending_id','crm_link_message_conversation','crm_advance_conversation_activity',
   'claim_crm_outbound_request','complete_crm_outbound_request','finish_crm_outbound_request',
   'get_crm_outbound_request','crm_outbound_result','crm_guard_outbound_request',
   'reconcile_crm_outbound_request','crm_guard_outbound_history','get_crm_whatsapp_window')
ORDER BY check_id;

SELECT 'triggers' AS section,c.relname||'.'||t.tgname AS check_id,'review' AS status,
  jsonb_build_object('enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) AS details
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname='public' AND c.relname IN
  ('org_members','channels','crm_patients','crm_messages','crm_deals','crm_conversations','crm_pending_items','crm_outbound_requests','crm_outbound_cancellations','crm_outbound_reconciliations') ORDER BY check_id;

SELECT 'publication' AS section,'supabase_realtime' AS check_id,
  CASE WHEN p.oid IS NULL THEN 'missing' ELSE 'review' END AS status,
  jsonb_build_object('all_tables',p.puballtables,'insert',p.pubinsert,'update',p.pubupdate,
    'delete',p.pubdelete,'truncate',p.pubtruncate) AS details
FROM (VALUES ('supabase_realtime')) target(name) LEFT JOIN pg_publication p ON p.pubname=target.name;

WITH expected(table_name) AS (VALUES ('crm_conversations'),('crm_messages'),('crm_pending_items'))
SELECT 'realtime' AS section,e.table_name||'.realtime' AS check_id,
  CASE WHEN p.tablename IS NULL THEN 'not_member' ELSE 'member' END AS status,
  jsonb_build_object('columns',p.attnames,'row_filter',p.rowfilter) AS details
FROM expected e LEFT JOIN pg_publication_tables p
  ON p.pubname='supabase_realtime' AND p.schemaname='public' AND p.tablename=e.table_name ORDER BY check_id;

-- Dynamic SELECTs allow the audit to report every missing predecessor instead
-- of failing at the first absent table. Never emit row identifiers or content.
DO $audit$
DECLARE check_row record; column_ref text; missing boolean; issue_count bigint;
BEGIN
  FOR check_row IN SELECT * FROM (VALUES
    ('duplicate_org_memberships',ARRAY['org_members.org_id','org_members.user_id'],
      'SELECT count(*) FROM (SELECT org_id,user_id FROM public.org_members GROUP BY org_id,user_id HAVING count(*)>1) duplicates',false),
    ('members_missing_identity',ARRAY['org_members.org_id','org_members.user_id'],
      'SELECT count(*) FROM public.org_members WHERE org_id IS NULL OR user_id IS NULL',false),
    ('members_unknown_org',ARRAY['org_members.org_id','organizations.id'],
      'SELECT count(*) FROM public.org_members m LEFT JOIN public.organizations o ON o.id=m.org_id WHERE o.id IS NULL',false),
    ('patients_unknown_org',ARRAY['crm_patients.org_id','organizations.id'],
      'SELECT count(*) FROM public.crm_patients p LEFT JOIN public.organizations o ON o.id=p.org_id WHERE o.id IS NULL',false),
    ('channels_unknown_org',ARRAY['channels.org_id','organizations.id'],
      'SELECT count(*) FROM public.channels c LEFT JOIN public.organizations o ON o.id=c.org_id WHERE o.id IS NULL',false),
    ('messages_unknown_org',ARRAY['crm_messages.org_id','organizations.id'],
      'SELECT count(*) FROM public.crm_messages m LEFT JOIN public.organizations o ON o.id=m.org_id WHERE o.id IS NULL',false),
    ('messages_patient_outside_org',ARRAY['crm_messages.org_id','crm_messages.patient_id','crm_patients.org_id','crm_patients.id'],
      'SELECT count(*) FROM public.crm_messages m LEFT JOIN public.crm_patients p ON p.id=m.patient_id AND p.org_id=m.org_id WHERE m.patient_id IS NOT NULL AND p.id IS NULL',false),
    ('messages_channel_outside_org',ARRAY['crm_messages.org_id','crm_messages.channel_id','channels.org_id','channels.id'],
      'SELECT count(*) FROM public.crm_messages m LEFT JOIN public.channels c ON c.id=m.channel_id AND c.org_id=m.org_id WHERE m.channel_id IS NOT NULL AND c.id IS NULL',false),
    ('messages_with_channel_missing_patient',ARRAY['crm_messages.patient_id','crm_messages.channel_id'],
      'SELECT count(*) FROM public.crm_messages WHERE channel_id IS NOT NULL AND patient_id IS NULL',false),
    ('legacy_messages_without_channel',ARRAY['crm_messages.channel_id'],
      'SELECT count(*) FROM public.crm_messages WHERE channel_id IS NULL',true),
    ('duplicate_whatsapp_message_ids',ARRAY['crm_messages.whatsapp_message_id'],
      'SELECT count(*) FROM (SELECT whatsapp_message_id FROM public.crm_messages WHERE whatsapp_message_id IS NOT NULL GROUP BY whatsapp_message_id HAVING count(*)>1) duplicates',false),
    ('deals_patient_outside_org',ARRAY['crm_deals.org_id','crm_deals.patient_id','crm_patients.id','crm_patients.org_id'],
      'SELECT count(*) FROM public.crm_deals d LEFT JOIN public.crm_patients p ON p.id=d.patient_id AND p.org_id=d.org_id WHERE d.patient_id IS NOT NULL AND p.id IS NULL',false),
    ('deals_stage_outside_org',ARRAY['crm_deals.org_id','crm_deals.stage_id','crm_pipeline_stages.id','crm_pipeline_stages.org_id'],
      'SELECT count(*) FROM public.crm_deals d LEFT JOIN public.crm_pipeline_stages s ON s.id=d.stage_id AND s.org_id=d.org_id WHERE d.stage_id IS NOT NULL AND s.id IS NULL',false),
    ('conversations_patient_outside_org',ARRAY['crm_conversations.org_id','crm_conversations.patient_id','crm_patients.id','crm_patients.org_id'],
      'SELECT count(*) FROM public.crm_conversations c LEFT JOIN public.crm_patients p ON p.id=c.patient_id AND p.org_id=c.org_id WHERE p.id IS NULL',false),
    ('conversations_channel_outside_org',ARRAY['crm_conversations.org_id','crm_conversations.channel_id','channels.id','channels.org_id'],
      'SELECT count(*) FROM public.crm_conversations c LEFT JOIN public.channels h ON h.id=c.channel_id AND h.org_id=c.org_id WHERE h.id IS NULL',false),
    ('conversations_assignee_outside_org',ARRAY['crm_conversations.org_id','crm_conversations.assigned_to','org_members.org_id','org_members.user_id'],
      'SELECT count(*) FROM public.crm_conversations c WHERE c.assigned_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=c.org_id AND m.user_id=c.assigned_to)',false),
    ('messages_conversation_mismatch',ARRAY['crm_messages.org_id','crm_messages.patient_id','crm_messages.channel_id','crm_messages.conversation_id','crm_conversations.org_id','crm_conversations.patient_id','crm_conversations.channel_id','crm_conversations.id'],
      'SELECT count(*) FROM public.crm_messages m LEFT JOIN public.crm_conversations c ON c.id=m.conversation_id AND c.org_id=m.org_id AND c.patient_id=m.patient_id AND c.channel_id=m.channel_id WHERE m.conversation_id IS NOT NULL AND c.id IS NULL',false),
    ('pending_conversation_mismatch',ARRAY['crm_pending_items.org_id','crm_pending_items.patient_id','crm_pending_items.conversation_id','crm_conversations.org_id','crm_conversations.patient_id','crm_conversations.id'],
      'SELECT count(*) FROM public.crm_pending_items p LEFT JOIN public.crm_conversations c ON c.id=p.conversation_id AND c.org_id=p.org_id AND c.patient_id=p.patient_id WHERE c.id IS NULL',false),
    ('pending_assignee_outside_org',ARRAY['crm_pending_items.org_id','crm_pending_items.assigned_to','org_members.org_id','org_members.user_id'],
      'SELECT count(*) FROM public.crm_pending_items p WHERE NOT EXISTS (SELECT 1 FROM public.org_members m WHERE m.org_id=p.org_id AND m.user_id=p.assigned_to)',false),
    ('inbound_invalid_timestamp',ARRAY['crm_messages.direction','crm_messages.created_at'],
      'SELECT count(*) FROM public.crm_messages WHERE direction=''inbound'' AND (created_at IS NULL OR NOT isfinite(created_at) OR created_at>now())',false),
    ('whatsapp_channels_without_waba',ARRAY['channels.type','channels.waba_id'],
      'SELECT count(*) FROM public.channels WHERE type=''whatsapp_cloud'' AND nullif(btrim(waba_id),'''') IS NULL',true),
    ('channels_unclassified',ARRAY['channels.inbox_key'],
      'SELECT count(*) FROM public.channels WHERE inbox_key IS NULL',true)
  ) AS checks(check_id,required_columns,query_text,informational)
  LOOP
    missing := false;
    FOREACH column_ref IN ARRAY check_row.required_columns LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_attribute
        WHERE attrelid=to_regclass('public.'||split_part(column_ref,'.',1))
          AND attname=split_part(column_ref,'.',2) AND attnum>0 AND NOT attisdropped) THEN
        missing := true;
      END IF;
    END LOOP;
    IF missing THEN
      RAISE NOTICE 'CRM_PREFLIGHT %',jsonb_build_object('section','data_checks',
        'check_id',check_row.check_id,'status','skipped_missing_columns','count',NULL);
      CONTINUE;
    END IF;
    BEGIN
      EXECUTE check_row.query_text INTO issue_count;
      RAISE NOTICE 'CRM_PREFLIGHT %',jsonb_build_object('section','data_checks',
        'check_id',check_row.check_id,'status',CASE WHEN check_row.informational THEN 'info'
          WHEN issue_count>0 THEN 'issues' ELSE 'clear' END,'count',issue_count);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'CRM_PREFLIGHT %',jsonb_build_object('section','data_checks',
        'check_id',check_row.check_id,'status','blocked','count',NULL,'sqlstate',SQLSTATE);
    END;
  END LOOP;
END $audit$;

ROLLBACK;
