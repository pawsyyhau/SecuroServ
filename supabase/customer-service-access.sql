-- Acceso privado de clientes a las salas de los servicios que solicitaron y fueron aceptados.
-- No permite consultar servicios ni conversaciones de otros clientes.

drop policy if exists "assigned staff read services" on public.services;
drop policy if exists "customer own service read" on public.services;
create policy "customer own service read" on public.services
for select to authenticated
using (
  public.is_manager()
  or exists (
    select 1 from public.appointments a
    where a.service_id = services.id
      and a.customer_user_id = auth.uid()
      and a.status in ('confirmed','completed')
  )
  or exists (
    select 1 from public.service_assignments sa
    where sa.service_id = services.id and sa.agent_id = auth.uid()
  )
  or (
    status in ('scheduled','active','paused')
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.status = 'approved'
        and p.role in ('agent','commander')
    )
  )
);

drop policy if exists "participants read service messages" on public.service_messages;
create policy "participants read service messages" on public.service_messages
for select to authenticated
using (
  public.is_manager()
  or exists (
    select 1 from public.service_assignments sa
    where sa.service_id = service_messages.service_id and sa.agent_id = auth.uid()
  )
  or exists (
    select 1 from public.appointments a
    where a.service_id = service_messages.service_id
      and a.customer_user_id = auth.uid()
      and a.status in ('confirmed','completed')
  )
);

drop policy if exists "participants send service messages" on public.service_messages;
create policy "participants send service messages" on public.service_messages
for insert to authenticated
with check (
  exists (
    select 1 from public.services s
    where s.id = service_messages.service_id and s.status <> 'completed'
  )
  and (
    public.is_manager()
    or exists (
      select 1 from public.service_assignments sa
      where sa.service_id = service_messages.service_id and sa.agent_id = auth.uid()
    )
    or exists (
      select 1 from public.appointments a
      where a.service_id = service_messages.service_id
        and a.customer_user_id = auth.uid()
        and a.status = 'confirmed'
    )
  )
);

drop policy if exists "participants read service events" on public.service_events;
create policy "participants read service events" on public.service_events
for select to authenticated
using (
  public.is_manager()
  or exists (
    select 1 from public.service_assignments sa
    where sa.service_id = service_events.service_id and sa.agent_id = auth.uid()
  )
  or exists (
    select 1 from public.appointments a
    where a.service_id = service_events.service_id
      and a.customer_user_id = auth.uid()
      and a.status in ('confirmed','completed')
  )
);

grant select on public.services to authenticated;
grant select, insert on public.service_messages to authenticated;
grant select on public.service_events to authenticated;
grant select on public.appointments to authenticated;

-- Permite al cliente adjuntar y consultar imágenes solo dentro de su propia sala.
drop policy if exists "participants service chat image read" on storage.objects;
drop policy if exists "participants service chat image upload" on storage.objects;
create policy "participants service chat image read" on storage.objects
for select to authenticated
using (
  bucket_id = 'service-chat'
  and (
    public.is_manager()
    or exists (
      select 1 from public.service_assignments sa
      where sa.service_id = (storage.foldername(name))[1]::uuid
        and sa.agent_id = auth.uid()
    )
    or exists (
      select 1 from public.appointments a
      where a.service_id = (storage.foldername(name))[1]::uuid
        and a.customer_user_id = auth.uid()
        and a.status in ('confirmed','completed')
    )
  )
);

create policy "participants service chat image upload" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'service-chat'
  and (
    public.is_manager()
    or exists (
      select 1 from public.service_assignments sa
      where sa.service_id = (storage.foldername(name))[1]::uuid
        and sa.agent_id = auth.uid()
    )
    or exists (
      select 1 from public.appointments a
      where a.service_id = (storage.foldername(name))[1]::uuid
        and a.customer_user_id = auth.uid()
        and a.status = 'confirmed'
    )
  )
);

notify pgrst, 'reload schema';
