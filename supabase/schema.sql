create extension if not exists pgcrypto;
create extension if not exists btree_gist;

create table if not exists public.profiles(
 id uuid primary key references auth.users(id) on delete cascade,
 full_name text not null, username text unique not null, phone text unique,
 contact_email text, age integer, discord text, discord_id text, iban text, photo_url text,
 rank text default 'Cliente',
 role text not null default 'customer',
 status text not null default 'approved',
 created_at timestamptz default now()
);
alter table public.profiles add column if not exists phone text;
alter table public.profiles add column if not exists contact_email text;
drop index if exists public.profiles_phone_unique_idx;
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check check(role in('agent','commander','admin','director','customer'));
alter table public.profiles drop constraint if exists profiles_status_check;
alter table public.profiles add constraint profiles_status_check check(status in('pending','approved','rejected','suspended'));

-- Cada cuenta nueva comienza como cliente. Dirección puede convertirla en agente y aprobarla.
create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path=''
as $func$
begin
 insert into public.profiles(id,full_name,username,phone,role,status,rank)
 values(
  new.id,
  coalesce(new.raw_user_meta_data->>'full_name','Usuario'),
  coalesce(nullif(new.raw_user_meta_data->>'username',''), 'user_'||substr(new.id::text,1,8)),
  nullif(new.raw_user_meta_data->>'phone',''),
  'customer','approved','Cliente'
 )
 on conflict(id) do nothing;
 return new;
end $func$;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute function public.create_profile_for_new_user();

create table if not exists public.appointments(
 id uuid primary key default gen_random_uuid(),
 customer_name text not null, customer_email text not null,
 date date not null, start_time time not null, end_time time not null,
 details text, status text not null default 'pending' check(status in ('pending','confirmed','rejected','completed','cancelled')),
 assigned_agents uuid[] default '{}', created_at timestamptz default now(),
 check(end_time>start_time)
);
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

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path=''
as $$ select exists(select 1 from public.profiles where id=auth.uid() and status='approved' and role in('agent','commander','admin','director')) $$;
create or replace function public.is_manager() returns boolean language sql stable security definer set search_path=''
as $$ select exists(select 1 from public.profiles where id=auth.uid() and status='approved' and role in('director','admin','commander')) $$;

-- Impide que una persona cambie su propio rol o aprobación desde el formulario de perfil.
create or replace function public.protect_profile_permissions()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if auth.uid()=old.id and not public.is_manager() then
  new.role:=old.role;
  new.status:=old.status;
  new.rank:=old.rank;
  new.iban:=case when old.role='agent' then new.iban else old.iban end;
 end if;
 return new;
end $$;
drop trigger if exists protect_profile_permissions_trigger on public.profiles;
create trigger protect_profile_permissions_trigger before update on public.profiles
for each row execute function public.protect_profile_permissions();

-- Agenda pública sin datos personales.
create or replace function public.sync_availability_slot() returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if TG_OP='DELETE' then delete from public.availability_slots where appointment_id=OLD.id; return OLD; end if;
 if NEW.status in ('pending','confirmed') then
  insert into public.availability_slots(appointment_id,date,start_time,end_time)
  values(NEW.id,NEW.date,NEW.start_time,NEW.end_time)
  on conflict(appointment_id) do update set date=excluded.date,start_time=excluded.start_time,end_time=excluded.end_time;
 else delete from public.availability_slots where appointment_id=NEW.id; end if;
 return NEW;
end $$;
drop trigger if exists appointments_sync_availability on public.appointments;
create trigger appointments_sync_availability after insert or update or delete on public.appointments
for each row execute function public.sync_availability_slot();

do $$ begin
 if not exists(select 1 from pg_constraint where conname='appointments_no_time_overlap') then
  alter table public.appointments add constraint appointments_no_time_overlap
  exclude using gist (tsrange(date + start_time,date + end_time,'[)') with &&)
  where (status in ('pending','confirmed'));
 end if;
end $$;

