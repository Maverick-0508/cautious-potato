import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// In-Memory Data Store
let users = [
  {
    id: 1,
    email: 'admin@lawncraft.com',
    full_name: 'Alex Rivera (Admin)',
    role: 'admin',
    department: 'Operations',
    cost_center: 'CC-101',
    notes: 'Head of Operations & Lead Supervisor'
  },
  {
    id: 2,
    email: 'supervisor@lawncraft.com',
    full_name: 'Jordan Miller',
    role: 'supervisor',
    department: 'Field',
    cost_center: 'CC-204',
    notes: 'North Territory Supervisor'
  },
  {
    id: 3,
    email: 'marcus.crew@lawncraft.com',
    full_name: 'Marcus Vance',
    role: 'field_tech',
    department: 'Field',
    cost_center: 'CC-204',
    notes: 'Crew Lead - Turf Specialist'
  }
];

let workOrders = [
  {
    id: 101,
    title: 'Spring Lawn Aeration & Overseeding',
    client_name: 'Eleanor Vance',
    client_email: 'eleanor.vance@example.com',
    client_phone: '(555) 234-5678',
    property_address: '742 Evergreen Terrace, Springfield',
    service_type: 'Aeration & Overseeding',
    status: 'incoming',
    priority: 'high',
    target_date: '2026-09-01T08:00:00Z',
    created_at: '2026-08-25T09:15:00Z',
    started_at: null,
    completed_at: null,
    description: 'Full front and backyard core aeration with premium fescue overseeding blend.',
    supervisor_notes: 'Gate access code is #4491. Dog will be kept inside.'
  },
  {
    id: 102,
    title: 'Commercial Turf Health Assessment & Treatment',
    client_name: 'Apex Industrial Park',
    client_email: 'facilities@apexpark.com',
    client_phone: '(555) 890-1234',
    property_address: '1200 Innovation Way, Tech Park',
    service_type: 'Commercial Maintenance',
    status: 'incoming',
    priority: 'medium',
    target_date: '2026-09-03T10:00:00Z',
    created_at: '2026-08-26T11:30:00Z',
    started_at: null,
    completed_at: null,
    description: 'Inspect yellowing patches on south lawn buffer zone and apply organic fertilizer treatment.',
    supervisor_notes: 'Check in with security booth before entering grounds.'
  },
  {
    id: 103,
    title: 'Irrigation System Zone Repair & Valve Replacement',
    client_name: 'Robert Thornton',
    client_email: 'rthornton@example.com',
    client_phone: '(555) 456-7890',
    property_address: '88 Riverview Crescent, Lakeside',
    service_type: 'Irrigation & Drainage',
    status: 'incoming',
    priority: 'urgent',
    target_date: '2026-08-28T09:00:00Z',
    created_at: '2026-08-26T14:45:00Z',
    started_at: null,
    completed_at: null,
    description: 'Zone 3 has low pressure; solenoid valve 2 is unresponsive to controller.',
    supervisor_notes: 'Urgent: Water pooling near driveway foundation.'
  },
  {
    id: 104,
    title: 'Precision Edge Trimming & Seasonal Fertilization',
    client_name: 'Sophia Martinez',
    client_email: 'sophia.m@example.com',
    client_phone: '(555) 678-9012',
    property_address: '45 Magnolia Drive, Blossom Hills',
    service_type: 'Lawn Maintenance',
    status: 'planned',
    priority: 'medium',
    target_date: '2026-08-29T13:00:00Z',
    created_at: '2026-08-24T08:00:00Z',
    started_at: null,
    completed_at: null,
    description: 'Full perimeter edging, weed suppression application, slow-release balanced feeding.',
    supervisor_notes: 'Assigned to Crew Team Beta.'
  },
  {
    id: 105,
    title: 'Landscape Bed Mulching & Weed Barrier Installation',
    client_name: 'Dr. Gregory House',
    client_email: 'ghouse@example.com',
    client_phone: '(555) 321-7654',
    property_address: '15 Meadowbrook Lane, Westend',
    service_type: 'Landscape Enhancement',
    status: 'reviewed',
    priority: 'low',
    target_date: '2026-08-30T10:00:00Z',
    created_at: '2026-08-23T15:20:00Z',
    started_at: null,
    completed_at: null,
    description: '10 yards premium dark cedar mulch delivery and spreading across flowerbeds.',
    supervisor_notes: 'Awaiting mulch supplier delivery confirmation.'
  },
  {
    id: 106,
    title: 'Hydroseeding & Soil Prep on Sloped Yard',
    client_name: 'Claire Underwood',
    client_email: 'claire.u@example.com',
    client_phone: '(555) 789-0123',
    property_address: '304 Highland Summit, Ridgeway',
    service_type: 'Hydroseeding',
    status: 'in_progress',
    priority: 'high',
    target_date: '2026-08-27T14:00:00Z',
    created_at: '2026-08-22T10:00:00Z',
    started_at: '2026-08-27T08:30:00Z',
    completed_at: null,
    description: 'Grade terrace slope, apply tackifier and sun/shade hydroseed slurry.',
    supervisor_notes: 'Field crew on site since 8:30am. Tanker truck positioned on driveway.'
  },
  {
    id: 107,
    title: 'Dethatching & Fall Lawn Renovation',
    client_name: 'David Chen',
    client_email: 'david.chen@example.com',
    client_phone: '(555) 234-8901',
    property_address: '912 Oakridge Boulevard, Greenfield',
    service_type: 'Turf Renovation',
    status: 'in_progress',
    priority: 'urgent',
    target_date: '2026-08-27T16:00:00Z',
    created_at: '2026-08-21T09:00:00Z',
    started_at: '2026-08-27T09:15:00Z',
    completed_at: null,
    description: 'Heavy power dethatching, debris haul away, topdressing with compost mix.',
    supervisor_notes: 'Overdue high-severity issue reported with thatch buildup thickness.'
  },
  {
    id: 108,
    title: 'Smart Sprinkler Controller Upgrade & Weather Sensor',
    client_name: 'Hannah Abbott',
    client_email: 'hannah.a@example.com',
    client_phone: '(555) 901-2345',
    property_address: '52 Sycamore Grove, Eastlake',
    service_type: 'Irrigation & Drainage',
    status: 'completed',
    priority: 'medium',
    target_date: '2026-08-25T11:00:00Z',
    created_at: '2026-08-19T14:00:00Z',
    started_at: '2026-08-25T09:00:00Z',
    completed_at: '2026-08-25T11:30:00Z',
    description: 'Installed 12-zone Rachio controller, wired rain & freeze sensor.',
    supervisor_notes: 'Tested all zones successfully. Client app paired.'
  },
  {
    id: 109,
    title: 'Total Sod Replacement & Topsoil Grading',
    client_name: 'Arthur Pendelton',
    client_email: 'arthur.p@example.com',
    client_phone: '(555) 567-8901',
    property_address: '220 King William Street, Old Town',
    service_type: 'Sod Installation',
    status: 'verified',
    priority: 'high',
    target_date: '2026-08-24T17:00:00Z',
    created_at: '2026-08-18T10:00:00Z',
    started_at: '2026-08-24T07:30:00Z',
    completed_at: '2026-08-24T16:45:00Z',
    description: 'Stripped old Bermuda grass, laser-graded 4 tons loam, laid fresh Kentucky Bluegrass sod.',
    supervisor_notes: 'Supervisor inspected turf rooting and moisture depth. Quality score 10/10.'
  }
];

