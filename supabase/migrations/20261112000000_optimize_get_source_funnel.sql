CREATE INDEX IF NOT EXISTS idx_crm_estimates_org_phone_canon ON public.crm_estimates (org_id, phone_canon);
CREATE INDEX IF NOT EXISTS idx_crm_attendances_org_appt_date ON public.crm_attendances (org_id, appt_date);

CREATE OR REPLACE FUNCTION public.get_source_funnel(p_org uuid, p_from date, p_to date)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v json;
BEGIN
  IF NOT is_org_member(p_org) THEN RAISE EXCEPTION 'sem acesso'; END IF;
  WITH leads AS MATERIALIZED (
    SELECT coalesce(nullif(initcap(trim(p.source)),''),'Sem origem') src,
           phone_canon(p.phone) pc,
           p.created_at::date d0
    FROM crm_patients p
    WHERE p.org_id = p_org AND p.created_at >= p_from AND p.created_at < p_to
  ), att_agg AS MATERIALIZED (
    SELECT phone_canon(phone) pc,
           max(appt_date) AS max_appt_date,
           max(appt_date) FILTER (WHERE status = 'compareceu') AS max_comp_date
    FROM crm_attendances
    WHERE org_id = p_org AND phone IS NOT NULL AND phone <> ''
    GROUP BY phone_canon(phone)
  ), est_agg AS MATERIALIZED (
    SELECT phone_canon AS pc,
           max(est_date) AS max_est_date
    FROM crm_estimates
    WHERE org_id = p_org AND phone_canon IS NOT NULL
    GROUP BY phone_canon
  ), est_app AS MATERIALIZED (
    SELECT phone_canon AS pc, est_date, amount
    FROM crm_estimates
    WHERE org_id = p_org AND phone_canon IS NOT NULL AND status = 'APPROVED'
  ), x AS (
    SELECT l.src,
      (a.max_appt_date IS NOT NULL AND a.max_appt_date >= l.d0) AS agend,
      (a.max_comp_date IS NOT NULL AND a.max_comp_date >= l.d0) AS comp,
      (ea.max_est_date IS NOT NULL AND ea.max_est_date >= l.d0) AS orc,
      CASE WHEN l.pc IS NOT NULL THEN
        coalesce((SELECT sum(e.amount) FROM est_app e WHERE e.pc = l.pc AND e.est_date >= l.d0), 0)
      ELSE 0 END AS rec
    FROM leads l
    LEFT JOIN att_agg a ON a.pc = l.pc AND l.pc IS NOT NULL
    LEFT JOIN est_agg ea ON ea.pc = l.pc AND l.pc IS NOT NULL
  )
  SELECT coalesce(json_agg(r ORDER BY r.leads DESC), '[]'::json) INTO v FROM (
    SELECT src AS source, count(*) leads,
      count(*) FILTER (WHERE agend) agendados,
      count(*) FILTER (WHERE comp) compareceram,
      count(*) FILTER (WHERE orc) orcamentos,
      count(*) FILTER (WHERE rec > 0) aprovados,
      sum(rec) receita
    FROM x GROUP BY src
  ) r;
  RETURN v;
END; $function$;