-- Servicios persistentes con estados e historial de cada transición.
create table if not exists public.services(
 id uuid primary key default gen_random_uuid(),
 name text not null,
 club text,
 description text,
 status text not null default 'scheduled' check(status in('scheduled','active','paused','completed')),
 created_by uuid not null references public.profiles(id),
 started_at timestamptz,
 paused_at timestamptz,
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists public.service_events(
 id uuid primary key default gen_random_uuid(),
 service_id uuid not null references public.services(id) on delete cascade,
 event_type text not null check(event_type in('created','started','paused','resumed','completed')),
 actor_id uuid references public.profiles(id) on delete set null,
 note text,
 created_at timestamptz not null default now()
);
create table if not exists public.service_messages(
 id uuid primary key default gen_random_uuid(),
 service_id uuid not null references public.services(id) on delete cascade,
 sender_id uuid references public.profiles(id) on delete set null,
 sender_name text not null default 'Personal SecuroServ',
 body text not null default '',
 media_path text,
 created_at timestamptz not null default now(),
 check(length(body)<=5000),
 check(body<>'' or media_path is not null)
);
create index if not exists service_messages_service_created_idx on public.service_messages(service_id,created_at);
create index if not exists service_events_service_created_idx on public.service_events(service_id,created_at);

create or replace function public.stamp_service_changes()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if new.status is distinct from old.status then
  if new.status='active' and new.started_at is null then new.started_at:=now(); end if;
  if new.status='paused' then new.paused_at:=now(); end if;
  if new.status='completed' then new.completed_at:=now(); end if;
 end if;
 new.updated_at:=now();
 return new;
end $$;
create or replace function public.audit_service_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $func$
begin
 if TG_OP = 'INSERT' then
  insert into public.service_events(service_id,event_type,actor_id)
  values(new.id,'created',auth.uid());
 elsif new.status is distinct from old.status then
  if new.status = 'active' then
   if old.status = 'paused' then
    insert into public.service_events(service_id,event_type,actor_id)
    values(new.id,'resumed',auth.uid());
   else
    insert into public.service_events(service_id,event_type,actor_id)
    values(new.id,'started',auth.uid());
   end if;
  elsif new.status = 'paused' then
   insert into public.service_events(service_id,event_type,actor_id)
   values(new.id,'paused',auth.uid());
  elsif new.status = 'completed' then
   insert into public.service_events(service_id,event_type,actor_id)
   values(new.id,'completed',auth.uid());
  end if;
 end if;
 return new;
end;
$func$;
drop trigger if exists services_audit_trigger on public.services;
drop trigger if exists services_stamp_trigger on public.services;
create trigger services_stamp_trigger before update on public.services
for each row execute function public.stamp_service_changes();
create trigger services_audit_trigger after insert or update on public.services
for each row execute function public.audit_service_changes();

create or replace function public.set_service_message_sender()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 new.sender_id:=auth.uid();
 select coalesce(full_name,'Personal SecuroServ') into new.sender_name from public.profiles where id=auth.uid();
 if new.sender_name is null then new.sender_name:='Personal SecuroServ'; end if;
 return new;
end $$;
drop trigger if exists service_message_sender_trigger on public.service_messages;
create trigger service_message_sender_trigger before insert on public.service_messages
for each row execute function public.set_service_message_sender();

create table if not exists public.business_tags(
 id uuid primary key default gen_random_uuid(),
 name text not null unique,
 created_by uuid references public.profiles(id) on delete set null,
 created_at timestamptz default now()
);
create table if not exists public.profile_business_tags(
 profile_id uuid not null references public.profiles(id) on delete cascade,
 tag_id uuid not null references public.business_tags(id) on delete cascade,
 assigned_by uuid references public.profiles(id) on delete set null,
 created_at timestamptz default now(),
 primary key(profile_id,tag_id)
);

alter table public.profiles enable row level security;
alter table public.appointments enable row level security;
alter table public.availability_slots enable row level security;
alter table public.chat_messages enable row level security;
alter table public.shifts enable row level security;
alter table public.customers enable row level security;
alter table public.reviews enable row level security;
alter table public.complaints enable row level security;
alter table public.services enable row level security;
alter table public.service_events enable row level security;
alter table public.service_messages enable row level security;
alter table public.business_tags enable row level security;
alter table public.profile_business_tags enable row level security;

drop policy if exists "profile self or manager read" on public.profiles;
drop policy if exists "profile own or manager select" on public.profiles;
create policy "profile own or manager select" on public.profiles for select using(id=auth.uid() or public.is_manager());
drop policy if exists "self register pending" on public.profiles;
drop policy if exists "manager profile update" on public.profiles;
drop policy if exists "profile own update" on public.profiles;
create policy "profile own update" on public.profiles for update using(id=auth.uid()) with check(id=auth.uid());
create policy "manager profile update" on public.profiles for update using(public.is_manager()) with check(public.is_manager());

drop policy if exists "public availability only appointments" on public.appointments;
drop policy if exists "public booking request" on public.appointments;
drop policy if exists "manager appointments" on public.appointments;
drop policy if exists "staff read appointments" on public.appointments;
create policy "staff read appointments" on public.appointments for select using(public.is_staff());
create policy "public booking request" on public.appointments for insert with check(status='pending');
create policy "manager appointments" on public.appointments for all using(public.is_manager()) with check(public.is_manager());
drop policy if exists "public read availability slots" on public.availability_slots;
create policy "public read availability slots" on public.availability_slots for select using(true);

drop policy if exists "public chat insert" on public.chat_messages;
drop policy if exists "staff chat read" on public.chat_messages;
create policy "public chat insert" on public.chat_messages for insert with check(true);
create policy "staff chat read" on public.chat_messages for select using(public.is_staff());

drop policy if exists "own shifts read" on public.shifts;
drop policy if exists "agent clock in" on public.shifts;
drop policy if exists "agent clock out" on public.shifts;
create policy "own shifts read" on public.shifts for select using(agent_id=auth.uid() or public.is_manager());
create policy "agent clock in" on public.shifts for insert with check(agent_id=auth.uid() and public.is_staff());
create policy "agent clock out" on public.shifts for update using(agent_id=auth.uid() or public.is_manager());
drop policy if exists "staff customers" on public.customers;
create policy "staff customers" on public.customers for all using(public.is_staff()) with check(public.is_staff());
drop policy if exists "public review insert" on public.reviews;
drop policy if exists "staff review read" on public.reviews;
create policy "public review insert" on public.reviews for insert with check(true);
create policy "staff review read" on public.reviews for select using(public.is_staff());
drop policy if exists "staff complaints" on public.complaints;
create policy "staff complaints" on public.complaints for all using(public.is_staff()) with check(public.is_staff());

drop policy if exists "staff read services" on public.services;
drop policy if exists "manager manage services" on public.services;
create policy "staff read services" on public.services for select using(public.is_staff());
create policy "manager manage services" on public.services for all using(public.is_manager()) with check(public.is_manager());
drop policy if exists "staff read service events" on public.service_events;
create policy "staff read service events" on public.service_events for select using(public.is_staff());
drop policy if exists "staff read service messages" on public.service_messages;
drop policy if exists "staff send service messages" on public.service_messages;
create policy "staff read service messages" on public.service_messages for select using(public.is_staff());
create policy "staff send service messages" on public.service_messages for insert with check(public.is_staff() and exists(select 1 from public.services s where s.id=service_id and s.status<>'completed'));
drop policy if exists "manager manage business tags" on public.business_tags;
drop policy if exists "staff read own business tags" on public.business_tags;
create policy "manager manage business tags" on public.business_tags for all using(public.is_manager()) with check(public.is_manager());
create policy "staff read own business tags" on public.business_tags for select using(exists(select 1 from public.profile_business_tags pbt where pbt.tag_id=id and pbt.profile_id=auth.uid()));
drop policy if exists "manager manage profile tags" on public.profile_business_tags;
drop policy if exists "staff read own profile tags" on public.profile_business_tags;
create policy "manager manage profile tags" on public.profile_business_tags for all using(public.is_manager()) with check(public.is_manager());
create policy "staff read own profile tags" on public.profile_business_tags for select using(profile_id=auth.uid());

-- Storage privado: solo personal aprobado puede subir/ver imágenes del chat.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('service-chat','service-chat',false,8388608,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set public=false,file_size_limit=8388608,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];
drop policy if exists "staff service chat image read" on storage.objects;
drop policy if exists "staff service chat image upload" on storage.objects;
create policy "staff service chat image read" on storage.objects for select using(bucket_id='service-chat' and public.is_staff());
create policy "staff service chat image upload" on storage.objects for insert with check(bucket_id='service-chat' and public.is_staff());

-- Realtime para que mensajes e historial aparezcan en vivo.
do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='service_messages') then alter publication supabase_realtime add table public.service_messages; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='service_events') then alter publication supabase_realtime add table public.service_events; end if;
end $$;

drop view if exists public.public_dashboard_stats;
create or replace function public.get_public_dashboard_stats()
returns table(agents_available integer, services_total integer)
language sql stable security definer set search_path=''
as $$
 select
  (select count(*)::integer from public.profiles where status='approved' and role='agent'),
  (select count(*)::integer from public.services where status in('scheduled','active','paused'));
$$;
revoke all on function public.get_public_dashboard_stats() from public;
grant execute on function public.get_public_dashboard_stats() to anon, authenticated;

grant select,update on public.profiles to authenticated;
grant select,insert,update,delete on public.appointments to authenticated;
grant insert on public.appointments to anon;
grant select on public.availability_slots to anon,authenticated;
grant select,insert,update,delete on public.services,public.service_messages,public.business_tags,public.profile_business_tags to authenticated;
grant select on public.service_events to authenticated;
grant select,insert,update,delete on public.shifts,public.customers,public.reviews,public.complaints,public.chat_messages to authenticated;
grant insert on public.chat_messages to anon;


-- Primera cuenta: después de registrarte, convierte tu perfil en director desde el SQL Editor.
-- update public.profiles set role='director',status='approved',rank='Dirección' where phone='+507...';
