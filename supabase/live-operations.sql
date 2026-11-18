-- Actualización en vivo del panel público y auditoría de fichajes de servicios.
-- La disponibilidad pública cuenta únicamente agentes con un turno abierto.
create or replace function public.get_public_dashboard_stats()
returns table(agents_available integer, services_total integer)
language sql stable security definer set search_path=''
as $$
 select
  (select count(distinct sh.agent_id)::integer
   from public.shifts sh
   join public.profiles p on p.id=sh.agent_id
   where sh.clock_out is null and p.status='approved' and p.role='agent'),
  (select count(*)::integer from public.services where status in('scheduled','active','paused'));
$$;
revoke all on function public.get_public_dashboard_stats() from public;
grant execute on function public.get_public_dashboard_stats() to anon, authenticated;

-- Publica los cambios de fichajes para actualizar el panel sin recargar toda la página.
do $$
declare t text;
begin
 foreach t in array array['shifts','services','service_time_entries','service_assignments','service_time_corrections'] loop
  if to_regclass('public.'||t) is not null
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
   execute format('alter publication supabase_realtime add table public.%I',t);
  end if;
 end loop;
end $$;
notify pgrst, 'reload schema';
