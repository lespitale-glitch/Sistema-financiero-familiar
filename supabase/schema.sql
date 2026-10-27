-- ============================================================================
-- Finanzas Familiares - esquema para Supabase / PostgreSQL
-- Ejecutar en el SQL Editor de Supabase. Montos en centavos (BIGINT).
-- Fechas en TIMESTAMPTZ (la app envia ISO-8601 UTC).
-- RLS queda habilitado SIN politicas: solo la service_role key (backend)
-- puede leer/escribir. NUNCA usar la service_role key en un cliente.
-- ============================================================================

create table if not exists public.users (
  id text primary key,
  name text not null,
  role text not null default 'other' check (role in ('husband','wife','daughter','son','other')),
  telegram_id text unique,
  email text unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.categories (
  id text primary key,
  name text not null,
  type text not null check (type in ('income','fixed_expense','variable_expense','investment')),
  emoji text,
  monthly_budget_cents bigint check (monthly_budget_cents is null or monthly_budget_cents >= 0),
  keywords jsonb default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create unique index if not exists idx_categories_name_unique on public.categories (lower(name));

create table if not exists public.documents (
  id text primary key,
  user_id text references public.users(id) on delete set null,
  telegram_file_id text,
  file_name text,
  mime_type text,
  vendor text,
  total_cents bigint,
  currency text not null default 'ARS',
  due_date date,
  category_id text references public.categories(id) on delete set null,
  extracted jsonb,
  status text not null default 'pending' check (status in ('pending','confirmed','discarded','failed')),
  source text not null default 'telegram',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create index if not exists idx_documents_status on public.documents(status);
create index if not exists idx_documents_user on public.documents(user_id);

create table if not exists public.transactions (
  id text primary key,
  user_id text references public.users(id) on delete set null,
  category_id text references public.categories(id) on delete set null,
  type text not null check (type in ('income','fixed_expense','variable_expense','investment')),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'ARS',
  note text,
  source text not null default 'text' check (source in ('text','voice','document','email','api','import')),
  status text not null default 'confirmed' check (status in ('confirmed','pending','discarded')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  document_id text references public.documents(id) on delete set null,
  metadata jsonb
);
create index if not exists idx_transactions_occurred on public.transactions(occurred_at);
create index if not exists idx_transactions_status_occurred on public.transactions(status, occurred_at);
create index if not exists idx_transactions_category on public.transactions(category_id);
create index if not exists idx_transactions_user on public.transactions(user_id);
create index if not exists idx_transactions_document on public.transactions(document_id);

create table if not exists public.goals (
  id text primary key,
  name text not null,
  target_cents bigint not null check (target_cents > 0),
  saved_cents bigint not null default 0 check (saved_cents >= 0),
  deadline date,
  user_id text references public.users(id) on delete set null,
  category_id text references public.categories(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.settings (
  key text primary key,
  value text,
  updated_at timestamptz
);

create table if not exists public.alert_events (
  id text primary key,
  key text not null unique,
  category_id text,
  threshold integer,
  period text,
  sent_at timestamptz not null default now(),
  payload jsonb
);
create index if not exists idx_alert_events_period on public.alert_events(period);

create table if not exists public.email_log (
  message_id text primary key,
  from_address text,
  subject text,
  status text not null,
  processed_at timestamptz not null default now(),
  transaction_id text,
  document_id text,
  error text
);

-- Seguridad: RLS habilitado sin politicas. El backend usa service_role.
alter table public.users enable row level security;
alter table public.categories enable row level security;
alter table public.transactions enable row level security;
alter table public.documents enable row level security;
alter table public.goals enable row level security;
alter table public.settings enable row level security;
alter table public.alert_events enable row level security;
alter table public.email_log enable row level security;

-- Opcional: permitir lectura con anon key para un dashboard propio.
-- create policy "lectura publica de categorias" on public.categories
--   for select using (true);
