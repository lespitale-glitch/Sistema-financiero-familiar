-- ============================================================================
-- Finanzas Familiares - esquema SQLite
-- Los montos se guardan en centavos (INTEGER). Fechas en ISO-8601 UTC (TEXT).
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'other'
    CHECK (role IN ('husband', 'wife', 'daughter', 'son', 'other')),
  telegram_id TEXT UNIQUE,
  email TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL
    CHECK (type IN ('income', 'fixed_expense', 'variable_expense', 'investment')),
  emoji TEXT,
  monthly_budget_cents INTEGER CHECK (monthly_budget_cents IS NULL OR monthly_budget_cents >= 0),
  keywords TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_unique ON categories (name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  telegram_file_id TEXT,
  file_name TEXT,
  mime_type TEXT,
  vendor TEXT,
  total_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'ARS',
  due_date TEXT,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  extracted TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'discarded', 'failed')),
  source TEXT NOT NULL DEFAULT 'telegram',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents (user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  type TEXT NOT NULL
    CHECK (type IN ('income', 'fixed_expense', 'variable_expense', 'investment')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'ARS',
  note TEXT,
  source TEXT NOT NULL DEFAULT 'text'
    CHECK (source IN ('text', 'voice', 'document', 'email', 'api', 'import')),
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'pending', 'discarded')),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_occurred ON transactions (occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_status_occurred ON transactions (status, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions (category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_document ON transactions (document_id);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  saved_cents INTEGER NOT NULL DEFAULT 0 CHECK (saved_cents >= 0),
  deadline TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  category_id TEXT,
  threshold INTEGER,
  period TEXT,
  sent_at TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_alert_events_period ON alert_events (period);

CREATE TABLE IF NOT EXISTS email_log (
  message_id TEXT PRIMARY KEY,
  from_address TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  transaction_id TEXT,
  document_id TEXT,
  error TEXT
);

-- Vencimientos a pagar (facturas con fecha limite o cargados con /vence).
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'ARS',
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'cancelled')),
  recurrence TEXT CHECK (recurrence IS NULL OR recurrence IN ('monthly')),
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  paid_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bills_status_due ON bills (status, due_date);
CREATE INDEX IF NOT EXISTS idx_bills_document ON bills (document_id);