let permissionPolicies = [
  {
    feature_key: 'financial_reports',
    label: 'Financial Reports Access',
    allowed_roles: 'admin,finance',
    allowed_departments: 'Operations, Finance',
    description: 'Access to financial summary, revenue forecasts, and conversion data',
    is_enabled: true
  },
  {
    feature_key: 'user_management',
    label: 'User Management',
    allowed_roles: 'admin',
    allowed_departments: 'Management, HR',
    description: 'Ability to create, update, and manage accounts and access profiles',
    is_enabled: true
  },
  {
    feature_key: 'work_order_dispatch',
    label: 'Work Order Dispatch',
    allowed_roles: 'admin,supervisor',
    allowed_departments: 'Operations, Field',
    description: 'Permission to assign jobs, alter schedules, and dispatch field crews',
    is_enabled: true
  },
  {
    feature_key: 'system_settings',
    label: 'System Configuration',
    allowed_roles: 'admin',
    allowed_departments: 'Operations, IT',
    description: 'Control system switches, API integrations, and notification triggers',
    is_enabled: true
  }
];

let systemSettings = [
  {
    setting_key: 'contact_intake_enabled',
    group_name: 'General',
    label: 'Contact Intake Pipeline',
    description: 'Enable or pause incoming service inquiries from website forms',
    value: 'true',
    is_sensitive: false
  },
  {
    setting_key: 'notification_email',
    group_name: 'Notifications',
    label: 'Dispatch Notification Email',
    description: 'Destination inbox for urgent job notifications and exception alerts',
    value: 'dispatch@lawncraft.com',
    is_sensitive: false
  },
  {
    setting_key: 'auto_assign_radius',
    group_name: 'Dispatch',
    label: 'Maximum Dispatch Radius (km)',
    description: 'Radius threshold for automated crew territory assignment',
    value: '25',
    is_sensitive: false
  },
  {
    setting_key: 'kpi_refresh_interval',
    group_name: 'Operations',
    label: 'Realtime Sync Interval (seconds)',
    description: 'Frequency of automated supervisor board polling',
    value: '30',
    is_sensitive: false
  }
];

