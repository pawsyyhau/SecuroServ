-- Solicitudes de servicio y salas con acceso por asignación
alter table public.appointments add column if not exists customer_user_id uuid references public.profiles(id) on delete set null;
alter table public.appointments add column if not exists service_id uuid references public.services(id) on delete set null;
create index if not exists appointments_service_id_idx on public.appointments(service_id);
drop policy if exists "customer own appointments read" on public.appointments;
create policy "customer own appointments read" on public.appointments for select to authenticated using (customer_user_id=auth.uid() or public.is_manager());
drop policy if exists "assigned staff read services" on public.services;
create policy "assigned staff read services" on public.services for select to authenticated using (
 public.is_manager()
 or exists(select 1 from public.service_assignments a where a.service_id=services.id and a.agent_id=auth.uid())
 or (status in ('scheduled','active','paused') and exists(select 1 from public.profiles p where p.id=auth.uid() and p.status='approved' and p.role in ('agent','commander')))
);
drop policy if exists "agent join service room" on public.service_assignments;
create policy "agent join service room" on public.service_assignments for insert to authenticated with check (
 agent_id=auth.uid()
 and exists(select 1 from public.profiles p where p.id=auth.uid() and p.status='approved' and p.role in ('agent','commander'))
 and exists(select 1 from public.services s where s.id=service_id and s.status in ('scheduled','active','paused'))
);
drop policy if exists "staff read service messages" on public.service_messages;
drop policy if exists "staff send service messages" on public.service_messages;
create policy "participants read service messages" on public.service_messages for select to authenticated using (
 public.is_manager() or exists(select 1 from public.service_assignments a where a.service_id=service_messages.service_id and a.agent_id=auth.uid())
);
create policy "participants send service messages" on public.service_messages for insert to authenticated with check (
 (public.is_manager() or exists(select 1 from public.service_assignments a where a.service_id=service_messages.service_id and a.agent_id=auth.uid()))
 and exists(select 1 from public.services s where s.id=service_id and s.status<>'completed')
);
grant select,insert,update on public.appointments to authenticated;
grant select,insert on public.service_assignments to authenticated;
grant select,insert on public.service_messages to authenticated;
do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='appointments') then alter publication supabase_realtime add table public.appointments; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='service_assignments') then alter publication supabase_realtime add table public.service_assignments; end if;
end $$;

-- El historial y los archivos adjuntos también respetan la privacidad de cada sala.
drop policy if exists "staff read service events" on public.service_events;
drop policy if exists "participants read service events" on public.service_events;
create policy "participants read service events" on public.service_events for select to authenticated
using (public.is_manager() or exists(select 1 from public.service_assignments a where a.service_id=service_events.service_id and a.agent_id=auth.uid()));

drop policy if exists "staff service chat image read" on storage.objects;
drop policy if exists "staff service chat image upload" on storage.objects;
drop policy if exists "participants service chat image read" on storage.objects;
drop policy if exists "participants service chat image upload" on storage.objects;
create policy "participants service chat image read" on storage.objects for select to authenticated
using (bucket_id='service-chat' and (
 public.is_manager() or exists(select 1 from public.service_assignments a where a.service_id=(storage.foldername(name))[1]::uuid and a.agent_id=auth.uid())
));
create policy "participants service chat image upload" on storage.objects for insert to authenticated
with check (bucket_id='service-chat' and (
 public.is_manager() or exists(select 1 from public.service_assignments a where a.service_id=(storage.foldername(name))[1]::uuid and a.agent_id=auth.uid())
));
