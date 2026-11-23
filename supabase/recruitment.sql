-- SecuroServ: reclutamiento configurable, postulaciones y fichas de personal.
alter table public.profiles add column if not exists character_id text;
create table if not exists public.recruitment_settings(
 id integer primary key check(id=1),
 title text not null default 'Quiero trabajar con ustedes',
 body text not null default 'En SecuroServ buscamos personas responsables, disciplinadas y comprometidas.',
 updated_by uuid references public.profiles(id) on delete set null,
 updated_at timestamptz not null default now()
);
insert into public.recruitment_settings(id) values(1) on conflict(id) do nothing;

create table if not exists public.recruitment_questions(
 id uuid primary key default gen_random_uuid(),
 question text not null check(length(trim(question)) between 5 and 1000),
 sort_order integer not null default 0,
 is_active boolean not null default true,
 created_by uuid references public.profiles(id) on delete set null,
 created_at timestamptz not null default now()
);
create table if not exists public.recruitment_applications(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null unique references public.profiles(id) on delete cascade,
 roleplay_email text not null,
 roleplay_phone text not null,
 age integer not null check(age between 1 and 99),
 iban text not null,
 character_photo_path text not null,
 answers jsonb not null default '{}'::jsonb,
 status text not null default 'pending' check(status in('pending','accepted','rejected')),
 reviewed_by uuid references public.profiles(id) on delete set null,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists recruitment_applications_status_created_idx on public.recruitment_applications(status,created_at desc);

alter table public.recruitment_settings enable row level security;
alter table public.recruitment_questions enable row level security;
alter table public.recruitment_applications enable row level security;

drop policy if exists "public recruitment settings read" on public.recruitment_settings;
create policy "public recruitment settings read" on public.recruitment_settings for select to anon,authenticated using(true);
drop policy if exists "managers edit recruitment settings" on public.recruitment_settings;
create policy "managers edit recruitment settings" on public.recruitment_settings for all to authenticated using(public.is_manager()) with check(public.is_manager());

drop policy if exists "public recruitment questions read" on public.recruitment_questions;
create policy "public recruitment questions read" on public.recruitment_questions for select to anon,authenticated using(is_active or public.is_manager());
drop policy if exists "managers manage recruitment questions" on public.recruitment_questions;
create policy "managers manage recruitment questions" on public.recruitment_questions for all to authenticated using(public.is_manager()) with check(public.is_manager());

drop policy if exists "applicant own application read" on public.recruitment_applications;
create policy "applicant own application read" on public.recruitment_applications for select to authenticated using(user_id=auth.uid() or public.is_manager());
drop policy if exists "applicant create own application" on public.recruitment_applications;
create policy "applicant create own application" on public.recruitment_applications for insert to authenticated with check(user_id=auth.uid() and status='pending');
drop policy if exists "applicant update own pending application" on public.recruitment_applications;
create policy "applicant update own pending application" on public.recruitment_applications for update to authenticated using(user_id=auth.uid() and status in('pending','rejected')) with check(user_id=auth.uid() and status='pending');
drop policy if exists "managers review applications" on public.recruitment_applications;
create policy "managers review applications" on public.recruitment_applications for update to authenticated using(public.is_manager()) with check(public.is_manager());

grant select on public.recruitment_settings,public.recruitment_questions to anon,authenticated;
grant insert,update,delete on public.recruitment_questions to authenticated;
grant select,insert,update on public.recruitment_applications to authenticated;
grant insert,update on public.recruitment_settings to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('staff-photos','staff-photos',true,8388608,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=true,file_size_limit=8388608,allowed_mime_types=array['image/jpeg','image/png','image/webp'];
drop policy if exists "applicant upload own staff photo" on storage.objects;
create policy "applicant upload own staff photo" on storage.objects for insert to authenticated
with check(bucket_id='staff-photos' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "applicant replace own staff photo" on storage.objects;
create policy "applicant replace own staff photo" on storage.objects for update to authenticated
using(bucket_id='staff-photos' and (storage.foldername(name))[1]=auth.uid()::text)
with check(bucket_id='staff-photos' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "staff photo public read" on storage.objects;
create policy "staff photo public read" on storage.objects for select to anon,authenticated using(bucket_id='staff-photos');

-- Personal operativo puede consultar las fichas del equipo para identificar a quien escribe en cada sala.
drop policy if exists "staff can view approved staff profiles" on public.profiles;
create policy "staff can view approved staff profiles" on public.profiles for select to authenticated
using(public.is_staff() and status='approved' and role in('agent','commander','admin','director'));

do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='recruitment_settings') then alter publication supabase_realtime add table public.recruitment_settings; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='recruitment_questions') then alter publication supabase_realtime add table public.recruitment_questions; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='recruitment_applications') then alter publication supabase_realtime add table public.recruitment_applications; end if;
end $$;

-- Preguntas iniciales editables (solo se insertan cuando el formulario está vacío).
insert into public.recruitment_questions(question,sort_order,created_by)
select v.question,v.sort_order,null
from (values
 ('¿Por qué quieres formar parte de SecuroServ?',1),
 ('¿Qué significa para ti la responsabilidad dentro de una corporación de seguridad?',2),
 ('¿Cómo actuarías ante un cliente molesto o una situación tensa?',3),
 ('¿Qué harías si un compañero incumple una instrucción durante un servicio?',4),
 ('¿Qué disponibilidad tienes para trabajar y participar en servicios?',5)
) as v(question,sort_order)
where not exists(select 1 from public.recruitment_questions);

-- Mantiene el ID del personaje en el perfil creado automáticamente al registrarse.
create or replace function public.create_profile_for_new_user()
returns trigger language plpgsql security definer set search_path=''
as $func$
begin
 insert into public.profiles(id,full_name,character_id,username,phone,role,status,rank)
 values(
  new.id,
  coalesce(new.raw_user_meta_data->>'full_name','Usuario'),
  nullif(new.raw_user_meta_data->>'character_id',''),
  coalesce(nullif(new.raw_user_meta_data->>'username',''), 'user_'||substr(new.id::text,1,8)),
  nullif(new.raw_user_meta_data->>'phone',''),
  'customer','approved','Cliente'
 )
 on conflict(id) do nothing;
 return new;
end $func$;
