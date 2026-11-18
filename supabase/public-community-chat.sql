-- Chat público comunitario: lectura y participación para visitantes y cuentas autenticadas.
alter table public.chat_messages add column if not exists sender_role text;
alter table public.chat_messages add column if not exists expires_at timestamptz;
alter table public.chat_messages add column if not exists user_id uuid references auth.users(id) on delete set null;

update public.chat_messages set expires_at = created_at + interval '1 hour' where expires_at is null;
delete from public.chat_messages where expires_at <= now();

create or replace function public.set_public_chat_identity()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_role text;
begin
 new.user_id := auth.uid();
 new.expires_at := now() + interval '1 hour';
 if auth.uid() is null then
   new.sender_role := 'visitante';
 else
   select p.role into v_role from public.profiles p where p.id=auth.uid();
   new.sender_role := coalesce(v_role,'customer');
 end if;
 new.guest_name := null;
 return new;
end;
$$;
drop trigger if exists set_public_chat_identity_trigger on public.chat_messages;
create trigger set_public_chat_identity_trigger before insert on public.chat_messages
for each row execute function public.set_public_chat_identity();

alter table public.chat_messages enable row level security;
drop policy if exists "public chat insert" on public.chat_messages;
drop policy if exists "staff chat read" on public.chat_messages;
drop policy if exists "public chat read all" on public.chat_messages;
drop policy if exists "public chat insert all" on public.chat_messages;
create policy "public chat read all" on public.chat_messages for select to anon,authenticated using (true);
create policy "public chat insert all" on public.chat_messages for insert to anon,authenticated with check (length(trim(body)) between 1 and 1500);
grant select,insert on public.chat_messages to anon,authenticated;

do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='chat_messages') then
  alter publication supabase_realtime add table public.chat_messages;
 end if;
end $$;

-- Índice para que la limpieza por vencimiento sea rápida.
create index if not exists chat_messages_expires_at_idx on public.chat_messages(expires_at);
