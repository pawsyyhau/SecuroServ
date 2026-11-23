-- SecuroServ: tarifas salariales por rango y pagos semanales.
create table if not exists public.rank_pay_rates(
 id uuid primary key default gen_random_uuid(),
 rank text not null unique,
 hourly_rate numeric(14,2) not null default 0 check(hourly_rate>=0),
 is_active boolean not null default true,
 updated_by uuid references public.profiles(id) on delete set null,
 updated_at timestamptz not null default now()
);
create table if not exists public.weekly_payments(
 id uuid primary key default gen_random_uuid(),
 agent_id uuid not null references public.profiles(id) on delete cascade,
 period_start date not null,
 period_end date not null,
 total_hours numeric(12,4) not null check(total_hours>=0),
 hourly_rate numeric(14,2) not null check(hourly_rate>=0),
 amount numeric(14,2) not null check(amount>=0),
 status text not null default 'pending' check(status in('pending','paid')),
 paid_at timestamptz,
 paid_by uuid references public.profiles(id) on delete set null,
 created_at timestamptz not null default now(),
 check(period_end>=period_start),
 unique(agent_id,period_start,period_end)
);
alter table public.rank_pay_rates enable row level security;
alter table public.weekly_payments enable row level security;
drop policy if exists "staff read pay rates" on public.rank_pay_rates;
create policy "staff read pay rates" on public.rank_pay_rates for select to authenticated using(true);
drop policy if exists "managers manage pay rates" on public.rank_pay_rates;
create policy "managers manage pay rates" on public.rank_pay_rates for all to authenticated using(public.is_manager()) with check(public.is_manager());
drop policy if exists "agents read own weekly payments" on public.weekly_payments;
create policy "agents read own weekly payments" on public.weekly_payments for select to authenticated using(agent_id=auth.uid() or public.is_manager());
drop policy if exists "managers manage weekly payments" on public.weekly_payments;
create policy "managers manage weekly payments" on public.weekly_payments for all to authenticated using(public.is_manager()) with check(public.is_manager());
grant select,insert,update,delete on public.rank_pay_rates to authenticated;
grant select,insert,update on public.weekly_payments to authenticated;
do $$ begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rank_pay_rates') then alter publication supabase_realtime add table public.rank_pay_rates; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='weekly_payments') then alter publication supabase_realtime add table public.weekly_payments; end if;
end $$;
