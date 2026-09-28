-- Local migration only. Review and apply once before deploying /assistant/billing.
begin;
create table if not exists public.service_billing (
  id text primary key check (id in ('kimi','openai','railway','supabase','vercel','resend')),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 8192),
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);
create table if not exists public.service_billing_history (
  id bigint generated always as identity primary key,
  service_id text not null references public.service_billing(id),
  previous_data jsonb not null,
  previous_version integer not null,
  changed_at timestamptz not null default now()
);
alter table public.service_billing enable row level security;
alter table public.service_billing_history enable row level security;
revoke all on public.service_billing, public.service_billing_history from public, anon, authenticated;
revoke all on sequence public.service_billing_history_id_seq from public, anon, authenticated;
grant select, update on public.service_billing to service_role;
grant select, insert on public.service_billing_history to service_role;
grant usage, select on sequence public.service_billing_history_id_seq to service_role;
create or replace function public.audit_service_billing() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.service_billing_history(service_id, previous_data, previous_version)
    values(old.id, old.data, old.version);
  return new;
end;
$$;
revoke all on function public.audit_service_billing() from public, anon, authenticated;
grant execute on function public.audit_service_billing() to service_role;
drop trigger if exists audit_service_billing on public.service_billing;
create trigger audit_service_billing before update on public.service_billing
for each row execute function public.audit_service_billing();
insert into public.service_billing(id) values ('kimi'),('openai'),('railway'),('supabase'),('vercel'),('resend') on conflict do nothing;
commit;
