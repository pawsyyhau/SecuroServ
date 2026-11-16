create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create table if not exists public.profiles(
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null, username text unique not null, age integer,
 discord text, discord_id text, iban text, photo_url text,
 rank text default 'Aprendiz',
 role text not null default 'agent' check(role in('agent','commander','admin','director')),
 status text not null default 'pending' check(status in('pending','approved','rejected','suspended')),
 created_at timestamptz default now()
);
create table if not exists public.appointments(
 id uuid primary key default gen_random_uuid(),
 customer_name text not null, customer_email text not null,
 date date not null, start_time time not null, end_time time not null,
 details text, status text not null default 'pending' check(status in('pending','confirmed','rejected','completed','cancelled')),
 assigned_agents uuid[] default '{}', created_at timestamptz default now(),
 check(end_time>start_time)
);
-- Tabla pública separada: solo contiene fechas y horas, nunca datos personales.
create table if not exists public.availability_slots(
 id uuid primary key default gen_random_uuid(),
 appointment_id uuid unique references public.appointments(id) on delete cascade,
 date date not null, start_time time not null, end_time time not null,
 check(end_time>start_time)
);
create table if not exists public.chat_messages(
 id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete set null,
 guest_name text, body text not null, created_at timestamptz default now()
);
create table if not exists public.shifts(
 id uuid primary key default gen_random_uuid(), agent_id uuid not null references public.profiles(id),
 clock_in timestamptz not null default now(), clock_out timestamptz, created_at timestamptz default now()
);
create table if not exists public.customers(
 id uuid primary key default gen_random_uuid(), full_name text not null, photo_url text,
 discord text, discord_id text, notes text, created_at timestamptz default now()
);
create table if not exists public.reviews(
 id uuid primary key default gen_random_uuid(), customer_id uuid references public.customers(id) on delete set null,
 appointment_id uuid references public.appointments(id) on delete set null,
 agent_id uuid references public.profiles(id) on delete set null,
 rating integer not null check(rating between 1 and 5), comment text, created_at timestamptz default now()
);
create table if not exists public.complaints(
 id uuid primary key default gen_random_uuid(), customer_id uuid references public.customers(id) on delete set null,
 appointment_id uuid references public.appointments(id) on delete set null,
 agent_id uuid references public.profiles(id) on delete set null, description text not null,
 status text not null default 'pending' check(status in('pending','reviewing','resolved')), created_at timestamptz default now()
);

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.profiles where id=auth.uid() and status='approved') $$;
create or replace function public.is_manager() returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.profiles where id=auth.uid() and status='approved' and role in('director','admin','commander')) $$;

-- Mantiene el calendario público sincronizado sin publicar datos del cliente.
create or replace function public.sync_availability_slot() returns trigger language plpgsql security definer set search_path=public
as $$
begin
 if TG_OP='DELETE' then
  delete from public.availability_slots where appointment_id=OLD.id;
  return OLD;
 end if;
 if NEW.status in ('pending','confirmed') then
  insert into public.availability_slots(appointment_id,date,start_time,end_time)
  values(NEW.id,NEW.date,NEW.start_time,NEW.end_time)
  on conflict(appointment_id) do update set date=excluded.date,start_time=excluded.start_time,end_time=excluded.end_time;
 else
  delete from public.availability_slots where appointment_id=NEW.id;
 end if;
 return NEW;
end $$;
drop trigger if exists appointments_sync_availability on public.appointments;
create trigger appointments_sync_availability after insert or update or delete on public.appointments
for each row execute function public.sync_availability_slot();

-- Evita que dos solicitudes pendientes/confirmadas reserven el mismo horario.
do $$ begin
 if not exists(select 1 from pg_constraint where conname='appointments_no_time_overlap') then
  alter table public.appointments add constraint appointments_no_time_overlap
  exclude using gist (tsrange(date + start_time,date + end_time,'[)') with &&)
  where (status in ('pending','confirmed'));
 end if;
end $$;

alter table public.profiles enable row level security;
alter table public.appointments enable row level security;
alter table public.availability_slots enable row level security;
alter table public.chat_messages enable row level security;
alter table public.shifts enable row level security;
alter table public.customers enable row level security;
alter table public.reviews enable row level security;
alter table public.complaints enable row level security;

drop policy if exists "profile self or manager read" on public.profiles;
create policy "profile self or manager read" on public.profiles for select using(id=auth.uid() or public.is_manager());
drop policy if exists "self register pending" on public.profiles;
create policy "self register pending" on public.profiles for insert with check(id=auth.uid() and role='agent' and status='pending');
drop policy if exists "manager profile update" on public.profiles;
create policy "manager profile update" on public.profiles for update using(public.is_manager()) with check(public.is_manager());

-- Los visitantes NO pueden leer appointments: solo leen esta tabla pública con fecha/hora.
drop policy if exists "public availability only appointments" on public.appointments;
drop policy if exists "public booking request" on public.appointments;
drop policy if exists "manager appointments" on public.appointments;
create policy "staff read appointments" on public.appointments for select using(public.is_staff());
create policy "public booking request" on public.appointments for insert with check(status='pending');
create policy "manager appointments" on public.appointments for all using(public.is_manager()) with check(public.is_manager());
create policy "public read availability slots" on public.availability_slots for select using(true);

drop policy if exists "public chat insert" on public.chat_messages;
drop policy if exists "staff chat read" on public.chat_messages;
create policy "public chat insert" on public.chat_messages for insert with check(true);
create policy "staff chat read" on public.chat_messages for select using(public.is_staff());

create policy "own shifts read" on public.shifts for select using(agent_id=auth.uid() or public.is_manager());
create policy "agent clock in" on public.shifts for insert with check(agent_id=auth.uid() and public.is_staff());
create policy "agent clock out" on public.shifts for update using(agent_id=auth.uid() or public.is_manager());
create policy "staff customers" on public.customers for all using(public.is_staff()) with check(public.is_staff());
create policy "public review insert" on public.reviews for insert with check(true);
create policy "staff review read" on public.reviews for select using(public.is_staff());
create policy "staff complaints" on public.complaints for all using(public.is_staff()) with check(public.is_staff());

-- Activa Realtime en chat_messages desde el panel de Supabase.
-- Para producción: limita el spam público y valida quién puede dejar reseñas/quejas.

-- Vista pública de solo agregados: no expone perfiles ni datos de reservas.
create or replace view public.public_dashboard_stats as
select
 (select count(*) from public.profiles where status='approved' and role='agent')::integer as agents_available,
 (select count(*) from public.appointments where status='confirmed')::integer as services_total;
grant select on public.public_dashboard_stats to anon, authenticated;
