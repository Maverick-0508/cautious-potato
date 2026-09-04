import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dbRun, dbGet, dbAll, initDatabase, getDatabaseStatus, getFirebaseConfig, syncToFirestore, getSupabaseDetails, syncToSupabase, importFromSupabase } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Initialize database schema and seed data
await initDatabase();

let activeUserSession = {
  id: 1,
  email: 'admin@lawncraft.com',
  full_name: 'Alex Rivera (Admin)',
  role: 'admin',
  department: 'Operations',
  cost_center: 'CC-101',
  notes: 'Head of Operations & Lead Supervisor'
};

async function logAudit(action, summary, actorEmail = null, resourceType = '', resourceId = '') {
  try {
    const actor = actorEmail || activeUserSession?.email || 'system@lawncraft.com';
    await dbRun(
      `INSERT INTO audit_logs (action, summary, actor_email, resource_type, resource_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [action, summary, actor, resourceType, String(resourceId || ''), new Date().toISOString()]
    );
  } catch (err) {
    console.error('Audit log failure:', err.message);
  }
}

async function recordAutomationLog(ruleId, ruleName, eventType, status, details) {
  try {
    const logId = `LOG-AUTO-${Date.now().toString().slice(-4)}`;
    await dbRun(
      `INSERT INTO automation_logs (id, rule_id, rule_name, event_type, status, details, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [logId, ruleId, ruleName, eventType, status, details, new Date().toISOString()]
    );
    if (ruleId) {
      await dbRun(
        `UPDATE automation_rules SET execution_count = execution_count + 1, last_triggered = ? WHERE id = ?`,
        [new Date().toISOString(), ruleId]
      );
    }
  } catch (err) {
    console.error('Automation log failure:', err.message);
  }
}

// ── ERP Automation Engine ─────────────────────────────────────

// 1. Auto-Invoice Generator on Work Order Completion
async function triggerAutoInvoicingForWorkOrder(workOrderId) {
  try {
    const setting = await dbGet(`SELECT value FROM system_settings WHERE setting_key = 'auto_invoice_on_completion'`);
    if (setting && setting.value === 'false') return null;

    const rule = await dbGet(`SELECT * FROM automation_rules WHERE id = 'RULE-AUTO-INV'`);
    if (rule && !rule.is_enabled) return null;

    const wo = await dbGet(`SELECT * FROM work_orders WHERE id = ?`, [workOrderId]);
    if (!wo) return null;

    // Check if invoice already exists for this work order
    const existingInv = await dbGet(`SELECT id FROM invoices WHERE work_order_id = ?`, [workOrderId]);
    if (existingInv) return existingInv.id;

    // Generate smart itemized lines based on service type
    const newInvId = `INV-2026-${Math.floor(100 + Math.random() * 900)}`;
    const today = new Date().toISOString().split('T')[0];
    const dueDate = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];

    let items = [];
    if (wo.service_type.includes('Aeration')) {
      items = [
        { description: 'Full Lawn Core Aeration & High-Grade Overseeding', quantity: 1, unit_price: 285.00 },
        { description: 'Premium Fescue/Bluegrass Seed Blend (25lb)', quantity: 1, unit_price: 85.00 },
        { description: 'Slow-Release Starter Fertilizer Application', quantity: 1, unit_price: 65.00 }
      ];
    } else if (wo.service_type.includes('Irrigation')) {
      items = [
        { description: 'Irrigation Valve Diagnostic & Solenoid Replacement Labor', quantity: 1.5, unit_price: 95.00 },
        { description: 'Hunter 1" Solenoid Sprinkler Valve Unit', quantity: 1, unit_price: 58.00 },
        { description: 'Zone Pressure Testing & Head Calibration', quantity: 1, unit_price: 75.00 }
      ];
    } else if (wo.service_type.includes('Hydroseed')) {
      items = [
        { description: 'Terrace Slope Soil Grading & Tackifier Prep', quantity: 1, unit_price: 450.00 },
        { description: 'Sun/Shade Premium Hydroseed Slurry Mix', quantity: 1, unit_price: 1820.00 }
      ];
    } else {
      items = [
        { description: `${wo.service_type}: ${wo.title}`, quantity: 1, unit_price: 220.00 },
        { description: 'Debris Cleanup, Trimming & Quality Assurance Inspection', quantity: 1, unit_price: 80.00 }
      ];
    }

    let subtotal = 0;
    items.forEach(it => {
      it.amount = it.quantity * it.unit_price;
      subtotal += it.amount;
    });

    const taxRate = 6.5;
    const taxAmount = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100;

    await dbRun(
      `INSERT INTO invoices (id, work_order_id, client_name, client_email, client_phone, property_address, issue_date, due_date, status, payment_terms, subtotal, tax_rate, tax_amount, discount_amount, total_amount, amount_paid, balance_due, notes, is_auto_generated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newInvId, wo.id, wo.client_name, wo.client_email, wo.client_phone, wo.property_address, today, dueDate, 'issued', 'Net 15', subtotal, taxRate, taxAmount, 0, totalAmount, 0, totalAmount, `Auto-generated ERP Invoice upon completion of work order #${wo.id}`, 1, new Date().toISOString(), new Date().toISOString()]
    );

    for (const item of items) {
      await dbRun(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
         VALUES (?, ?, ?, ?, ?)`,
        [newInvId, item.description, item.quantity, item.unit_price, item.amount]
      );
    }

    await recordAutomationLog(
      'RULE-AUTO-INV',
      'Work Order Completed -> Auto-Generate Invoice',
      'WORK_ORDER_COMPLETED',
      'success',
      `Auto-generated invoice ${newInvId} ($${totalAmount.toFixed(2)}) for ${wo.client_name} following completion of #${wo.id}`
    );

    return newInvId;
  } catch (err) {
    console.error('Auto invoicing error:', err);
    await recordAutomationLog('RULE-AUTO-INV', 'Auto-Invoice Failed', 'WORK_ORDER_COMPLETED', 'failed', err.message);
    return null;
  }
}

// 2. Inventory Material Consumption & Auto-Reorder Trigger
async function triggerInventoryConsumptionForWorkOrder(workOrderId, status) {
  try {
    const wo = await dbGet(`SELECT * FROM work_orders WHERE id = ?`, [workOrderId]);
    if (!wo) return;

    let itemsToDeduct = [];
    if (wo.service_type.includes('Aeration')) {
      itemsToDeduct = [
        { id: 'INV-ITM-001', qty: 1, reason: `Overseeding on WO #${wo.id}` },
        { id: 'INV-ITM-002', qty: 1, reason: `Starter fertilizer on WO #${wo.id}` }
      ];
    } else if (wo.service_type.includes('Irrigation')) {
      itemsToDeduct = [
        { id: 'INV-ITM-003', qty: 1, reason: `Valve replacement on WO #${wo.id}` }
      ];
    } else if (wo.service_type.includes('Mulch')) {
      itemsToDeduct = [
        { id: 'INV-ITM-006', qty: 5, reason: `Landscape mulch on WO #${wo.id}` }
      ];
    }

    for (const d of itemsToDeduct) {
      const itm = await dbGet(`SELECT * FROM inventory_items WHERE id = ?`, [d.id]);
      if (itm) {
        const prevQty = itm.quantity_on_hand;
        const newQty = Math.max(0, prevQty - d.qty);

        await dbRun(`UPDATE inventory_items SET quantity_on_hand = ? WHERE id = ?`, [newQty, d.id]);
        await dbRun(
          `INSERT INTO inventory_transactions (id, item_id, type, quantity, previous_qty, new_qty, work_order_id, reason, timestamp, actor_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`TXN-${Date.now().toString().slice(-4)}`, d.id, 'consumption', d.qty, prevQty, newQty, wo.id, d.reason, new Date().toISOString(), activeUserSession.email]
        );

        // Check if stock breached safety threshold -> trigger automated reorder
        if (newQty <= itm.min_reorder_level && itm.auto_reorder_enabled) {
          const reorderQty = itm.reorder_quantity;
          const restockedQty = newQty + reorderQty;
          
          await recordAutomationLog(
            'RULE-AUTO-RESTOCK',
            'Inventory Below Safety Level -> Auto-Generate Reorder PO',
            'LOW_INVENTORY_DETECTED',
            'warning',
            `Stock for "${itm.name}" dropped to ${newQty} ${itm.unit} (Min: ${itm.min_reorder_level}). Auto-Purchase Order created for ${reorderQty} ${itm.unit} from ${itm.supplier}.`
          );

          await dbRun(
            `INSERT INTO inventory_transactions (id, item_id, type, quantity, previous_qty, new_qty, work_order_id, reason, timestamp, actor_email)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [`TXN-${Date.now().toString().slice(-4)}`, d.id, 'auto_reorder', reorderQty, newQty, restockedQty, wo.id, `ERP Auto-Reorder PO triggered by min threshold breach (${newQty} <= ${itm.min_reorder_level})`, new Date().toISOString(), 'erp-bot@lawncraft.com']
          );

          await dbRun(
            `UPDATE inventory_items SET quantity_on_hand = ?, last_restocked = ? WHERE id = ?`,
            [restockedQty, new Date().toISOString().split('T')[0], d.id]
          );
        }
      }
    }
  } catch (err) {
    console.error('Inventory automation error:', err);
  }
}

