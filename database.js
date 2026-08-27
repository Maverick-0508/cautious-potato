import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc, getDocFromServer, collection, getDocs, writeBatch } from 'firebase/firestore';

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_FILE = path.join(__dirname, 'lawncraft.db');

let activeEngine = 'sqlite'; // 'supabase_pg', 'supabase_client', or 'sqlite'
let pgPool = null;
let supabaseClient = null;
let sqliteDb = null;
let firebaseApp = null;
let firestoreDb = null;
let firebaseConfig = null;

// Initialize SQLite fallback
try {
  sqliteDb = new DatabaseSync(DB_FILE);
  console.log('[Database] Local persistent SQLite database ready at', DB_FILE);
} catch (err) {
  console.error('[Database] Local SQLite init warning:', err.message);
}

// Load Firebase configuration
try {
  const fbConfigPath = path.join(__dirname, 'firebase-applet-config.json');
  if (fs.existsSync(fbConfigPath)) {
    const rawConfig = fs.readFileSync(fbConfigPath, 'utf8');
    firebaseConfig = JSON.parse(rawConfig);
    if (firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId) {
      if (getApps().length === 0) {
        firebaseApp = initializeApp({
          apiKey: firebaseConfig.apiKey,
          authDomain: firebaseConfig.authDomain,
          projectId: firebaseConfig.projectId,
          storageBucket: firebaseConfig.storageBucket,
          messagingSenderId: firebaseConfig.messagingSenderId,
          appId: firebaseConfig.appId
        });
      } else {
        firebaseApp = getApp();
      }
      firestoreDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId || '(default)');
      console.log('[Database] Initialized Firebase Firestore with project ID:', firebaseConfig.projectId, 'and DB ID:', firebaseConfig.firestoreDatabaseId);
    }
  }
} catch (fbErr) {
  console.warn('[Database] Firebase initialization notice:', fbErr.message);
}

// Check for Supabase / PostgreSQL credentials
const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

if (dbUrl) {
  try {
    pgPool = new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false }
    });
    activeEngine = 'supabase_pg';
    console.log('[Database] Configured Supabase PostgreSQL connection pool.');
  } catch (err) {
    console.error('[Database] Failed to initialize PostgreSQL pool:', err.message);
  }
} else if (supabaseUrl && supabaseKey) {
  try {
    supabaseClient = createClient(supabaseUrl, supabaseKey);
    activeEngine = 'supabase_client';
    console.log('[Database] Configured Supabase JS Client for', supabaseUrl);
  } catch (err) {
    console.error('[Database] Failed to initialize Supabase client:', err.message);
  }
}

export function getDatabaseStatus() {
  const isSupabase = activeEngine === 'supabase_pg' || activeEngine === 'supabase_client';
  const isFirebaseReady = Boolean(firebaseApp && firestoreDb);
  
  let providerName = 'SQLite (Local Engine)';
  if (isSupabase) {
    providerName = activeEngine === 'supabase_pg' ? 'Supabase (Direct PostgreSQL)' : 'Supabase (REST Client)';
  } else if (isFirebaseReady) {
    providerName = 'Firebase Firestore + SQLite Persistence';
  }

  return {
    engine: activeEngine,
    is_supabase_connected: isSupabase,
    is_firebase_connected: isFirebaseReady,
    provider: providerName,
    firebase: {
      is_configured: isFirebaseReady,
      project_id: firebaseConfig?.projectId || null,
      database_id: firebaseConfig?.firestoreDatabaseId || '(default)',
      auth_domain: firebaseConfig?.authDomain || null
    },
    configured_env_vars: {
      DATABASE_URL: Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL),
      SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
      SUPABASE_ANON_KEY: Boolean(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY)
    }
  };
}

export function getFirebaseConfig() {
  return firebaseConfig;
}

