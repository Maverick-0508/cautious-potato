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

export async function getSupabaseDetails() {
  const supabaseUrl = process.env.SUPABASE_URL || null;
  const hasAnonKey = Boolean(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY);
  const hasServiceKey = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hasDbUrl = Boolean(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  
  let isConnected = false;
  let connectionType = 'Not Connected';
  let testError = null;
  const tableCounts = {};

  if (pgPool) {
    try {
      await pgPool.query('SELECT 1');
      isConnected = true;
      connectionType = 'PostgreSQL Direct Pool (Active)';
    } catch (e) {
      testError = e.message;
    }
  } else if (supabaseClient) {
    try {
      // Check accessible tables
      const candidateTables = ['work_orders', 'clients', 'properties', 'users', 'invoices', 'inventory_items', 'payroll_entries', 'automation_rules'];
      for (const t of candidateTables) {
        const { data, error } = await supabaseClient.from(t).select('*', { count: 'exact', head: true });
        if (!error) {
          tableCounts[t] = typeof data === 'number' ? data : 'Available';
        }
      }

      const { count: woCount, error: woErr } = await supabaseClient.from('work_orders').select('*', { count: 'exact', head: true });
      if (!woErr || woErr.code === 'PGRST116') {
        isConnected = true;
        connectionType = hasServiceKey
          ? 'Supabase Service Role (Full Admin & Storage Access)'
          : 'Supabase JS Client (REST API)';
      } else {
        testError = woErr.message;
      }
    } catch (e) {
      testError = e.message;
    }
  } else if (supabaseUrl && !hasAnonKey && !hasServiceKey && !hasDbUrl) {
    testError = 'SUPABASE_URL is configured, but SUPABASE_SERVICE_ROLE_KEY is required to authenticate database operations.';
  }

  return {
    supabase_url: supabaseUrl,
    has_url: Boolean(supabaseUrl),
    has_anon_key: hasAnonKey,
    has_service_role_key: hasServiceKey,
    has_database_url: hasDbUrl,
    is_connected: isConnected,
    connection_type: connectionType,
    error: testError,
    table_counts: tableCounts,
    engine: activeEngine,
    guide: {
      url_configured: Boolean(supabaseUrl),
      service_key_configured: hasServiceKey,
      missing_keys: [
        ...(!hasAnonKey && !hasServiceKey ? ['SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY'] : [])
      ]
    }
  };
}

export async function importFromSupabase() {
  if (!supabaseClient) {
    throw new Error('Supabase client is not initialized.');
  }

  console.log('[Database] Importing data from Supabase into application store...');
  let importedWorkOrders = 0;
  let importedClients = 0;
  let importedLeads = 0;

  try {
    const { data: clients } = await supabaseClient.from('clients').select('*');
    const { data: properties } = await supabaseClient.from('properties').select('*');
    const { data: workOrders } = await supabaseClient.from('work_orders').select('*');
    const { data: leads } = await supabaseClient.from('leads').select('*').order('id', { ascending: true });

    const clientMap = new Map((clients || []).map(c => [c.id, c]));
    const propByClient = new Map((properties || []).map(p => [p.client_id, p]));

    // 1. Process explicit work orders
    if (workOrders && workOrders.length > 0) {
      for (const wo of workOrders) {
        const client = clientMap.get(wo.client_id) || {};
        const prop = propByClient.get(wo.client_id) || {};
        
        const clientName = client.name || `Commercial Account #${wo.client_id || wo.id}`;
        const address = prop.address || 'Lawnview Commercial District';
        const phone = client.phone || '(555) 0100';
        const email = client.email || 'ops@lawnview.com';
        const status = wo.status === 'open' ? 'incoming' : (wo.status || 'incoming');
        const title = wo.title || `Grounds Maintenance - ${clientName}`;
        const createdAt = wo.created_at || new Date().toISOString();

        // Check if work order exists
        const existing = await dbGet('SELECT id FROM work_orders WHERE id = ?', [wo.id]);
        if (existing) {
          await dbRun(`
            UPDATE work_orders 
            SET title = ?, client_name = ?, client_email = ?, client_phone = ?, property_address = ?, status = ?
            WHERE id = ?
          `, [title, clientName, email, phone, address, status, wo.id]);
        } else {
          await dbRun(`
            INSERT INTO work_orders (id, title, client_name, client_email, client_phone, property_address, service_type, status, priority, created_at, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [wo.id, title, clientName, email, phone, address, 'Commercial Lawn Care & Grounds', status, 'medium', createdAt, 'Imported from Supabase cloud database.']);
        }
        importedWorkOrders++;
      }
    }

    // 2. Process website booking requests / leads from lawncraft.vercel.app
    if (leads && leads.length > 0) {
      for (const lead of leads) {
        const leadWoId = 5000 + Number(lead.id || 0);
        const clientName = lead.name || 'Website Customer';
        const email = lead.email || '';
        const phone = lead.phone || '';
        const msg = lead.message || '';
        const createdAt = lead.created_at || new Date().toISOString();

        // Parse structured fields from website contact message if formatted with headers
        let address = 'Property location pending confirmation';
        let serviceType = 'Lawn Care & Maintenance';
        let propertyType = 'Residential / Commercial';
        let preferredDate = null;
        let clientNotes = msg;

        const addrMatch = msg.match(/Address:\s*([^\n\r]+)/i);
        if (addrMatch) address = addrMatch[1].trim();

        const srvMatch = msg.match(/Service of Interest:\s*([^\n\r]+)/i);
        if (srvMatch) {
          const srvRaw = srvMatch[1].trim().toLowerCase();
          const srvLookup = {
            mowing: 'Precision Lawn Mowing & Edging',
            design: 'Landscape Design & Installation',
            seasonal: 'Seasonal Cleanup & Aeration',
            treatment: 'Turf Treatment & Fertilization',
            hedge: 'Hedge & Shrub Trimming',
            property: 'Commercial Grounds Management',
            consultation: 'General Consultation & Property Survey'
          };
          serviceType = srvLookup[srvRaw] || `Specialized Care (${srvMatch[1].trim()})`;
        } else if (msg.toLowerCase().includes('mow')) {
          serviceType = 'Precision Lawn Mowing & Edging';
        }

        const propTypeMatch = msg.match(/Property Type:\s*([^\n\r]+)/i);
        if (propTypeMatch) propertyType = propTypeMatch[1].trim();

        const dateMatch = msg.match(/Preferred Start Date:\s*([^\n\r]+)/i);
        if (dateMatch) preferredDate = dateMatch[1].trim();

        const title = `${serviceType} - ${clientName}`;
        const description = `Website Booking from lawncraft.vercel.app (Lead #${lead.id})\n\nType: ${propertyType}\nPreferred Date: ${preferredDate || 'Earliest Available'}\nCustomer Notes: ${clientNotes}`;

        const existingLeadWo = await dbGet('SELECT id, status FROM work_orders WHERE id = ?', [leadWoId]);
        if (!existingLeadWo) {
          await dbRun(`
            INSERT INTO work_orders (id, title, client_name, client_email, client_phone, property_address, service_type, status, priority, created_at, description)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [leadWoId, title, clientName, email, phone, address, serviceType, 'incoming', 'high', createdAt, description]);
          importedLeads++;
        }
      }
    }

    if (clients) importedClients = clients.length;
  } catch (err) {
    console.error('[Database] Notice during Supabase import:', err.message);
  }

  return {
    success: true,
    imported_work_orders: importedWorkOrders,
    imported_leads: importedLeads,
    imported_clients: importedClients
  };
}

export async function syncToSupabase() {
  const details = await getSupabaseDetails();
  if (!details.is_connected && !pgPool && !supabaseClient) {
    throw new Error(details.error || 'Supabase is not yet connected. Please configure SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY in Settings.');
  }

  console.log('[Database] Synchronizing local dataset to Supabase...');

  const workOrders = await dbAll('SELECT * FROM work_orders');
  const inventory = await dbAll('SELECT * FROM inventory_items');
  const payroll = await dbAll('SELECT * FROM payroll_entries');
  const invoices = await dbAll('SELECT * FROM invoices');
  const rules = await dbAll('SELECT * FROM automation_rules');
  const settings = await dbAll('SELECT * FROM system_settings');

  const syncedCounts = {};

  if (supabaseClient) {
    // 1. Sync work orders (adapting to Supabase columns)
    try {
      const { data: existingClients } = await supabaseClient.from('clients').select('id, name');
      const clientNameMap = new Map((existingClients || []).map(c => [c.name, c.id]));

      const supabaseWoRows = [];
      for (const wo of workOrders) {
        let clientId = clientNameMap.get(wo.client_name);
        if (!clientId) {
          try {
            const { data: newClient } = await supabaseClient.from('clients').insert([{
              name: wo.client_name,
              email: wo.client_email || null,
              phone: wo.client_phone || null
            }]).select();
            if (newClient && newClient[0]) {
              clientId = newClient[0].id;
              clientNameMap.set(wo.client_name, clientId);
            }
          } catch (_) {}
        }

        supabaseWoRows.push({
          id: wo.id,
          client_id: clientId || 1,
          status: wo.status === 'incoming' ? 'open' : wo.status,
          created_at: wo.created_at || new Date().toISOString()
        });
      }

      if (supabaseWoRows.length) {
        const { error: woSyncErr } = await supabaseClient.from('work_orders').upsert(supabaseWoRows);
        if (!woSyncErr) syncedCounts.work_orders = supabaseWoRows.length;
      }
    } catch (err) {
      console.warn('[Supabase Sync Warning] Work orders sync:', err.message);
    }

    // 2. Try syncing extended tables if created via SQL schema
    const trySyncTable = async (tableName, records) => {
      if (!records || !records.length) return;
      try {
        const { error } = await supabaseClient.from(tableName).upsert(records);
        if (!error) syncedCounts[tableName] = records.length;
      } catch (_) {}
    };

    await trySyncTable('inventory_items', inventory);
    await trySyncTable('payroll_entries', payroll);
    await trySyncTable('invoices', invoices);
    await trySyncTable('automation_rules', rules);
    await trySyncTable('system_settings', settings);
  }

  return {
    success: true,
    message: 'Supabase cloud synchronization completed successfully.',
    synced_counts: syncedCounts
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

  // Digital Quotes & Estimates (Shareable Customer Portals)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS quotes (
      id TEXT PRIMARY KEY,
      work_order_id INTEGER,
      client_name TEXT NOT NULL,
      client_email TEXT,
      client_phone TEXT,
      property_address TEXT NOT NULL,
      service_tier TEXT NOT NULL DEFAULT 'Deluxe Grounds Care',
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      tax REAL NOT NULL DEFAULT 0,
      discount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      signature_name TEXT,
      signature_svg TEXT,
      signed_at TEXT,
      notes TEXT,
      valid_until TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Work Order Before & After Photos (Proof of Work)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS work_order_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL,
      photo_type TEXT NOT NULL,
      photo_url TEXT NOT NULL,
      caption TEXT,
      uploaded_at TEXT NOT NULL,
      uploaded_by TEXT
    )
  `);

  // Recurring Maintenance Contracts & Subscriptions
  await dbRun(`
    CREATE TABLE IF NOT EXISTS recurring_contracts (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      client_email TEXT,
      client_phone TEXT,
      property_address TEXT NOT NULL,
      service_type TEXT NOT NULL,
      frequency TEXT NOT NULL DEFAULT 'bi_weekly',
      rate_per_visit REAL NOT NULL DEFAULT 120.00,
      status TEXT NOT NULL DEFAULT 'active',
      next_scheduled_date TEXT,
      assigned_crew TEXT,
      notes TEXT,
      auto_generate_wo INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);

  // Client CRM & Property Profiles
  await dbRun(`
    CREATE TABLE IF NOT EXISTS client_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      email TEXT,
      phone TEXT,
      property_address TEXT,
      zone TEXT DEFAULT 'North Zone',
      property_size_sqft REAL DEFAULT 5000,
      grass_type TEXT DEFAULT 'Kentucky Bluegrass / Fine Fescue',
      gate_code TEXT DEFAULT '',
      special_instructions TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      total_spend REAL DEFAULT 0,
      last_service_date TEXT,
      review_status TEXT DEFAULT 'not_requested',
      created_at TEXT NOT NULL
    )
  `);

  // Customer Review Requests
  await dbRun(`
    CREATE TABLE IF NOT EXISTS review_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER,
      client_name TEXT NOT NULL,
      client_phone TEXT,
      client_email TEXT,
      channel TEXT DEFAULT 'whatsapp',
      rating INTEGER DEFAULT 5,
      feedback_text TEXT,
      status TEXT DEFAULT 'sent',
      sent_at TEXT NOT NULL
    )
  `);

  // ── Odoo ERP Enterprise Extensions ─────────────────────────

  // 1. M-Pesa & Multi-Gateway Transactions (Lipa Na M-Pesa Online / STK Push)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS mpesa_transactions (
      id TEXT PRIMARY KEY,
      invoice_id TEXT,
      work_order_id INTEGER,
      phone_number TEXT NOT NULL,
      amount REAL NOT NULL,
      mpesa_receipt_number TEXT UNIQUE,
      transaction_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result_desc TEXT,
      customer_name TEXT,
      account_reference TEXT,
      checkout_request_id TEXT UNIQUE,
      created_at TEXT NOT NULL
    )
  `);

  // 2. C2B / Paybill / Till Number Reconciliation Ledger
  await dbRun(`
    CREATE TABLE IF NOT EXISTS c2b_transactions (
      id TEXT PRIMARY KEY,
      trans_id TEXT UNIQUE NOT NULL,
      trans_time TEXT NOT NULL,
      trans_amount REAL NOT NULL,
      business_short_code TEXT NOT NULL DEFAULT '522522',
      bill_ref_number TEXT NOT NULL,
      msisdn TEXT NOT NULL,
      first_name TEXT,
      matched_invoice_id TEXT,
      reconciled_status TEXT NOT NULL DEFAULT 'unmatched',
      reconciled_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // 3. Customer Loyalty Accounts & Rewards Engine
  await dbRun(`
    CREATE TABLE IF NOT EXISTS loyalty_accounts (
      id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      client_phone TEXT,
      client_email TEXT,
      points_balance INTEGER NOT NULL DEFAULT 0,
      lifetime_points_earned INTEGER NOT NULL DEFAULT 0,
      lifetime_points_redeemed INTEGER NOT NULL DEFAULT 0,
      tier TEXT NOT NULL DEFAULT 'bronze',
      referral_code TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 4. Loyalty Points Ledger / Audit Trail
  await dbRun(`
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      type TEXT NOT NULL,
      points INTEGER NOT NULL,
      invoice_id TEXT,
      work_order_id INTEGER,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // 5. Digital Promo Coupons & Referral Discounts
  await dbRun(`
    CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY,
      discount_type TEXT NOT NULL DEFAULT 'percentage',
      discount_value REAL NOT NULL,
      min_spend REAL DEFAULT 0,
      max_discount REAL DEFAULT 100,
      usage_limit INTEGER DEFAULT 100,
      times_used INTEGER DEFAULT 0,
      valid_until TEXT,
      is_active INTEGER DEFAULT 1,
      description TEXT NOT NULL
    )
  `);

  // 6. Fleet & Equipment Asset Management (Odoo Fleet)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS equipment_fleet (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      serial_number TEXT,
      model_year INTEGER DEFAULT 2024,
      meter_hours REAL DEFAULT 0,
      fuel_type TEXT DEFAULT 'Gasoline',
      status TEXT NOT NULL DEFAULT 'operational',
      assigned_crew TEXT,
      last_maintenance_date TEXT,
      next_service_hours REAL DEFAULT 50,
      notes TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // 7. Fleet Maintenance & Fuel Logs
  await dbRun(`
    CREATE TABLE IF NOT EXISTS fleet_maintenance_logs (
      id TEXT PRIMARY KEY,
      equipment_id TEXT NOT NULL,
      log_type TEXT NOT NULL,
      cost REAL NOT NULL DEFAULT 0,
      performed_by TEXT NOT NULL,
      odometer_hours REAL NOT NULL,
      notes TEXT,
      logged_at TEXT NOT NULL
    )
  `);

  // 8. GPS Geo-Fenced Timesheets & Clock-in (Odoo Timesheets)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS gps_timesheets (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      employee_name TEXT NOT NULL,
      work_order_id INTEGER,
      property_address TEXT,
      clock_in_time TEXT NOT NULL,
      clock_out_time TEXT,
      clock_in_lat REAL,
      clock_in_lng REAL,
      geo_distance_meters REAL DEFAULT 0,
      geo_status TEXT NOT NULL DEFAULT 'verified_on_site',
      total_minutes REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // 9. Vendor Bills & Purchase Orders (Odoo Purchase)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS vendor_purchase_orders (
      id TEXT PRIMARY KEY,
      vendor_name TEXT NOT NULL,
      vendor_contact TEXT,
      order_date TEXT NOT NULL,
      expected_delivery TEXT,
      status TEXT NOT NULL DEFAULT 'approved',
      total_amount REAL NOT NULL DEFAULT 0,
      notes TEXT,
      received_at TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // 10. Purchase Order Line Items
  await dbRun(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id TEXT NOT NULL,
      inventory_item_id TEXT,
      item_name TEXT NOT NULL,
      quantity_ordered REAL NOT NULL DEFAULT 1,
      quantity_received REAL NOT NULL DEFAULT 0,
      unit_cost REAL NOT NULL DEFAULT 0,
      line_total REAL NOT NULL DEFAULT 0
    )
  `);

  // 11. Automated Dunning & Overdue Reminders (Odoo Dunning)
  await dbRun(`
    CREATE TABLE IF NOT EXISTS dunning_logs (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      client_name TEXT NOT NULL,
      client_email TEXT,
      client_phone TEXT,
      stage TEXT NOT NULL,
      sent_via TEXT NOT NULL DEFAULT 'whatsapp',
      payment_link TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'dispatched',
      sent_at TEXT NOT NULL
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

  // Seed Quotes if empty
  const quotesCount = (await dbGet('SELECT COUNT(*) as cnt FROM quotes'))?.cnt || 0;
  if (quotesCount === 0) {
    await dbRun(`
      INSERT INTO quotes (id, work_order_id, client_name, client_email, client_phone, property_address, service_tier, items_json, subtotal, tax, discount, total_amount, status, notes, valid_until, created_at)
      VALUES
        ('QTE-2026-001', 101, 'Eleanor Vance', 'eleanor.vance@example.com', '(555) 234-5678', '742 Evergreen Terrace, Springfield', 'Deluxe Turf Care Package', 
        '[{"description":"Core Aeration (Double Pass 8,000 sq ft)","quantity":1,"unit_price":280.00,"amount":280.00},{"description":"Premium Turf-Type Tall Fescue Overseed (25 lbs)","quantity":1,"unit_price":145.00,"amount":145.00},{"description":"Starter Fertilizer & Moisture Retainer Application","quantity":1,"unit_price":95.00,"amount":95.00}]',
        520.00, 33.80, 25.00, 528.80, 'sent', 'Includes 14-day germination guarantee and watering schedule plan.', '2026-09-15', '2026-08-27T10:00:00Z'),
        
        ('QTE-2026-002', 102, 'Apex Industrial Park', 'facilities@apexpark.com', '(555) 890-1234', '1200 Innovation Way, Tech Park', 'Commercial Master Grounds Agreement',
        '[{"description":"Commercial Campus Grounds Assessment & Soil Chemistry Testing","quantity":1,"unit_price":450.00,"amount":450.00},{"description":"Custom Nitrogen/Iron Soil Amendment & Organic Weed Suppressant","quantity":1,"unit_price":1200.00,"amount":1200.00},{"description":"Full Perimeter Shrubbery Precision Pruning","quantity":1,"unit_price":620.00,"amount":620.00}]',
        2270.00, 147.55, 0.00, 2417.55, 'approved', 'Signed by Director of Facilities. Work scheduled for Sept 3.', '2026-09-30', '2026-08-26T12:00:00Z'),

        ('QTE-2026-003', 105, 'Dr. Gregory House', 'ghouse@example.com', '(555) 321-7654', '15 Meadowbrook Lane, Westend', 'Estate Landscape Enhancement',
        '[{"description":"Premium Dark Cedar Bark Mulch (10 Cubic Yards Delivered)","quantity":10,"unit_price":65.00,"amount":650.00},{"description":"Weed Barrier Fabric Installation & Bed Trench Edging","quantity":1,"unit_price":420.00,"amount":420.00},{"description":"Perennial Shrub Trimming & Bed Cleanup","quantity":1,"unit_price":310.00,"amount":310.00}]',
        1380.00, 89.70, 50.00, 1419.70, 'draft', 'Pending client selection of cedar vs pine mulch color.', '2026-09-20', '2026-08-28T14:30:00Z')
    `);
  }

  // Seed Work Order Photos if empty
  const photosCount = (await dbGet('SELECT COUNT(*) as cnt FROM work_order_photos'))?.cnt || 0;
  if (photosCount === 0) {
    await dbRun(`
      INSERT INTO work_order_photos (work_order_id, photo_type, photo_url, caption, uploaded_at, uploaded_by)
      VALUES
        (109, 'before', 'https://images.unsplash.com/photo-1592417817038-d13fd7342605?w=800&auto=format&fit=crop', 'Original dead patchy Bermuda grass prior to excavation', '2026-08-24T07:45:00Z', 'marcus.crew@lawncraft.com'),
        (109, 'after', 'https://images.unsplash.com/photo-1558904541-efa843a96f01?w=800&auto=format&fit=crop', 'Lush Kentucky Bluegrass sod newly installed and roll-pressed', '2026-08-24T16:30:00Z', 'marcus.crew@lawncraft.com'),
        (108, 'after', 'https://images.unsplash.com/photo-1560749003-f4b1e17e2dff?w=800&auto=format&fit=crop', 'Smart 12-zone controller installed in weatherproof garage enclosure', '2026-08-25T11:15:00Z', 'elena.tech@lawncraft.com'),
        (106, 'before', 'https://images.unsplash.com/photo-1523348837708-15d4a09cfac2?w=800&auto=format&fit=crop', 'Eroded hill terrace bank before hydroseed tackifier slurry', '2026-08-27T08:40:00Z', 'marcus.crew@lawncraft.com')
    `);
  }

  // Seed Recurring Contracts if empty
  const contractsCount = (await dbGet('SELECT COUNT(*) as cnt FROM recurring_contracts'))?.cnt || 0;
  if (contractsCount === 0) {
    await dbRun(`
      INSERT INTO recurring_contracts (id, client_name, client_email, client_phone, property_address, service_type, frequency, rate_per_visit, status, next_scheduled_date, assigned_crew, notes, auto_generate_wo, created_at)
      VALUES
        ('REC-2026-001', 'Riverstone Retail Center', 'mgmt@riverstoneretail.com', '(555) 789-0123', '400 Commercial Blvd, Riverstone', 'Commercial Grounds Maintenance', 'weekly', 350.00, 'active', '2026-09-07', 'Team Alpha (Marcus Vance)', 'Weekly Monday morning service prior to retail store opening at 9:30 AM.', 1, '2026-08-01T08:00:00Z'),
        ('REC-2026-002', 'Greenfield Apartments HOA', 'hoa@greenfieldapts.org', '(555) 456-7890', '150 Greenfield Parkway, North Hills', 'Lawn Mowing & Shrub Maintenance', 'bi_weekly', 480.00, 'active', '2026-09-08', 'Team Beta (Elena Rostova)', 'Bi-weekly turf mowing, edge trimming, courtyard leaf blowing.', 1, '2026-08-05T09:00:00Z'),
        ('REC-2026-003', 'Sophia Martinez', 'sophia.m@example.com', '(555) 678-9012', '45 Magnolia Drive, Blossom Hills', 'Residential Lawn Care & Edge Trimming', 'bi_weekly', 115.00, 'active', '2026-09-10', 'Team Alpha (Marcus Vance)', 'Side yard gate has combination lock #1288.', 1, '2026-08-10T10:00:00Z'),
        ('REC-2026-004', 'Northgate Office Park', 'admin@northgatepark.com', '(555) 234-8901', '800 Northgate Expressway, Northgate', 'Full Commercial Estate Grounds Care', 'weekly', 620.00, 'active', '2026-09-09', 'Team Alpha (Marcus Vance)', 'Includes retention basin weed mitigation and quarterly flower rotation.', 1, '2026-08-12T11:00:00Z')
    `);
  }

  // Seed Client Profiles if empty
  const clientsCount = (await dbGet('SELECT COUNT(*) as cnt FROM client_profiles'))?.cnt || 0;
  if (clientsCount === 0) {
    await dbRun(`
      INSERT INTO client_profiles (name, email, phone, property_address, zone, property_size_sqft, grass_type, gate_code, special_instructions, status, total_spend, last_service_date, review_status, created_at)
      VALUES
        ('Eleanor Vance', 'eleanor.vance@example.com', '(555) 234-5678', '742 Evergreen Terrace, Springfield', 'North Zone', 8200, 'Kentucky Bluegrass / Fine Fescue', '#4491', 'Keep back gate latched; golden retriever inside.', 'active', 1240.00, '2026-08-25', 'requested', '2026-08-01T08:00:00Z'),
        ('Apex Industrial Park', 'facilities@apexpark.com', '(555) 890-1234', '1200 Innovation Way, Tech Park', 'East Zone', 45000, 'Bermuda Hybrid / Tall Fescue', 'Security Guard Check-in', 'Wear high-visibility vests at all times.', 'active', 7650.00, '2026-08-26', 'reviewed', '2026-07-15T09:00:00Z'),
        ('Arthur Pendelton', 'arthur.p@example.com', '(555) 567-8901', '220 King William Street, Old Town', 'South Zone', 4200, 'Fresh Kentucky Bluegrass Sod', '#0072', 'Please avoid parking trucks on newly laid driveway pavers.', 'active', 4260.00, '2026-08-24', 'reviewed', '2026-08-18T10:00:00Z'),
        ('Hannah Abbott', 'hannah.a@example.com', '(555) 901-2345', '52 Sycamore Grove, Eastlake', 'East Zone', 6500, 'Perennial Ryegrass / Fescue', 'None', 'Irrigation shutoff valve is located behind the side shed.', 'active', 1450.00, '2026-08-25', 'not_requested', '2026-08-19T14:00:00Z'),
        ('Claire Underwood', 'claire.u@example.com', '(555) 789-0123', '304 Highland Summit, Ridgeway', 'West Zone', 12000, 'Sun/Shade Slurry Hydroseed', '#9921', 'Steep slope on north bank; use extra caution with heavy mowers.', 'active', 2639.13, '2026-08-27', 'not_requested', '2026-08-22T10:00:00Z'),
        ('David Chen', 'david.chen@example.com', '(555) 234-8901', '912 Oakridge Boulevard, Greenfield', 'North Zone', 7400, 'Tall Fescue / Bluegrass Blend', 'Side Latch', 'Organic weed control preferred due to organic vegetable garden.', 'active', 1820.00, '2026-08-27', 'requested', '2026-08-21T09:00:00Z'),
        ('Dr. Gregory House', 'ghouse@example.com', '(555) 321-7654', '15 Meadowbrook Lane, Westend', 'West Zone', 9500, 'Fine Fescue / Zoysia', '#3141', 'Do not mow near rose bushes on the south pergola.', 'active', 890.00, '2026-08-23', 'not_requested', '2026-08-23T15:20:00Z')
    `);
  }

  // Seed Loyalty Accounts if empty
  const loyaltyCount = (await dbGet('SELECT COUNT(*) as cnt FROM loyalty_accounts'))?.cnt || 0;
  if (loyaltyCount === 0) {
    await dbRun(`
      INSERT INTO loyalty_accounts (id, client_name, client_phone, client_email, points_balance, lifetime_points_earned, lifetime_points_redeemed, tier, referral_code, created_at, updated_at)
      VALUES
        ('ACC-LOYAL-001', 'Eleanor Vance', '254712345678', 'eleanor.vance@example.com', 185, 235, 50, 'silver', 'REF-ELEANOR', '2026-08-01T08:00:00Z', '2026-08-25T14:00:00Z'),
        ('ACC-LOYAL-002', 'Apex Industrial Park', '254722998877', 'facilities@apexpark.com', 760, 760, 0, 'platinum', 'REF-APEXVIP', '2026-07-15T09:00:00Z', '2026-08-26T12:00:00Z'),
        ('ACC-LOYAL-003', 'Arthur Pendelton', '254700554433', 'arthur.p@example.com', 420, 420, 0, 'gold', 'REF-ARTHUR', '2026-08-18T10:00:00Z', '2026-08-24T16:00:00Z'),
        ('ACC-LOYAL-004', 'Hannah Abbott', '254733112233', 'hannah.a@example.com', 95, 95, 0, 'bronze', 'REF-HANNAH', '2026-08-19T14:00:00Z', '2026-08-25T11:00:00Z'),
        ('ACC-LOYAL-005', 'Sophia Martinez', '254711887766', 'sophia.m@example.com', 210, 210, 0, 'silver', 'REF-SOPHIA', '2026-08-10T10:00:00Z', '2026-08-24T08:00:00Z')
    `);

    // Seed Loyalty Transactions
    await dbRun(`
      INSERT INTO loyalty_transactions (id, account_id, type, points, invoice_id, work_order_id, description, created_at)
      VALUES
        ('LTX-101', 'ACC-LOYAL-001', 'earn', 124, 'INV-2026-001', 101, 'Earned 124 points for Aeration & Overseeding Service ($1,240 spend)', '2026-08-25T11:00:00Z'),
        ('LTX-102', 'ACC-LOYAL-001', 'redeem', -50, 'INV-2026-001', 101, 'Redeemed 50 points for $25.00 discount on overseeding package', '2026-08-25T11:30:00Z'),
        ('LTX-103', 'ACC-LOYAL-002', 'earn', 760, 'INV-2026-004', 102, 'Earned 760 points for Commercial Grounds Retainer ($7,600 spend)', '2026-08-26T12:00:00Z'),
        ('LTX-104', 'ACC-LOYAL-003', 'earn', 420, 'INV-2026-001', 109, 'Earned 420 points for Full Turf Sodding Project ($4,200 spend)', '2026-08-24T16:00:00Z')
    `);
  }

  // Seed Promo Coupons
  const couponsCount = (await dbGet('SELECT COUNT(*) as cnt FROM coupons'))?.cnt || 0;
  if (couponsCount === 0) {
    await dbRun(`
      INSERT INTO coupons (code, discount_type, discount_value, min_spend, max_discount, usage_limit, times_used, valid_until, is_active, description)
      VALUES
        ('SUMMER20', 'percentage', 20.0, 100.0, 150.0, 100, 14, '2026-09-30', 1, '20% off all seasonal lawn care and mulch packages over $100'),
        ('EARLYBIRD15', 'percentage', 15.0, 50.0, 75.0, 200, 38, '2026-10-31', 1, '15% early bird booking discount for aerations and fall cleanup'),
        ('VIPLAWN10', 'percentage', 10.0, 0.0, 500.0, 500, 22, '2026-12-31', 1, '10% recurring client loyalty discount'),
        ('KES1000OFF', 'fixed', 10.0, 80.0, 10.0, 150, 19, '2026-09-30', 1, '$10 (KES 1,300) instant credit on first M-Pesa or POS payment')
    `);
  }

  // Seed M-Pesa Transactions
  const mpesaCount = (await dbGet('SELECT COUNT(*) as cnt FROM mpesa_transactions'))?.cnt || 0;
  if (mpesaCount === 0) {
    await dbRun(`
      INSERT INTO mpesa_transactions (id, invoice_id, work_order_id, phone_number, amount, mpesa_receipt_number, transaction_date, status, result_desc, customer_name, account_reference, checkout_request_id, created_at)
      VALUES
        ('TXN-MP-001', 'INV-2026-001', 109, '254700554433', 4260.00, 'QK89X4J21A', '2026-08-25T11:05:22Z', 'completed', 'The service request is processed successfully.', 'Arthur Pendelton', 'INV-2026-001', 'ws_CO_25082026110522001', '2026-08-25T11:05:00Z'),
        ('TXN-MP-002', 'INV-2026-002', 108, '254733112233', 748.16, 'QK91B7K82M', '2026-08-26T09:42:15Z', 'completed', 'The service request is processed successfully.', 'Hannah Abbott', 'INV-2026-002', 'ws_CO_26082026094215002', '2026-08-26T09:42:00Z'),
        ('TXN-MP-003', 'INV-2026-003', 106, '254712345678', 500.00, 'QL02H9N44P', '2026-08-27T08:15:30Z', 'completed', 'Deposit payment processed via Lipa Na M-Pesa Online.', 'Claire Underwood', 'INV-2026-003', 'ws_CO_27082026081530003', '2026-08-27T08:15:00Z')
    `);
  }

  // Seed C2B / Paybill Reconciliation Ledger
  const c2bCount = (await dbGet('SELECT COUNT(*) as cnt FROM c2b_transactions'))?.cnt || 0;
  if (c2bCount === 0) {
    await dbRun(`
      INSERT INTO c2b_transactions (id, trans_id, trans_time, trans_amount, business_short_code, bill_ref_number, msisdn, first_name, matched_invoice_id, reconciled_status, reconciled_at, notes, created_at)
      VALUES
        ('C2B-001', 'QK89X4J21A', '2026-08-25 11:05:22', 4260.00, '522522', 'INV-2026-001', '254700554433', 'Arthur', 'INV-2026-001', 'reconciled', '2026-08-25T11:06:00Z', 'Auto-matched by Invoice Number account reference.', '2026-08-25T11:05:22Z'),
        ('C2B-002', 'QK91B7K82M', '2026-08-26 09:42:15', 748.16, '522522', 'INV-2026-002', '254733112233', 'Hannah', 'INV-2026-002', 'reconciled', '2026-08-26T09:43:00Z', 'Auto-matched by Invoice Number account reference.', '2026-08-26 09:42:15'),
        ('C2B-003', 'QL14M2P89Z', '2026-08-27 10:18:40', 350.00, '522522', 'WO-104', '254711887766', 'Sophia', 'INV-2026-003', 'unmatched', NULL, 'Pending manual supervisor allocation to Work Order #104 retainer.', '2026-08-27 10:18:40')
    `);
  }

  // Seed Equipment Fleet (Odoo Fleet)
  const fleetCount = (await dbGet('SELECT COUNT(*) as cnt FROM equipment_fleet'))?.cnt || 0;
  if (fleetCount === 0) {
    await dbRun(`
      INSERT INTO equipment_fleet (id, name, category, serial_number, model_year, meter_hours, fuel_type, status, assigned_crew, last_maintenance_date, next_service_hours, notes, created_at)
      VALUES
        ('EQ-MOW-01', 'Toro Z Master 6000 Commercial (60" Deck)', 'Zero-Turn Mower', 'TOR-ZM-8841', 2024, 184.5, 'Gasoline', 'operational', 'Team Alpha (Marcus Vance)', '2026-08-20', 200.0, 'Blades balanced and sharpened at 150 hrs. Excellent cutting performance.', '2026-06-01T08:00:00Z'),
        ('EQ-MOW-02', 'Scag Cheetah II 61" Velocity Plus', 'Zero-Turn Mower', 'SCG-CH-9923', 2023, 312.0, 'Gasoline', 'operational', 'Team Beta (Elena Rostova)', '2026-08-15', 350.0, 'High-speed commercial unit for estate contracts.', '2026-05-10T08:00:00Z'),
        ('EQ-AER-01', 'Billy Goat 30" Stand-On Hydro Aerator', 'Stand-on Aerator', 'BG-AER-4412', 2024, 62.0, 'Gasoline', 'operational', 'Team Alpha (Marcus Vance)', '2026-08-22', 100.0, 'Core aerator tines replaced with hardened steel set.', '2026-07-01T08:00:00Z'),
        ('EQ-TRK-01', 'Ford F-350 Super Duty Service Truck & Trailer', 'Truck / Utility Vehicle', '1FT8W3B-TRK1', 2023, 1420.0, 'Diesel', 'operational', 'Team Alpha (Marcus Vance)', '2026-08-10', 1500.0, 'Equipped with 300-gal hydroseed tank and ramp trailer.', '2026-04-15T08:00:00Z'),
        ('EQ-HYD-01', 'Finn HydroSeeder T60 Tanker Unit (600 Gal)', 'Hydroseeder Rig', 'FINN-T60-551', 2023, 98.4, 'Diesel', 'in_service', 'Team Alpha (Marcus Vance)', '2026-08-18', 120.0, 'Agitator paddle seals serviced. Deployed on Highland Summit.', '2026-06-15T08:00:00Z'),
        ('EQ-TRM-01', 'Stihl FS 131 Professional String Trimmer', 'String Trimmer', 'STH-FS131-01', 2024, 45.0, 'Gasoline 2-Stroke', 'operational', 'Team Beta (Elena Rostova)', '2026-08-24', 60.0, '0.095 line spool pre-loaded.', '2026-07-10T08:00:00Z')
    `);

    // Seed Fleet Maintenance Logs
    await dbRun(`
      INSERT INTO fleet_maintenance_logs (id, equipment_id, log_type, cost, performed_by, odometer_hours, notes, logged_at)
      VALUES
        ('FML-101', 'EQ-MOW-01', 'blade_sharpening', 45.00, 'Marcus Vance', 150.0, 'Re-sharpened 3 high-lift mulching blades and greased spindle bearings.', '2026-08-20T17:00:00Z'),
        ('FML-102', 'EQ-TRK-01', 'oil_change', 120.00, 'Fleet Service Center', 1350.0, 'Synthetic diesel motor oil change and fuel filter replacement.', '2026-08-10T14:30:00Z'),
        ('FML-103', 'EQ-AER-01', 'routine_service', 185.00, 'Elena Rostova', 60.0, 'Installed fresh heat-treated aeration coring tines and calibrated hydraulic down-pressure.', '2026-08-22T16:00:00Z')
    `);
  }

  // Seed GPS Geo-Fenced Timesheets (Odoo Timesheets)
  const timesheetCount = (await dbGet('SELECT COUNT(*) as cnt FROM gps_timesheets'))?.cnt || 0;
  if (timesheetCount === 0) {
    await dbRun(`
      INSERT INTO gps_timesheets (id, user_id, employee_name, work_order_id, property_address, clock_in_time, clock_out_time, clock_in_lat, clock_in_lng, geo_distance_meters, geo_status, total_minutes, notes, created_at)
      VALUES
        ('TS-GPS-001', 3, 'Marcus Vance', 109, '220 King William Street, Old Town', '2026-08-24T07:30:00Z', '2026-08-24T16:45:00Z', -1.286389, 36.817223, 14.2, 'verified_on_site', 555.0, 'On-site turf installation completed on schedule.', '2026-08-24T07:30:00Z'),
        ('TS-GPS-002', 4, 'Elena Rostova', 108, '52 Sycamore Grove, Eastlake', '2026-08-25T09:00:00Z', '2026-08-25T11:30:00Z', -1.292066, 36.821946, 8.5, 'verified_on_site', 150.0, 'Controller wiring and Wi-Fi pairing verified within 10m of controller box.', '2026-08-25T09:00:00Z'),
        ('TS-GPS-003', 3, 'Marcus Vance', 106, '304 Highland Summit, Ridgeway', '2026-08-27T08:30:00Z', NULL, -1.303250, 36.804100, 22.0, 'verified_on_site', 240.0, 'Currently active on slope tackifier hydroseeding pass.', '2026-08-27T08:30:00Z')
    `);
  }

  // Seed Vendor Purchase Orders (Odoo Purchase)
  const poCount = (await dbGet('SELECT COUNT(*) as cnt FROM vendor_purchase_orders'))?.cnt || 0;
  if (poCount === 0) {
    await dbRun(`
      INSERT INTO vendor_purchase_orders (id, vendor_name, vendor_contact, order_date, expected_delivery, status, total_amount, notes, received_at, created_at)
      VALUES
        ('PO-2026-001', 'GreenValley Seeds Co.', 'orders@greenvalleyseeds.com', '2026-08-18', '2026-08-20', 'received', 2125.00, '25 bags Kentucky Bluegrass seed certified 0% weed seed.', '2026-08-20T14:00:00Z', '2026-08-18T09:00:00Z'),
        ('PO-2026-002', 'HydroFlow Systems', 'supply@hydroflowparts.com', '2026-08-26', '2026-08-30', 'approved', 480.00, '20x Hunter 1" Solenoid Sprinkler Valves to replenish safety inventory buffer.', NULL, '2026-08-26T08:30:00Z'),
        ('PO-2026-003', 'BioTurf Organics Ltd.', 'wholesale@bioturforganics.com', '2026-08-24', '2026-08-29', 'approved', 1300.00, '40 bags slow-release 24-4-12 organic turf fertilizer.', NULL, '2026-08-24T11:00:00Z')
    `);

    // Seed Purchase Order Items
    await dbRun(`
      INSERT INTO purchase_order_items (po_id, inventory_item_id, item_name, quantity_ordered, quantity_received, unit_cost, line_total)
      VALUES
        ('PO-2026-001', 'INV-ITM-001', 'Kentucky Bluegrass Premium Seed (50lb bag)', 25, 25, 85.00, 2125.00),
        ('PO-2026-002', 'INV-ITM-003', 'Hunter 1" Solenoid Sprinkler Valves', 20, 0, 24.00, 480.00),
        ('PO-2026-003', 'INV-ITM-002', 'Organic Slow-Release Fertilizer (24-4-12)', 40, 0, 32.50, 1300.00)
    `);
  }

  // Seed Automated Dunning Reminders (Odoo Dunning)
  const dunningCount = (await dbGet('SELECT COUNT(*) as cnt FROM dunning_logs'))?.cnt || 0;
  if (dunningCount === 0) {
    await dbRun(`
      INSERT INTO dunning_logs (id, invoice_id, client_name, client_email, client_phone, stage, sent_via, payment_link, status, sent_at)
      VALUES
        ('DUN-001', 'INV-2026-004', 'Apex Industrial Park', 'facilities@apexpark.com', '254722998877', 'overdue_notice_7d', 'whatsapp', 'https://ais-pre-2r565755mktnute2mkiant-69525622808.europe-west2.run.app/pay/INV-2026-004', 'dispatched', '2026-08-27T08:00:00Z')
    `);
  }
}