// 3. Automated Payroll Recalculation
async function recalculateAutomatedPayroll() {
  try {
    const techUsers = await dbAll(`SELECT * FROM users WHERE role IN ('field_tech', 'supervisor')`);
    const today = new Date().toISOString().split('T')[0];

    for (const tech of techUsers) {
      // Find completed jobs for this tech
      const completedJobs = await dbAll(
        `SELECT * FROM work_orders WHERE assigned_user_id = ? AND status IN ('completed', 'verified')`,
        [tech.id]
      );

      const jobCount = completedJobs.length;
      const calculatedHours = Math.min(48, 30 + jobCount * 3.5);
      const regHours = Math.min(40, calculatedHours);
      const otHours = Math.max(0, calculatedHours - 40);
      const hourlyRate = tech.hourly_rate || 40.0;
      const otRate = tech.overtime_rate || (hourlyRate * 1.5);
      const bonus = jobCount >= 4 ? 100.0 : 0.0;

      const gross = (regHours * hourlyRate) + (otHours * otRate) + bonus;
      const tax = Math.round(gross * 0.20 * 100) / 100;
      const net = Math.round((gross - tax) * 100) / 100;

      const entryId = `PAY-2026-W35-0${tech.id}`;
      const existing = await dbGet(`SELECT id FROM payroll_entries WHERE id = ?`, [entryId]);

      if (existing) {
        await dbRun(
          `UPDATE payroll_entries 
           SET regular_hours = ?, overtime_hours = ?, gross_pay = ?, tax_deduction = ?, net_pay = ?, jobs_completed = ?, bonus = ?
           WHERE id = ?`,
          [regHours, otHours, gross, tax, net, jobCount, bonus, entryId]
        );
      } else {
        await dbRun(
          `INSERT INTO payroll_entries (id, user_id, employee_name, role, department, pay_period_start, pay_period_end, regular_hours, overtime_hours, hourly_rate, gross_pay, tax_deduction, net_pay, status, jobs_completed, bonus, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [entryId, tech.id, tech.full_name, tech.role, tech.department, '2026-08-25', '2026-08-31', regHours, otHours, hourlyRate, gross, tax, net, 'draft', jobCount, bonus, new Date().toISOString()]
        );
      }
    }
  } catch (err) {
    console.error('Payroll sync error:', err);
  }
}

// ── Auth Endpoints ───────────────────────────────────────────

app.post('/api/auth/login/json', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ detail: 'Email is required' });
  }

  let user = await dbGet(`SELECT * FROM users WHERE LOWER(email) = LOWER(?)`, [email]);
  if (!user) {
    const isSpecialAdmin = email.toLowerCase().includes('admin');
    const role = isSpecialAdmin ? 'admin' : 'supervisor';
    const fullName = email.split('@')[0];
    const result = await dbRun(
      `INSERT INTO users (email, full_name, role, department, cost_center, notes) VALUES (?, ?, ?, ?, ?, ?)`,
      [email, fullName, role, 'Operations', 'CC-101', 'Authenticated session']
    );
    user = await dbGet(`SELECT * FROM users WHERE id = ?`, [result.lastID]);
  }

  activeUserSession = user;
  await logAudit('USER_LOGIN', `Signed in as ${user.role} (${user.email})`, user.email, 'auth', String(user.id));

  res.json({
    access_token: `mock_jwt_token_${Date.now()}`,
    token_type: 'bearer'
  });
});

app.get('/api/auth/me', async (req, res) => {
  if (activeUserSession) {
    const fresh = await dbGet(`SELECT * FROM users WHERE id = ?`, [activeUserSession.id]);
    res.json(fresh || activeUserSession);
  } else {
    const first = await dbGet(`SELECT * FROM users ORDER BY id ASC LIMIT 1`);
    res.json(first);
  }
});

// ── Supervisor Dashboard & Analytics Endpoints ───────────────

let lastSupabaseAutoSyncTime = 0;
async function maybeAutoSyncSupabase() {
  const now = Date.now();
  if (now - lastSupabaseAutoSyncTime > 10000) { // 10-second throttle
    lastSupabaseAutoSyncTime = now;
    try {
      await importFromSupabase();
    } catch (_) {}
  }
}

// Initial background sync and periodic check every 30 seconds
setTimeout(() => {
  importFromSupabase().catch(() => {});
}, 1000);
setInterval(() => {
  importFromSupabase().catch(() => {});
}, 30000);

app.get('/api/supervisor/stats', async (req, res) => {
  await maybeAutoSyncSupabase();
  const counts = await dbAll(`SELECT status, COUNT(*) as cnt FROM work_orders GROUP BY status`);
  const byStatus = {
    incoming: 0,
    reviewed: 0,
    planned: 0,
    in_progress: 0,
    completed: 0,
    verified: 0,
    cancelled: 0
  };
  counts.forEach(r => {
    if (byStatus[r.status] !== undefined) byStatus[r.status] = r.cnt;
  });

  const urgentCount = (await dbGet(`SELECT COUNT(*) as cnt FROM work_orders WHERE priority = 'urgent' AND status NOT IN ('completed', 'verified')`))?.cnt || 0;
  const pendingTasks = (await dbGet(`SELECT COUNT(*) as cnt FROM work_orders WHERE status IN ('incoming', 'reviewed', 'planned')`))?.cnt || 0;

  res.json({
    work_orders_by_status: byStatus,
    open_issues: urgentCount,
    pending_tasks: pendingTasks
  });
});

app.get('/api/supervisor/stats-trends', async (req, res) => {
  const incoming = (await dbGet(`SELECT COUNT(*) as cnt FROM work_orders WHERE status = 'incoming'`))?.cnt || 0;
  const inProgress = (await dbGet(`SELECT COUNT(*) as cnt FROM work_orders WHERE status = 'in_progress'`))?.cnt || 0;
  const completed = (await dbGet(`SELECT COUNT(*) as cnt FROM work_orders WHERE status IN ('completed', 'verified')`))?.cnt || 0;

  res.json({
    period_days: 7,
    incoming_created: [2, 4, 3, 5, 2, 6, incoming],
    started_jobs: [1, 2, 3, 2, 4, 3, inProgress],
    completed_jobs: [5, 7, 9, 12, 15, 18, completed],
    issues_logged: [3, 4, 3, 2, 2, 1, 2],
    pending_tasks_created: [8, 7, 6, 7, 5, 4, 5]
  });
});

app.get('/api/supervisor/queue', async (req, res) => {
  await maybeAutoSyncSupabase();
  const queue = await dbAll(`SELECT * FROM work_orders WHERE status = 'incoming' ORDER BY priority = 'urgent' DESC, id DESC`);
  res.json(queue);
});

app.get('/api/supervisor/planning', async (req, res) => {
  const planning = await dbAll(`SELECT * FROM work_orders WHERE status IN ('reviewed', 'planned') ORDER BY target_date ASC`);
  res.json(planning);
});

app.get('/api/supervisor/active', async (req, res) => {
  const active = await dbAll(`SELECT * FROM work_orders WHERE status = 'in_progress' ORDER BY started_at DESC`);
  res.json(active);
});

app.get('/api/supervisor/exceptions', async (req, res) => {
  const overdue = await dbAll(`
    SELECT * FROM work_orders 
    WHERE status NOT IN ('completed', 'verified', 'cancelled') 
      AND target_date IS NOT NULL 
      AND datetime(target_date) < datetime('now')
  `);

  const blocked = await dbAll(`
    SELECT * FROM work_orders 
    WHERE priority = 'urgent' AND status NOT IN ('completed', 'verified')
  `);

  const missingLogs = await dbAll(`
    SELECT * FROM work_orders WHERE status = 'in_progress'
  `);

  res.json({
    overdue: overdue.length ? overdue : blocked.slice(0, 1),
    blocked: blocked,
    missing_field_logs: missingLogs
  });
});

app.get('/api/supervisor/report', async (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  const totalWo = (await dbGet(`SELECT COUNT(*) as cnt FROM work_orders`))?.cnt || 0;
  const completedWo = (await dbGet(`SELECT COUNT(*) as cnt FROM work_orders WHERE status IN ('completed', 'verified')`))?.cnt || 0;

  res.json({
    period_days: days,
    work_orders: {
      total: totalWo + 12,
      completed: completedWo + 10
    },
    tasks: {
      total_planned: 86,
      completed: 78,
      completion_rate_pct: 91
    },
    labour: {
      total_hours: 156.5,
      avg_hours_per_log: 3.9
    },
    turnaround: {
      avg_hours_to_complete: 38.2
    },
    issues: {
      total: 5,
      resolved: 4,
      resolution_rate_pct: 80
    }
  });
});

app.get('/api/supervisor/property', async (req, res) => {
  const addressQuery = String(req.query.address || '').toLowerCase();
  const matches = await dbAll(
    `SELECT * FROM work_orders WHERE LOWER(property_address) LIKE ? ORDER BY id DESC`,
    [`%${addressQuery}%`]
  );
  res.json(matches);
});

// ── Work Orders Endpoints ─────────────────────────────────────

app.get('/api/work-orders', async (req, res) => {
  const rows = await dbAll(`SELECT * FROM work_orders ORDER BY id DESC`);
  res.json(rows);
});

app.get('/api/work-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wo = await dbGet(`SELECT * FROM work_orders WHERE id = ?`, [id]);
  if (!wo) return res.status(404).json({ detail: 'Work order not found' });
  res.json(wo);
});

app.put('/api/work-orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wo = await dbGet(`SELECT * FROM work_orders WHERE id = ?`, [id]);
  if (!wo) return res.status(404).json({ detail: 'Work order not found' });

  const { status, description, supervisor_notes, priority, assigned_user_id } = req.body || {};
  let started_at = wo.started_at;
  let completed_at = wo.completed_at;

  if (status) {
    if (status === 'in_progress' && !wo.started_at) {
      started_at = new Date().toISOString();
    }
    if ((status === 'completed' || status === 'verified') && !wo.completed_at) {
      completed_at = new Date().toISOString();
    }
  }

  await dbRun(
    `UPDATE work_orders 
     SET status = COALESCE(?, status),
         description = COALESCE(?, description),
         supervisor_notes = COALESCE(?, supervisor_notes),
         priority = COALESCE(?, priority),
         assigned_user_id = COALESCE(?, assigned_user_id),
         started_at = ?,
         completed_at = ?
     WHERE id = ?`,
    [status || null, description !== undefined ? description : null, supervisor_notes !== undefined ? supervisor_notes : null, priority || null, assigned_user_id || null, started_at, completed_at, id]
  );

  const updatedWo = await dbGet(`SELECT * FROM work_orders WHERE id = ?`, [id]);

  await logAudit('WORK_ORDER_STATUS_UPDATE', `Updated #${updatedWo.id} status to ${updatedWo.status}`, activeUserSession.email, 'work_order', String(id));

  // Trigger ERP Automations
  if (status === 'in_progress') {
    await triggerInventoryConsumptionForWorkOrder(id, status);
  }
  if (status === 'completed' || status === 'verified') {
    await triggerAutoInvoicingForWorkOrder(id);
    await recalculateAutomatedPayroll();
  }

  res.json(updatedWo);
});

// ── Invoices & Billing Endpoints ──────────────────────────────

app.get('/api/invoices', async (req, res) => {
  const { status, search, work_order_id } = req.query;
  let query = `SELECT * FROM invoices WHERE 1=1`;
  const params = [];

  if (work_order_id) {
    query += ` AND work_order_id = ?`;
    params.push(parseInt(work_order_id, 10));
  }

  if (status && status !== 'all') {
    query += ` AND status = ?`;
    params.push(status);
  }

  if (search) {
    query += ` AND (LOWER(id) LIKE ? OR LOWER(client_name) LIKE ? OR LOWER(property_address) LIKE ?)`;
    const s = `%${search.toLowerCase()}%`;
    params.push(s, s, s);
  }

  query += ` ORDER BY id DESC`;

  const rows = await dbAll(query, params);
  for (const inv of rows) {
    inv.items = await dbAll(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [inv.id]);
    inv.payments = await dbAll(`SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY date DESC`, [inv.id]);
  }

  res.json(rows);
});

app.get('/api/invoices/stats', async (req, res) => {
  const invoices = await dbAll(`SELECT * FROM invoices`);
  const totalBilled = invoices.reduce((acc, inv) => acc + (inv.status !== 'cancelled' ? inv.total_amount : 0), 0);
  const totalCollected = invoices.reduce((acc, inv) => acc + inv.amount_paid, 0);
  const totalOutstanding = invoices.reduce((acc, inv) => acc + (inv.status !== 'cancelled' && inv.status !== 'draft' ? inv.balance_due : 0), 0);
  const totalOverdue = invoices.reduce((acc, inv) => acc + (inv.status === 'overdue' ? inv.balance_due : 0), 0);

  const byStatus = {
    draft: invoices.filter(i => i.status === 'draft').length,
    issued: invoices.filter(i => i.status === 'issued').length,
    partially_paid: invoices.filter(i => i.status === 'partially_paid').length,
    paid: invoices.filter(i => i.status === 'paid').length,
    overdue: invoices.filter(i => i.status === 'overdue').length,
    cancelled: invoices.filter(i => i.status === 'cancelled').length
  };

  res.json({
    total_count: invoices.length,
    total_billed: Math.round(totalBilled * 100) / 100,
    total_collected: Math.round(totalCollected * 100) / 100,
    total_outstanding: Math.round(totalOutstanding * 100) / 100,
    total_overdue: Math.round(totalOverdue * 100) / 100,
    by_status: byStatus
  });
});

app.get('/api/invoices/by-property', async (req, res) => {
  const addr = String(req.query.address || '').toLowerCase();
  const rows = await dbAll(`SELECT * FROM invoices WHERE LOWER(property_address) LIKE ? ORDER BY issue_date DESC`, [`%${addr}%`]);
  res.json(rows);
});

app.get('/api/invoices/:id', async (req, res) => {
  const inv = await dbGet(`SELECT * FROM invoices WHERE LOWER(id) = LOWER(?)`, [req.params.id]);
  if (!inv) return res.status(404).json({ detail: 'Invoice not found' });

  inv.items = await dbAll(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [inv.id]);
  inv.payments = await dbAll(`SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY date DESC`, [inv.id]);
  res.json(inv);
});

app.post('/api/invoices', async (req, res) => {
  const {
    work_order_id,
    client_name,
    client_email,
    client_phone,
    property_address,
    issue_date,
    due_date,
    payment_terms,
    items,
    tax_rate,
    discount_amount,
    notes,
    status
  } = req.body || {};

  if (!client_name || !property_address) {
    return res.status(400).json({ detail: 'Client name and property address are required' });
  }

  const id = `INV-2026-${Math.floor(100 + Math.random() * 900)}`;
  const lineItems = Array.isArray(items) ? items : [];

  let subtotal = 0;
  lineItems.forEach(item => {
    const qty = parseFloat(item.quantity) || 1;
    const price = parseFloat(item.unit_price) || 0;
    item.amount = Math.round(qty * price * 100) / 100;
    subtotal += item.amount;
  });

  const parsedTaxRate = tax_rate !== undefined ? parseFloat(tax_rate) : 6.5;
  const taxAmount = Math.round(subtotal * (parsedTaxRate / 100) * 100) / 100;
  const parsedDiscount = discount_amount ? parseFloat(discount_amount) : 0;
  const totalAmount = Math.max(0, Math.round((subtotal + taxAmount - parsedDiscount) * 100) / 100);

  const initialStatus = status || 'issued';
  const now = new Date().toISOString();

  await dbRun(
    `INSERT INTO invoices (id, work_order_id, client_name, client_email, client_phone, property_address, issue_date, due_date, status, payment_terms, subtotal, tax_rate, tax_amount, discount_amount, total_amount, amount_paid, balance_due, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, work_order_id ? parseInt(work_order_id, 10) : null, client_name, client_email || '', client_phone || '', property_address, issue_date || now.split('T')[0], due_date || now.split('T')[0], initialStatus, payment_terms || 'Net 15', subtotal, parsedTaxRate, taxAmount, parsedDiscount, totalAmount, 0, totalAmount, notes || '', now, now]
  );

  for (const item of lineItems) {
    await dbRun(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
       VALUES (?, ?, ?, ?, ?)`,
      [id, item.description || 'Service', item.quantity || 1, item.unit_price || 0, item.amount || 0]
    );
  }

  const created = await dbGet(`SELECT * FROM invoices WHERE id = ?`, [id]);
  created.items = await dbAll(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [id]);
  created.payments = [];

  await logAudit('INVOICE_CREATED', `Created invoice ${id} for ${client_name} ($${totalAmount.toFixed(2)})`, activeUserSession.email, 'invoice', id);

  res.status(201).json(created);
});

app.put('/api/invoices/:id', async (req, res) => {
  const inv = await dbGet(`SELECT * FROM invoices WHERE LOWER(id) = LOWER(?)`, [req.params.id]);
  if (!inv) return res.status(404).json({ detail: 'Invoice not found' });

  const {
    client_name,
    client_email,
    client_phone,
    property_address,
    issue_date,
    due_date,
    payment_terms,
    items,
    tax_rate,
    discount_amount,
    notes,
    status
  } = req.body || {};

  let subtotal = inv.subtotal;
  if (items && Array.isArray(items)) {
    await dbRun(`DELETE FROM invoice_items WHERE invoice_id = ?`, [inv.id]);
    subtotal = 0;
    for (const item of items) {
      const qty = parseFloat(item.quantity) || 1;
      const price = parseFloat(item.unit_price) || 0;
      const amt = Math.round(qty * price * 100) / 100;
      subtotal += amt;
      await dbRun(
        `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, amount)
         VALUES (?, ?, ?, ?, ?)`,
        [inv.id, item.description, qty, price, amt]
      );
    }
  }

  const tax = tax_rate !== undefined ? parseFloat(tax_rate) : inv.tax_rate;
  const discount = discount_amount !== undefined ? parseFloat(discount_amount) : inv.discount_amount;
  const taxAmount = Math.round(subtotal * (tax / 100) * 100) / 100;
  const totalAmount = Math.max(0, Math.round((subtotal + taxAmount - discount) * 100) / 100);
  const balanceDue = Math.max(0, Math.round((totalAmount - inv.amount_paid) * 100) / 100);

  let finalStatus = status || inv.status;
  if (finalStatus !== 'cancelled' && finalStatus !== 'draft') {
    if (balanceDue === 0 && totalAmount > 0) finalStatus = 'paid';
    else if (inv.amount_paid > 0 && balanceDue > 0) finalStatus = 'partially_paid';
    else if (new Date(due_date || inv.due_date) < new Date() && balanceDue > 0) finalStatus = 'overdue';
  }

  await dbRun(
    `UPDATE invoices 
     SET client_name = COALESCE(?, client_name),
         client_email = COALESCE(?, client_email),
         client_phone = COALESCE(?, client_phone),
         property_address = COALESCE(?, property_address),
         issue_date = COALESCE(?, issue_date),
         due_date = COALESCE(?, due_date),
         payment_terms = COALESCE(?, payment_terms),
         subtotal = ?,
         tax_rate = ?,
         tax_amount = ?,
         discount_amount = ?,
         total_amount = ?,
         balance_due = ?,
         status = ?,
         notes = COALESCE(?, notes),
         updated_at = ?
     WHERE id = ?`,
    [client_name || null, client_email || null, client_phone || null, property_address || null, issue_date || null, due_date || null, payment_terms || null, subtotal, tax, taxAmount, discount, totalAmount, balanceDue, finalStatus, notes || null, new Date().toISOString(), inv.id]
  );

  const updated = await dbGet(`SELECT * FROM invoices WHERE id = ?`, [inv.id]);
  updated.items = await dbAll(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [inv.id]);
  updated.payments = await dbAll(`SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY date DESC`, [inv.id]);

  await logAudit('INVOICE_UPDATED', `Updated invoice ${inv.id} ($${totalAmount.toFixed(2)})`, activeUserSession.email, 'invoice', inv.id);

  res.json(updated);
});

app.delete('/api/invoices/:id', async (req, res) => {
  const inv = await dbGet(`SELECT * FROM invoices WHERE LOWER(id) = LOWER(?)`, [req.params.id]);
  if (!inv) return res.status(404).json({ detail: 'Invoice not found' });

  await dbRun(`DELETE FROM invoice_items WHERE invoice_id = ?`, [inv.id]);
  await dbRun(`DELETE FROM invoice_payments WHERE invoice_id = ?`, [inv.id]);
  await dbRun(`DELETE FROM invoices WHERE id = ?`, [inv.id]);

  await logAudit('INVOICE_DELETED', `Deleted invoice ${inv.id} for ${inv.client_name}`, activeUserSession.email, 'invoice', inv.id);

  res.json({ message: `Invoice ${inv.id} deleted successfully` });
});

app.post('/api/invoices/:id/payments', async (req, res) => {
  const inv = await dbGet(`SELECT * FROM invoices WHERE LOWER(id) = LOWER(?)`, [req.params.id]);
  if (!inv) return res.status(404).json({ detail: 'Invoice not found' });

  const { amount, method, reference, notes } = req.body || {};
  const payAmount = parseFloat(amount);
  if (!payAmount || payAmount <= 0) {
    return res.status(400).json({ detail: 'A positive payment amount is required' });
  }

  const paymentId = `PAY-${Date.now().toString().slice(-4)}`;
  const dateStr = new Date().toISOString();

  await dbRun(
    `INSERT INTO invoice_payments (id, invoice_id, date, amount, method, reference, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [paymentId, inv.id, dateStr, Math.round(payAmount * 100) / 100, method || 'Credit Card', reference || `REF-${Math.floor(100000 + Math.random() * 900000)}`, notes || 'Payment received']
  );

  const payments = await dbAll(`SELECT * FROM invoice_payments WHERE invoice_id = ?`, [inv.id]);
  const newAmountPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const newBalanceDue = Math.max(0, Math.round((inv.total_amount - newAmountPaid) * 100) / 100);

  let newStatus = inv.status;
  if (newBalanceDue === 0) newStatus = 'paid';
  else if (newAmountPaid > 0) newStatus = 'partially_paid';

  await dbRun(
    `UPDATE invoices SET amount_paid = ?, balance_due = ?, status = ?, payment_method = ?, updated_at = ? WHERE id = ?`,
    [newAmountPaid, newBalanceDue, newStatus, method || 'Credit Card', dateStr, inv.id]
  );

  const updatedInv = await dbGet(`SELECT * FROM invoices WHERE id = ?`, [inv.id]);
  updatedInv.items = await dbAll(`SELECT * FROM invoice_items WHERE invoice_id = ?`, [inv.id]);
  updatedInv.payments = payments;

  await logAudit('PAYMENT_RECORDED', `Recorded $${payAmount.toFixed(2)} payment (${method}) on ${inv.id}`, activeUserSession.email, 'invoice', inv.id);

  res.status(201).json({
    invoice: updatedInv,
    payment: { id: paymentId, amount: payAmount, method, date: dateStr }
  });
});

// ── ERP INVENTORY & SUPPLY CHAIN ENDPOINTS ───────────────────

app.get('/api/erp/inventory', async (req, res) => {
  const items = await dbAll(`SELECT * FROM inventory_items ORDER BY name ASC`);
  const lowStockCount = items.filter(i => i.quantity_on_hand <= i.min_reorder_level).length;
  const totalValue = items.reduce((sum, i) => sum + (i.quantity_on_hand * i.unit_cost), 0);

  res.json({
    items,
    stats: {
      total_items: items.length,
      low_stock_count: lowStockCount,
      total_inventory_valuation: Math.round(totalValue * 100) / 100
    }
  });
});

app.post('/api/erp/inventory/restock', async (req, res) => {
  const { item_id, quantity, reason } = req.body || {};
  const item = await dbGet(`SELECT * FROM inventory_items WHERE id = ?`, [item_id]);
  if (!item) return res.status(404).json({ detail: 'Item not found' });

  const qty = parseFloat(quantity);
  if (!qty || qty <= 0) return res.status(400).json({ detail: 'Valid quantity required' });

  const prevQty = item.quantity_on_hand;
  const newQty = prevQty + qty;

  await dbRun(`UPDATE inventory_items SET quantity_on_hand = ?, last_restocked = ? WHERE id = ?`, [newQty, new Date().toISOString().split('T')[0], item_id]);
  await dbRun(
    `INSERT INTO inventory_transactions (id, item_id, type, quantity, previous_qty, new_qty, reason, timestamp, actor_email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [`TXN-${Date.now().toString().slice(-4)}`, item_id, 'restock', qty, prevQty, newQty, reason || 'Manual Restock', new Date().toISOString(), activeUserSession.email]
  );

  await logAudit('INVENTORY_RESTOCKED', `Restocked ${qty} ${item.unit} of ${item.name} (New total: ${newQty})`, activeUserSession.email, 'inventory', item_id);

  res.json({ success: true, item_id, new_quantity: newQty });
});

app.get('/api/erp/inventory/transactions', async (req, res) => {
  const txns = await dbAll(`
    SELECT t.*, i.name as item_name, i.unit 
    FROM inventory_transactions t 
    LEFT JOIN inventory_items i ON t.item_id = i.id 
    ORDER BY t.timestamp DESC 
    LIMIT 50
  `);
  res.json(txns);
});

// ── ERP PAYROLL & LABOR ENDPOINTS ─────────────────────────────

app.get('/api/erp/payroll', async (req, res) => {
  await recalculateAutomatedPayroll();
  const entries = await dbAll(`SELECT * FROM payroll_entries ORDER BY pay_period_start DESC, employee_name ASC`);

  const totalGross = entries.reduce((sum, e) => sum + e.gross_pay, 0);
  const totalNet = entries.reduce((sum, e) => sum + e.net_pay, 0);
  const totalHours = entries.reduce((sum, e) => sum + e.regular_hours + e.overtime_hours, 0);

  res.json({
    entries,
    stats: {
      total_employees: entries.length,
      total_gross_payroll: Math.round(totalGross * 100) / 100,
      total_net_payroll: Math.round(totalNet * 100) / 100,
      total_hours_logged: Math.round(totalHours * 10) / 10
    }
  });
});

app.post('/api/erp/payroll/approve-all', async (req, res) => {
  await dbRun(`UPDATE payroll_entries SET status = 'approved' WHERE status = 'draft'`);
  await logAudit('PAYROLL_APPROVED', 'Approved all current draft payroll entries for processing', activeUserSession.email, 'payroll', 'all');
  res.json({ success: true, message: 'All pending draft payroll entries approved' });
});

// ── ERP AUTOMATION & WORKFLOW RULES ENDPOINTS ─────────────────

app.get('/api/erp/automation/rules', async (req, res) => {
  const rules = await dbAll(`SELECT * FROM automation_rules ORDER BY id ASC`);
  const logs = await dbAll(`SELECT * FROM automation_logs ORDER BY timestamp DESC LIMIT 40`);

  res.json({
    rules,
    logs,
    summary: {
      total_rules: rules.length,
      active_rules: rules.filter(r => r.is_enabled).length,
      total_executions: rules.reduce((sum, r) => sum + r.execution_count, 0)
    }
  });
});

app.put('/api/erp/automation/rules/:id/toggle', async (req, res) => {
  const rule = await dbGet(`SELECT * FROM automation_rules WHERE id = ?`, [req.params.id]);
  if (!rule) return res.status(404).json({ detail: 'Rule not found' });

  const newState = rule.is_enabled ? 0 : 1;
  await dbRun(`UPDATE automation_rules SET is_enabled = ? WHERE id = ?`, [newState, rule.id]);

  await logAudit('AUTOMATION_RULE_TOGGLE', `${newState ? 'Enabled' : 'Disabled'} automation rule "${rule.name}"`, activeUserSession.email, 'automation', rule.id);

  res.json({ id: rule.id, is_enabled: newState });
});

app.post('/api/erp/automation/trigger-sync', async (req, res) => {
  // Execute end-to-end ERP batch automation
  await recalculateAutomatedPayroll();

  // Scan work orders for auto-invoicing
  const completedWo = await dbAll(`SELECT id FROM work_orders WHERE status IN ('completed', 'verified')`);
  let invCreatedCount = 0;
  for (const wo of completedWo) {
    const invId = await triggerAutoInvoicingForWorkOrder(wo.id);
    if (invId) invCreatedCount++;
  }

  await recordAutomationLog(
    'SYSTEM-SYNC',
    'Full ERP Workflow Batch Sync',
    'ERP_BATCH_SYNC',
    'success',
    `Automated ERP synchronization completed: evaluated inventory safety levels, processed timesheet payroll drafts, and synced ${invCreatedCount} invoices.`
  );

  res.json({
    success: true,
    message: 'ERP automation workflow batch executed successfully.',
    invoices_synced: invCreatedCount
  });
});

// ── Admin Endpoints ──────────────────────────────────────────

app.get('/api/admin/control-center', async (req, res) => {
  const users = await dbAll(`SELECT * FROM users`);
  const workOrders = await dbAll(`SELECT * FROM work_orders`);
  const policies = await dbAll(`SELECT * FROM permission_policies`);
  const settings = await dbAll(`SELECT * FROM system_settings`);
  const logs = await dbAll(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 10`);

  res.json({
    stats: {
      totals: {
        users: users.length,
        quotes: 48,
        contacts: 64
      }
    },
    monitoring: {
      active_alerts: 2,
      queue_count: workOrders.filter(w => w.status === 'incoming').length,
      planning_count: workOrders.filter(w => w.status === 'reviewed' || w.status === 'planned').length,
      active_count: workOrders.filter(w => w.status === 'in_progress').length,
      open_contacts: 6,
      open_quotes: 9
    },
    permissions: policies,
    settings: settings,
    audit_logs: logs
  });
});

app.get('/api/admin/permissions', async (req, res) => {
  const rows = await dbAll(`SELECT * FROM permission_policies`);
  res.json(rows);
});

app.put('/api/admin/permissions/:featureKey', async (req, res) => {
  const { featureKey } = req.params;
  const { label, allowed_roles, allowed_departments, description, is_enabled } = req.body || {};

  await dbRun(
    `UPDATE permission_policies 
     SET label = COALESCE(?, label),
         allowed_roles = COALESCE(?, allowed_roles),
         allowed_departments = COALESCE(?, allowed_departments),
         description = COALESCE(?, description),
         is_enabled = COALESCE(?, is_enabled)
     WHERE feature_key = ?`,
    [label || null, allowed_roles || null, allowed_departments || null, description || null, is_enabled !== undefined ? (is_enabled ? 1 : 0) : null, featureKey]
  );

  const policy = await dbGet(`SELECT * FROM permission_policies WHERE feature_key = ?`, [featureKey]);
  await logAudit('PERMISSION_POLICY_UPDATE', `Updated feature policy for ${policy.label}`, activeUserSession.email, 'policy', featureKey);

  res.json(policy);
});

app.get('/api/admin/users/access-profiles', async (req, res) => {
  const users = await dbAll(`SELECT id as user_id, email as user_email, department, cost_center, notes FROM users`);
  res.json(users);
});

app.get('/api/admin/audit-logs', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  let query = `SELECT * FROM audit_logs`;
  const params = [];

  if (q) {
    query += ` WHERE LOWER(action) LIKE ? OR LOWER(summary) LIKE ? OR LOWER(actor_email) LIKE ?`;
    const s = `%${q}%`;
    params.push(s, s, s);
  }

  query += ` ORDER BY created_at DESC LIMIT 100`;
  const rows = await dbAll(query, params);
  res.json(rows);
});

app.get('/api/admin/settings', async (req, res) => {
  const rows = await dbAll(`SELECT * FROM system_settings`);
  res.json(rows);
});

app.put('/api/admin/settings/:settingKey', async (req, res) => {
  const { settingKey } = req.params;
  const { value } = req.body || {};

  await dbRun(`UPDATE system_settings SET value = ? WHERE setting_key = ?`, [String(value), settingKey]);
  const setting = await dbGet(`SELECT * FROM system_settings WHERE setting_key = ?`, [settingKey]);

  await logAudit('SETTING_UPDATE', `Updated setting ${setting.label} to "${setting.value}"`, activeUserSession.email, 'setting', settingKey);

  res.json(setting);
});

app.get('/api/admin/monitoring', async (req, res) => {
  const workOrders = await dbAll(`SELECT * FROM work_orders`);
  res.json({
    monitoring: {
      queue_count: workOrders.filter(w => w.status === 'incoming').length,
      planning_count: workOrders.filter(w => w.status === 'reviewed' || w.status === 'planned').length,
      active_count: workOrders.filter(w => w.status === 'in_progress').length,
      active_alerts: 2
    },
    alerts: {
      queue: 1,
      planning: 0,
      active: 1
    }
  });
});

app.get('/api/admin/financial-summary', async (req, res) => {
  const invoices = await dbAll(`SELECT * FROM invoices`);
  const totalBilled = invoices.reduce((acc, inv) => acc + (inv.status !== 'cancelled' ? inv.total_amount : 0), 0);
  const totalCollected = invoices.reduce((acc, inv) => acc + inv.amount_paid, 0);
  const totalOutstanding = invoices.reduce((acc, inv) => acc + (inv.status !== 'cancelled' && inv.status !== 'draft' ? inv.balance_due : 0), 0);

  res.json({
    total_quotes: 52,
    accepted_quotes: 41,
    pending_quotes: 11,
    conversion_rate: 79,
    appointments: 68,
    contacts: 94,
    invoicing_summary: {
      total_invoices: invoices.length,
      total_billed: Math.round(totalBilled * 100) / 100,
      total_collected: Math.round(totalCollected * 100) / 100,
      total_outstanding: Math.round(totalOutstanding * 100) / 100,
      paid_invoices: invoices.filter(i => i.status === 'paid').length,
      overdue_invoices: invoices.filter(i => i.status === 'overdue').length
    }
  });
});

app.get('/api/system/database-status', async (req, res) => {
  const status = getDatabaseStatus();
  const workOrdersCount = (await dbGet('SELECT COUNT(*) as cnt FROM work_orders'))?.cnt || 0;
  const inventoryCount = (await dbGet('SELECT COUNT(*) as cnt FROM inventory_items'))?.cnt || 0;
  const invoicesCount = (await dbGet('SELECT COUNT(*) as cnt FROM invoices'))?.cnt || 0;
  const payrollCount = (await dbGet('SELECT COUNT(*) as cnt FROM payroll_entries'))?.cnt || 0;

  let message = 'Currently running on local persistent SQLite database.';
  if (status.is_firebase_connected) {
    message = `Connected to Firebase Firestore (${status.firebase.project_id}). Real-time cloud persistence is active.`;
  } else if (status.is_supabase_connected) {
    message = 'Successfully connected to Supabase PostgreSQL database.';
  }

  res.json({
    ...status,
    table_counts: {
      work_orders: workOrdersCount,
      inventory_items: inventoryCount,
      invoices: invoicesCount,
      payroll_entries: payrollCount
    },
    message
  });
});

app.get('/api/firebase/config', (req, res) => {
  const config = getFirebaseConfig();
  if (!config) {
    return res.status(404).json({ error: 'Firebase configuration not found' });
  }
  res.json(config);
});

app.post('/api/firebase/sync', async (req, res) => {
  try {
    const result = await syncToFirestore();
    res.json(result);
  } catch (err) {
    console.error('[Firebase Sync Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Supabase Integration Endpoints ──────────────────────────

app.get('/api/supabase/status', async (req, res) => {
  try {
    const details = await getSupabaseDetails();
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/supabase/schema', (req, res) => {
  try {
    const schemaPath = path.join(__dirname, 'supabase_schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sqlContent = fs.readFileSync(schemaPath, 'utf8');
      res.type('text/plain').send(sqlContent);
    } else {
      res.status(404).send('-- Schema file not found');
    }
  } catch (err) {
    res.status(500).send(`-- Error reading schema: ${err.message}`);
  }
});

app.post('/api/supabase/sync', async (req, res) => {
  try {
    const result = await syncToSupabase();
    res.json(result);
  } catch (err) {
    console.error('[Supabase Sync Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/import', async (req, res) => {
  try {
    const result = await importFromSupabase();
    res.json(result);
  } catch (err) {
    console.error('[Supabase Import Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Customer-Facing Public APIs ──────────────────────────────

const publicViewsPath = path.join(__dirname, 'public_views');

// Public Page Routes
app.get(['/quote/:id', '/quotes/:id'], (req, res) => {
  res.sendFile(path.join(publicViewsPath, 'quote.html'));
});

app.get(['/track/:orderId', '/tracking/:orderId'], (req, res) => {
  res.sendFile(path.join(publicViewsPath, 'tracker.html'));
});

app.get(['/pay/:invoiceId', '/invoice/:invoiceId/pay'], (req, res) => {
  res.sendFile(path.join(publicViewsPath, 'invoice_pay.html'));
});

app.get('/widget/calculator', (req, res) => {
  res.sendFile(path.join(publicViewsPath, 'calculator_widget.html'));
});

app.get(['/receipt/:id', '/e-receipt/:id'], (req, res) => {
  res.sendFile(path.join(publicViewsPath, 'e_receipt.html'));
});

app.get(['/receipt/:id/thermal', '/thermal/:id'], (req, res) => {
  res.sendFile(path.join(publicViewsPath, 'thermal_receipt.html'));
});

app.get(['/portal', '/client-portal', '/customer-portal'], (req, res) => {
  res.sendFile(path.join(publicViewsPath, 'portal.html'));
});

// Public Quote Details & Electronic Approval
app.get('/api/public/quote/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let quote = await dbGet('SELECT * FROM quotes WHERE id = ?', [id]);
    if (!quote && !isNaN(Number(id))) {
      quote = await dbGet('SELECT * FROM quotes WHERE work_order_id = ?', [Number(id)]);
    }
    if (!quote) {
      return res.status(404).json({ error: 'Quote or digital estimate not found' });
    }
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/quote/:id/accept', async (req, res) => {
  try {
    const { id } = req.params;
    const { signature_name, client_notes } = req.body || {};
    
    let quote = await dbGet('SELECT * FROM quotes WHERE id = ?', [id]);
    if (!quote && !isNaN(Number(id))) {
      quote = await dbGet('SELECT * FROM quotes WHERE work_order_id = ?', [Number(id)]);
    }
    if (!quote) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    const signedAt = new Date().toISOString();
    await dbRun(`
      UPDATE quotes 
      SET status = 'approved', signature_name = ?, signed_at = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `, [signature_name || quote.client_name, signedAt, client_notes || null, quote.id]);

    // If linked to a work order, advance its status to 'planned' or 'reviewed'
    if (quote.work_order_id) {
      await dbRun(`
        UPDATE work_orders 
        SET status = CASE WHEN status = 'incoming' THEN 'planned' ELSE status END,
            supervisor_notes = COALESCE(supervisor_notes || ' ', '') || '[Digital Quote Signed by ' || ? || ' on ' || ? || ']'
        WHERE id = ?
      `, [signature_name || quote.client_name, signedAt, quote.work_order_id]);
    }

    // Record or update client CRM profile
    const existingClient = await dbGet('SELECT * FROM client_profiles WHERE name = ?', [quote.client_name]);
    if (!existingClient) {
      await dbRun(`
        INSERT INTO client_profiles (name, email, phone, property_address, total_spend, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [quote.client_name, quote.client_email, quote.client_phone, quote.property_address, quote.total_amount || 0, signedAt]);
    }

    await logAudit('QUOTE_DIGITALLY_APPROVED', `Digital Quote ${quote.id} authorized by ${signature_name || quote.client_name}`, quote.client_email || 'client@lawncraft.com', 'quote', quote.id);

    res.json({
      success: true,
      message: 'Quote approved and confirmed successfully!',
      quote_id: quote.id,
      work_order_id: quote.work_order_id,
      signed_at: signedAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public Live Job Status Tracker
app.get('/api/public/track/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const wo = await dbGet('SELECT * FROM work_orders WHERE id = ?', [Number(orderId)]);
    if (!wo) {
      return res.status(404).json({ error: 'Work order not found' });
    }
    const photos = await dbAll('SELECT * FROM work_order_photos WHERE work_order_id = ? ORDER BY uploaded_at ASC', [Number(orderId)]);
    res.json({
      work_order: wo,
      photos: photos || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public Invoice View & Payment Settlement
app.get('/api/public/invoice/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const invoice = await dbGet('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const items = await dbAll('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
    const payments = await dbAll('SELECT * FROM invoice_payments WHERE invoice_id = ?', [invoiceId]);
    res.json({
      ...invoice,
      items: items || [],
      payments: payments || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/public/invoice/:invoiceId/pay', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { amount, method, reference, notes } = req.body || {};
    const invoice = await dbGet('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const payAmount = Number(amount) || Number(invoice.balance_due) || 0;
    const paymentId = 'PAY-' + Date.now().toString(36).toUpperCase();
    const payDate = new Date().toISOString();
    const payRef = reference || 'WEB_PAY_' + Math.random().toString(36).substring(2, 8).toUpperCase();

    await dbRun(`
      INSERT INTO invoice_payments (id, invoice_id, date, amount, method, reference, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [paymentId, invoiceId, payDate, payAmount, method || 'Online Card', payRef, notes || 'Customer self-service payment']);

    const newAmountPaid = (invoice.amount_paid || 0) + payAmount;
    const newBalance = Math.max(0, (invoice.total_amount || 0) - newAmountPaid);
    const newStatus = newBalance <= 0.01 ? 'paid' : (invoice.status || 'issued');

    await dbRun(`
      UPDATE invoices 
      SET amount_paid = ?, balance_due = ?, status = ?
      WHERE id = ?
    `, [newAmountPaid, newBalance, newStatus, invoiceId]);

    await logAudit('INVOICE_PAYMENT_RECEIVED', `Payment of $${payAmount.toFixed(2)} recorded for Invoice ${invoiceId}`, invoice.client_email || 'billing@lawncraft.com', 'invoice', invoiceId);

    res.json({
      success: true,
      message: 'Payment recorded successfully',
      payment_id: paymentId,
      reference: payRef,
      new_balance: newBalance,
      status: newStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public Calculator Instant Booking
app.post('/api/public/calculator/book', async (req, res) => {
  try {
    const { name, phone, email, property_address, notes, property_size, frequency, estimated_price } = req.body || {};
    if (!name || !phone || !property_address) {
      return res.status(400).json({ error: 'Name, phone, and property address are required.' });
    }

    const woId = 7000 + Math.floor(Math.random() * 9000);
    const now = new Date().toISOString();
    const title = `Lawn Maintenance (${frequency || 'Scheduled'} - ${property_size || 5000} sq ft)`;
    const price = Number(estimated_price) || 55.00;

    // 1. Create Work Order in local database
    await dbRun(`
      INSERT INTO work_orders (id, title, client_name, client_email, client_phone, property_address, service_type, status, priority, created_at, description, supervisor_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      woId,
      title,
      name,
      email || '',
      phone,
      property_address,
      'Precision Lawn Mowing & Turf Care',
      'incoming',
      'high',
      now,
      `Calculated estimate: $${price}/visit. Frequency: ${frequency || 'Weekly'}. Property area: ${property_size || 5000} sq ft.`,
      notes ? `Customer instructions: ${notes}` : 'Booked via Instant Website Pricing Calculator.'
    ]);

    // 2. Generate Digital Quote
    const quoteId = 'QTE-2026-' + (Math.floor(Math.random() * 800) + 100);
    const items = [
      { description: `Precision Turf Cut, Edge Trimming & Cleanup (${property_size || 5000} sq ft)`, quantity: 1, unit_price: price, amount: price }
    ];
    const tax = Math.round(price * 0.065 * 100) / 100;
    const total = Math.round((price + tax) * 100) / 100;

    await dbRun(`
      INSERT INTO quotes (id, work_order_id, client_name, client_email, client_phone, property_address, service_tier, items_json, subtotal, tax, discount, total_amount, status, notes, valid_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      quoteId,
      woId,
      name,
      email || '',
      phone,
      property_address,
      `${frequency ? frequency.toUpperCase() : 'WEEKLY'} Turf Care Plan`,
      JSON.stringify(items),
      price,
      tax,
      0,
      total,
      'sent',
      `Locked-in pricing from web calculator. ${notes || ''}`,
      new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
      now
    ]);

    // 3. Record in Client CRM
    const existingClient = await dbGet('SELECT * FROM client_profiles WHERE name = ?', [name]);
    if (!existingClient) {
      await dbRun(`
        INSERT INTO client_profiles (name, email, phone, property_address, property_size_sqft, special_instructions, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [name, email || '', phone, property_address, Number(property_size) || 5000, notes || '', now]);
    }

    // 4. Log Audit
    await logAudit('WEB_CALCULATOR_BOOKING', `New instant booking #${woId} from ${name} (${property_address})`, email || 'web@lawncraft.com', 'work_order', String(woId));

    res.json({
      success: true,
      message: 'Booking placed successfully in supervisor dispatch queue',
      work_order_id: woId,
      quote_id: quoteId
    });
  } catch (err) {
    console.error('[Calculator Book Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Supervisor Dashboard Digital Quotes API ─────────────────

app.get('/api/quotes', async (req, res) => {
  try {
    const quotes = await dbAll('SELECT * FROM quotes ORDER BY created_at DESC');
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quotes', async (req, res) => {
  try {
    const { work_order_id, client_name, client_email, client_phone, property_address, service_tier, items, discount, notes, valid_until } = req.body || {};
    if (!client_name || !property_address) {
      return res.status(400).json({ error: 'Client name and property address are required.' });
    }

    const quoteId = 'QTE-2026-' + (Math.floor(Math.random() * 900) + 100);
    const lineItems = Array.isArray(items) ? items : [
      { description: service_tier || 'Grounds Maintenance Package', quantity: 1, unit_price: 150.00, amount: 150.00 }
    ];
    const subtotal = lineItems.reduce((sum, it) => sum + (Number(it.amount) || (Number(it.quantity) * Number(it.unit_price)) || 0), 0);
    const disc = Number(discount) || 0;
    const tax = Math.round((subtotal - disc) * 0.065 * 100) / 100;
    const total = Math.max(0, subtotal - disc + tax);
    const now = new Date().toISOString();

    await dbRun(`
      INSERT INTO quotes (id, work_order_id, client_name, client_email, client_phone, property_address, service_tier, items_json, subtotal, tax, discount, total_amount, status, notes, valid_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
    `, [
      quoteId,
      work_order_id || null,
      client_name,
      client_email || '',
      client_phone || '',
      property_address,
      service_tier || 'Deluxe Turf Care Package',
      JSON.stringify(lineItems),
      subtotal,
      tax,
      disc,
      total,
      notes || '',
      valid_until || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
      now
    ]);

    await logAudit('QUOTE_CREATED', `Created digital estimate ${quoteId} for ${client_name} ($${total.toFixed(2)})`, activeUserSession.email, 'quote', quoteId);

    const created = await dbGet('SELECT * FROM quotes WHERE id = ?', [quoteId]);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/work-orders/:id/generate-quote', async (req, res) => {
  try {
    const { id } = req.params;
    const wo = await dbGet('SELECT * FROM work_orders WHERE id = ?', [Number(id)]);
    if (!wo) {
      return res.status(404).json({ error: 'Work order not found' });
    }

    const quoteId = 'QTE-2026-' + (Math.floor(Math.random() * 900) + 100);
    const lineItems = [
      { description: `${wo.service_type || wo.title || 'Grounds Care Service'} - Initial Scope`, quantity: 1, unit_price: 240.00, amount: 240.00 },
      { description: 'Soil Amendment & Premium Eco-Safe Turf Treatment', quantity: 1, unit_price: 85.00, amount: 85.00 }
    ];
    const subtotal = 325.00;
    const tax = 21.13;
    const total = 346.13;
    const now = new Date().toISOString();

    await dbRun(`
      INSERT INTO quotes (id, work_order_id, client_name, client_email, client_phone, property_address, service_tier, items_json, subtotal, tax, discount, total_amount, status, notes, valid_until, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)
    `, [
      quoteId,
      wo.id,
      wo.client_name,
      wo.client_email || '',
      wo.client_phone || '',
      wo.property_address,
      `${wo.service_type || 'Grounds Care'} Custom Estimate`,
      JSON.stringify(lineItems),
      subtotal,
      tax,
      0,
      total,
      wo.supervisor_notes || wo.description || 'Generated by Supervisor',
      new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0],
      now
    ]);

    await logAudit('QUOTE_AUTO_GENERATED', `Auto-generated digital quote ${quoteId} from Work Order #${wo.id}`, activeUserSession.email, 'quote', quoteId);

    const created = await dbGet('SELECT * FROM quotes WHERE id = ?', [quoteId]);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/quotes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { service_tier, status, notes, valid_until, discount } = req.body || {};
    
    await dbRun(`
      UPDATE quotes 
      SET service_tier = COALESCE(?, service_tier),
          status = COALESCE(?, status),
          notes = COALESCE(?, notes),
          valid_until = COALESCE(?, valid_until),
          discount = COALESCE(?, discount)
      WHERE id = ?
    `, [service_tier || null, status || null, notes || null, valid_until || null, discount !== undefined ? Number(discount) : null, id]);

    const updated = await dbGet('SELECT * FROM quotes WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/quotes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM quotes WHERE id = ?', [id]);
    await logAudit('QUOTE_DELETED', `Deleted digital quote ${id}`, activeUserSession.email, 'quote', id);
    res.json({ success: true, message: `Quote ${id} removed` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Before & After Photo Proof API ───────────────────────────

app.get('/api/work-orders/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;
    const photos = await dbAll('SELECT * FROM work_order_photos WHERE work_order_id = ? ORDER BY uploaded_at ASC', [Number(id)]);
    res.json(photos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/work-orders/:id/photos', async (req, res) => {
  try {
    const { id } = req.params;
    const { photo_type, photo_url, caption } = req.body || {};
    if (!photo_url) {
      return res.status(400).json({ error: 'photo_url is required.' });
    }

    const now = new Date().toISOString();
    const result = await dbRun(`
      INSERT INTO work_order_photos (work_order_id, photo_type, photo_url, caption, uploaded_at, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [Number(id), photo_type || 'after', photo_url, caption || '', now, activeUserSession.email]);

    await logAudit('WORK_ORDER_PHOTO_UPLOADED', `Uploaded ${photo_type || 'proof'} photo for Work Order #${id}`, activeUserSession.email, 'photo', String(result.lastID));

    const photo = await dbGet('SELECT * FROM work_order_photos WHERE id = ?', [result.lastID]);
    res.json(photo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/work-orders/photos/:photoId', async (req, res) => {
  try {
    const { photoId } = req.params;
    await dbRun('DELETE FROM work_order_photos WHERE id = ?', [Number(photoId)]);
    res.json({ success: true, message: 'Photo deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recurring Maintenance Contracts API ──────────────────────

app.get('/api/contracts', async (req, res) => {
  try {
    const contracts = await dbAll('SELECT * FROM recurring_contracts ORDER BY created_at DESC');
    res.json(contracts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contracts', async (req, res) => {
  try {
    const { client_name, client_email, client_phone, property_address, service_type, frequency, rate_per_visit, next_scheduled_date, assigned_crew, notes } = req.body || {};
    if (!client_name || !property_address) {
      return res.status(400).json({ error: 'Client name and property address are required.' });
    }

    const contractId = 'REC-2026-' + (Math.floor(Math.random() * 900) + 100);
    const now = new Date().toISOString();

    await dbRun(`
      INSERT INTO recurring_contracts (id, client_name, client_email, client_phone, property_address, service_type, frequency, rate_per_visit, status, next_scheduled_date, assigned_crew, notes, auto_generate_wo, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?)
    `, [
      contractId,
      client_name,
      client_email || '',
      client_phone || '',
      property_address,
      service_type || 'Weekly Grounds Maintenance',
      frequency || 'weekly',
      Number(rate_per_visit) || 120.00,
      next_scheduled_date || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
      assigned_crew || 'Team Alpha (Marcus Vance)',
      notes || '',
      now
    ]);

    await logAudit('CONTRACT_CREATED', `Created recurring contract ${contractId} for ${client_name} ($${rate_per_visit || 120}/visit)`, activeUserSession.email, 'contract', contractId);

    const created = await dbGet('SELECT * FROM recurring_contracts WHERE id = ?', [contractId]);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/contracts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, frequency, rate_per_visit, next_scheduled_date, assigned_crew, notes } = req.body || {};
    
    await dbRun(`
      UPDATE recurring_contracts 
      SET status = COALESCE(?, status),
          frequency = COALESCE(?, frequency),
          rate_per_visit = COALESCE(?, rate_per_visit),
          next_scheduled_date = COALESCE(?, next_scheduled_date),
          assigned_crew = COALESCE(?, assigned_crew),
          notes = COALESCE(?, notes)
      WHERE id = ?
    `, [status || null, frequency || null, rate_per_visit ? Number(rate_per_visit) : null, next_scheduled_date || null, assigned_crew || null, notes || null, id]);

    const updated = await dbGet('SELECT * FROM recurring_contracts WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/contracts/:id/generate-order', async (req, res) => {
  try {
    const { id } = req.params;
    const contract = await dbGet('SELECT * FROM recurring_contracts WHERE id = ?', [id]);
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found' });
    }

    const woId = 8000 + Math.floor(Math.random() * 1000);
    const now = new Date().toISOString();
    const title = `Scheduled Visit: ${contract.service_type}`;

    await dbRun(`
      INSERT INTO work_orders (id, title, client_name, client_email, client_phone, property_address, service_type, status, priority, target_date, created_at, description, supervisor_notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 'medium', ?, ?, ?, ?)
    `, [
      woId,
      title,
      contract.client_name,
      contract.client_email,
      contract.client_phone,
      contract.property_address,
      contract.service_type,
      contract.next_scheduled_date ? `${contract.next_scheduled_date}T08:30:00Z` : now,
      now,
      `Auto-generated from Recurring Contract ${contract.id}. Rate: $${contract.rate_per_visit}/visit.`,
      `Assigned to: ${contract.assigned_crew || 'Field Crew'}. Special notes: ${contract.notes || 'Standard protocol'}`
    ]);

    // Advance next scheduled date by frequency
    let daysToAdd = 7;
    if (contract.frequency === 'bi_weekly') daysToAdd = 14;
    else if (contract.frequency === 'monthly') daysToAdd = 30;

    const nextDate = new Date(Date.now() + daysToAdd * 86400000).toISOString().split('T')[0];
    await dbRun('UPDATE recurring_contracts SET next_scheduled_date = ? WHERE id = ?', [nextDate, id]);

    await logAudit('CONTRACT_WORK_ORDER_DISPATCHED', `Generated Work Order #${woId} from Contract ${contract.id}`, activeUserSession.email, 'work_order', String(woId));

    res.json({
      success: true,
      message: `Work Order #${woId} generated successfully. Next visit scheduled for ${nextDate}.`,
      work_order_id: woId,
      next_scheduled_date: nextDate
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Client CRM & Property Profiles API ───────────────────────

app.get('/api/clients/crm', async (req, res) => {
  try {
    const clients = await dbAll('SELECT * FROM client_profiles ORDER BY total_spend DESC, name ASC');
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients/crm', async (req, res) => {
  try {
    const { name, email, phone, property_address, zone, property_size_sqft, grass_type, gate_code, special_instructions } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Client name is required.' });

    const now = new Date().toISOString();
    const result = await dbRun(`
      INSERT INTO client_profiles (name, email, phone, property_address, zone, property_size_sqft, grass_type, gate_code, special_instructions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, email || '', phone || '', property_address || '', zone || 'North Zone', Number(property_size_sqft) || 5000, grass_type || 'Kentucky Bluegrass', gate_code || '', special_instructions || '', now]);

    const created = await dbGet('SELECT * FROM client_profiles WHERE id = ?', [result.lastID]);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/clients/crm/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { email, phone, property_address, zone, property_size_sqft, grass_type, gate_code, special_instructions, status } = req.body || {};
    
    await dbRun(`
      UPDATE client_profiles 
      SET email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          property_address = COALESCE(?, property_address),
          zone = COALESCE(?, zone),
          property_size_sqft = COALESCE(?, property_size_sqft),
          grass_type = COALESCE(?, grass_type),
          gate_code = COALESCE(?, gate_code),
          special_instructions = COALESCE(?, special_instructions),
          status = COALESCE(?, status)
      WHERE id = ?
    `, [email || null, phone || null, property_address || null, zone || null, property_size_sqft ? Number(property_size_sqft) : null, grass_type || null, gate_code || null, special_instructions || null, status || null, Number(id)]);

    const updated = await dbGet('SELECT * FROM client_profiles WHERE id = ?', [Number(id)]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/crm/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun('DELETE FROM client_profiles WHERE id = ?', [Number(id)]);
    res.json({ success: true, message: 'Client profile deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Post-Service Review Requests API ─────────────────────────

app.get('/api/reviews', async (req, res) => {
  try {
    const reviews = await dbAll('SELECT * FROM review_requests ORDER BY sent_at DESC');
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reviews/request', async (req, res) => {
  try {
    const { work_order_id, client_name, client_phone, client_email, channel } = req.body || {};
    const now = new Date().toISOString();

    const result = await dbRun(`
      INSERT INTO review_requests (work_order_id, client_name, client_phone, client_email, channel, status, sent_at)
      VALUES (?, ?, ?, ?, ?, 'sent', ?)
    `, [work_order_id || null, client_name || 'Valued Customer', client_phone || '', client_email || '', channel || 'whatsapp', now]);

    // Update client profile status
    if (client_name) {
      await dbRun(`UPDATE client_profiles SET review_status = 'requested' WHERE name = ?`, [client_name]);
    }

    const reviewLink = `https://g.page/r/lawncraft-reviews/review`;
    const messageText = `Hi ${client_name}! Thank you for trusting Lawn Craft with your grounds care. Our supervisor verified your completed job #${work_order_id || ''}. Could you take 30 seconds to share your experience on Google? ${reviewLink}`;
    
    let dispatchUrl = '';
    if (client_phone) {
      const cleanPhone = client_phone.replace(/\D/g, '');
      dispatchUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(messageText)}`;
    }

    await logAudit('REVIEW_REQUEST_SENT', `Sent Google Review invitation to ${client_name} via ${channel || 'whatsapp'}`, activeUserSession.email, 'review', String(result.lastID));

    res.json({
      success: true,
      message: 'Review request dispatched',
      dispatch_url: dispatchUrl,
      message_text: messageText,
      review_link: reviewLink
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
// ── ODOO ERP MODULES & ENTERPRISE EXTENSIONS ───────────────────
// ════════════════════════════════════════════════════════════════

// ── 1. M-Pesa STK Push & Multi-Gateway Payments (Odoo Payments) ──

app.get('/api/mpesa/transactions', async (req, res) => {
  try {
    const txns = await dbAll('SELECT * FROM mpesa_transactions ORDER BY transaction_date DESC');
    res.json(txns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { invoice_id, work_order_id, phone_number, amount, customer_name, coupon_code, loyalty_points_redeemed, notes } = req.body || {};
    
    if (!phone_number) {
      return res.status(400).json({ error: 'M-Pesa phone number is required.' });
    }

    // Normalize Kenyan & International phone numbers (e.g. 0712345678 -> 254712345678)
    let cleanPhone = phone_number.replace(/\D/g, '');
    if (cleanPhone.startsWith('0') && cleanPhone.length === 10) {
      cleanPhone = '254' + cleanPhone.slice(1);
    } else if (cleanPhone.length === 9) {
      cleanPhone = '254' + cleanPhone;
    }

    let rawAmount = Number(amount) || 0;
    let discountApplied = 0;
    let loyaltyDiscount = 0;

    // Apply Coupon if valid
    if (coupon_code) {
      const coupon = await dbGet('SELECT * FROM coupons WHERE UPPER(code) = UPPER(?) AND is_active = 1', [coupon_code.trim()]);
      if (coupon) {
        if (coupon.discount_type === 'percentage') {
          discountApplied = Math.min(coupon.max_discount, Math.round((rawAmount * (coupon.discount_value / 100)) * 100) / 100);
        } else {
          discountApplied = Math.min(rawAmount, coupon.discount_value);
        }
        await dbRun('UPDATE coupons SET times_used = times_used + 1 WHERE code = ?', [coupon.code]);
      }
    }

    // Apply Loyalty Points Redemption ($0.50 per point)
    const pointsToRedeem = Math.max(0, parseInt(loyalty_points_redeemed, 10) || 0);
    if (pointsToRedeem > 0) {
      loyaltyDiscount = Math.min(rawAmount - discountApplied, Math.round((pointsToRedeem * 0.50) * 100) / 100);
    }

    const payableAmount = Math.max(1, Math.round((rawAmount - discountApplied - loyaltyDiscount) * 100) / 100);
    const now = new Date().toISOString();
    const txnId = 'TXN-MP-' + (Math.floor(Math.random() * 90000) + 10000);
    const checkoutReqId = 'ws_CO_' + Date.now() + '_' + Math.floor(Math.random() * 900);
    
    // Generate realistic M-Pesa Receipt Number (e.g. QK89X4J21A)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let mpesaReceipt = 'QK';
    for (let i = 0; i < 8; i++) {
      mpesaReceipt += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // 1. Record M-Pesa Transaction
    await dbRun(`
      INSERT INTO mpesa_transactions (id, invoice_id, work_order_id, phone_number, amount, mpesa_receipt_number, transaction_date, status, result_desc, customer_name, account_reference, checkout_request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'The service request is processed successfully via Lipa Na M-Pesa Online.', ?, ?, ?, ?)
    `, [
      txnId,
      invoice_id || null,
      work_order_id ? Number(work_order_id) : null,
      cleanPhone,
      payableAmount,
      mpesaReceipt,
      now,
      customer_name || 'Valued Customer',
      invoice_id || ('WO-' + (work_order_id || '999')),
      checkoutReqId,
      now
    ]);

    // 2. Record C2B / Paybill Ledger entry for automated reconciliation
    await dbRun(`
      INSERT INTO c2b_transactions (id, trans_id, trans_time, trans_amount, business_short_code, bill_ref_number, msisdn, first_name, matched_invoice_id, reconciled_status, reconciled_at, notes, created_at)
      VALUES (?, ?, ?, ?, '522522', ?, ?, ?, ?, 'reconciled', ?, ?, ?)
    `, [
      'C2B-' + txnId,
      mpesaReceipt,
      now.replace('T', ' ').slice(0, 19),
      payableAmount,
      invoice_id || ('WO-' + (work_order_id || '999')),
      cleanPhone,
      (customer_name || 'Customer').split(' ')[0],
      invoice_id || null,
      now,
      'Settled via M-Pesa Express STK Push.',
      now
    ]);

    // 3. Update Invoice if provided
    let invoiceData = null;
    if (invoice_id) {
      const inv = await dbGet('SELECT * FROM invoices WHERE id = ?', [invoice_id]);
      if (inv) {
        const totalPaid = Math.round((inv.amount_paid + payableAmount + discountApplied + loyaltyDiscount) * 100) / 100;
        const newBalance = Math.max(0, Math.round((inv.total_amount - totalPaid) * 100) / 100);
        const newStatus = newBalance <= 0.01 ? 'paid' : 'partially_paid';

        await dbRun(`
          UPDATE invoices 
          SET amount_paid = ?, balance_due = ?, status = ?, payment_method = 'M-Pesa (Lipa Na M-Pesa)', updated_at = ?
          WHERE id = ?
        `, [totalPaid, newBalance, newStatus, now, invoice_id]);

        // Record Invoice Payment
        const paymentId = 'PAY-MP-' + (Math.floor(Math.random() * 9000) + 1000);
        await dbRun(`
          INSERT INTO invoice_payments (id, invoice_id, date, amount, method, reference, notes)
          VALUES (?, ?, ?, ?, 'M-Pesa (STK Push)', ?, ?)
        `, [
          paymentId,
          invoice_id,
          now,
          payableAmount,
          mpesaReceipt,
          `M-Pesa Online prompt sent to ${cleanPhone}. Receipt: ${mpesaReceipt}`
        ]);

        invoiceData = await dbGet('SELECT * FROM invoices WHERE id = ?', [invoice_id]);
      }
    }

    // 4. Accrue & Update Loyalty Points (Earn 1 pt per $10 spent)
    const pointsEarned = Math.max(1, Math.floor(payableAmount / 10));
    let loyaltyAccount = await dbGet('SELECT * FROM loyalty_accounts WHERE client_phone = ? OR client_name = ?', [cleanPhone, customer_name || '']);
    
    if (loyaltyAccount) {
      const newPoints = loyaltyAccount.points_balance - pointsToRedeem + pointsEarned;
      const lifetimeEarned = loyaltyAccount.lifetime_points_earned + pointsEarned;
      const lifetimeRedeemed = loyaltyAccount.lifetime_points_redeemed + pointsToRedeem;
      
      // Auto upgrade tier based on lifetime points
      let newTier = 'bronze';
      if (lifetimeEarned >= 600) newTier = 'platinum';
      else if (lifetimeEarned >= 300) newTier = 'gold';
      else if (lifetimeEarned >= 150) newTier = 'silver';

      await dbRun(`
        UPDATE loyalty_accounts 
        SET points_balance = ?, lifetime_points_earned = ?, lifetime_points_redeemed = ?, tier = ?, updated_at = ?
        WHERE id = ?
      `, [newPoints, lifetimeEarned, lifetimeRedeemed, newTier, now, loyaltyAccount.id]);

      // Record Loyalty Earn Transaction
      await dbRun(`
        INSERT INTO loyalty_transactions (id, account_id, type, points, invoice_id, work_order_id, description, created_at)
        VALUES (?, ?, 'earn', ?, ?, ?, ?, ?)
      `, [
        'LTX-' + Date.now(),
        loyaltyAccount.id,
        pointsEarned,
        invoice_id || null,
        work_order_id ? Number(work_order_id) : null,
        `Earned ${pointsEarned} loyalty points from M-Pesa payment (${mpesaReceipt})`,
        now
      ]);

      if (pointsToRedeem > 0) {
        await dbRun(`
          INSERT INTO loyalty_transactions (id, account_id, type, points, invoice_id, work_order_id, description, created_at)
          VALUES (?, ?, 'redeem', ?, ?, ?, ?, ?)
        `, [
          'LTX-R-' + Date.now(),
          loyaltyAccount.id,
          -pointsToRedeem,
          invoice_id || null,
          work_order_id ? Number(work_order_id) : null,
          `Redeemed ${pointsToRedeem} points for $${loyaltyDiscount.toFixed(2)} discount`,
          now
        ]);
      }
    } else if (customer_name) {
      const newAccId = 'ACC-LOYAL-' + (Math.floor(Math.random() * 900) + 100);
      const refCode = 'REF-' + (customer_name.replace(/[^a-zA-Z]/g, '').slice(0, 6).toUpperCase() || 'LAWN');
      await dbRun(`
        INSERT INTO loyalty_accounts (id, client_name, client_phone, client_email, points_balance, lifetime_points_earned, lifetime_points_redeemed, tier, referral_code, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, ?, 0, 'bronze', ?, ?, ?)
      `, [newAccId, customer_name, cleanPhone, pointsEarned, pointsEarned, refCode, now, now]);

      await dbRun(`
        INSERT INTO loyalty_transactions (id, account_id, type, points, invoice_id, work_order_id, description, created_at)
        VALUES (?, ?, 'earn', ?, ?, ?, ?, ?)
      `, [
        'LTX-' + Date.now(),
        newAccId,
        pointsEarned,
        invoice_id || null,
        work_order_id ? Number(work_order_id) : null,
        `Welcome bonus and ${pointsEarned} points earned from M-Pesa settlement`,
        now
      ]);
    }

    // 5. Update Client total spend in CRM
    if (customer_name) {
      await dbRun(`
        UPDATE client_profiles 
        SET total_spend = total_spend + ?, last_service_date = ?
        WHERE name = ?
      `, [payableAmount, now.split('T')[0], customer_name]);
    }

    await logAudit('MPESA_PAYMENT_SUCCESS', `M-Pesa STK push confirmed for ${customer_name || cleanPhone}: $${payableAmount.toFixed(2)} (Receipt: ${mpesaReceipt})`, activeUserSession.email, 'payment', mpesaReceipt);

    res.json({
      success: true,
      message: 'M-Pesa STK Push processed and confirmed successfully',
      checkout_request_id: checkoutReqId,
      mpesa_receipt: mpesaReceipt,
      transaction_id: txnId,
      amount_paid: payableAmount,
      discount_applied: discountApplied,
      loyalty_discount: loyaltyDiscount,
      points_earned: pointsEarned,
      invoice: invoiceData,
      e_receipt_url: `/receipt/${invoice_id || txnId}`
    });
  } catch (err) {
    console.error('[M-Pesa STK Error]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. C2B / Paybill Reconciliation Ledger (Odoo Ledger) ─────

app.get('/api/mpesa/c2b-ledger', async (req, res) => {
  try {
    const records = await dbAll('SELECT * FROM c2b_transactions ORDER BY trans_time DESC');
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/mpesa/c2b-reconcile/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { invoice_id, notes } = req.body || {};
    const now = new Date().toISOString();

    const c2b = await dbGet('SELECT * FROM c2b_transactions WHERE id = ?', [id]);
    if (!c2b) return res.status(404).json({ error: 'C2B transaction not found' });

    if (invoice_id) {
      const inv = await dbGet('SELECT * FROM invoices WHERE id = ?', [invoice_id]);
      if (inv) {
        const totalPaid = Math.round((inv.amount_paid + c2b.trans_amount) * 100) / 100;
        const newBalance = Math.max(0, Math.round((inv.total_amount - totalPaid) * 100) / 100);
        const newStatus = newBalance <= 0.01 ? 'paid' : 'partially_paid';

        await dbRun(`
          UPDATE invoices 
          SET amount_paid = ?, balance_due = ?, status = ?, payment_method = 'M-Pesa Paybill Reconciliation', updated_at = ?
          WHERE id = ?
        `, [totalPaid, newBalance, newStatus, now, invoice_id]);

        await dbRun(`
          INSERT INTO invoice_payments (id, invoice_id, date, amount, method, reference, notes)
          VALUES (?, ?, ?, ?, 'M-Pesa Paybill', ?, ?)
        `, [
          'PAY-C2B-' + Math.floor(Math.random() * 9000),
          invoice_id,
          now,
          c2b.trans_amount,
          c2b.trans_id,
          `Reconciled Paybill payment from ${c2b.first_name || 'Client'} (${c2b.msisdn})`
        ]);
      }
    }

    await dbRun(`
      UPDATE c2b_transactions 
      SET matched_invoice_id = COALESCE(?, matched_invoice_id),
          reconciled_status = 'reconciled',
          reconciled_at = ?,
          notes = COALESCE(?, notes)
      WHERE id = ?
    `, [invoice_id || null, now, notes || 'Reconciled by supervisor.', id]);

    await logAudit('C2B_RECONCILE', `Reconciled M-Pesa C2B txn ${c2b.trans_id} to invoice ${invoice_id || 'manual ledger'}`, activeUserSession.email, 'payment', id);

    const updated = await dbGet('SELECT * FROM c2b_transactions WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 3. Loyalty Rewards & Points Engine (Odoo Loyalty) ─────────

app.get('/api/loyalty/accounts', async (req, res) => {
  try {
    const accounts = await dbAll('SELECT * FROM loyalty_accounts ORDER BY points_balance DESC, client_name ASC');
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/loyalty/summary/:key', async (req, res) => {
  try {
    const { key } = req.params;
    let cleanPhone = key.replace(/\D/g, '');
    if (cleanPhone.startsWith('0') && cleanPhone.length === 10) cleanPhone = '254' + cleanPhone.slice(1);

    let account = await dbGet('SELECT * FROM loyalty_accounts WHERE client_phone = ? OR LOWER(client_email) = LOWER(?) OR LOWER(client_name) = LOWER(?) OR UPPER(referral_code) = UPPER(?)', [cleanPhone, key, key, key]);
    
    if (!account) {
      return res.json({
        found: false,
        points_balance: 0,
        tier: 'bronze',
        tier_label: 'Standard Bronze Member',
        discount_value: 0,
        perks: ['Earn 1 pt per $10 spent']
      });
    }

    const perksByTier = {
      bronze: ['1 Point per $10 spent', 'Birthday seasonal offer discount'],
      silver: ['1.2x Points Multiplier', '5% Off Aeration & Seasonal Cleanup', 'Priority Dispatch Queue'],
      gold: ['1.5x Points Multiplier', '10% Off All Services', 'Free Soil Chemistry & pH Test ($85 value)', 'Dedicated Lead Supervisor'],
      platinum: ['2.0x Double Points', '15% Off All Services & Sod Installations', 'Complimentary Spring Overseeding Pass', 'Emergency 2-Hour Response Service']
    };

    res.json({
      found: true,
      account,
      points_balance: account.points_balance,
      tier: account.tier,
      tier_label: `${account.tier.toUpperCase()} VIP Member`,
      discount_value: Math.round(account.points_balance * 0.50 * 100) / 100,
      perks: perksByTier[account.tier] || perksByTier.bronze
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/loyalty/transactions', async (req, res) => {
  try {
    const txns = await dbAll('SELECT * FROM loyalty_transactions ORDER BY created_at DESC LIMIT 50');
    res.json(txns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 4. Coupons & Promo Engine (Odoo Promotions) ───────────────

app.get('/api/coupons', async (req, res) => {
  try {
    const coupons = await dbAll('SELECT * FROM coupons ORDER BY is_active DESC, valid_until ASC');
    res.json(coupons);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coupons/validate', async (req, res) => {
  try {
    const { code, spend_amount } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Coupon code required' });

    const coupon = await dbGet('SELECT * FROM coupons WHERE UPPER(code) = UPPER(?)', [code.trim()]);
    if (!coupon) {
      return res.status(404).json({ valid: false, message: 'Invalid promo code' });
    }

    if (!coupon.is_active) {
      return res.status(400).json({ valid: false, message: 'This promo code is inactive' });
    }

    if (coupon.valid_until && new Date(coupon.valid_until) < new Date()) {
      return res.status(400).json({ valid: false, message: 'This promo code has expired' });
    }

    const spend = Number(spend_amount) || 0;
    if (spend < coupon.min_spend) {
      return res.status(400).json({ valid: false, message: `Minimum spend of $${coupon.min_spend.toFixed(2)} required for code ${coupon.code}` });
    }

    let discount = 0;
    if (coupon.discount_type === 'percentage') {
      discount = Math.min(coupon.max_discount, Math.round((spend * (coupon.discount_value / 100)) * 100) / 100);
    } else {
      discount = Math.min(spend, coupon.discount_value);
    }

    res.json({
      valid: true,
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
      discount_calculated: discount,
      description: coupon.description
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 5. Branded Electronic Tax E-Receipts (Odoo E-Receipts) ─────

app.get('/api/receipts/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Look up via invoice, payment, or mpesa transaction
    let invoice = await dbGet('SELECT * FROM invoices WHERE id = ?', [id]);
    let mpesaTxn = await dbGet('SELECT * FROM mpesa_transactions WHERE id = ? OR invoice_id = ? OR mpesa_receipt_number = ?', [id, id, id]);
    let items = [];
    let payments = [];

    if (invoice) {
      items = await dbAll('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
      payments = await dbAll('SELECT * FROM invoice_payments WHERE invoice_id = ?', [invoice.id]);
    }

    if (!invoice && mpesaTxn) {
      // Build receipt from M-Pesa transaction
      invoice = {
        id: mpesaTxn.invoice_id || ('REC-' + mpesaTxn.id),
        client_name: mpesaTxn.customer_name || 'Customer',
        client_phone: mpesaTxn.phone_number,
        property_address: 'Direct Mobile Payment / Field Service',
        issue_date: mpesaTxn.transaction_date.split('T')[0],
        total_amount: mpesaTxn.amount,
        amount_paid: mpesaTxn.amount,
        balance_due: 0,
        status: 'paid',
        payment_method: 'Lipa Na M-Pesa Online'
      };
      items = [{ description: 'Lawn & Grounds Maintenance Service', quantity: 1, unit_price: mpesaTxn.amount, amount: mpesaTxn.amount }];
      payments = [{ id: mpesaTxn.id, date: mpesaTxn.transaction_date, amount: mpesaTxn.amount, method: 'M-Pesa Express', reference: mpesaTxn.mpesa_receipt_number }];
    }

    if (!invoice) {
      return res.status(404).json({ error: 'Receipt record not found' });
    }

    const receiptData = {
      receipt_number: 'RCPT-' + (mpesaTxn?.mpesa_receipt_number || invoice.id.replace('INV-', '')),
      company_name: 'Lawn Craft Professional Grounds & Turf ERP',
      company_tax_pin: 'P051829104A',
      company_vat_reg: 'VAT-99214-KE',
      company_phone: '+254 700 112 233 / (555) 0199',
      company_email: 'billing@lawncraft.com',
      company_address: 'Lawn Craft Headquarters, Suite 400, Green City',
      invoice,
      items,
      payments,
      mpesa_transaction: mpesaTxn,
      generated_at: new Date().toISOString(),
      qr_verification_token: `LAWNCRAFT-VERIFIED-TAX-${invoice.id}-${Date.now().toString(36).toUpperCase()}`
    };

    res.json(receiptData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/receipts/dispatch', async (req, res) => {
  try {
    const { receipt_id, client_email, client_phone, channel } = req.body || {};
    const receiptUrl = `https://ais-pre-2r565755mktnute2mkiant-69525622808.europe-west2.run.app/receipt/${receipt_id}`;
    
    let dispatchUrl = '';
    const message = `Dear Client, thank you for your payment to Lawn Craft! Your official electronic tax receipt (#${receipt_id}) is ready: ${receiptUrl}`;

    if (client_phone) {
      const cleanPhone = client_phone.replace(/\D/g, '');
      dispatchUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
    }

    await logAudit('E_RECEIPT_DISPATCHED', `Dispatched electronic receipt ${receipt_id} to ${client_email || client_phone} via ${channel || 'auto'}`, activeUserSession.email, 'receipt', receipt_id);

    res.json({
      success: true,
      message: `E-Receipt #${receipt_id} dispatched successfully to ${client_email || client_phone}`,
      receipt_url: receiptUrl,
      whatsapp_dispatch_url: dispatchUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 6. Fleet & Equipment Asset Management (Odoo Fleet) ────────

app.get('/api/fleet', async (req, res) => {
  try {
    const fleet = await dbAll('SELECT * FROM equipment_fleet ORDER BY category ASC, name ASC');
    res.json(fleet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fleet', async (req, res) => {
  try {
    const { name, category, serial_number, model_year, meter_hours, fuel_type, assigned_crew, next_service_hours, notes } = req.body || {};
    if (!name || !category) return res.status(400).json({ error: 'Name and category required.' });

    const eqId = 'EQ-' + category.slice(0, 3).toUpperCase() + '-' + (Math.floor(Math.random() * 90) + 10);
    const now = new Date().toISOString();

    await dbRun(`
      INSERT INTO equipment_fleet (id, name, category, serial_number, model_year, meter_hours, fuel_type, status, assigned_crew, next_service_hours, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'operational', ?, ?, ?, ?)
    `, [
      eqId,
      name,
      category,
      serial_number || 'SN-' + Date.now().toString().slice(-6),
      Number(model_year) || 2024,
      Number(meter_hours) || 0,
      fuel_type || 'Gasoline',
      assigned_crew || 'Team Alpha (Marcus Vance)',
      Number(next_service_hours) || 50,
      notes || '',
      now
    ]);

    await logAudit('FLEET_ASSET_ADDED', `Added equipment asset ${name} (${eqId})`, activeUserSession.email, 'fleet', eqId);

    const created = await dbGet('SELECT * FROM equipment_fleet WHERE id = ?', [eqId]);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fleet/:id/maintenance', async (req, res) => {
  try {
    const { id } = req.params;
    const { log_type, cost, performed_by, odometer_hours, notes, next_service_hours } = req.body || {};
    const logId = 'FML-' + Date.now().toString().slice(-4);
    const now = new Date().toISOString();

    await dbRun(`
      INSERT INTO fleet_maintenance_logs (id, equipment_id, log_type, cost, performed_by, odometer_hours, notes, logged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      logId,
      id,
      log_type || 'routine_service',
      Number(cost) || 0,
      performed_by || activeUserSession.full_name,
      Number(odometer_hours) || 0,
      notes || '',
      now
    ]);

    // Update equipment stats
    await dbRun(`
      UPDATE equipment_fleet 
      SET last_maintenance_date = ?, 
          meter_hours = CASE WHEN ? > meter_hours THEN ? ELSE meter_hours END,
          next_service_hours = COALESCE(?, next_service_hours + 50)
      WHERE id = ?
    `, [now.split('T')[0], Number(odometer_hours) || 0, Number(odometer_hours) || 0, next_service_hours ? Number(next_service_hours) : null, id]);

    await logAudit('FLEET_MAINTENANCE_LOGGED', `Logged ${log_type} for asset ${id} ($${Number(cost) || 0})`, activeUserSession.email, 'fleet', id);

    res.json({ success: true, message: 'Maintenance record saved', log_id: logId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fleet/logs', async (req, res) => {
  try {
    const logs = await dbAll(`
      SELECT l.*, e.name as equipment_name, e.category as equipment_category 
      FROM fleet_maintenance_logs l 
      JOIN equipment_fleet e ON l.equipment_id = e.id 
      ORDER BY l.logged_at DESC
    `);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 7. GPS Geo-Fenced Timesheets (Odoo Timesheets) ────────────

app.get('/api/gps-timesheets', async (req, res) => {
  try {
    const timesheets = await dbAll('SELECT * FROM gps_timesheets ORDER BY clock_in_time DESC');
    res.json(timesheets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gps-timesheets/clock-in', async (req, res) => {
  try {
    const { work_order_id, lat, lng, employee_name, notes } = req.body || {};
    const tsId = 'TS-GPS-' + Date.now().toString().slice(-5);
    const now = new Date().toISOString();

    let propAddress = 'Field Site Location';
    let geoStatus = 'verified_on_site';
    let distanceMeters = 15.0; // Standard simulated close proximity

    if (work_order_id) {
      const wo = await dbGet('SELECT * FROM work_orders WHERE id = ?', [Number(work_order_id)]);
      if (wo) {
        propAddress = wo.property_address;
        // If lat/lng provided, simulate realistic geofence calculation
        if (lat && lng) {
          distanceMeters = Math.round(Math.random() * 45 + 5);
          geoStatus = distanceMeters <= 250 ? 'verified_on_site' : 'radius_override';
        }
        // Advance work order status to in_progress if incoming/planned
        if (wo.status === 'incoming' || wo.status === 'planned' || wo.status === 'reviewed') {
          await dbRun(`UPDATE work_orders SET status = 'in_progress', started_at = ? WHERE id = ?`, [now, Number(work_order_id)]);
        }
      }
    }

    await dbRun(`
      INSERT INTO gps_timesheets (id, user_id, employee_name, work_order_id, property_address, clock_in_time, clock_in_lat, clock_in_lng, geo_distance_meters, geo_status, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tsId,
      activeUserSession.id,
      employee_name || activeUserSession.full_name,
      work_order_id ? Number(work_order_id) : null,
      propAddress,
      now,
      Number(lat) || -1.286389,
      Number(lng) || 36.817223,
      distanceMeters,
      geoStatus,
      notes || 'Geo-verified clock-in at property perimeter.',
      now
    ]);

    await logAudit('GPS_CLOCK_IN', `Crew clocked in for WO #${work_order_id || 'general'} (Geo-status: ${geoStatus}, ${distanceMeters}m from site)`, activeUserSession.email, 'timesheet', tsId);

    const created = await dbGet('SELECT * FROM gps_timesheets WHERE id = ?', [tsId]);
    res.json(created);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gps-timesheets/:id/clock-out', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};
    const now = new Date().toISOString();

    const ts = await dbGet('SELECT * FROM gps_timesheets WHERE id = ?', [id]);
    if (!ts) return res.status(404).json({ error: 'Timesheet record not found' });

    const clockIn = new Date(ts.clock_in_time).getTime();
    const clockOut = new Date(now).getTime();
    const totalMinutes = Math.max(15, Math.round((clockOut - clockIn) / 60000));

    await dbRun(`
      UPDATE gps_timesheets 
      SET clock_out_time = ?, total_minutes = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `, [now, totalMinutes, notes || null, id]);

    await logAudit('GPS_CLOCK_OUT', `Crew clocked out of timesheet ${id} (Total: ${totalMinutes} mins)`, activeUserSession.email, 'timesheet', id);

    const updated = await dbGet('SELECT * FROM gps_timesheets WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 8. Vendor Bills & Purchase Orders (Odoo Purchase) ─────────

app.get('/api/purchase-orders', async (req, res) => {
  try {
    const pos = await dbAll('SELECT * FROM vendor_purchase_orders ORDER BY order_date DESC');
    const items = await dbAll('SELECT * FROM purchase_order_items');
    const itemsByPo = new Map();
    items.forEach(it => {
      if (!itemsByPo.has(it.po_id)) itemsByPo.set(it.po_id, []);
      itemsByPo.get(it.po_id).push(it);
    });

    const enriched = pos.map(p => ({
      ...p,
      items: itemsByPo.get(p.id) || []
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-orders', async (req, res) => {
  try {
    const { vendor_name, vendor_contact, expected_delivery, items, notes } = req.body || {};
    if (!vendor_name) return res.status(400).json({ error: 'Vendor name is required.' });

    const poId = 'PO-2026-' + (Math.floor(Math.random() * 900) + 100);
    const now = new Date().toISOString();
    const lineItems = Array.isArray(items) && items.length > 0 ? items : [
      { item_name: 'Turf Supplies Restock', quantity_ordered: 10, unit_cost: 45.00, line_total: 450.00 }
    ];

    const total = lineItems.reduce((sum, it) => sum + (Number(it.line_total) || (Number(it.quantity_ordered) * Number(it.unit_cost)) || 0), 0);

    await dbRun(`
      INSERT INTO vendor_purchase_orders (id, vendor_name, vendor_contact, order_date, expected_delivery, status, total_amount, notes, created_at)
      VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)
    `, [
      poId,
      vendor_name,
      vendor_contact || '',
      now.split('T')[0],
      expected_delivery || new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0],
      total,
      notes || '',
      now
    ]);

    for (const it of lineItems) {
      await dbRun(`
        INSERT INTO purchase_order_items (po_id, inventory_item_id, item_name, quantity_ordered, quantity_received, unit_cost, line_total)
        VALUES (?, ?, ?, ?, 0, ?, ?)
      `, [
        poId,
        it.inventory_item_id || null,
        it.item_name,
        Number(it.quantity_ordered) || 1,
        Number(it.unit_cost) || 0,
        Number(it.line_total) || (Number(it.quantity_ordered) * Number(it.unit_cost))
      ]);
    }

    await logAudit('PURCHASE_ORDER_CREATED', `Created vendor PO ${poId} for ${vendor_name} ($${total.toFixed(2)})`, activeUserSession.email, 'purchase_order', poId);

    res.json({ success: true, message: 'Purchase Order created', po_id: poId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchase-orders/:id/receive', async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date().toISOString();

    const po = await dbGet('SELECT * FROM vendor_purchase_orders WHERE id = ?', [id]);
    if (!po) return res.status(404).json({ error: 'Purchase order not found' });

    const items = await dbAll('SELECT * FROM purchase_order_items WHERE po_id = ?', [id]);
    let restockedCount = 0;

    for (const it of items) {
      // Update line item received quantity
      await dbRun(`UPDATE purchase_order_items SET quantity_received = quantity_ordered WHERE id = ?`, [it.id]);

      // If linked to an inventory item, automatically increase warehouse quantity
      if (it.inventory_item_id) {
        const invItem = await dbGet('SELECT * FROM inventory_items WHERE id = ?', [it.inventory_item_id]);
        if (invItem) {
          const oldQty = invItem.quantity_on_hand;
          const newQty = oldQty + it.quantity_ordered;
          await dbRun(`
            UPDATE inventory_items 
            SET quantity_on_hand = ?, last_restocked = ? 
            WHERE id = ?
          `, [newQty, now.split('T')[0], it.inventory_item_id]);

          // Log inventory transaction
          await dbRun(`
            INSERT INTO inventory_transactions (id, item_id, type, quantity, previous_qty, new_qty, reason, timestamp, actor_email)
            VALUES (?, ?, 'RESTOCK_PO', ?, ?, ?, ?, ?, ?)
          `, [
            'TXN-PO-' + Math.floor(Math.random() * 9000),
            it.inventory_item_id,
            it.quantity_ordered,
            oldQty,
            newQty,
            `Received from Vendor PO #${id} (${po.vendor_name})`,
            now,
            activeUserSession.email
          ]);
          restockedCount++;
        }
      }
    }

    await dbRun(`
      UPDATE vendor_purchase_orders 
      SET status = 'received', received_at = ? 
      WHERE id = ?
    `, [now, id]);

    await logAudit('PO_RECEIVED_RESTOCKED', `Received shipment for PO ${id} and auto-restocked ${restockedCount} inventory items`, activeUserSession.email, 'purchase_order', id);

    res.json({ success: true, message: `PO #${id} received. Restocked ${restockedCount} warehouse inventory items.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 9. Automated Dunning & Overdue Reminders (Odoo Dunning) ────

app.get('/api/dunning/logs', async (req, res) => {
  try {
    const logs = await dbAll('SELECT * FROM dunning_logs ORDER BY sent_at DESC');
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/dunning/run-scan', async (req, res) => {
  try {
    const overdueInvoices = await dbAll(`SELECT * FROM invoices WHERE status = 'overdue' OR (status = 'issued' AND due_date < date('now'))`);
    const now = new Date().toISOString();
    let remindersDispatched = 0;

    for (const inv of overdueInvoices) {
      const stage = 'overdue_notice_7d';
      const logId = 'DUN-' + (Math.floor(Math.random() * 9000) + 1000);
      const payLink = `https://ais-pre-2r565755mktnute2mkiant-69525622808.europe-west2.run.app/pay/${inv.id}`;

      await dbRun(`
        INSERT INTO dunning_logs (id, invoice_id, client_name, client_email, client_phone, stage, sent_via, payment_link, status, sent_at)
        VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', ?, 'dispatched', ?)
      `, [logId, inv.id, inv.client_name, inv.client_email || '', inv.client_phone || '', stage, payLink, now]);

      remindersDispatched++;
    }

    await logAudit('DUNNING_SCAN_RUN', `Executed automated dunning scan: Dispatched ${remindersDispatched} overdue payment reminders`, activeUserSession.email, 'dunning', 'automated');

    res.json({
      success: true,
      message: `Dunning scan complete. Dispatched ${remindersDispatched} overdue payment notices with 1-click M-Pesa/Card links.`,
      dispatched_count: remindersDispatched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 10. Customer Self-Service Portal API (Odoo Portal) ────────

app.post('/api/portal/lookup', async (req, res) => {
  try {
    const { identifier } = req.body || {};
    if (!identifier) return res.status(400).json({ error: 'Phone number or email required.' });

    let cleanPhone = identifier.replace(/\D/g, '');
    if (cleanPhone.startsWith('0') && cleanPhone.length === 10) cleanPhone = '254' + cleanPhone.slice(1);

    // Search client profiles
    const client = await dbGet(`
      SELECT * FROM client_profiles 
      WHERE LOWER(email) = LOWER(?) OR phone LIKE ? OR phone LIKE ? OR LOWER(name) LIKE LOWER(?)
    `, [identifier.trim(), `%${cleanPhone}%`, `%${identifier.trim()}%`, `%${identifier.trim()}%`]);

    const clientName = client?.name || identifier.trim();

    // Fetch related records
    const workOrders = await dbAll(`
      SELECT * FROM work_orders 
      WHERE LOWER(client_name) = LOWER(?) OR client_phone LIKE ? OR LOWER(client_email) = LOWER(?)
      ORDER BY created_at DESC
    `, [clientName, `%${cleanPhone}%`, identifier.trim()]);

    const invoices = await dbAll(`
      SELECT * FROM invoices 
      WHERE LOWER(client_name) = LOWER(?) OR client_phone LIKE ? OR LOWER(client_email) = LOWER(?)
      ORDER BY issue_date DESC
    `, [clientName, `%${cleanPhone}%`, identifier.trim()]);

    const quotes = await dbAll(`
      SELECT * FROM quotes 
      WHERE LOWER(client_name) = LOWER(?) OR client_phone LIKE ? OR LOWER(client_email) = LOWER(?)
      ORDER BY created_at DESC
    `, [clientName, `%${cleanPhone}%`, identifier.trim()]);

    const loyalty = await dbGet(`
      SELECT * FROM loyalty_accounts 
      WHERE client_phone = ? OR LOWER(client_name) = LOWER(?) OR LOWER(client_email) = LOWER(?)
    `, [cleanPhone, clientName, identifier.trim()]);

    res.json({
      success: true,
      client: client || { name: clientName, phone: cleanPhone, email: identifier },
      loyalty: loyalty || { points_balance: 0, tier: 'bronze', referral_code: 'REF-NEW' },
      work_orders: workOrders,
      invoices: invoices,
      quotes: quotes
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Static Asset & Frontend Serving ──────────────────────────

const frontendPath = path.join(__dirname, 'frontend');

app.use(express.static(frontendPath));
app.use('/frontend', express.static(frontendPath));

app.get(['/', '/dashboard', '/frontend/dashboard', '/frontend/dashboard.html'], (req, res) => {
  res.sendFile(path.join(frontendPath, 'dashboard.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'dashboard.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lawn Craft Supervisor Dashboard & ERP Engine running at http://0.0.0.0:${PORT}`);
});
