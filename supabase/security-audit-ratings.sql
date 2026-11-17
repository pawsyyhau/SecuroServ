-- SecuroServ: auditoría de correcciones de tiempo y reseñas verificadas.
-- Ejecutar DESPUÉS de schema.sql y tariff-time.sql.

-- Vincula una reserva a la cuenta que la envió autenticada. Las reservas de invitados
-- siguen permitidas, pero no pueden publicar reseñas verificadas.
alter table public.appointments
 add column if not exists customer_user_id uuid references public.profiles(id) on delete set null;

drop policy if exists "public booking request" on public.appointments;
create policy "public booking request" on public.appointments
 for insert to anon, authenticated
 with check (
  status='pending'
  and (customer_user_id is null or customer_user_id=auth.uid())
 );

-- Historial inmutable de correcciones administrativas de fichajes.
create table if not exists public.service_time_corrections (
 id uuid primary key default gen_random_uuid(),
 time_entry_id uuid not null references public.service_time_entries(id) on delete restrict,
 service_id uuid not null references public.services(id) on delete restrict,
 agent_id uuid not null references public.profiles(id) on delete restrict,
 corrected_by uuid not null references public.profiles(id) on delete restrict,
 old_started_at timestamptz not null,
 old_ended_at timestamptz,
 new_started_at timestamptz not null,
 new_ended_at timestamptz,
 reason text not null check(length(trim(reason)) between 5 and 1000),
 corrected_at timestamptz not null default now()
);
create index if not exists service_time_corrections_entry_idx
 on public.service_time_corrections(time_entry_id, corrected_at desc);
alter table public.service_time_corrections enable row level security;
drop policy if exists "managers read time corrections" on public.service_time_corrections;
create policy "managers read time corrections" on public.service_time_corrections
 for select to authenticated using(public.is_manager());
grant select on public.service_time_corrections to authenticated;

-- Los agentes solo pueden detener su propio contador abierto. Dirección puede corregir
-- fechas únicamente mediante la función RPC, que exige un motivo y deja auditoría.
create or replace function public.validate_service_time_entry()
returns trigger language plpgsql security definer set search_path=''
as $$
declare
 v_reason text;
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
  if old.service_id is distinct from new.service_id or old.agent_id is distinct from new.agent_id then
   raise exception 'No puedes cambiar el servicio ni el agente de un fichaje.';
  end if;
  if public.is_manager() then
   v_reason := current_setting('securoserv.correction_reason', true);
   if v_reason is null or length(trim(v_reason)) < 5 then
    -- Cierre operativo automático/manual permitido solo si no altera el inicio
    -- y únicamente transforma un contador abierto en uno cerrado.
    if new.started_at is distinct from old.started_at
       or old.ended_at is not null
       or new.ended_at is null
       or new.ended_at < old.started_at then
     raise exception 'Las correcciones administrativas requieren un motivo mediante el formulario de Dirección.';
    end if;
   end if;
  else
   if old.agent_id <> auth.uid() then raise exception 'No puedes modificar este registro.'; end if;
   if old.ended_at is not null then raise exception 'Este registro ya fue cerrado.'; end if;
   if new.started_at is distinct from old.started_at then
    raise exception 'No puedes cambiar la hora original de inicio.';
   end if;
   if new.ended_at is null or new.ended_at < old.started_at then
    raise exception 'La hora de cierre no es válida.';
   end if;
  end if;
 end if;
 return new;
end $$;

create or replace function public.log_service_time_correction()
returns trigger language plpgsql security definer set search_path=''
as $$
declare
 v_reason text;
begin
 if new.started_at is distinct from old.started_at or new.ended_at is distinct from old.ended_at then
  v_reason := current_setting('securoserv.correction_reason', true);
  if public.is_manager() and v_reason is not null and length(trim(v_reason)) >= 5 then
   insert into public.service_time_corrections(
    time_entry_id,service_id,agent_id,corrected_by,
    old_started_at,old_ended_at,new_started_at,new_ended_at,reason
   ) values (
    new.id,new.service_id,new.agent_id,auth.uid(),
    old.started_at,old.ended_at,new.started_at,new.ended_at,trim(v_reason)
   );
  end if;
 end if;
 return new;
end $$;
drop trigger if exists service_time_correction_audit_trigger on public.service_time_entries;
create trigger service_time_correction_audit_trigger
 after update on public.service_time_entries
 for each row execute function public.log_service_time_correction();

create or replace function public.correct_service_time_entry(
 p_entry_id uuid,
 p_started_at timestamptz,
 p_ended_at timestamptz,
 p_reason text
) returns boolean
language plpgsql
security definer
set search_path=''
as $$
begin
 if not public.is_manager() then raise exception 'Solo Dirección puede corregir fichajes.'; end if;
 if p_entry_id is null or p_started_at is null or p_ended_at is null or p_ended_at < p_started_at then
  raise exception 'Indica un intervalo de tiempo válido.';
 end if;
 if p_reason is null or length(trim(p_reason)) < 5 or length(trim(p_reason)) > 1000 then
  raise exception 'Explica el motivo de la corrección (mínimo 5 caracteres).';
 end if;
 perform set_config('securoserv.correction_reason',trim(p_reason),true);
 update public.service_time_entries
 set started_at=p_started_at,ended_at=p_ended_at
 where id=p_entry_id;
 if not found then raise exception 'No se encontró el registro de tiempo.'; end if;
 return true;
end $$;
revoke all on function public.correct_service_time_entry(uuid,timestamptz,timestamptz,text) from public,anon;
grant execute on function public.correct_service_time_entry(uuid,timestamptz,timestamptz,text) to authenticated;

-- Una reseña solo puede enviarla la cuenta vinculada a una reserva completada,
-- y únicamente sobre un agente asignado a esa reserva. Una fila con agent_id NULL
-- representa la valoración general de la experiencia.
create unique index if not exists reviews_one_agent_rating
 on public.reviews(appointment_id,agent_id) where agent_id is not null;
create unique index if not exists reviews_one_overall_rating
 on public.reviews(appointment_id) where agent_id is null;

drop policy if exists "public review insert" on public.reviews;
drop policy if exists "customer verified review insert" on public.reviews;
drop policy if exists "customer own reviews read" on public.reviews;
drop policy if exists "staff review read" on public.reviews;
drop policy if exists "manager manage reviews" on public.reviews;
create policy "customer verified review insert" on public.reviews
 for insert to authenticated
 with check (
  exists (
   select 1 from public.appointments a
   where a.id=appointment_id
    and a.customer_user_id=auth.uid()
    and a.status='completed'
    and (agent_id is null or agent_id=any(a.assigned_agents))
  )
 );
create policy "customer own reviews read" on public.reviews
 for select to authenticated
 using (
  exists(select 1 from public.appointments a
   where a.id=appointment_id and a.customer_user_id=auth.uid())
  or public.is_manager()
 );
create policy "manager manage reviews" on public.reviews
 for all to authenticated using(public.is_manager()) with check(public.is_manager());
grant select,insert on public.reviews to authenticated;

notify pgrst, 'reload schema';
