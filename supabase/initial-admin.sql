-- SecuroServ: registro protegido del primer Director.
-- Ejecutar una sola vez en Supabase SQL Editor antes de habilitar registros.

create table if not exists public.securoserv_bootstrap (
  id smallint primary key default 1 check (id = 1),
  admin_claimed boolean not null default false,
  admin_user_id uuid references auth.users(id) on delete set null,
  claimed_at timestamptz
);

insert into public.securoserv_bootstrap (id, admin_claimed)
values (1, false)
on conflict (id) do nothing;

alter table public.securoserv_bootstrap enable row level security;
revoke all on public.securoserv_bootstrap from public, anon, authenticated;
grant select, update on public.securoserv_bootstrap to service_role;

create or replace function public.claim_securoserv_initial_admin(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized';
  end if;

  select admin_claimed
    into v_claimed
    from public.securoserv_bootstrap
    where id = 1
    for update;

  if not found then
    raise exception 'Bootstrap row is missing';
  end if;

  if v_claimed then
    return false;
  end if;

  update public.profiles
     set role = 'director',
         status = 'approved',
         rank = 'Dirección'
   where id = p_user_id;

  if not found then
    raise exception 'Profile for the new account was not created';
  end if;

  update public.securoserv_bootstrap
     set admin_claimed = true,
         admin_user_id = p_user_id,
         claimed_at = now()
   where id = 1;

  return true;
end;
$$;

revoke all on function public.claim_securoserv_initial_admin(uuid) from public, anon, authenticated;
grant execute on function public.claim_securoserv_initial_admin(uuid) to service_role;
