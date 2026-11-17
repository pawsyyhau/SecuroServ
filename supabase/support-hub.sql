-- SecuroServ: chat individual en tiempo real y expedientes
-- Ejecutar una sola vez en Supabase > SQL Editor.

alter table public.appointments
  add column if not exists customer_user_id uuid references public.profiles(id) on delete set null;

alter table public.reviews
  add column if not exists customer_user_id uuid references public.profiles(id) on delete set null;

create index if not exists appointments_customer_user_created_idx
  on public.appointments(customer_user_id, created_at desc);
create index if not exists reviews_customer_user_created_idx
  on public.reviews(customer_user_id, created_at desc);

create table if not exists public.support_conversations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null unique references public.profiles(id) on delete cascade,
  owner_role text not null check (owner_role in ('customer','agent')),
  owner_name text not null,
  subject text not null default 'Atención SecuroServ',
  status text not null default 'open' check (status in ('open','closed')),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists support_conversations_last_message_idx
  on public.support_conversations(last_message_at desc);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.support_conversations(id) on delete cascade,
  sender_id uuid references public.profiles(id) on delete set null,
  sender_name text not null,
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists support_messages_conversation_created_idx
  on public.support_messages(conversation_id, created_at);

alter table public.support_conversations enable row level security;
alter table public.support_messages enable row level security;

drop policy if exists "support conversation owner or manager read" on public.support_conversations;
create policy "support conversation owner or manager read"
on public.support_conversations for select to authenticated
using (owner_user_id = auth.uid() or public.is_manager());

drop policy if exists "support conversation owner create" on public.support_conversations;
create policy "support conversation owner create"
on public.support_conversations for insert to authenticated
with check (
  owner_user_id = auth.uid()
  and owner_role = (select role from public.profiles where id = auth.uid())
  and owner_role in ('customer','agent')
);

drop policy if exists "support manager update" on public.support_conversations;
create policy "support manager update"
on public.support_conversations for update to authenticated
using (public.is_manager()) with check (public.is_manager());

drop policy if exists "support message conversation read" on public.support_messages;
create policy "support message conversation read"
on public.support_messages for select to authenticated
using (
  exists (
    select 1 from public.support_conversations c
    where c.id = conversation_id
      and (c.owner_user_id = auth.uid() or public.is_manager())
  )
);

drop policy if exists "support message owner or manager insert" on public.support_messages;
create policy "support message owner or manager insert"
on public.support_messages for insert to authenticated
with check (
  sender_id = auth.uid()
  and exists (
    select 1 from public.support_conversations c
    where c.id = conversation_id
      and (c.owner_user_id = auth.uid() or public.is_manager())
      and c.status = 'open'
  )
);

create or replace function public.set_support_message_sender()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  new.sender_id := auth.uid();
  select coalesce(full_name, 'Personal SecuroServ')
    into new.sender_name
    from public.profiles where id = auth.uid();
  if new.sender_name is null then new.sender_name := 'Personal SecuroServ'; end if;
  return new;
end $$;
drop trigger if exists support_message_sender_trigger on public.support_messages;
create trigger support_message_sender_trigger
before insert on public.support_messages
for each row execute function public.set_support_message_sender();

create or replace function public.touch_support_conversation()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  update public.support_conversations
  set last_message_at = new.created_at
  where id = new.conversation_id;
  return new;
end $$;
drop trigger if exists support_message_touch_conversation on public.support_messages;
create trigger support_message_touch_conversation
after insert on public.support_messages
for each row execute function public.touch_support_conversation();

drop policy if exists "public booking request" on public.appointments;
create policy "public booking request"
on public.appointments for insert
with check (status = 'pending' and (customer_user_id is null or customer_user_id = auth.uid()));

drop policy if exists "customer own appointments read" on public.appointments;
create policy "customer own appointments read"
on public.appointments for select to authenticated
using (customer_user_id = auth.uid() or public.is_manager());

drop policy if exists "customer own reviews read" on public.reviews;
create policy "customer own reviews read"
on public.reviews for select to authenticated
using (customer_user_id = auth.uid() or public.is_manager());

grant select, insert on public.support_conversations to authenticated;
grant update on public.support_conversations to authenticated;
grant select, insert on public.support_messages to authenticated;
grant select on public.appointments, public.reviews to authenticated;

do $$
begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='support_conversations') then
    alter publication supabase_realtime add table public.support_conversations;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='support_messages') then
    alter publication supabase_realtime add table public.support_messages;
  end if;
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='profiles') then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;

-- Fotos de perfiles: se recomienda usar photo_url con URL pública ya existente.
-- El chat funciona con texto; las fotos de conversación no se habilitan en esta primera migración.