export async function syncToFirestore() {
  if (!firestoreDb) {
    throw new Error('Firestore is not configured. Missing firebase-applet-config.json.');
  }

  console.log('[Database] Synchronizing local dataset to Firebase Firestore...');

  // Sync Users
  const users = await dbAll('SELECT * FROM users');
  for (const user of users) {
    await setDoc(doc(firestoreDb, 'users', String(user.id)), {
      ...user,
      synced_at: new Date().toISOString()
    }, { merge: true });
  }

  // Sync Work Orders
  const workOrders = await dbAll('SELECT * FROM work_orders');
  for (const wo of workOrders) {
    await setDoc(doc(firestoreDb, 'work_orders', String(wo.id)), {
      ...wo,
      synced_at: new Date().toISOString()
    }, { merge: true });
  }

  // Sync Inventory Items
  const inventory = await dbAll('SELECT * FROM inventory_items');
  for (const item of inventory) {
    await setDoc(doc(firestoreDb, 'inventory_items', String(item.id)), {
      ...item,
      synced_at: new Date().toISOString()
    }, { merge: true });
  }

  // Sync Payroll Entries
  const payroll = await dbAll('SELECT * FROM payroll_entries');
  for (const p of payroll) {
    await setDoc(doc(firestoreDb, 'payroll_entries', String(p.id)), {
      ...p,
      synced_at: new Date().toISOString()
    }, { merge: true });
  }

  // Sync Invoices
  const invoices = await dbAll('SELECT * FROM invoices');
  for (const inv of invoices) {
    await setDoc(doc(firestoreDb, 'invoices', String(inv.id)), {
      ...inv,
      synced_at: new Date().toISOString()
    }, { merge: true });
  }

  // Sync Automation Rules
  const rules = await dbAll('SELECT * FROM automation_rules');
  for (const r of rules) {
    await setDoc(doc(firestoreDb, 'automation_rules', String(r.id)), {
      ...r,
      synced_at: new Date().toISOString()
    }, { merge: true });
  }

  // Sync System Settings
  const settings = await dbAll('SELECT * FROM system_settings');
  for (const s of settings) {
    await setDoc(doc(firestoreDb, 'system_settings', String(s.setting_key)), {
      ...s,
      synced_at: new Date().toISOString()
    }, { merge: true });
  }

  console.log('[Database] Successfully synchronized dataset to Firebase Firestore.');
  return {
    success: true,
    synced_counts: {
      users: users.length,
      work_orders: workOrders.length,
      inventory_items: inventory.length,
      payroll_entries: payroll.length,
      invoices: invoices.length,
      automation_rules: rules.length,
      system_settings: settings.length
    }
  };
}

// Convert SQLite '?' placeholders to PostgreSQL '$1, $2, ...'
function convertSqlToPg(sql) {
  let paramIndex = 1;
  let pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);
  
  // Syntax adaptations
  pgSql = pgSql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
  pgSql = pgSql.replace(/datetime\('now'\)/gi, 'NOW()');
  pgSql = pgSql.replace(/datetime\(([^)]+)\)/gi, '$1::timestamptz');
  return pgSql;
}

export async function dbRun(sql, params = []) {
  if (activeEngine === 'supabase_pg' && pgPool) {
    try {
      const pgSql = convertSqlToPg(sql);
      const res = await pgPool.query(pgSql, params);
      return {
        lastID: res.rows && res.rows[0] && res.rows[0].id ? res.rows[0].id : 0,
        changes: res.rowCount
      };
    } catch (err) {
      console.error('[Supabase PG dbRun Error]:', err.message, '\nSQL:', sql);
      // Fallback to SQLite if connection fails
      if (sqliteDb) {
        return fallbackSqliteRun(sql, params);
      }
      throw err;
    }
  }

  return fallbackSqliteRun(sql, params);
}

function fallbackSqliteRun(sql, params = []) {
  try {
    const stmt = sqliteDb.prepare(sql);
    const result = stmt.run(...params);
    return { lastID: Number(result.lastInsertRowid), changes: result.changes };
  } catch (err) {
    throw err;
  }
}

export async function dbGet(sql, params = []) {
  if (activeEngine === 'supabase_pg' && pgPool) {
    try {
      const pgSql = convertSqlToPg(sql);
      const res = await pgPool.query(pgSql, params);
      return res.rows[0] || null;
    } catch (err) {
      console.error('[Supabase PG dbGet Error]:', err.message);
      if (sqliteDb) return fallbackSqliteGet(sql, params);
      throw err;
    }
  }

  return fallbackSqliteGet(sql, params);
}

function fallbackSqliteGet(sql, params = []) {
  try {
    const stmt = sqliteDb.prepare(sql);
    const row = stmt.get(...params);
    return row || null;
  } catch (err) {
    throw err;
  }
}

export async function dbAll(sql, params = []) {
  if (activeEngine === 'supabase_pg' && pgPool) {
    try {
      const pgSql = convertSqlToPg(sql);
      const res = await pgPool.query(pgSql, params);
      return res.rows || [];
    } catch (err) {
      console.error('[Supabase PG dbAll Error]:', err.message);
      if (sqliteDb) return fallbackSqliteAll(sql, params);
      throw err;
    }
  }

  return fallbackSqliteAll(sql, params);
}