let auditLogs = [
  {
    action: 'WORK_ORDER_STATUS_UPDATE',
    summary: 'Updated #106 Hydroseeding status to in_progress',
    actor_email: 'admin@lawncraft.com',
    resource_type: 'work_order',
    resource_id: '106',
    created_at: new Date(Date.now() - 3600000).toISOString()
  },
  {
    action: 'PERMISSION_POLICY_UPDATE',
    summary: 'Updated feature policy for financial_reports',
    actor_email: 'admin@lawncraft.com',
    resource_type: 'policy',
    resource_id: 'financial_reports',
    created_at: new Date(Date.now() - 86400000).toISOString()
  },
  {
    action: 'USER_LOGIN',
    summary: 'Supervisor login from Web Portal',
    actor_email: 'admin@lawncraft.com',
    resource_type: 'auth',
    resource_id: '',
    created_at: new Date(Date.now() - 172800000).toISOString()
  }
];

let activeUserSession = users[0];

// ── Auth Endpoints ───────────────────────────────────────────

app.post('/api/auth/login/json', (req, res) => {
  const { email, password } = req.body || {};
  if (!email) {
    return res.status(400).json({ detail: 'Email is required' });
  }

  const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) {
    activeUserSession = existingUser;
  } else {
    const isSpecialAdmin = email.toLowerCase().includes('admin');
    activeUserSession = {
      id: users.length + 1,
      email: email,
      full_name: email.split('@')[0],
      role: isSpecialAdmin ? 'admin' : 'supervisor',
      department: 'Operations',
      cost_center: 'CC-101',
      notes: 'Authenticated session'
    };
    users.push(activeUserSession);
  }

  auditLogs.unshift({
    action: 'USER_LOGIN',
    summary: `Signed in as ${activeUserSession.role} (${activeUserSession.email})`,
    actor_email: activeUserSession.email,
    resource_type: 'auth',
    resource_id: '',
    created_at: new Date().toISOString()
  });

  res.json({
    access_token: `mock_jwt_token_${Date.now()}`,
    token_type: 'bearer'
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json(activeUserSession || users[0]);
});

// ── Supervisor Dashboard Endpoints ───────────────────────────

app.get('/api/supervisor/stats', (req, res) => {
  const byStatus = {
    incoming: workOrders.filter(w => w.status === 'incoming').length,
    reviewed: workOrders.filter(w => w.status === 'reviewed').length,
    planned: workOrders.filter(w => w.status === 'planned').length,
    in_progress: workOrders.filter(w => w.status === 'in_progress').length,
    completed: workOrders.filter(w => w.status === 'completed').length,
    verified: workOrders.filter(w => w.status === 'verified').length,
    cancelled: workOrders.filter(w => w.status === 'cancelled').length,
  };

  res.json({
    work_orders_by_status: byStatus,
    open_issues: 2,
    pending_tasks: 5
  });
});

app.get('/api/supervisor/stats-trends', (req, res) => {
  res.json({
    period_days: 7,
    incoming_created: [2, 4, 3, 5, 2, 6, workOrders.filter(w => w.status === 'incoming').length],
    started_jobs: [1, 2, 3, 2, 4, 3, workOrders.filter(w => w.status === 'in_progress').length],
    completed_jobs: [5, 7, 9, 12, 15, 18, workOrders.filter(w => w.status === 'completed' || w.status === 'verified').length],
    issues_logged: [3, 4, 3, 2, 2, 1, 2],
    pending_tasks_created: [8, 7, 6, 7, 5, 4, 5]
  });
});

app.get('/api/supervisor/queue', (req, res) => {
  const queue = workOrders.filter(w => w.status === 'incoming');
  res.json(queue);
});

app.get('/api/supervisor/planning', (req, res) => {
  const planning = workOrders.filter(w => w.status === 'reviewed' || w.status === 'planned');
  res.json(planning);
});

app.get('/api/supervisor/active', (req, res) => {
  const active = workOrders.filter(w => w.status === 'in_progress');
  res.json(active);
});

app.get('/api/supervisor/exceptions', (req, res) => {
  const now = new Date();
  const overdue = workOrders.filter(w => {
    if (w.status === 'completed' || w.status === 'verified' || w.status === 'cancelled') return false;
    return w.target_date && new Date(w.target_date) < now;
  });

  const blocked = workOrders.filter(w => w.priority === 'urgent' && w.status !== 'completed' && w.status !== 'verified');
  const missingLogs = workOrders.filter(w => w.status === 'in_progress');

  res.json({
    overdue: overdue.length ? overdue : [workOrders[2]],
    blocked: blocked.length ? blocked : [workOrders[2]],
    missing_field_logs: missingLogs
  });
});

app.get('/api/supervisor/report', (req, res) => {
  const days = parseInt(req.query.days || '30', 10);
  res.json({
    period_days: days,
    work_orders: {
      total: workOrders.length + 18,
      completed: workOrders.filter(w => w.status === 'completed' || w.status === 'verified').length + 14
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
      avg_hours_to_complete: 42.4
    },
    issues: {
      total: 5,
      resolved: 4,
      resolution_rate_pct: 80
    }
  });
});

app.get('/api/supervisor/property', (req, res) => {
  const addressQuery = String(req.query.address || '').toLowerCase();
  const matches = workOrders.filter(w => w.property_address.toLowerCase().includes(addressQuery));
  res.json(matches);
});

// ── Work Orders CRUD ─────────────────────────────────────────

app.get('/api/work-orders', (req, res) => {
  res.json(workOrders);
});

app.get('/api/work-orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wo = workOrders.find(w => w.id === id);
  if (!wo) {
    return res.status(404).json({ detail: 'Work order not found' });
  }
  res.json(wo);
});

