-- ==========================================================
-- Lawn Craft ERP & Operations Database Schema for Supabase
-- Run this in your Supabase SQL Editor if provisioning manually
-- ==========================================================

-- 1. Users & Staff
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'supervisor',
  department TEXT DEFAULT 'Operations',
  cost_center TEXT DEFAULT 'CC-101',
  notes TEXT DEFAULT '',
  hourly_rate NUMERIC(10,2) DEFAULT 42.50,
  overtime_rate NUMERIC(10,2) DEFAULT 63.75
);

-- 2. Work Orders & Field Jobs
CREATE TABLE IF NOT EXISTS work_orders (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_email TEXT,
  client_phone TEXT,
  property_address TEXT NOT NULL,
  service_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incoming',
  priority TEXT NOT NULL DEFAULT 'medium',
  target_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  description TEXT,
  supervisor_notes TEXT,
  assigned_user_id INTEGER REFERENCES users(id)
);

-- 3. Inventory Items Catalog (ERP)
CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sku TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity_on_hand NUMERIC(10,2) NOT NULL DEFAULT 0,
  min_reorder_level NUMERIC(10,2) NOT NULL DEFAULT 10,
  reorder_quantity NUMERIC(10,2) NOT NULL DEFAULT 50,
  unit_cost NUMERIC(10,2) NOT NULL DEFAULT 0,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  supplier TEXT,
  location TEXT,
  auto_reorder_enabled INTEGER NOT NULL DEFAULT 1,
  last_restocked TEXT
);

-- 4. Inventory Material Transactions & Audit Logs
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  quantity NUMERIC(10,2) NOT NULL,
  previous_qty NUMERIC(10,2) NOT NULL,
  new_qty NUMERIC(10,2) NOT NULL,
  work_order_id INTEGER,
  reason TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_email TEXT
);

-- 5. Automated Payroll & Technician Timesheets
CREATE TABLE IF NOT EXISTS payroll_entries (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  employee_name TEXT NOT NULL,
  role TEXT NOT NULL,
  department TEXT NOT NULL,
  pay_period_start DATE NOT NULL,
  pay_period_end DATE NOT NULL,
  regular_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
  hourly_rate NUMERIC(10,2) NOT NULL,
  gross_pay NUMERIC(10,2) NOT NULL,
  tax_deduction NUMERIC(10,2) NOT NULL DEFAULT 0,
  net_pay NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  jobs_completed INTEGER NOT NULL DEFAULT 0,
  bonus NUMERIC(10,2) NOT NULL DEFAULT 0,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Workflow Automation Rules
CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  description TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  last_triggered TIMESTAMPTZ,
  action_config TEXT,
  execution_count INTEGER NOT NULL DEFAULT 0
);

-- 7. Automation Execution Event Logs
CREATE TABLE IF NOT EXISTS automation_logs (
  id TEXT PRIMARY KEY,
  rule_id TEXT,
  rule_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 8. Client Invoices
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  work_order_id INTEGER,
  client_name TEXT NOT NULL,
  client_email TEXT,
  client_phone TEXT,
  property_address TEXT NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',
  payment_terms TEXT DEFAULT 'Net 15',
  subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 6.5,
  tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  balance_due NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes TEXT,
  payment_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_auto_generated INTEGER DEFAULT 0
);

-- 9. Invoice Line Items
CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount NUMERIC(10,2) NOT NULL DEFAULT 0
);

-- 10. Invoice Payments
CREATE TABLE IF NOT EXISTS invoice_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  amount NUMERIC(10,2) NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  notes TEXT
);

-- 11. Permission Policies
CREATE TABLE IF NOT EXISTS permission_policies (
  feature_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  allowed_roles TEXT NOT NULL,
  allowed_departments TEXT NOT NULL,
  description TEXT,
  is_enabled INTEGER NOT NULL DEFAULT 1
);

-- 12. System Settings
CREATE TABLE IF NOT EXISTS system_settings (
  setting_key TEXT PRIMARY KEY,
  group_name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  value TEXT NOT NULL,
  is_sensitive INTEGER NOT NULL DEFAULT 0
);

-- 13. Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