function fallbackSqliteAll(sql, params = []) {
  try {
    const stmt = sqliteDb.prepare(sql);
    const rows = stmt.all(...params);
    return rows || [];
  } catch (err) {
    throw err;
  }
}

export async function initDatabase() {
  console.log(`[Database] Initializing tables on engine: ${activeEngine}...`);

  // Users
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'supervisor',
      department TEXT DEFAULT 'Operations',
      cost_center TEXT DEFAULT 'CC-101',
      notes TEXT DEFAULT '',
      hourly_rate REAL DEFAULT 42.50,
      overtime_rate REAL DEFAULT 63.75
    )
  `);

  // Work Orders
  await dbRun(`
    CREATE TABLE IF NOT EXISTS work_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      client_name TEXT NOT NULL,
      client_email TEXT,
      client_phone TEXT,
      property_address TEXT NOT NULL,
      service_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'incoming',
      priority TEXT NOT NULL DEFAULT 'medium',
      target_date TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      description TEXT,
      supervisor_notes TEXT,
      assigned_user_id INTEGER
    )
  `);

  // Inventory Items (ERP)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT UNIQUE NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      quantity_on_hand REAL NOT NULL DEFAULT 0,
      min_reorder_level REAL NOT NULL DEFAULT 10,
      reorder_quantity REAL NOT NULL DEFAULT 50,
      unit_cost REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      supplier TEXT,
      location TEXT,
      auto_reorder_enabled INTEGER NOT NULL DEFAULT 1,
      last_restocked TEXT
    )
  `);

  // Inventory Transactions & Audit
  await dbRun(`
    CREATE TABLE IF NOT EXISTS inventory_transactions (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      previous_qty REAL NOT NULL,
      new_qty REAL NOT NULL,
      work_order_id INTEGER,
      reason TEXT,
      timestamp TEXT NOT NULL,
      actor_email TEXT
    )
  `);

  // Payroll Entries (ERP)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS payroll_entries (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      employee_name TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL,
      pay_period_start TEXT NOT NULL,
      pay_period_end TEXT NOT NULL,
      regular_hours REAL NOT NULL DEFAULT 0,
      overtime_hours REAL NOT NULL DEFAULT 0,
      hourly_rate REAL NOT NULL,
      gross_pay REAL NOT NULL,
      tax_deduction REAL NOT NULL DEFAULT 0,
      net_pay REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      jobs_completed INTEGER NOT NULL DEFAULT 0,
      bonus REAL NOT NULL DEFAULT 0,
      processed_at TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Automation Rules (ERP)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger_event TEXT NOT NULL,
      description TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_triggered TEXT,
      action_config TEXT,
      execution_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Automation Execution Logs
  await dbRun(`
    CREATE TABLE IF NOT EXISTS automation_logs (
      id TEXT PRIMARY KEY,
      rule_id TEXT,
      rule_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  // Invoices
  await dbRun(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      work_order_id INTEGER,
      client_name TEXT NOT NULL,
      client_email TEXT,
      client_phone TEXT,
      property_address TEXT NOT NULL,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'issued',
      payment_terms TEXT DEFAULT 'Net 15',
      subtotal REAL NOT NULL DEFAULT 0,
      tax_rate REAL NOT NULL DEFAULT 6.5,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      amount_paid REAL NOT NULL DEFAULT 0,
      balance_due REAL NOT NULL DEFAULT 0,
      notes TEXT,
      payment_method TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_auto_generated INTEGER DEFAULT 0
    )
  `);

  // Invoice Line Items
  await dbRun(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0
    )
  `);

  // Invoice Payments
  await dbRun(`
    CREATE TABLE IF NOT EXISTS invoice_payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      notes TEXT
    )
  `);

  // Permission Policies
  await dbRun(`
    CREATE TABLE IF NOT EXISTS permission_policies (
      feature_key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      allowed_roles TEXT NOT NULL,
      allowed_departments TEXT NOT NULL,
      description TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

  // System Settings
  await dbRun(`
    CREATE TABLE IF NOT EXISTS system_settings (
      setting_key TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      value TEXT NOT NULL,
      is_sensitive INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Audit Logs
  await dbRun(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      summary TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Seed default data if empty
  await seedInitialData();
}

async function seedInitialData() {
  const usersCount = (await dbGet('SELECT COUNT(*) as cnt FROM users'))?.cnt || 0;
  if (usersCount === 0) {
    console.log('[Database] Seeding initial database tables...');

    // Seed Users
    await dbRun(`
      INSERT INTO users (id, email, full_name, role, department, cost_center, notes, hourly_rate, overtime_rate)
      VALUES 
        (1, 'admin@lawncraft.com', 'Alex Rivera (Admin)', 'admin', 'Operations', 'CC-101', 'Head of Operations & Lead Supervisor', 55.00, 82.50),
        (2, 'supervisor@lawncraft.com', 'Jordan Miller', 'supervisor', 'Field', 'CC-204', 'North Territory Supervisor', 46.00, 69.00),
        (3, 'marcus.crew@lawncraft.com', 'Marcus Vance', 'field_tech', 'Field', 'CC-204', 'Crew Lead - Turf Specialist', 38.50, 57.75),
        (4, 'elena.tech@lawncraft.com', 'Elena Rostova', 'field_tech', 'Field', 'CC-204', 'Irrigation & Drainage Specialist', 41.00, 61.50)
    `);

    // Seed Work Orders
    await dbRun(`
      INSERT INTO work_orders (id, title, client_name, client_email, client_phone, property_address, service_type, status, priority, target_date, created_at, started_at, completed_at, description, supervisor_notes, assigned_user_id)
      VALUES
        (101, 'Spring Lawn Aeration & Overseeding', 'Eleanor Vance', 'eleanor.vance@example.com', '(555) 234-5678', '742 Evergreen Terrace, Springfield', 'Aeration & Overseeding', 'incoming', 'high', '2026-09-01T08:00:00Z', '2026-08-25T09:15:00Z', NULL, NULL, 'Full front and backyard core aeration with premium fescue overseeding blend.', 'Gate access code is #4491. Dog will be kept inside.', 3),
        (102, 'Commercial Turf Health Assessment & Treatment', 'Apex Industrial Park', 'facilities@apexpark.com', '(555) 890-1234', '1200 Innovation Way, Tech Park', 'Commercial Maintenance', 'incoming', 'medium', '2026-09-03T10:00:00Z', '2026-08-26T11:30:00Z', NULL, NULL, 'Inspect yellowing patches on south lawn buffer zone and apply organic fertilizer treatment.', 'Check in with security booth before entering grounds.', 2),
        (103, 'Irrigation System Zone Repair & Valve Replacement', 'Robert Thornton', 'rthornton@example.com', '(555) 456-7890', '88 Riverview Crescent, Lakeside', 'Irrigation & Drainage', 'incoming', 'urgent', '2026-08-28T09:00:00Z', '2026-08-26T14:45:00Z', NULL, NULL, 'Zone 3 has low pressure; solenoid valve 2 is unresponsive to controller.', 'Urgent: Water pooling near driveway foundation.', 4),
        (104, 'Precision Edge Trimming & Seasonal Fertilization', 'Sophia Martinez', 'sophia.m@example.com', '(555) 678-9012', '45 Magnolia Drive, Blossom Hills', 'Lawn Maintenance', 'planned', 'medium', '2026-08-29T13:00:00Z', '2026-08-24T08:00:00Z', NULL, NULL, 'Full perimeter edging, weed suppression application, slow-release balanced feeding.', 'Assigned to Crew Team Beta.', 3),
        (105, 'Landscape Bed Mulching & Weed Barrier Installation', 'Dr. Gregory House', 'ghouse@example.com', '(555) 321-7654', '15 Meadowbrook Lane, Westend', 'Landscape Enhancement', 'reviewed', 'low', '2026-08-30T10:00:00Z', '2026-08-23T15:20:00Z', NULL, NULL, '10 yards premium dark cedar mulch delivery and spreading across flowerbeds.', 'Awaiting mulch supplier delivery confirmation.', 3),
        (106, 'Hydroseeding & Soil Prep on Sloped Yard', 'Claire Underwood', 'claire.u@example.com', '(555) 789-0123', '304 Highland Summit, Ridgeway', 'Hydroseeding', 'in_progress', 'high', '2026-08-27T14:00:00Z', '2026-08-22T10:00:00Z', '2026-08-27T08:30:00Z', NULL, 'Grade terrace slope, apply tackifier and sun/shade hydroseed slurry.', 'Field crew on site since 8:30am. Tanker truck positioned on driveway.', 3),
        (107, 'Dethatching & Fall Lawn Renovation', 'David Chen', 'david.chen@example.com', '(555) 234-8901', '912 Oakridge Boulevard, Greenfield', 'Turf Renovation', 'in_progress', 'urgent', '2026-08-27T16:00:00Z', '2026-08-21T09:00:00Z', '2026-08-27T09:15:00Z', NULL, 'Heavy power dethatching, debris haul away, topdressing with compost mix.', 'Overdue high-severity issue reported with thatch buildup thickness.', 2),
        (108, 'Smart Sprinkler Controller Upgrade & Weather Sensor', 'Hannah Abbott', 'hannah.a@example.com', '(555) 901-2345', '52 Sycamore Grove, Eastlake', 'Irrigation & Drainage', 'completed', 'medium', '2026-08-25T11:00:00Z', '2026-08-19T14:00:00Z', '2026-08-25T09:00:00Z', '2026-08-25T11:30:00Z', 'Installed 12-zone Rachio controller, wired rain & freeze sensor.', 'Tested all zones successfully. Client app paired.', 4),
        (109, 'Total Sod Replacement & Topsoil Grading', 'Arthur Pendelton', 'arthur.p@example.com', '(555) 567-8901', '220 King William Street, Old Town', 'Sod Installation', 'verified', 'high', '2026-08-24T17:00:00Z', '2026-08-18T10:00:00Z', '2026-08-24T07:30:00Z', '2026-08-24T16:45:00Z', 'Stripped old Bermuda grass, laser-graded 4 tons loam, laid fresh Kentucky Bluegrass sod.', 'Supervisor inspected turf rooting and moisture depth. Quality score 10/10.', 3)
    `);

    // Seed Inventory Items
    await dbRun(`
      INSERT INTO inventory_items (id, name, sku, category, unit, quantity_on_hand, min_reorder_level, reorder_quantity, unit_cost, unit_price, supplier, location, auto_reorder_enabled, last_restocked)
      VALUES
        ('INV-ITM-001', 'Kentucky Bluegrass Premium Seed (50lb bag)', 'SEED-KBG-50', 'Seeds & Turf', 'Bags', 14, 8, 25, 85.00, 140.00, 'GreenValley Seeds Co.', 'Warehouse Bay A-1', 1, '2026-08-20'),
        ('INV-ITM-002', 'Organic Slow-Release Fertilizer (24-4-12)', 'FERT-ORG-24', 'Fertilizer & Soil', 'Bags (50lb)', 32, 15, 40, 32.50, 68.00, 'BioTurf Organics', 'Warehouse Bay B-3', 1, '2026-08-22'),
        ('INV-ITM-003', 'Hunter 1" Solenoid Sprinkler Valves', 'IRR-VALVE-100', 'Irrigation Parts', 'Units', 6, 10, 20, 24.00, 58.00, 'HydroFlow Systems', 'Parts Bin C-12', 1, '2026-08-15'),
        ('INV-ITM-004', 'Rachio 3 Smart 12-Zone Controller', 'IRR-CTRL-12Z', 'Irrigation Parts', 'Units', 4, 3, 10, 185.00, 320.00, 'SmartIrrigate Ltd.', 'Secure Cage S-2', 1, '2026-08-18'),
        ('INV-ITM-005', 'Commercial Grade 0.095" Trimmer Line (5lb)', 'TOOL-LINE-095', 'Equipment & Mower', 'Spools', 18, 5, 20, 18.00, 36.00, 'Stihl Equipment Supply', 'Tool Rack T-4', 1, '2026-08-24'),
        ('INV-ITM-006', 'Premium Shredded Dark Cedar Mulch', 'MULCH-CEDAR-YD', 'Landscape Materials', 'Cubic Yards', 28, 12, 50, 28.00, 65.00, 'TimberBark Wholesale', 'Yard Bin Bulk-1', 1, '2026-08-21'),
        ('INV-ITM-007', 'Hydroseed Tackifier & Fiber Slurry Mix', 'HYDRO-TAC-50', 'Seeds & Turf', 'Bales', 8, 10, 30, 42.00, 95.00, 'HydroMulch Pro', 'Warehouse Bay A-4', 1, '2026-08-19'),
        ('INV-ITM-008', 'Heavy Duty Aerator Replacement Tines (Set)', 'TOOL-TINE-SET', 'Equipment & Mower', 'Sets', 3, 4, 12, 65.00, 120.00, 'TurfMech Parts', 'Parts Bin C-08', 1, '2026-08-10')
    `);

    // Seed Payroll Entries
    await dbRun(`
      INSERT INTO payroll_entries (id, user_id, employee_name, role, department, pay_period_start, pay_period_end, regular_hours, overtime_hours, hourly_rate, gross_pay, tax_deduction, net_pay, status, jobs_completed, bonus, processed_at, created_at)
      VALUES
        ('PAY-2026-W34-01', 3, 'Marcus Vance', 'field_tech', 'Field', '2026-08-18', '2026-08-24', 40.0, 6.5, 38.50, 1915.38, 383.08, 1532.30, 'approved', 5, 100.00, '2026-08-25T17:00:00Z', '2026-08-25T16:00:00Z'),
        ('PAY-2026-W34-02', 4, 'Elena Rostova', 'field_tech', 'Field', '2026-08-18', '2026-08-24', 40.0, 4.0, 41.00, 1886.00, 377.20, 1508.80, 'approved', 4, 75.00, '2026-08-25T17:00:00Z', '2026-08-25T16:00:00Z'),
        ('PAY-2026-W34-03', 2, 'Jordan Miller', 'supervisor', 'Field', '2026-08-18', '2026-08-24', 40.0, 2.0, 46.00, 1978.00, 395.60, 1582.40, 'processed', 8, 150.00, '2026-08-25T17:30:00Z', '2026-08-25T16:00:00Z'),
        ('PAY-2026-W35-01', 3, 'Marcus Vance', 'field_tech', 'Field', '2026-08-25', '2026-08-31', 32.0, 3.5, 38.50, 1434.13, 286.83, 1147.30, 'draft', 3, 0.00, NULL, '2026-08-27T06:00:00Z'),
        ('PAY-2026-W35-02', 4, 'Elena Rostova', 'field_tech', 'Field', '2026-08-25', '2026-08-31', 30.5, 2.0, 41.00, 1373.50, 274.70, 1098.80, 'draft', 2, 0.00, NULL, '2026-08-27T06:00:00Z')
    `);

    // Seed Automation Rules
    await dbRun(`
      INSERT INTO automation_rules (id, name, trigger_event, description, is_enabled, last_triggered, action_config, execution_count)
      VALUES
        ('RULE-AUTO-INV', 'Work Order Completed -> Auto-Generate Invoice', 'WORK_ORDER_COMPLETED', 'Automatically generates a complete draft/issued client invoice with itemized services when a job is marked verified or completed.', 1, '2026-08-25T11:30:00Z', '{"auto_status": "issued", "tax_rate": 6.5, "due_days": 15}', 18),
        ('RULE-AUTO-RESTOCK', 'Inventory Below Safety Level -> Auto-Generate Reorder PO', 'LOW_INVENTORY_DETECTED', 'Monitors inventory stock levels in real time and automatically creates purchase requisition orders when stock breaches safety thresholds.', 1, '2026-08-26T08:00:00Z', '{"auto_approve_under": 1500, "supplier_notify": true}', 7),
        ('RULE-AUTO-PAYROLL', 'Logged Work Orders -> Automated Timesheet & Payroll Calculation', 'TIMESHEET_WORK_ORDER_SYNC', 'Calculates technician regular and overtime pay, bonuses for on-time quality completion, and compiles bi-weekly payroll entries.', 1, '2026-08-25T17:00:00Z', '{"overtime_multiplier": 1.5, "completion_bonus": 25.0}', 12),
        ('RULE-AUTO-OVERDUE', 'Invoice Due Date Exceeded -> Auto Overdue Flag & Notification', 'INVOICE_OVERDUE_SCAN', 'Runs daily checks on unpaid balances, flags accounts as overdue, and prepares automated client statements.', 1, '2026-08-27T00:00:00Z', '{"grace_days": 0, "auto_penalty_pct": 0}', 24),
        ('RULE-AUTO-MATERIAL-DEDUCT', 'Job Started / Completed -> Deduct Materials from Inventory', 'WORK_ORDER_MATERIAL_USAGE', 'Automatically decreases warehouse inventory quantities for materials and parts assigned to specific work orders.', 1, '2026-08-27T08:30:00Z', '{"track_lot": true}', 14)
    `);

    // Seed Automation Execution Logs
    await dbRun(`
      INSERT INTO automation_logs (id, rule_id, rule_name, event_type, status, details, timestamp)
      VALUES
        ('LOG-AUTO-901', 'RULE-AUTO-INV', 'Work Order Completed -> Auto-Generate Invoice', 'WORK_ORDER_COMPLETED', 'success', 'Auto-generated invoice INV-2026-001 ($4,260.00) for Arthur Pendelton upon completion of #109 Sod Replacement.', '2026-08-25T11:30:00Z'),
        ('LOG-AUTO-902', 'RULE-AUTO-MATERIAL-DEDUCT', 'Job Started -> Deduct Materials', 'WORK_ORDER_MATERIAL_USAGE', 'success', 'Deducted 6,500 sq ft Hydroseed Slurry Mix and 3 Bales Straw from inventory for #106 Highland Summit.', '2026-08-27T08:30:00Z'),
        ('LOG-AUTO-903', 'RULE-AUTO-RESTOCK', 'Inventory Below Safety Level', 'LOW_INVENTORY_DETECTED', 'warning', 'Low stock detected for Hunter Solenoid Valves (6 on hand, min 10). Automated PO #PO-4412 created for 20 units.', '2026-08-26T08:00:00Z'),
        ('LOG-AUTO-904', 'RULE-AUTO-PAYROLL', 'Automated Timesheet Calculation', 'TIMESHEET_WORK_ORDER_SYNC', 'success', 'Compiled weekly timesheets and generated payroll drafts for 3 field technicians (Period Aug 18 - Aug 24).', '2026-08-25T17:00:00Z')
    `);

    // Seed Invoices
    await dbRun(`
      INSERT INTO invoices (id, work_order_id, client_name, client_email, client_phone, property_address, issue_date, due_date, status, payment_terms, subtotal, tax_rate, tax_amount, discount_amount, total_amount, amount_paid, balance_due, notes, payment_method, created_at, updated_at, is_auto_generated)
      VALUES
        ('INV-2026-001', 109, 'Arthur Pendelton', 'arthur.p@example.com', '(555) 567-8901', '220 King William Street, Old Town', '2026-08-25', '2026-09-09', 'paid', 'Net 15', 4000.00, 6.5, 260.00, 0.00, 4260.00, 4260.00, 0.00, 'Thank you for choosing Lawn Craft! Please keep new sod moist for the first 14 days.', 'Credit Card', '2026-08-25T11:00:00Z', '2026-08-26T14:30:00Z', 1),
        ('INV-2026-002', 108, 'Hannah Abbott', 'hannah.a@example.com', '(555) 901-2345', '52 Sycamore Grove, Eastlake', '2026-08-26', '2026-09-10', 'issued', 'Net 15', 702.50, 6.5, 45.66, 0.00, 748.16, 0.00, 748.16, 'Controller synced with mobile app. 2-year warranty on hardware.', NULL, '2026-08-26T09:30:00Z', '2026-08-26T09:30:00Z', 1),
        ('INV-2026-003', 106, 'Claire Underwood', 'claire.u@example.com', '(555) 789-0123', '304 Highland Summit, Ridgeway', '2026-08-27', '2026-08-27', 'draft', 'Due on Receipt', 2525.00, 6.5, 164.13, 50.00, 2639.13, 0.00, 2639.13, 'Draft estimate ready for final review upon field crew completion.', NULL, '2026-08-27T08:00:00Z', '2026-08-27T08:00:00Z', 0),
        ('INV-2026-004', 102, 'Apex Industrial Park', 'facilities@apexpark.com', '(555) 890-1234', '1200 Innovation Way, Tech Park', '2026-08-10', '2026-08-25', 'overdue', 'Net 15', 2270.00, 6.5, 147.55, 0.00, 2417.55, 0.00, 2417.55, 'Please remit payment to avoid service pause on next month schedule.', NULL, '2026-08-10T10:00:00Z', '2026-08-10T10:00:00Z', 0)
    `);

    // Seed Invoice Items
    await dbRun(`
      INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
      VALUES
        ('INV-2026-001', 'Total Old Sod Removal & Ground Prep', 1, 650.00, 650.00),
        ('INV-2026-001', 'Premium Kentucky Bluegrass Sod (4,200 sq ft)', 4200, 0.65, 2730.00),
        ('INV-2026-001', 'Screened Loam Topsoil (4 Tons Delivery & Spread)', 4, 110.00, 440.00),
        ('INV-2026-001', 'Initial Starter Fertilizer & Soil Conditioner Treatment', 1, 180.00, 180.00),
        ('INV-2026-002', 'Smart Sprinkler Controller 12-Zone Unit', 1, 320.00, 320.00),
        ('INV-2026-002', 'Wireless Rain & Freeze Sensor Kit', 1, 145.00, 145.00),
        ('INV-2026-002', 'Installation, Wiring & Zone Optimization Labor (2.5 hrs)', 2.5, 95.00, 237.50),
        ('INV-2026-003', 'Terrace Slope Soil Grading & Tackifier Prep', 1, 450.00, 450.00),
        ('INV-2026-003', 'Sun/Shade Premium Hydroseed Slurry (6,500 sq ft)', 6500, 0.28, 1820.00),
        ('INV-2026-003', 'Erosion Control Straw Matting (Slope Area)', 3, 85.00, 255.00),
        ('INV-2026-004', 'Monthly Commercial Turf Maintenance Retainer (July)', 1, 1850.00, 1850.00),
        ('INV-2026-004', 'Broadleaf Herbicide & Pre-Emergent Application', 1, 420.00, 420.00)
    `);

    // Seed Invoice Payments
    await dbRun(`
      INSERT INTO invoice_payments (id, invoice_id, date, amount, method, reference, notes)
      VALUES
        ('PAY-1001', 'INV-2026-001', '2026-08-26T14:30:00Z', 4260.00, 'Credit Card', 'AUTH_TXN_99214', 'Paid in full online')
    `);

    // Seed Policies & Settings
    await dbRun(`
      INSERT INTO permission_policies (feature_key, label, allowed_roles, allowed_departments, description, is_enabled)
      VALUES
        ('financial_reports', 'Financial Reports Access', 'admin,finance', 'Operations, Finance', 'Access to financial summary, revenue forecasts, and conversion data', 1),
        ('user_management', 'User Management', 'admin', 'Management, HR', 'Ability to create, update, and manage accounts and access profiles', 1),
        ('work_order_dispatch', 'Work Order Dispatch', 'admin,supervisor', 'Operations, Field', 'Permission to assign jobs, alter schedules, and dispatch field crews', 1),
        ('erp_automation_control', 'ERP & Automation Control', 'admin,supervisor', 'Operations, IT', 'Control inventory reordering, payroll calculations, and auto-invoicing rules', 1),
        ('system_settings', 'System Configuration', 'admin', 'Operations, IT', 'Control system switches, API integrations, and notification triggers', 1)
    `);

    await dbRun(`
      INSERT INTO system_settings (setting_key, group_name, label, description, value, is_sensitive)
      VALUES
        ('contact_intake_enabled', 'General', 'Contact Intake Pipeline', 'Enable or pause incoming service inquiries from website forms', 'true', 0),
        ('auto_invoice_on_completion', 'ERP Automation', 'Auto-Invoice on Job Completion', 'Automatically generate tax invoice when work order reaches verified status', 'true', 0),
        ('auto_inventory_reorder', 'ERP Automation', 'Auto-Reorder Low Inventory', 'Automatically trigger purchase orders when stock breaches reorder thresholds', 'true', 0),
        ('auto_payroll_sync', 'ERP Automation', 'Auto-Sync Timesheets & Overtime', 'Synchronize technician hours and completed work orders with bi-weekly payroll engine', 'true', 0),
        ('notification_email', 'Notifications', 'Dispatch Notification Email', 'Destination inbox for urgent job notifications and exception alerts', 'dispatch@lawncraft.com', 0),
        ('auto_assign_radius', 'Dispatch', 'Maximum Dispatch Radius (km)', 'Radius threshold for automated crew territory assignment', '25', 0),
        ('kpi_refresh_interval', 'Operations', 'Realtime Sync Interval (seconds)', 'Frequency of automated supervisor board polling', '30', 0)
    `);

    await dbRun(`
      INSERT INTO audit_logs (action, summary, actor_email, resource_type, resource_id, created_at)
      VALUES
        ('DATABASE_INITIALIZED', 'SQLite persistent database engine mounted and seeded with ERP tables', 'system@lawncraft.com', 'database', 'lawncraft.db', '2026-08-27T06:00:00Z'),
        ('WORK_ORDER_STATUS_UPDATE', 'Updated #106 Hydroseeding status to in_progress', 'admin@lawncraft.com', 'work_order', '106', '2026-08-27T05:00:00Z'),
        ('ERP_RULE_ENABLED', 'Enabled automatic inventory reordering and invoice synchronization', 'admin@lawncraft.com', 'automation', 'RULE-AUTO-INV', '2026-08-27T05:30:00Z')
    `);
  }
}