app.put('/api/work-orders/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wo = workOrders.find(w => w.id === id);
  if (!wo) {
    return res.status(404).json({ detail: 'Work order not found' });
  }

  const { status, description, supervisor_notes, priority } = req.body || {};
  if (status) {
    wo.status = status;
    if (status === 'in_progress' && !wo.started_at) {
      wo.started_at = new Date().toISOString();
    }
    if ((status === 'completed' || status === 'verified') && !wo.completed_at) {
      wo.completed_at = new Date().toISOString();
    }
  }
  if (description !== undefined) wo.description = description;
  if (supervisor_notes !== undefined) wo.supervisor_notes = supervisor_notes;
  if (priority !== undefined) wo.priority = priority;

  auditLogs.unshift({
    action: 'WORK_ORDER_STATUS_UPDATE',
    summary: `Updated #${wo.id} status to ${wo.status}`,
    actor_email: activeUserSession.email,
    resource_type: 'work_order',
    resource_id: String(wo.id),
    created_at: new Date().toISOString()
  });

  res.json(wo);
});

// ── Admin Endpoints ──────────────────────────────────────────

app.get('/api/admin/control-center', (req, res) => {
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
    permissions: permissionPolicies,
    settings: systemSettings,
    audit_logs: auditLogs.slice(0, 10)
  });
});

app.get('/api/admin/permissions', (req, res) => {
  res.json(permissionPolicies);
});

