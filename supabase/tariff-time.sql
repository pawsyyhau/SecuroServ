-- SecuroServ: tarifario, asignaciones y registro de tiempo por servicio.
create table if not exists public.service_tariffs (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 description text,
 billing_mode text not null check (billing_mode in ('hourly','per_agent','hourly_per_agent')),
 hourly_rate numeric(12,2) not null default 0 check (hourly_rate >= 0),
 per_agent_rate numeric(12,2) not null default 0 check (per_agent_rate >= 0),
 is_active boolean not null default true,
 created_by uuid references public.profiles(id) on delete set null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check ((billing_mode='hourly' and hourly_rate>0) or (billing_mode='per_agent' and per_agent_rate>0) or (billing_mode='hourly_per_agent' and hourly_rate>0 and per_agent_rate>0))
);

alter table public.services add column if not exists tariff_id uuid references public.service_tariffs(id) on delete set null;
alter table public.services add column if not exists tariff_name_snapshot text;
alter table public.services add column if not exists billing_mode_snapshot text;
alter table public.services add column if not exists hourly_rate_snapshot numeric(12,2);
alter table public.services add column if not exists per_agent_rate_snapshot numeric(12,2);

create table if not exists public.service_assignments (
 id uuid primary key default gen_random_uuid(),
 service_id uuid not null references public.services(id) on delete cascade,
 agent_id uuid not null references public.profiles(id) on delete cascade,
 assigned_by uuid references public.profiles(id) on delete set null,
 assigned_at timestamptz not null default now(),
 unique(service_id,agent_id)
);

