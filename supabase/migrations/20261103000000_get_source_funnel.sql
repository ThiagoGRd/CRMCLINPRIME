-- Funil por origem (coorte): leads criados no período e o que cada um virou depois,
-- cruzando por phone_canon com agenda e orçamentos do Clinicorp.
CREATE OR REPLACE FUNCTION public.get_source_funnel(p_org uuid, p_from date, p_to date)
 RETURNS json
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE v json;
BEGIN
  IF NOT is_org_member(p_org) THEN RAISE EXCEPTION 'sem acesso'; END IF;
  WITH leads AS (
    SELECT coalesce(nullif(initcap(trim(p.source)),''),'Sem origem') src, phone_canon(p.phone) pc, p.created_at::date d0
    FROM crm_patients p
    WHERE p.org_id = p_org AND p.created_at >= p_from AND p.created_at < p_to
  ), att AS (
    SELECT phone_canon(phone) pc, appt_date, status FROM crm_attendances WHERE org_id = p_org
  ), est AS (
    SELECT phone_canon, est_date, status, amount FROM crm_estimates WHERE org_id = p_org
  ), x AS (
    SELECT l.src,
      EXISTS(SELECT 1 FROM att a WHERE a.pc = l.pc AND a.appt_date >= l.d0) agend,
      EXISTS(SELECT 1 FROM att a WHERE a.pc = l.pc AND a.appt_date >= l.d0 AND a.status = 'compareceu') comp,
      EXISTS(SELECT 1 FROM est e WHERE e.phone_canon = l.pc AND e.est_date >= l.d0) orc,
      (SELECT coalesce(sum(amount),0) FROM est e WHERE e.phone_canon = l.pc AND e.est_date >= l.d0 AND e.status = 'APPROVED') rec
    FROM leads l
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

GRANT EXECUTE ON FUNCTION public.get_source_funnel(uuid, date, date) TO authenticated;
