-- SecuroServ: nombre editable y cambio de usuario limitado a una vez cada 30 días.
alter table public.profiles
 add column if not exists username_changed_at timestamptz;

create or replace function public.guard_profile_username_change()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
 if new.username is distinct from old.username then
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role' then
   raise exception 'El nombre de usuario solo puede cambiarse desde el proceso seguro de perfil.';
  end if;
  if old.username_changed_at is not null and now() < old.username_changed_at + interval '30 days' then
   raise exception 'Solo puedes cambiar tu nombre de usuario una vez cada 30 días.';
  end if;
  new.username_changed_at := now();
 end if;
 return new;
end;
$$;

drop trigger if exists guard_profile_username_change_trigger on public.profiles;
create trigger guard_profile_username_change_trigger
before update of username on public.profiles
for each row execute function public.guard_profile_username_change();

notify pgrst, 'reload schema';
