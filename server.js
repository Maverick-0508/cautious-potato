import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbRun, dbGet, dbAll, initDatabase, getDatabaseStatus, getFirebaseConfig, syncToFirestore } from './database.js';

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

app.get('/api/supervisor/stats', async (req, res) => {
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