app.put('/api/admin/permissions/:featureKey', (req, res) => {
  const { featureKey } = req.params;
  const policy = permissionPolicies.find(p => p.feature_key === featureKey);
  if (!policy) {
    return res.status(404).json({ detail: 'Policy not found' });
  }

  const { label, allowed_roles, allowed_departments, description, is_enabled } = req.body || {};
  if (label !== undefined) policy.label = label;
  if (allowed_roles !== undefined) policy.allowed_roles = allowed_roles;
  if (allowed_departments !== undefined) policy.allowed_departments = allowed_departments;
  if (description !== undefined) policy.description = description;
  if (is_enabled !== undefined) policy.is_enabled = Boolean(is_enabled);

  auditLogs.unshift({
    action: 'PERMISSION_POLICY_UPDATE',
    summary: `Updated feature policy for ${policy.label}`,
    actor_email: activeUserSession.email,
    resource_type: 'policy',
    resource_id: featureKey,
    created_at: new Date().toISOString()
  });

  res.json(policy);
});

app.get('/api/admin/users/access-profiles', (req, res) => {
  const profiles = users.map(u => ({
    user_id: u.id,
    user_email: u.email,
    department: u.department || '',
    cost_center: u.cost_center || '',
    notes: u.notes || ''
  }));
  res.json(profiles);
});

app.put('/api/admin/users/:id/access-profile', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = users.find(u => u.id === id);
  if (!user) {
    return res.status(404).json({ detail: 'User not found' });
  }

  const { department, cost_center, notes } = req.body || {};
  if (department !== undefined) user.department = department;
  if (cost_center !== undefined) user.cost_center = cost_center;
  if (notes !== undefined) user.notes = notes;

  auditLogs.unshift({
    action: 'ACCESS_PROFILE_UPDATE',
    summary: `Updated access profile for ${user.email}`,
    actor_email: activeUserSession.email,
    resource_type: 'user',
    resource_id: String(user.id),
    created_at: new Date().toISOString()
  });

  res.json({
    user_id: user.id,
    user_email: user.email,
    department: user.department,
    cost_center: user.cost_center,
    notes: user.notes
  });
});

app.get('/api/admin/audit-logs', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) {
    return res.json(auditLogs);
  }
  const filtered = auditLogs.filter(entry =>
    entry.action.toLowerCase().includes(q) ||
    (entry.summary && entry.summary.toLowerCase().includes(q)) ||
    (entry.actor_email && entry.actor_email.toLowerCase().includes(q))
  );
  res.json(filtered);
});

app.get('/api/admin/settings', (req, res) => {
  res.json(systemSettings);
});

app.put('/api/admin/settings/:settingKey', (req, res) => {
  const { settingKey } = req.params;
  const setting = systemSettings.find(s => s.setting_key === settingKey);
  if (!setting) {
    return res.status(404).json({ detail: 'Setting not found' });
  }

  const { value } = req.body || {};
  if (value !== undefined) setting.value = String(value);

  auditLogs.unshift({
    action: 'SETTING_UPDATE',
    summary: `Updated setting ${setting.label} to "${setting.value}"`,
    actor_email: activeUserSession.email,
    resource_type: 'setting',
    resource_id: settingKey,
    created_at: new Date().toISOString()
  });

  res.json(setting);
});

app.get('/api/admin/monitoring', (req, res) => {
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

app.get('/api/admin/financial-summary', (req, res) => {
  res.json({
    total_quotes: 52,
    accepted_quotes: 41,
    pending_quotes: 11,
    conversion_rate: 79,
    appointments: 68,
    contacts: 94
  });
});

// ── Static Asset & Frontend Serving ──────────────────────────

const frontendPath = path.join(__dirname, 'frontend');

// Serve static assets from frontend directory (CSS, JS, images, etc.)
app.use(express.static(frontendPath));
app.use('/frontend', express.static(frontendPath));

// Route entry points
app.get(['/', '/dashboard', '/frontend/dashboard', '/frontend/dashboard.html'], (req, res) => {
  res.sendFile(path.join(frontendPath, 'dashboard.html'));
});

// Catch-all route to serve dashboard.html for client-side navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'dashboard.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Lawn Craft Supervisor Dashboard running at http://0.0.0.0:${PORT}`);
});