create table if not exists public.service_time_entries (
 id uuid primary key default gen_random_uuid(),
 service_id uuid not null references public.services(id) on delete cascade,
 agent_id uuid not null references public.profiles(id) on delete cascade,
 started_at timestamptz not null default now(),
 ended_at timestamptz,
 created_at timestamptz not null default now(),
 check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists one_open_service_timer_per_agent
 on public.service_time_entries(agent_id) where ended_at is null;
create index if not exists service_time_entries_service_idx
 on public.service_time_entries(service_id,started_at desc);
create index if not exists service_assignments_agent_idx
 on public.service_assignments(agent_id,service_id);

create or replace function public.snapshot_service_tariff()
returns trigger language plpgsql security definer set search_path=''
as $$
declare t public.service_tariffs%rowtype;
begin
 if new.tariff_id is null then
  if tg_op='INSERT' or new.tariff_id is distinct from old.tariff_id then
   new.tariff_name_snapshot:=null; new.billing_mode_snapshot:=null;
   new.hourly_rate_snapshot:=null; new.per_agent_rate_snapshot:=null;
  end if;
 elsif tg_op='INSERT' or new.tariff_id is distinct from old.tariff_id then
  select * into t from public.service_tariffs where id=new.tariff_id;
  if not found then raise exception 'La tarifa seleccionada no existe.'; end if;
  if not t.is_active then raise exception 'La tarifa seleccionada está desactivada.'; end if;
  new.tariff_name_snapshot:=t.name;
  new.billing_mode_snapshot:=t.billing_mode;
  new.hourly_rate_snapshot:=t.hourly_rate;
  new.per_agent_rate_snapshot:=t.per_agent_rate;
 end if;
 return new;
end $$;
drop trigger if exists services_snapshot_tariff_trigger on public.services;
create trigger services_snapshot_tariff_trigger before insert or update of tariff_id on public.services
for each row execute function public.snapshot_service_tariff();

create or replace function public.validate_service_time_entry()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if tg_op='INSERT' then
  if new.agent_id <> auth.uid() then raise exception 'Solo puedes fichar tu propio tiempo.'; end if;
  if not exists(select 1 from public.service_assignments a where a.service_id=new.service_id and a.agent_id=new.agent_id) then
   raise exception 'No estás asignado a este servicio.';
  end if;
  if not exists(select 1 from public.shifts sh where sh.agent_id=new.agent_id and sh.clock_out is null) then
   raise exception 'Debes iniciar tu turno antes de iniciar un servicio.';
  end if;
  if not exists(select 1 from public.services s where s.id=new.service_id and s.status='active') then
   raise exception 'El servicio debe estar activo para registrar tiempo.';
  end if;
 elsif tg_op='UPDATE' then
  if old.agent_id <> auth.uid() and not public.is_manager() then raise exception 'No puedes modificar este registro.'; end if;
  if old.ended_at is not null then raise exception 'Este registro ya fue cerrado.'; end if;
  if new.service_id<>old.service_id or new.agent_id<>old.agent_id or new.started_at<>old.started_at then
   raise exception 'No puedes cambiar los datos originales del fichaje.';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists service_time_entry_validate_trigger on public.service_time_entries;
create trigger service_time_entry_validate_trigger before insert or update on public.service_time_entries
for each row execute function public.validate_service_time_entry();

alter table public.service_tariffs enable row level security;
alter table public.service_assignments enable row level security;
alter table public.service_time_entries enable row level security;

drop policy if exists "staff read active tariffs" on public.service_tariffs;
drop policy if exists "managers manage tariffs" on public.service_tariffs;
create policy "staff read active tariffs" on public.service_tariffs for select to authenticated using (is_active or public.is_manager());
create policy "managers manage tariffs" on public.service_tariffs for all to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff read service assignments" on public.service_assignments;
drop policy if exists "managers manage service assignments" on public.service_assignments;
create policy "staff read service assignments" on public.service_assignments for select to authenticated using (agent_id=auth.uid() or public.is_manager());
create policy "managers manage service assignments" on public.service_assignments for all to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists "agents and managers read service time" on public.service_time_entries;
drop policy if exists "agents start own service timer" on public.service_time_entries;
drop policy if exists "agents stop own service timer" on public.service_time_entries;
create policy "agents and managers read service time" on public.service_time_entries for select to authenticated using (agent_id=auth.uid() or public.is_manager());
create policy "agents start own service timer" on public.service_time_entries for insert to authenticated with check (agent_id=auth.uid() and public.is_staff());
create policy "agents stop own service timer" on public.service_time_entries for update to authenticated using (agent_id=auth.uid() or public.is_manager()) with check (agent_id=auth.uid() or public.is_manager());

grant select,insert,update,delete on public.service_tariffs,public.service_assignments,public.service_time_entries to authenticated;
grant select,update on public.services to authenticated;

-- Al pausar/finalizar un servicio se cierran automáticamente los contadores abiertos.
create or replace function public.close_service_timers_on_status_change()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if new.status is distinct from old.status and new.status in ('paused','completed') then
  update public.service_time_entries
  set ended_at=now()
  where service_id=new.id and ended_at is null;
 end if;
 return new;
end $$;
drop trigger if exists close_service_timers_on_status_change_trigger on public.services;
create trigger close_service_timers_on_status_change_trigger
after update of status on public.services
for each row execute function public.close_service_timers_on_status_change();

-- Si Dirección corrige/cierra un turno, el contador abierto también queda cerrado.
create or replace function public.close_service_timer_on_shift_end()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if old.clock_out is null and new.clock_out is not null then
  update public.service_time_entries
  set ended_at=new.clock_out
  where agent_id=new.agent_id and ended_at is null;
 end if;
 return new;
end $$;
drop trigger if exists close_service_timer_on_shift_end_trigger on public.shifts;
create trigger close_service_timer_on_shift_end_trigger
after update of clock_out on public.shifts
for each row execute function public.close_service_timer_on_shift_end();

-- Un turno abierto por agente y total de facturación congelado al finalizar.
create unique index if not exists one_open_shift_per_agent
 on public.shifts(agent_id) where clock_out is null;
alter table public.services add column if not exists billing_total_snapshot numeric(12,2);
alter table public.services add column if not exists billing_calculated_at timestamptz;

-- Solo se pueden asignar miembros aprobados del personal operativo.
create or replace function public.validate_service_assignment()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if not exists(select 1 from public.profiles p where p.id=new.agent_id and p.status='approved' and p.role in ('agent','commander')) then
  raise exception 'Solo puedes asignar agentes o comandantes aprobados.';
 end if;
 return new;
end $$;
drop trigger if exists service_assignment_validate_trigger on public.service_assignments;
create trigger service_assignment_validate_trigger
before insert or update of agent_id on public.service_assignments
for each row execute function public.validate_service_assignment();

-- Las salas operativas solo son visibles para Dirección/mandos o personal asignado.
drop policy if exists "staff read services" on public.services;
drop policy if exists "assigned staff read services" on public.services;
create policy "assigned staff read services" on public.services for select to authenticated
using (public.is_manager() or exists(
 select 1 from public.service_assignments a
 where a.service_id=public.services.id and a.agent_id=auth.uid()
));

drop policy if exists "staff read service events" on public.service_events;
drop policy if exists "assigned staff read service events" on public.service_events;
create policy "assigned staff read service events" on public.service_events for select to authenticated
using (public.is_manager() or exists(
 select 1 from public.service_assignments a
 where a.service_id=public.service_events.service_id and a.agent_id=auth.uid()
));

drop policy if exists "staff read service messages" on public.service_messages;
drop policy if exists "staff send service messages" on public.service_messages;
drop policy if exists "assigned staff read service messages" on public.service_messages;
drop policy if exists "assigned staff send service messages" on public.service_messages;
create policy "assigned staff read service messages" on public.service_messages for select to authenticated
using (public.is_manager() or exists(
 select 1 from public.service_assignments a
 where a.service_id=public.service_messages.service_id and a.agent_id=auth.uid()
));
create policy "assigned staff send service messages" on public.service_messages for insert to authenticated
with check (
 (public.is_manager() or exists(
  select 1 from public.service_assignments a
  where a.service_id=public.service_messages.service_id and a.agent_id=auth.uid()
 ))
 and exists(select 1 from public.services s where s.id=service_id and s.status<>'completed')
);

-- Los adjuntos del chat siguen las mismas reglas de acceso que su sala.
drop policy if exists "staff service chat image read" on storage.objects;
drop policy if exists "staff service chat image upload" on storage.objects;
create policy "assigned service chat image read" on storage.objects for select
using (bucket_id='service-chat' and (
 public.is_manager() or exists(
  select 1 from public.service_assignments a
  where a.service_id=(storage.foldername(name))[1]::uuid and a.agent_id=auth.uid()
 )
));
create policy "assigned service chat image upload" on storage.objects for insert
with check (bucket_id='service-chat' and (
 public.is_manager() or exists(
  select 1 from public.service_assignments a
  where a.service_id=(storage.foldername(name))[1]::uuid and a.agent_id=auth.uid()
 )
));


-- Historial de asignaciones: conservar las salidas y permitir reincorporaciones.
alter table public.service_assignments
 add column if not exists removed_at timestamptz,
 add column if not exists removed_by uuid references public.profiles(id) on delete set null;

alter table public.service_assignments
 drop constraint if exists service_assignments_service_id_agent_id_key;
drop index if exists public.service_assignments_service_id_agent_id_key;
create unique index if not exists service_assignments_one_active_agent
 on public.service_assignments(service_id,agent_id) where removed_at is null;
create index if not exists service_assignments_service_active_idx
 on public.service_assignments(service_id,removed_at);

create or replace function public.close_service_timer_on_assignment_removal()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if old.removed_at is null and new.removed_at is not null then
  update public.service_time_entries set ended_at=new.removed_at
  where service_id=new.service_id and agent_id=new.agent_id and ended_at is null;
 end if;
 return new;
end $$;
drop trigger if exists close_service_timer_on_assignment_removal_trigger on public.service_assignments;
create trigger close_service_timer_on_assignment_removal_trigger
after update of removed_at on public.service_assignments
for each row execute function public.close_service_timer_on_assignment_removal();

create or replace function public.validate_service_time_entry()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if tg_op='INSERT' then
  if new.agent_id <> auth.uid() then raise exception 'Solo puedes fichar tu propio tiempo.'; end if;
  if not exists(select 1 from public.service_assignments a where a.service_id=new.service_id and a.agent_id=new.agent_id and a.removed_at is null) then
   raise exception 'No estás asignado actualmente a este servicio.';
  end if;
  if not exists(select 1 from public.shifts sh where sh.agent_id=new.agent_id and sh.clock_out is null) then
   raise exception 'Debes iniciar tu turno antes de iniciar un servicio.';
  end if;
  if not exists(select 1 from public.services s where s.id=new.service_id and s.status='active') then
   raise exception 'El servicio debe estar activo para registrar tiempo.';
  end if;
 elsif tg_op='UPDATE' then
  if old.agent_id <> auth.uid() and not public.is_manager() then raise exception 'No puedes modificar este registro.'; end if;
  if old.ended_at is not null then raise exception 'Este registro ya fue cerrado.'; end if;
  if new.service_id<>old.service_id or new.agent_id<>old.agent_id or new.started_at<>old.started_at then
   raise exception 'No puedes cambiar los datos originales del fichaje.';
  end if;
 end if;
 return new;
end $$;

-- Las personas retiradas conservan el historial, pero pierden acceso a la sala.
drop policy if exists "assigned staff read service events" on public.service_events;
drop policy if exists "participants read service events" on public.service_events;
create policy "assigned staff read service events" on public.service_events for select to authenticated
using (public.is_manager() or exists(
 select 1 from public.service_assignments a where a.service_id=service_events.service_id
 and a.agent_id=auth.uid() and a.removed_at is null
) or exists(
 select 1 from public.appointments ap where ap.service_id=service_events.service_id
 and ap.customer_user_id=auth.uid() and ap.status in ('confirmed','completed')
));

drop policy if exists "assigned staff read service messages" on public.service_messages;
drop policy if exists "participants read service messages" on public.service_messages;
create policy "participants read service messages" on public.service_messages for select to authenticated
using (public.is_manager() or exists(
 select 1 from public.service_assignments a where a.service_id=service_messages.service_id
 and a.agent_id=auth.uid() and a.removed_at is null
) or exists(
 select 1 from public.appointments ap where ap.service_id=service_messages.service_id
 and ap.customer_user_id=auth.uid() and ap.status in ('confirmed','completed')
));

drop policy if exists "assigned staff send service messages" on public.service_messages;
drop policy if exists "participants send service messages" on public.service_messages;
create policy "participants send service messages" on public.service_messages for insert to authenticated
with check (
 exists(select 1 from public.services s where s.id=service_messages.service_id and s.status<>'completed')
 and (public.is_manager() or exists(
  select 1 from public.service_assignments a where a.service_id=service_messages.service_id
  and a.agent_id=auth.uid() and a.removed_at is null
 ) or exists(
  select 1 from public.appointments ap where ap.service_id=service_messages.service_id
  and ap.customer_user_id=auth.uid() and ap.status='confirmed'
 ))
);
