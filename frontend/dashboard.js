/**
 * Supervisor Dashboard – JavaScript
 *
 * Handles:
 *   - Login / logout (JWT stored in localStorage)
 *   - View routing (sidebar navigation)
 *   - Data fetching from the FastAPI backend (/api/…)
 *   - Rendering: stats, work order tables, KPI report, exceptions, property search
 *   - Work order status updates via inline modal
 */

// ─── Configuration ───────────────────────────────────────────────────────────

// API_BASE defaults to '/api' (same-origin, works when frontend is served by
// the backend). To point at a different backend host, set a global variable
// before this script runs:
//   <script>window.DASHBOARD_API_BASE = 'https://your-api.example.com/api';</script>
//
// Local development safety:
// - If the page is opened via file://, or from localhost on a non-8000 port,
//   use the FastAPI backend on 127.0.0.1:8000.
const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');
const LOCAL_API_BASE = 'http://127.0.0.1:8000/api';

const API_BASE = (() => {
  if (typeof window === 'undefined') return '/api';

  const explicitBase = typeof window.DASHBOARD_API_BASE === 'string'
    ? window.DASHBOARD_API_BASE.trim()
    : '';
  if (explicitBase) return trimTrailingSlash(explicitBase);

  const { protocol, hostname, port } = window.location;
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';

  if (protocol === 'file:') return LOCAL_API_BASE;
  if (isLocalHost && port && port !== '8000') return LOCAL_API_BASE;

  return '/api';
})();

// ─── State ───────────────────────────────────────────────────────────────────

let currentUser = null;
let currentView = 'overview';
let workOrderDetailId = null;
let modalLastFocusedElement = null;
let autoRefreshTimer = null;
let syncLabelTimer = null;
let lastSyncedAt = null;
let adminMode = false;
let sessionExpiryHandledAt = 0;
let darkModeEnabled = false;

const ADMIN_VIEWS = new Set(['control', 'permissions', 'audit', 'settings', 'monitoring', 'financial']);
const VIEW_TITLES = {
  overview: 'Overview',
  queue: 'Incoming Queue',
  planning: 'Planning Board',
  active: 'Active Jobs',
  workorders: 'All Work Orders',
  invoices: 'Client Invoices & Billing',
  inventory: 'Inventory ERP & Supply Chain',
  payroll: 'Automated Payroll & Timesheets',
  automation: 'Workflow Automation & ERP Rules',
  exceptions: 'Exceptions',
  report: 'KPI Report',
  property: 'Property History',
  control: 'Control Center',
  permissions: 'Permissions',
  audit: 'Audit Trail',
  settings: 'Configuration Hub',
  monitoring: 'Live Monitoring',
  financial: 'Financial Reports',
};

const AUTO_REFRESH_INTERVAL_MS = 30000;

function formatRelativeSyncTime(date) {
  if (!date) return 'Waiting for first sync…';

  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.max(0, Math.round(diffMs / 1000));

  if (diffSeconds < 60) {
    return `Synced ${diffSeconds}s ago`;
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `Synced ${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  return `Synced ${diffHours}h ago`;
}

function markDashboardSynced() {
  lastSyncedAt = new Date();

  const syncStatus = document.getElementById('sync-status');
  if (syncStatus) {
    syncStatus.innerHTML = '<span class="sync-dot"></span> Live · 30s';
  }

  const lastUpdatedEl = document.getElementById('last-updated');
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = formatRelativeSyncTime(lastSyncedAt);
  }
}

function markDashboardLoading() {
  const syncStatus = document.getElementById('sync-status');
  if (syncStatus) {
    syncStatus.innerHTML = '<span class="sync-dot"></span> Syncing…';
  }
}

function startSyncLabelTicker() {
  stopSyncLabelTicker();
  syncLabelTimer = window.setInterval(() => {
    const lastUpdatedEl = document.getElementById('last-updated');
    if (!lastUpdatedEl) return;
    lastUpdatedEl.textContent = formatRelativeSyncTime(lastSyncedAt);
  }, 15000);
}

function stopSyncLabelTicker() {
  if (syncLabelTimer) {
    window.clearInterval(syncLabelTimer);
    syncLabelTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  startSyncLabelTicker();
  autoRefreshTimer = window.setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (!getToken()) return;
    if (currentView === 'property') return;

    refreshDashboardView({ silent: true });
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    window.clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  stopSyncLabelTicker();
}

async function refreshDashboardView({ silent = false } = {}) {
  if (!silent) {
    markDashboardLoading();
  }

  await loadView(currentView);
  markDashboardSynced();
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function getToken() {
  return localStorage.getItem('dashboard_token');
}

function setToken(token) {
  localStorage.setItem('dashboard_token', token);
}

function clearToken() {
  localStorage.removeItem('dashboard_token');
  localStorage.removeItem('dashboard_user');
}

function shouldSetJsonContentType(options = {}) {
  if (!options.body) return false;
  return typeof options.body === 'string';
}

function buildAuthHeaders(options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && shouldSetJsonContentType(options)) {
    headers.set('Content-Type', 'application/json');
  }
  return headers;
}

async function readErrorDetail(resp) {
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await resp.json().catch(() => ({}));
    return body.detail || body.message || null;
  }
  const text = await resp.text().catch(() => '');
  return text || null;
}

async function apiFetch(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: buildAuthHeaders(options),
  });

  if (resp.status === 401) {
    handleSessionExpired();
    const error = new Error('Session expired – please log in again.');
    // Callers can use this code to skip UI updates when the session has expired.
    error.code = 'SESSION_EXPIRED';
    throw error;
  }

  if (!resp.ok) {
    const detail = await readErrorDetail(resp);
    throw new Error(detail || `HTTP ${resp.status}`);
  }

  if (resp.status === 204) return null;

  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return resp.json();
  }

  const text = await resp.text().catch(() => '');
  return text || null;
}

function handleSessionExpired() {
  const now = Date.now();
  // Guard against rapid repeated 401s causing view flicker.
  if (now - sessionExpiryHandledAt < 1500) return;
  sessionExpiryHandledAt = now;

  clearToken();
  currentUser = null;
  stopAutoRefresh();
  showLogin();
}

// ─── Login / Logout ───────────────────────────────────────────────────────────

function showLogin() {
  stopAutoRefresh();
  currentUser = null;
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').classList.remove('visible');
}

function showApp() {
  sessionExpiryHandledAt = 0;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
}

function setTheme(isDark) {
  darkModeEnabled = Boolean(isDark);
  document.body.classList.toggle('theme-dark', darkModeEnabled);
  localStorage.setItem('dashboard_theme', darkModeEnabled ? 'dark' : 'light');

  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.innerHTML = darkModeEnabled
      ? '<i class="fa-solid fa-sun"></i> Light'
      : '<i class="fa-solid fa-moon"></i> Dark';
    btn.setAttribute('aria-pressed', String(darkModeEnabled));
  }
}

function initTheme() {
  const saved = localStorage.getItem('dashboard_theme');
  if (saved === 'dark') {
    setTheme(true);
    return;
  }
  if (saved === 'light') {
    setTheme(false);
    return;
  }

  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(prefersDark);
}

async function login(email, password) {
  const resp = await fetch(`${API_BASE}/auth/login/json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || 'Invalid credentials');
  }

  const data = await resp.json();
  setToken(data.access_token);
}

async function loadCurrentUser() {
  const user = await apiFetch('/auth/me');
  currentUser = user;
  localStorage.setItem('dashboard_user', JSON.stringify(user));
  setAdminVisibility(String(user.role || '').toLowerCase() === 'admin');

  // Update sidebar user info
  const initials = (user.full_name || user.email || '?')
    .split(' ')
    .map(p => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent = user.full_name || user.email;
  document.getElementById('user-role').textContent = user.role || 'supervisor';
  return user;
}

function logout() {
  stopAutoRefresh();
  clearToken();
  currentUser = null;
  showLogin();
}

function isDashboardRoleAllowed(user) {
  const role = String(user?.role || '').toLowerCase();
  return role === 'supervisor' || role === 'admin';
}

function setAdminVisibility(enabled) {
  adminMode = enabled;

  document.querySelectorAll('.admin-only').forEach(el => {
    el.classList.toggle('visible', enabled);
  });
}

function getEmptyWorkOrderMessage(viewId) {
  const messages = {
    queue: 'All caught up. No new work orders in the incoming queue.',
    planning: 'Planning board is clear. Nothing waiting to be scheduled.',
    active: 'No active jobs right now. Field teams are between assignments.',
    workorders: 'No work orders found yet. New jobs will appear here once created.',
  };

  return messages[viewId] || 'No work orders found.';
}

function initSidebarCollapsibles() {
  const storageKey = 'dashboard_collapsed_nav_groups';
  const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');

  const persistState = () => {
    const state = {};
    document.querySelectorAll('.sidebar-section-toggle[data-collapse-target]').forEach(btn => {
      const targetId = btn.getAttribute('data-collapse-target');
      state[targetId] = btn.getAttribute('aria-expanded') === 'true';
    });
    localStorage.setItem(storageKey, JSON.stringify(state));
  };

  document.querySelectorAll('.sidebar-section-toggle[data-collapse-target]').forEach(btn => {
    const targetId = btn.getAttribute('data-collapse-target');
    const targetEl = document.getElementById(targetId);
    if (!targetEl) return;

    const isOpen = Object.prototype.hasOwnProperty.call(saved, targetId) ? !!saved[targetId] : true;
    targetEl.classList.toggle('open', isOpen);
    btn.setAttribute('aria-expanded', String(isOpen));

    btn.addEventListener('click', () => {
      const nextOpen = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(nextOpen));
      targetEl.classList.toggle('open', nextOpen);
      persistState();
    });
  });
}

function clearLoginMessages() {
  document.getElementById('login-error').classList.remove('visible');
  document.getElementById('login-info').classList.remove('visible');
}

function showLoginError(message) {
  const errorEl = document.getElementById('login-error');
  errorEl.textContent = message;
  errorEl.classList.add('visible');
}

function showLoginInfo(message) {
  const infoEl = document.getElementById('login-info');
  infoEl.textContent = message;
  infoEl.classList.add('visible');
}

function handleUnauthorizedDashboardAccess() {
  clearToken();
  currentUser = null;
  showLogin();
  clearLoginMessages();
  showLoginInfo('Access restricted: Supervisor and Admin accounts only.');
}

// ─── Toast notifications ──────────────────────────────────────────────────────

let toastTimer = null;

function showToast(message, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast visible toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

function getViewFromHash() {
  const hash = String(window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
  if (!hash) return null;

  return document.getElementById(`view-${hash}`) ? hash : null;
}

// ─── View routing ─────────────────────────────────────────────────────────────

function navigate(viewId, { pushHash = true } = {}) {
  const normalizedViewId = String(viewId || '').trim().toLowerCase();
  const targetSection = document.getElementById(`view-${normalizedViewId}`);

  if (!targetSection) {
    showToast(`View not found: ${normalizedViewId || 'unknown'}`, 'danger');
    return;
  }

  if (!adminMode && ADMIN_VIEWS.has(normalizedViewId)) {
    showToast('Admin access is required for this section.', 'danger');
    const normalizedHash = String(window.location.hash || '').replace(/^#/, '');
    const shouldUpdateHash = normalizedHash !== 'overview';
    if (currentView !== 'overview') {
      navigate('overview', { pushHash: shouldUpdateHash });
    } else if (shouldUpdateHash) {
      window.location.hash = 'overview';
    }
    return;
  }

  currentView = normalizedViewId;

  // Update active link
  document.querySelectorAll('.sidebar-nav a').forEach(a => {
    a.classList.toggle('active', a.dataset.view === normalizedViewId);
  });

  // Show/hide sections
  document.querySelectorAll('.view-section').forEach(s => {
    s.classList.toggle('active', s === targetSection);
  });

  // Update top-bar title
  document.getElementById('page-title').textContent = VIEW_TITLES[normalizedViewId] || normalizedViewId;

  if (pushHash && window.location.hash !== `#${normalizedViewId}`) {
    window.location.hash = normalizedViewId;
  }

  // Load data for the view
  loadView(normalizedViewId);

  // Close mobile sidebar
  closeMobileSidebar();
}

async function loadView(viewId) {
  switch (viewId) {
    case 'overview':
      await loadStats();
      break;
    case 'queue':
      await loadWorkOrderTable('queue', '/supervisor/queue');
      break;
    case 'planning':
      await loadWorkOrderTable('planning', '/supervisor/planning');
      break;
    case 'active':
      await loadWorkOrderTable('active', '/supervisor/active');
      break;
    case 'exceptions':
      await loadExceptions();
      break;
    case 'report':
      await loadReport();
      break;
    case 'workorders':
      await loadWorkOrderTable('workorders', '/work-orders');
      break;
    case 'invoices':
      await loadInvoices();
      break;
    case 'inventory':
      await loadInventory();
      break;
    case 'payroll':
      await loadPayroll();
      break;
    case 'automation':
      await loadAutomationRules();
      break;
    case 'property':
      // Property search – don't auto-load
      break;
    case 'control':
      await loadAdminControlCenter();
      break;
    case 'permissions':
      await loadPermissionsHub();
      break;
    case 'audit':
      await loadAuditTrail();
      break;
    case 'settings':
      await loadSettingsHub();
      break;
    case 'monitoring':
      await loadMonitoringHub();
      break;
    case 'financial':
      await loadFinancialSummary();
      break;
  }
}

// ─── Stats / Overview ─────────────────────────────────────────────────────────

async function loadStats() {
  const container = document.getElementById('stats-container');
  container.innerHTML = `<div class="stat-card"><div class="spinner"></div> Loading…</div>`;

  try {
    const [data, trend, queueItems, planningItems, activeItems] = await Promise.all([
      apiFetch('/supervisor/stats'),
      apiFetch('/supervisor/stats-trends?days=7').catch(() => null),
      apiFetch('/supervisor/queue?limit=12').catch(() => []),
      apiFetch('/supervisor/planning?limit=12').catch(() => []),
      apiFetch('/supervisor/active').catch(() => []),
    ]);
    const byStatus = data.work_orders_by_status || {};

    const totalOpen = (byStatus.incoming || 0) + (byStatus.reviewed || 0) + (byStatus.planned || 0) + (byStatus.in_progress || 0);
    const completedTotal = (byStatus.completed || 0) + (byStatus.verified || 0);
    const isQuietBoard = totalOpen === 0 && (data.open_issues || 0) === 0;
    const incomingSub = (byStatus.incoming || 0) === 0
      ? 'All caught up. No new work orders.'
      : 'awaiting review';
    const activeSub = (byStatus.in_progress || 0) === 0
      ? 'No field crews active right now.'
      : 'currently active';
    const issuesSub = (data.open_issues || 0) === 0
      ? 'No unresolved issues. Great job.'
      : 'unresolved';

    const incomingTrend = trend?.incoming_created || [byStatus.incoming || 0];
    const activeTrend = trend?.started_jobs || [byStatus.in_progress || 0];
    const completedTrend = trend?.completed_jobs || [completedTotal];
    const issuesTrend = trend?.issues_logged || [data.open_issues || 0];
    const pendingTrend = trend?.pending_tasks_created || [data.pending_tasks || 0];
    const trendLabel = trend?.period_days ? `${trend.period_days}-day trend` : 'recent trend';

    container.innerHTML = `
      <div class="stat-card bento-primary warning-card">
        <div class="stat-label">Incoming</div>
        <div class="stat-value">${byStatus.incoming || 0}</div>
        <div class="stat-sub">${incomingSub}</div>
        <div class="stat-inline-note">${trendLabel}: ${trendSummary(incomingTrend)}</div>
        ${createSparklineSvg(incomingTrend, 'warning')}
        <div class="row-actions"><button class="btn-save" data-target-view="queue">Review Now</button></div>
        ${isQuietBoard ? '<div class="empty-trend" aria-hidden="true"></div><div class="empty-cue">Flat trend means no queue pressure in the last sync window.</div>' : ''}
      </div>
      <div class="stat-card bento-wide blue-card">
        <div class="stat-label">Planned</div>
        <div class="stat-value">${(byStatus.reviewed || 0) + (byStatus.planned || 0)}</div>
        <div class="stat-sub">reviewed + planned</div>
        <div class="row-actions"><button class="btn-subtle" data-target-view="planning">View Details</button></div>
      </div>
      <div class="stat-card bento-wide warning-card">
        <div class="stat-label">In Progress</div>
        <div class="stat-value">${byStatus.in_progress || 0}</div>
        <div class="stat-sub">${activeSub}</div>
        <div class="stat-inline-note">${trendLabel}: ${trendSummary(activeTrend)}</div>
        ${createSparklineSvg(activeTrend, 'warning')}
        <div class="row-actions"><button class="btn-subtle" data-target-view="active">View Details</button></div>
      </div>
      <div class="stat-card success-card">
        <div class="stat-label">Completed</div>
        <div class="stat-value">${completedTotal}</div>
        <div class="stat-sub">completed + verified</div>
        <div class="stat-inline-note">${trendLabel}: ${trendSummary(completedTrend)}</div>
        ${createSparklineSvg(completedTrend, 'success')}
        <div class="row-actions"><button class="btn-save" data-target-view="workorders">Verify</button></div>
      </div>
      <div class="stat-card danger-card">
        <div class="stat-label">Open Issues</div>
        <div class="stat-value">${data.open_issues || 0}</div>
        <div class="stat-sub">${issuesSub}</div>
        <div class="stat-inline-note">${trendLabel}: ${trendSummary(issuesTrend, true)}</div>
        ${createSparklineSvg(issuesTrend, 'danger')}
        <div class="row-actions"><button class="btn-save" data-target-view="exceptions">Resolve</button></div>
      </div>
      <div class="stat-card warning-card-soft">
        <div class="stat-label">Pending Tasks</div>
        <div class="stat-value">${data.pending_tasks || 0}</div>
        <div class="stat-sub">across all jobs</div>
        <div class="stat-inline-note">${trendLabel}: ${trendSummary(pendingTrend, true)}</div>
        ${createSparklineSvg(pendingTrend, 'warning')}
        <div class="row-actions"><button class="btn-subtle" data-target-view="planning">Assign Tasks</button></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Open</div>
        <div class="stat-value">${totalOpen}</div>
        <div class="stat-sub">active work orders</div>
        <div class="row-actions"><button class="btn-subtle" data-target-view="workorders">View Details</button></div>
      </div>
      <div class="stat-card muted-card">
        <div class="stat-label">Cancelled</div>
        <div class="stat-value">${byStatus.cancelled || 0}</div>
        <div class="stat-sub">all time</div>
        <div class="row-actions"><button class="btn-subtle" data-target-view="workorders">Review History</button></div>
      </div>
    `;

    // Update sidebar queue badge
    const badge = document.getElementById('queue-badge');
    if (badge) badge.textContent = byStatus.incoming || 0;

    renderLiveFeed(queueItems, planningItems, activeItems);
    renderMiniMap(queueItems, planningItems, activeItems);

    markDashboardSynced();

  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

// ─── Generic work order table ─────────────────────────────────────────────────

async function loadWorkOrderTable(viewId, endpoint) {
  const tbody = document.getElementById(`tbody-${viewId}`);
  const countEl = document.getElementById(`count-${viewId}`);

  tbody.innerHTML = `<tr class="loading-row"><td colspan="7"><span class="spinner"></span> Loading…</td></tr>`;

  try {
    const data = await apiFetch(endpoint);
    const items = Array.isArray(data) ? data : [];

    if (countEl) countEl.textContent = `${items.length} record${items.length !== 1 ? 's' : ''}`;

    if (items.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${getEmptyWorkOrderMessage(viewId)}</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(wo => renderWorkOrderRow(wo)).join('');
    markDashboardSynced();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="alert alert-danger">${err.message}</div></td></tr>`;
  }
}

function renderWorkOrderRow(wo) {
  const targetDate = wo.target_date ? formatDate(wo.target_date) : '—';
  const created = formatDate(wo.created_at);

  return `
    <tr>
      <td>
        <span class="td-link td-main" onclick="openWorkOrderDetail(${wo.id})">#${wo.id} ${esc(wo.title)}</span>
      </td>
      <td>
        <div>${esc(wo.client_name)}</div>
        ${wo.client_email ? `<div class="td-addr">${esc(wo.client_email)}</div>` : ''}
      </td>
      <td class="td-addr">${esc(wo.property_address)}</td>
      <td><span class="badge-status status-${wo.status}">${labelStatus(wo.status)}</span></td>
      <td><span class="badge-priority priority-${wo.priority}">${esc(wo.priority)}</span></td>
      <td>${targetDate}</td>
      <td>${created}</td>
    </tr>
  `;
}

// ─── Exceptions ───────────────────────────────────────────────────────────────

async function loadExceptions() {
  const container = document.getElementById('exceptions-container');
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading exceptions…</div>`;

  try {
    const data = await apiFetch('/supervisor/exceptions');

    let html = '';

    html += renderExceptionGroup(
      'Overdue',
      data.overdue || [],
      'dot-danger',
      'These jobs have passed their target date.'
    );
    html += renderExceptionGroup(
      'Blocked – High-Severity Issues',
      data.blocked || [],
      'dot-warning',
      'These jobs have unresolved high-severity issues.'
    );
    html += renderExceptionGroup(
      'Missing Field Logs',
      data.missing_field_logs || [],
      'dot-info',
      'In-progress or completed jobs with no field log submitted.'
    );

    container.innerHTML = html || `<div class="alert alert-success">No exceptions found. All clear!</div>`;
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderExceptionGroup(title, items, dotClass, description) {
  const tableRows = items.length === 0
    ? `<tr class="empty-row"><td colspan="6">None</td></tr>`
    : items.map(wo => renderWorkOrderRow(wo)).join('');

  return `
    <div class="exception-group">
      <h2>
        <span class="dot ${dotClass}"></span>
        ${title}
        <span style="color:var(--text-light);font-weight:400">(${items.length})</span>
      </h2>
      <p style="font-size:0.82rem;color:var(--text-light);margin-bottom:0.6rem">${description}</p>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Work Order</th>
              <th>Client</th>
              <th>Address</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Target Date</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// ─── KPI Report ───────────────────────────────────────────────────────────────

async function loadReport(days = 30) {
  const container = document.getElementById('report-container');
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading report…</div>`;

  try {
    const data = await apiFetch(`/supervisor/report?days=${days}`);

    container.innerHTML = `
      <div class="kpi-grid">

        <div class="kpi-card">
          <h3>Work Orders – last ${data.period_days} days</h3>
          <div class="kpi-row">
            <span class="kpi-label">Total created</span>
            <span class="kpi-val">${data.work_orders.total}</span>
          </div>
          <div class="kpi-row">
            <span class="kpi-label">Completed / verified</span>
            <span class="kpi-val">${data.work_orders.completed}</span>
          </div>
          <div class="kpi-row">
            <span class="kpi-label">Completion rate</span>
            <span class="kpi-val">${data.work_orders.total > 0
              ? Math.round((data.work_orders.completed / data.work_orders.total) * 100) + '%'
              : '—'}</span>
          </div>
        </div>

        <div class="kpi-card">
          <h3>Task Completion</h3>
          <div class="kpi-big">${data.tasks.completion_rate_pct}%</div>
          <div class="kpi-sub">of all planned tasks completed</div>
          <div class="kpi-row" style="margin-top:0.75rem">
            <span class="kpi-label">Planned</span>
            <span class="kpi-val">${data.tasks.total_planned}</span>
          </div>
          <div class="kpi-row">
            <span class="kpi-label">Completed</span>
            <span class="kpi-val">${data.tasks.completed}</span>
          </div>
        </div>

        <div class="kpi-card">
          <h3>Labour Hours</h3>
          <div class="kpi-big">${data.labour.total_hours.toFixed(1)}</div>
          <div class="kpi-sub">total hours logged</div>
          <div class="kpi-row" style="margin-top:0.75rem">
            <span class="kpi-label">Avg per field log</span>
            <span class="kpi-val">${data.labour.avg_hours_per_log.toFixed(1)} hrs</span>
          </div>
        </div>

        <div class="kpi-card">
          <h3>Turnaround Time</h3>
          <div class="kpi-big">${(data.turnaround.avg_hours_to_complete / 24).toFixed(1)}</div>
          <div class="kpi-sub">avg days from creation to completion</div>
          <div class="kpi-row" style="margin-top:0.75rem">
            <span class="kpi-label">Avg hours</span>
            <span class="kpi-val">${data.turnaround.avg_hours_to_complete.toFixed(1)} hrs</span>
          </div>
        </div>

        <div class="kpi-card">
          <h3>Issues & Rework</h3>
          <div class="kpi-row">
            <span class="kpi-label">Total issues logged</span>
            <span class="kpi-val">${data.issues.total}</span>
          </div>
          <div class="kpi-row">
            <span class="kpi-label">Resolved</span>
            <span class="kpi-val">${data.issues.resolved}</span>
          </div>
          <div class="kpi-row">
            <span class="kpi-label">Resolution rate</span>
            <span class="kpi-val">${data.issues.resolution_rate_pct}%</span>
          </div>
        </div>

      </div>
    `;
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

// ─── Property search ──────────────────────────────────────────────────────────

async function searchProperty() {
  const input = document.getElementById('property-search-input');
  const query = input.value.trim();
  if (!query) return;

  const tbody = document.getElementById('tbody-property');
  const countEl = document.getElementById('count-property');
  const invTbody = document.getElementById('tbody-property-invoices');
  const invCountEl = document.getElementById('count-property-invoices');

  tbody.innerHTML = `<tr class="loading-row"><td colspan="7"><span class="spinner"></span> Searching work orders…</td></tr>`;
  if (invTbody) {
    invTbody.innerHTML = `<tr class="loading-row"><td colspan="7"><span class="spinner"></span> Searching invoices…</td></tr>`;
  }

  try {
    const [data, invoicesData] = await Promise.all([
      apiFetch(`/supervisor/property?address=${encodeURIComponent(query)}`),
      apiFetch(`/invoices/by-property?address=${encodeURIComponent(query)}`).catch(() => [])
    ]);
    const items = Array.isArray(data) ? data : [];
    const invItems = Array.isArray(invoicesData) ? invoicesData : [];

    if (countEl) countEl.textContent = `${items.length} record${items.length !== 1 ? 's' : ''}`;

    if (items.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No work orders found for this address.</td></tr>`;
    } else {
      tbody.innerHTML = items.map(wo => renderWorkOrderRow(wo)).join('');
    }

    if (invTbody && invCountEl) {
      invCountEl.textContent = `${invItems.length} invoice${invItems.length !== 1 ? 's' : ''}`;
      if (invItems.length === 0) {
        invTbody.innerHTML = `<tr class="empty-row"><td colspan="7">No invoices recorded for this property yet.</td></tr>`;
      } else {
        invTbody.innerHTML = invItems.map(inv => `
          <tr>
            <td>
              <span class="td-link td-main" onclick="openInvoicePreview('${inv.id}')">${esc(inv.id)}</span>
            </td>
            <td>${inv.work_order_id ? `<span class="td-link" onclick="openWorkOrderDetail(${inv.work_order_id})">#${inv.work_order_id}</span>` : '—'}</td>
            <td>${formatDate(inv.issue_date)}</td>
            <td><strong>$${Number(inv.total_amount || 0).toFixed(2)}</strong></td>
            <td style="color:${inv.balance_due > 0 ? 'var(--danger)' : 'inherit'}"><strong>$${Number(inv.balance_due || 0).toFixed(2)}</strong></td>
            <td><span class="status-badge status-${inv.status}">${labelStatus(inv.status)}</span></td>
            <td>
              <button class="btn-subtle btn-sm" onclick="openInvoicePreview('${inv.id}')" title="View & Print"><i class="fa-solid fa-eye"></i></button>
              ${inv.balance_due > 0 && inv.status !== 'cancelled' ? `<button class="btn-save btn-sm" onclick="openPaymentModal('${inv.id}')" title="Record Payment"><i class="fa-solid fa-dollar-sign"></i></button>` : ''}
            </td>
          </tr>
        `).join('');
      }
    }

    markDashboardSynced();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="alert alert-danger">${err.message}</div></td></tr>`;
    if (invTbody) {
      invTbody.innerHTML = `<tr><td colspan="7"><div class="alert alert-danger">${err.message}</div></td></tr>`;
    }
  }
}

// ─── Invoicing & Billing Controller ──────────────────────────────────────────

async function loadInvoices() {
  const tbody = document.getElementById('tbody-invoices');
  const countEl = document.getElementById('count-invoices');
  const statusFilter = document.getElementById('invoice-status-filter')?.value || 'all';
  const searchInput = document.getElementById('invoice-search-input')?.value || '';

  tbody.innerHTML = `<tr class="loading-row"><td colspan="10"><span class="spinner"></span> Loading client invoices…</td></tr>`;

  try {
    const [invoicesList, stats] = await Promise.all([
      apiFetch(`/invoices?status=${encodeURIComponent(statusFilter)}&search=${encodeURIComponent(searchInput)}`),
      apiFetch('/invoices/stats').catch(() => null)
    ]);

    // Update KPI Stat Cards
    if (stats) {
      const billedEl = document.getElementById('inv-stat-billed');
      const collectedEl = document.getElementById('inv-stat-collected');
      const outstandingEl = document.getElementById('inv-stat-outstanding');
      const overdueEl = document.getElementById('inv-stat-overdue');
      const badgeEl = document.getElementById('invoices-badge');

      if (billedEl) billedEl.textContent = `$${Number(stats.total_billed || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (collectedEl) collectedEl.textContent = `$${Number(stats.total_collected || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (outstandingEl) outstandingEl.textContent = `$${Number(stats.total_outstanding || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (overdueEl) overdueEl.textContent = `$${Number(stats.total_overdue || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      
      if (badgeEl) {
        const pendingCount = (stats.by_status?.overdue || 0) + (stats.by_status?.issued || 0) + (stats.by_status?.partially_paid || 0);
        badgeEl.textContent = pendingCount;
      }
    }

    const items = Array.isArray(invoicesList) ? invoicesList : [];
    if (countEl) countEl.textContent = `${items.length} invoice${items.length !== 1 ? 's' : ''}`;

    if (items.length === 0) {
      tbody.innerHTML = `
        <tr class="empty-row">
          <td colspan="10">
            No invoices found matching current filters. Click <strong>"+ Create New Invoice"</strong> to generate one.
          </td>
        </tr>`;
      return;
    }

    tbody.innerHTML = items.map(inv => renderInvoiceRow(inv)).join('');
    markDashboardSynced();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10"><div class="alert alert-danger">${err.message}</div></td></tr>`;
  }
}

function renderInvoiceRow(inv) {
  const isOverdue = inv.status === 'overdue';
  const balanceColor = inv.balance_due > 0 ? 'var(--danger)' : 'var(--success)';
  const workOrderCell = inv.work_order_id
    ? `<span class="td-link" onclick="openWorkOrderDetail(${inv.work_order_id})"><i class="fa-solid fa-link"></i> #${inv.work_order_id}</span>`
    : '<span style="color:var(--text-light)">Standalone</span>';

  return `
    <tr>
      <td>
        <span class="td-link td-main" onclick="openInvoicePreview('${inv.id}')">${esc(inv.id)}</span>
      </td>
      <td>${workOrderCell}</td>
      <td>
        <div><strong>${esc(inv.client_name)}</strong></div>
        ${inv.client_email ? `<div class="td-addr" style="font-size:0.8rem">${esc(inv.client_email)}</div>` : ''}
      </td>
      <td class="td-addr">${esc(inv.property_address)}</td>
      <td>${formatDate(inv.issue_date)}</td>
      <td style="${isOverdue ? 'color:var(--danger);font-weight:700;' : ''}">${formatDate(inv.due_date)}</td>
      <td><strong>$${Number(inv.total_amount || 0).toFixed(2)}</strong></td>
      <td style="color:${balanceColor}"><strong>$${Number(inv.balance_due || 0).toFixed(2)}</strong></td>
      <td><span class="status-badge status-${inv.status}">${labelStatus(inv.status)}</span></td>
      <td>
        <div style="display:flex; gap: 4px; align-items:center;">
          <button class="btn-subtle btn-sm" onclick="openInvoicePreview('${inv.id}')" title="Preview & Print Invoice">
            <i class="fa-solid fa-eye"></i>
          </button>
          ${inv.balance_due > 0 && inv.status !== 'cancelled' ? `
            <button class="btn-save btn-sm" onclick="openPaymentModal('${inv.id}')" title="Record Client Payment">
              <i class="fa-solid fa-dollar-sign"></i> Pay
            </button>
          ` : ''}
          <button class="btn-subtle btn-sm" onclick="openInvoiceForm('${inv.id}')" title="Edit Invoice Details">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="btn-subtle btn-sm btn-icon-danger" onclick="deleteInvoice('${inv.id}')" title="Delete Invoice">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `;
}

// ─── Invoice Form Modal (Create / Edit) ───────────────────────────────────────

let currentWorkOrdersList = [];

async function openInvoiceForm(invoiceId = null, defaultWorkOrderId = null) {
  const overlay = document.getElementById('invoice-form-modal');
  const titleEl = document.getElementById('invoice-form-modal-title');
  const editIdInput = document.getElementById('inv-edit-id');
  const linkWoSelect = document.getElementById('inv-link-wo');
  const form = document.getElementById('invoice-form');

  form.reset();
  editIdInput.value = invoiceId || '';

  // Load available work orders for linking
  try {
    currentWorkOrdersList = await apiFetch('/work-orders');
    linkWoSelect.innerHTML = '<option value="">-- Standalone Invoice (No Work Order) --</option>' +
      currentWorkOrdersList.map(w => `<option value="${w.id}">#${w.id} - ${esc(w.client_name)} (${esc(w.title || w.service_type)})</option>`).join('');
  } catch (e) {
    console.error('Could not load work orders for invoice autofill', e);
  }

  const tbody = document.getElementById('line-items-tbody');
  tbody.innerHTML = '';

  if (invoiceId) {
    // Editing existing invoice
    titleEl.textContent = `Edit Invoice ${invoiceId}`;
    try {
      const inv = await apiFetch(`/invoices/${invoiceId}`);
      if (inv.work_order_id) linkWoSelect.value = String(inv.work_order_id);
      document.getElementById('inv-client-name').value = inv.client_name || '';
      document.getElementById('inv-client-email').value = inv.client_email || '';
      document.getElementById('inv-client-phone').value = inv.client_phone || '';
      document.getElementById('inv-property-address').value = inv.property_address || '';
      document.getElementById('inv-issue-date').value = inv.issue_date || '';
      document.getElementById('inv-due-date').value = inv.due_date || '';
      document.getElementById('inv-payment-terms').value = inv.payment_terms || 'Net 15';
      document.getElementById('inv-status').value = inv.status || 'issued';
      document.getElementById('inv-tax-rate').value = inv.tax_rate !== undefined ? inv.tax_rate : 6.5;
      document.getElementById('inv-discount-amount').value = inv.discount_amount !== undefined ? inv.discount_amount : 0;
      document.getElementById('inv-notes').value = inv.notes || '';

      if (Array.isArray(inv.items) && inv.items.length > 0) {
        inv.items.forEach(item => addLineItemRow(item.description, item.quantity, item.unit_price));
      } else {
        addLineItemRow('Lawn Mowing & Turf Maintenance', 1, 150.00);
      }
    } catch (err) {
      showToast(`Failed to load invoice: ${err.message}`, 'error');
      return;
    }
  } else {
    // Creating new invoice
    titleEl.textContent = 'Create Client Invoice';
    const today = new Date().toISOString().split('T')[0];
    const due15 = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];

    document.getElementById('inv-issue-date').value = today;
    document.getElementById('inv-due-date').value = due15;
    document.getElementById('inv-payment-terms').value = 'Net 15';
    document.getElementById('inv-status').value = 'issued';
    document.getElementById('inv-tax-rate').value = '6.5';
    document.getElementById('inv-discount-amount').value = '0.00';
    document.getElementById('inv-notes').value = 'Thank you for choosing Lawn Craft! Please remit payment within specified terms.';

    if (defaultWorkOrderId) {
      linkWoSelect.value = String(defaultWorkOrderId);
      autofillInvoiceFromWorkOrder(defaultWorkOrderId);
    } else {
      addLineItemRow('Lawn Mowing & Edge Trimming', 1, 120.00);
      addLineItemRow('Aeration & Organic Fertilization', 1, 95.00);
    }
  }

  calculateFormTotals();
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function autofillInvoiceFromWorkOrder(woId) {
  const wo = currentWorkOrdersList.find(w => w.id === parseInt(woId, 10));
  if (!wo) return;

  document.getElementById('inv-client-name').value = wo.client_name || '';
  document.getElementById('inv-client-email').value = wo.client_email || '';
  document.getElementById('inv-client-phone').value = wo.client_phone || '';
  document.getElementById('inv-property-address').value = wo.property_address || '';

  const tbody = document.getElementById('line-items-tbody');
  tbody.innerHTML = '';
  const serviceDesc = `${wo.service_type || 'Landscape Service'}: ${wo.title || 'Property Maintenance'}`;
  addLineItemRow(serviceDesc, 1, 185.00);
  if (wo.description) {
    addLineItemRow(`Additional work performed: ${wo.description.slice(0, 50)}...`, 1, 65.00);
  }
}

function addLineItemRow(description = '', quantity = 1, unitPrice = 0) {
  const tbody = document.getElementById('line-items-tbody');
  const tr = document.createElement('tr');
  tr.className = 'line-item-row';

  const numQty = parseFloat(quantity) || 1;
  const numPrice = parseFloat(unitPrice) || 0;
  const lineTotal = (numQty * numPrice).toFixed(2);

  tr.innerHTML = `
    <td>
      <input type="text" class="item-desc" required placeholder="Service description or materials" value="${esc(description)}">
    </td>
    <td>
      <input type="number" class="item-qty" min="0.1" step="0.5" value="${numQty}">
    </td>
    <td>
      <input type="number" class="item-price" min="0" step="0.01" value="${numPrice.toFixed(2)}">
    </td>
    <td class="item-total-cell" style="font-weight:700;text-align:right;padding-right:10px;">
      $${lineTotal}
    </td>
    <td>
      <button type="button" class="btn-icon-danger remove-item-btn" title="Remove line item">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </td>
  `;

  const qtyInput = tr.querySelector('.item-qty');
  const priceInput = tr.querySelector('.item-price');
  const descInput = tr.querySelector('.item-desc');
  const removeBtn = tr.querySelector('.remove-item-btn');

  const onRowChange = () => {
    const q = parseFloat(qtyInput.value) || 0;
    const p = parseFloat(priceInput.value) || 0;
    tr.querySelector('.item-total-cell').textContent = `$${(q * p).toFixed(2)}`;
    calculateFormTotals();
  };

  qtyInput.addEventListener('input', onRowChange);
  priceInput.addEventListener('input', onRowChange);
  descInput.addEventListener('input', calculateFormTotals);

  removeBtn.addEventListener('click', () => {
    if (tbody.querySelectorAll('.line-item-row').length > 1) {
      tr.remove();
      calculateFormTotals();
    } else {
      showToast('Invoice must contain at least one line item.', 'error');
    }
  });

  tbody.appendChild(tr);
  calculateFormTotals();
}

function calculateFormTotals() {
  const rows = document.querySelectorAll('#line-items-tbody .line-item-row');
  let subtotal = 0;

  rows.forEach(row => {
    const qty = parseFloat(row.querySelector('.item-qty')?.value) || 0;
    const price = parseFloat(row.querySelector('.item-price')?.value) || 0;
    subtotal += (qty * price);
  });

  const taxRate = parseFloat(document.getElementById('inv-tax-rate')?.value) || 0;
  const discount = parseFloat(document.getElementById('inv-discount-amount')?.value) || 0;

  const taxAmount = (subtotal * taxRate) / 100;
  const finalTotal = Math.max(0, subtotal + taxAmount - discount);

  const subtotalEl = document.getElementById('calc-subtotal');
  const taxEl = document.getElementById('calc-tax-amount');
  const discountEl = document.getElementById('calc-discount-amount');
  const totalEl = document.getElementById('calc-total');

  if (subtotalEl) subtotalEl.textContent = `$${subtotal.toFixed(2)}`;
  if (taxEl) taxEl.textContent = `+$${taxAmount.toFixed(2)}`;
  if (discountEl) discountEl.textContent = `-$${discount.toFixed(2)}`;
  if (totalEl) totalEl.textContent = `$${finalTotal.toFixed(2)}`;
}

async function saveInvoice(e) {
  e.preventDefault();
  const invoiceId = document.getElementById('inv-edit-id').value;
  const linkWoVal = document.getElementById('inv-link-wo').value;
  const clientName = document.getElementById('inv-client-name').value.trim();
  const propertyAddress = document.getElementById('inv-property-address').value.trim();

  if (!clientName || !propertyAddress) {
    showToast('Please enter both client name and property address.', 'error');
    return;
  }

  // Gather line items
  const rows = document.querySelectorAll('#line-items-tbody .line-item-row');
  const items = [];
  rows.forEach(row => {
    const desc = row.querySelector('.item-desc')?.value.trim();
    const qty = parseFloat(row.querySelector('.item-qty')?.value) || 1;
    const price = parseFloat(row.querySelector('.item-price')?.value) || 0;
    if (desc) {
      items.push({
        description: desc,
        quantity: qty,
        unit_price: price,
        amount: Math.round(qty * price * 100) / 100
      });
    }
  });

  if (items.length === 0) {
    showToast('Please add at least one line item with a description.', 'error');
    return;
  }

  const payload = {
    work_order_id: linkWoVal ? parseInt(linkWoVal, 10) : null,
    client_name: clientName,
    client_email: document.getElementById('inv-client-email').value.trim(),
    client_phone: document.getElementById('inv-client-phone').value.trim(),
    property_address: propertyAddress,
    issue_date: document.getElementById('inv-issue-date').value,
    due_date: document.getElementById('inv-due-date').value,
    payment_terms: document.getElementById('inv-payment-terms').value,
    status: document.getElementById('inv-status').value,
    tax_rate: parseFloat(document.getElementById('inv-tax-rate').value) || 0,
    discount_amount: parseFloat(document.getElementById('inv-discount-amount').value) || 0,
    notes: document.getElementById('inv-notes').value.trim(),
    items: items
  };

  const saveBtn = document.getElementById('invoice-form-save-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span> Saving…';

  try {
    if (invoiceId) {
      await apiFetch(`/invoices/${invoiceId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast(`Invoice ${invoiceId} updated successfully.`, 'success');
    } else {
      const created = await apiFetch('/invoices', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Invoice ${created.id} created successfully!`, 'success');
    }

    closeInvoiceFormModal();
    if (currentView === 'invoices') {
      await loadInvoices();
    } else {
      navigate('invoices');
    }
  } catch (err) {
    showToast(`Failed to save invoice: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save Invoice';
  }
}

function closeInvoiceFormModal() {
  const overlay = document.getElementById('invoice-form-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

async function deleteInvoice(id) {
  if (!confirm(`Are you sure you want to delete invoice ${id}? This action cannot be undone.`)) {
    return;
  }

  try {
    await apiFetch(`/invoices/${id}`, { method: 'DELETE' });
    showToast(`Invoice ${id} deleted successfully.`, 'success');
    await loadInvoices();
  } catch (err) {
    showToast(`Failed to delete invoice: ${err.message}`, 'error');
  }
}

// ─── Payment Recording Modal ──────────────────────────────────────────────────

async function openPaymentModal(invoiceId) {
  const overlay = document.getElementById('payment-modal');
  const summaryEl = document.getElementById('payment-invoice-summary');
  const invIdInput = document.getElementById('payment-inv-id');
  const amountInput = document.getElementById('payment-amount');
  const form = document.getElementById('payment-form');

  form.reset();
  invIdInput.value = invoiceId;
  summaryEl.innerHTML = '<div class="spinner"></div> Loading invoice summary…';

  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');

  try {
    const inv = await apiFetch(`/invoices/${invoiceId}`);
    summaryEl.innerHTML = `
      <div>
        <div class="sum-item-title">Invoice / Client</div>
        <div class="sum-item-val">${esc(inv.id)}</div>
        <div style="font-size:0.8rem;color:var(--text-light)">${esc(inv.client_name)}</div>
      </div>
      <div>
        <div class="sum-item-title">Total Invoiced</div>
        <div class="sum-item-val">$${Number(inv.total_amount || 0).toFixed(2)}</div>
        <div style="font-size:0.8rem;color:var(--success)">$${Number(inv.amount_paid || 0).toFixed(2)} Paid</div>
      </div>
      <div>
        <div class="sum-item-title">Balance Due</div>
        <div class="sum-item-val due-highlight">$${Number(inv.balance_due || 0).toFixed(2)}</div>
        <div style="font-size:0.8rem;color:var(--text-light)">${esc(inv.payment_terms || 'Net 15')}</div>
      </div>
    `;
    amountInput.value = Number(inv.balance_due || 0).toFixed(2);
    amountInput.max = Number(inv.balance_due || 0).toFixed(2);
  } catch (err) {
    summaryEl.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function savePayment(e) {
  e.preventDefault();
  const invoiceId = document.getElementById('payment-inv-id').value;
  const amount = parseFloat(document.getElementById('payment-amount').value);
  const method = document.getElementById('payment-method').value;
  const reference = document.getElementById('payment-reference').value.trim();
  const notes = document.getElementById('payment-notes').value.trim();

  if (!amount || amount <= 0) {
    showToast('Please enter a valid positive payment amount.', 'error');
    return;
  }

  const saveBtn = document.getElementById('payment-save-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span> Recording…';

  try {
    await apiFetch(`/invoices/${invoiceId}/payments`, {
      method: 'POST',
      body: JSON.stringify({ amount, method, reference, notes })
    });
    showToast(`Payment of $${amount.toFixed(2)} recorded on ${invoiceId}!`, 'success');
    closePaymentModal();
    if (currentView === 'invoices') {
      await loadInvoices();
    }
  } catch (err) {
    showToast(`Failed to record payment: ${err.message}`, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="fa-solid fa-check"></i> Record &amp; Update Invoice';
  }
}

function closePaymentModal() {
  const overlay = document.getElementById('payment-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

// ─── Printable / PDF Invoice Preview Modal ────────────────────────────────────

async function openInvoicePreview(invoiceId) {
  const overlay = document.getElementById('invoice-view-modal');
  const contentEl = document.getElementById('invoice-view-content');
  const titleEl = document.getElementById('invoice-view-modal-title');

  titleEl.textContent = `Invoice ${invoiceId}`;
  contentEl.innerHTML = '<div class="alert alert-info"><span class="spinner"></span> Loading invoice document…</div>';

  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');

  try {
    const inv = await apiFetch(`/invoices/${invoiceId}`);
    renderPrintableInvoice(inv);
  } catch (err) {
    contentEl.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderPrintableInvoice(inv) {
  const contentEl = document.getElementById('invoice-view-content');

  const itemsRows = (inv.items || []).map((item, index) => `
    <tr>
      <td>${index + 1}</td>
      <td><strong>${esc(item.description)}</strong></td>
      <td style="text-align:center">${item.quantity}</td>
      <td style="text-align:right">$${Number(item.unit_price || 0).toFixed(2)}</td>
      <td style="text-align:right;font-weight:700;">$${Number(item.amount || (item.quantity * item.unit_price) || 0).toFixed(2)}</td>
    </tr>
  `).join('');

  const paymentsSection = Array.isArray(inv.payments) && inv.payments.length > 0 ? `
    <div class="invoice-payments-history">
      <h4><i class="fa-solid fa-receipt"></i> Recorded Payment History</h4>
      <table class="list-table" style="width:100%">
        <thead>
          <tr>
            <th>Payment ID</th>
            <th>Date</th>
            <th>Method</th>
            <th>Reference</th>
            <th style="text-align:right">Amount Paid</th>
          </tr>
        </thead>
        <tbody>
          ${inv.payments.map(p => `
            <tr>
              <td><code>${esc(p.id)}</code></td>
              <td>${formatDate(p.date)}</td>
              <td>${esc(p.method)}</td>
              <td>${esc(p.reference || '—')}</td>
              <td style="text-align:right;color:var(--success);font-weight:700">+$${Number(p.amount || 0).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  ` : '';

  contentEl.innerHTML = `
    <div class="invoice-printable" id="printable-area">
      <!-- Header -->
      <div class="invoice-printable-header">
        <div>
          <div class="invoice-brand-logo">LAWN <span>CRAFT</span></div>
          <div class="invoice-brand-tagline">Premium Turf Management &amp; Landscape Architecture</div>
          <div style="font-size:0.85rem;color:#666;margin-top:6px;line-height:1.4">
            142 Heritage Way, Melbourne VIC 3000<br>
            Phone: (03) 9876 5432 · accounts@lawncraft.com.au
          </div>
        </div>
        <div class="invoice-meta-block">
          <div class="invoice-meta-title">TAX INVOICE</div>
          <div class="invoice-meta-row">Invoice #: <strong>${esc(inv.id)}</strong></div>
          <div class="invoice-meta-row">Issue Date: <strong>${formatDate(inv.issue_date)}</strong></div>
          <div class="invoice-meta-row">Due Date: <strong>${formatDate(inv.due_date)}</strong></div>
          <div class="invoice-meta-row">Payment Terms: <strong>${esc(inv.payment_terms || 'Net 15')}</strong></div>
          ${inv.work_order_id ? `<div class="invoice-meta-row">Work Order Reference: <strong>#${inv.work_order_id}</strong></div>` : ''}
          <div class="invoice-meta-row" style="margin-top:6px;">Status: <span class="status-badge status-${inv.status}">${labelStatus(inv.status)}</span></div>
        </div>
      </div>

      <!-- Parties Grid -->
      <div class="invoice-parties-grid">
        <div class="invoice-party-box">
          <h4>Billed To (Client):</h4>
          <div class="invoice-party-name">${esc(inv.client_name)}</div>
          <div class="invoice-party-details">
            ${inv.client_email ? `<div><i class="fa-solid fa-envelope" style="width:16px"></i> ${esc(inv.client_email)}</div>` : ''}
            ${inv.client_phone ? `<div><i class="fa-solid fa-phone" style="width:16px"></i> ${esc(inv.client_phone)}</div>` : ''}
          </div>
        </div>
        <div class="invoice-party-box">
          <h4>Service / Property Location:</h4>
          <div class="invoice-party-name">${esc(inv.property_address)}</div>
          <div class="invoice-party-details">
            <div>Authorized Field Supervisor: <strong>${currentUser?.full_name || 'Lawn Craft Supervisor'}</strong></div>
          </div>
        </div>
      </div>

      <!-- Line Items Table -->
      <table class="invoice-print-table">
        <thead>
          <tr>
            <th style="width:5%">#</th>
            <th style="width:55%">Description of Services / Materials</th>
            <th style="width:10%;text-align:center">Qty</th>
            <th style="width:15%;text-align:right">Rate ($)</th>
            <th style="width:15%;text-align:right">Amount ($)</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>

      <!-- Totals Breakdown -->
      <div class="invoice-print-totals">
        <table class="invoice-totals-table">
          <tr>
            <td>Subtotal:</td>
            <td style="text-align:right">$${Number(inv.subtotal || 0).toFixed(2)}</td>
          </tr>
          <tr>
            <td>Sales Tax / GST (${inv.tax_rate || 0}%):</td>
            <td style="text-align:right">+$${Number(inv.tax_amount || 0).toFixed(2)}</td>
          </tr>
          ${inv.discount_amount > 0 ? `
            <tr>
              <td>Discount Applied:</td>
              <td style="text-align:right;color:var(--success)">-$${Number(inv.discount_amount).toFixed(2)}</td>
            </tr>
          ` : ''}
          <tr class="total-highlight">
            <td>Total Invoiced:</td>
            <td style="text-align:right">$${Number(inv.total_amount || 0).toFixed(2)}</td>
          </tr>
          <tr>
            <td>Total Payments Received:</td>
            <td style="text-align:right;color:var(--success)">-$${Number(inv.amount_paid || 0).toFixed(2)}</td>
          </tr>
          <tr class="due-highlight">
            <td>Balance Outstanding:</td>
            <td style="text-align:right">$${Number(inv.balance_due || 0).toFixed(2)}</td>
          </tr>
        </table>
      </div>

      <!-- Payment Log -->
      ${paymentsSection}

      <!-- Notes and Terms -->
      ${inv.notes ? `
        <div class="invoice-notes-block">
          <strong>Client Notes &amp; Remittance Advice:</strong><br>
          ${esc(inv.notes)}
        </div>
      ` : ''}

      <div class="invoice-footer-terms">
        Electronic funds transfer (EFT): BSB: 063-000 | Account: 1234-5678 | Reference: ${esc(inv.id)}<br>
        Thank you for entrusting your grounds care to Lawn Craft. For billing questions, contact accounts@lawncraft.com.au.
      </div>
    </div>
  `;
}

function closeInvoiceViewModal() {
  const overlay = document.getElementById('invoice-view-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

function createInvoiceForWorkOrder(woId) {
  closeModal();
  openInvoiceForm(null, woId);
}

function groupBy(items, key) {
  return items.reduce((groups, item) => {
    const groupKey = item[key] || 'Uncategorized';
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(item);
    return groups;
  }, {});
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toLocaleString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function loadAdminControlCenter() {
  const container = document.getElementById('control-center-container');
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading control center…</div>`;

  try {
    const data = await apiFetch('/admin/control-center');
    const stats = data.stats || {};
    const monitoring = data.monitoring || {};
    const permissions = data.permissions || [];
    const settings = data.settings || [];
    const logs = data.audit_logs || [];

    container.innerHTML = `
      <div class="admin-grid">
        <div class="control-card">
          <h3>Operational Snapshot</h3>
          <div class="control-stat">${monitoring.active_alerts || 0}</div>
          <div class="control-subtext">Live alerts requiring review right now.</div>
          <div class="row-actions"><button class="btn-save" data-target-view="monitoring">Open Monitoring</button></div>
        </div>
        <div class="control-card">
          <h3>Permission Rules</h3>
          <div class="control-stat">${permissions.length}</div>
          <div class="control-subtext">Feature policies managed without code.</div>
          <div class="row-actions"><button class="btn-save" data-target-view="permissions">Edit Policies</button></div>
        </div>
        <div class="control-card">
          <h3>Configuration Items</h3>
          <div class="control-stat">${settings.length}</div>
          <div class="control-subtext">Grouped settings and integrations.</div>
          <div class="row-actions"><button class="btn-save" data-target-view="settings">Open Config Hub</button></div>
        </div>
        <div class="control-card">
          <h3>Audit Entries</h3>
          <div class="control-stat">${logs.length}</div>
          <div class="control-subtext">Most recent logged actions.</div>
          <div class="row-actions"><button class="btn-save" data-target-view="audit">Search Logs</button></div>
        </div>
      </div>

      <div class="admin-grid">
        <div class="monitoring-card">
          <h3>Operational Metrics</h3>
          <table class="list-table">
            <tbody>
              <tr><th>Queue</th><td>${monitoring.queue_count || 0}</td></tr>
              <tr><th>Planning</th><td>${monitoring.planning_count || 0}</td></tr>
              <tr><th>Active</th><td>${monitoring.active_count || 0}</td></tr>
              <tr><th>Open Contacts</th><td>${monitoring.open_contacts || 0}</td></tr>
              <tr><th>Open Quotes</th><td>${monitoring.open_quotes || 0}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="permission-card">
          <h3>Access Rules</h3>
          ${permissions.slice(0, 3).map(policy => `
            <div class="audit-entry">
              <div class="audit-action">${esc(policy.label)}</div>
              <div class="audit-summary">${esc(policy.allowed_roles || '')}</div>
              <div class="audit-meta">Departments: ${esc(policy.allowed_departments || 'none')}</div>
            </div>
          `).join('') || '<div class="permission-note">No policies found.</div>'}
        </div>
        <div class="audit-card">
          <h3>Recent Activity</h3>
          ${logs.slice(0, 5).map(entry => `
            <div class="audit-entry">
              <div class="audit-action">${esc(entry.action)}</div>
              <div class="audit-summary">${esc(entry.summary || '')}</div>
              <div class="audit-meta">${esc(entry.actor_email || 'system')} · ${formatDateTime(entry.created_at)}</div>
            </div>
          `).join('') || '<div class="audit-note">No log entries yet.</div>'}
        </div>
      </div>

      <div class="monitoring-card">
        <h3>Current Snapshot</h3>
        <div class="control-subtext">Users: ${stats.totals?.users || 0} · Quotes: ${stats.totals?.quotes || 0} · Contacts: ${stats.totals?.contacts || 0}</div>
      </div>
    `;
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function loadPermissionsHub() {
  const container = document.getElementById('permissions-container');
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading permissions…</div>`;

  try {
    const [policies, profiles] = await Promise.all([
      apiFetch('/admin/permissions'),
      apiFetch('/admin/users/access-profiles'),
    ]);

    container.innerHTML = `
      <div class="admin-grid">
        ${(policies || []).map(policy => `
          <div class="permission-card" data-feature-key="${esc(policy.feature_key)}">
            <h3>${esc(policy.label)}</h3>
            <div class="permission-note">${esc(policy.description || 'Feature access rule')}</div>
            <form class="permission-form" onsubmit="return false;">
              <input class="policy-input" data-policy-field="label" value="${esc(policy.label)}" placeholder="Policy label">
              <input class="policy-input" data-policy-field="allowed_roles" value="${esc(policy.allowed_roles || '')}" placeholder="Allowed roles (comma separated)">
              <input class="policy-input" data-policy-field="allowed_departments" value="${esc(policy.allowed_departments || '')}" placeholder="Allowed departments (comma separated)">
              <input class="policy-input" data-policy-field="description" value="${esc(policy.description || '')}" placeholder="Description">
              <label><input type="checkbox" data-policy-field="is_enabled" ${policy.is_enabled ? 'checked' : ''}> Enabled</label>
              <button type="button" class="btn-save" onclick="savePermissionPolicy('${esc(policy.feature_key)}')">Save Policy</button>
            </form>
          </div>
        `).join('')}
      </div>

      <div class="settings-group">
        <h3>Department Assignments</h3>
        <div class="settings-note">Assign users to the departments that unlock feature access rules.</div>
        <table class="list-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Department</th>
              <th>Cost Center</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${(profiles || []).map(profile => `
              <tr data-profile-user-id="${profile.user_id}">
                <td>${esc(profile.user_email || profile.user_id)}</td>
                <td><input class="department-input" data-profile-field="department" value="${esc(profile.department || '')}"></td>
                <td><input class="department-input" data-profile-field="cost_center" value="${esc(profile.cost_center || '')}"></td>
                <td><input class="department-input" data-profile-field="notes" value="${esc(profile.notes || '')}"></td>
                <td><button type="button" class="btn-subtle" onclick="saveAccessProfileDepartment(${profile.user_id})">Save</button></td>
              </tr>
            `).join('') || '<tr><td colspan="5">No access profiles yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function loadAuditTrail() {
  const container = document.getElementById('audit-container');
  const query = document.getElementById('audit-search-input')?.value.trim() || '';
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading audit trail…</div>`;

  try {
    const logs = await apiFetch(`/admin/audit-logs?q=${encodeURIComponent(query)}`);
    container.innerHTML = `
      <div class="audit-card">
        <h3>Searchable Activity Log</h3>
        <div class="audit-note">Every login, policy change, setting update, and work-order action is stored here.</div>
        ${logs.length ? logs.map(entry => `
          <div class="audit-entry">
            <div class="audit-action">${esc(entry.action)}</div>
            <div class="audit-summary">${esc(entry.summary || '')}</div>
            <div class="audit-meta">${esc(entry.actor_email || 'system')} · ${esc(entry.resource_type || 'system')} ${esc(entry.resource_id || '')} · ${formatDateTime(entry.created_at)}</div>
          </div>
        `).join('') : '<div class="audit-note">No audit entries matched the current search.</div>'}
      </div>
    `;
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function loadSettingsHub() {
  const container = document.getElementById('settings-container');
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading configuration…</div>`;

  try {
    const settings = await apiFetch('/admin/settings');
    const grouped = groupBy(settings || [], 'group_name');

    container.innerHTML = Object.entries(grouped).map(([groupName, items]) => `
      <div class="settings-group">
        <h3>${esc(groupName)}</h3>
        <div class="settings-note">Manage ${esc(groupName.toLowerCase())} settings and integrations here.</div>
        ${items.map(setting => `
          <div class="permission-card" data-setting-key="${esc(setting.setting_key)}">
            <div class="audit-action">${esc(setting.label)}</div>
            <div class="settings-note">${esc(setting.description || '')}</div>
            <div class="settings-form">
              <input class="setting-input" data-setting-field="value" value="${esc(setting.value || '')}" ${setting.is_sensitive ? 'type="password"' : 'type="text"'}>
              <div class="row-actions">
                <button type="button" class="btn-save" onclick="saveSystemSetting('${esc(setting.setting_key)}')">Save Setting</button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function loadMonitoringHub() {
  const container = document.getElementById('monitoring-container');
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading monitoring data…</div>`;

  try {
    const [snapshot, settings] = await Promise.all([
      apiFetch('/admin/monitoring'),
      apiFetch('/admin/settings'),
    ]);

    const intakeSetting = (settings || []).find(item => item.setting_key === 'contact_intake_enabled');
    const intakeEnabled = !intakeSetting || String(intakeSetting.value).toLowerCase() !== 'false';

    container.innerHTML = `
      <div class="admin-grid">
        <div class="monitoring-card">
          <h3>Live Operations</h3>
          <div class="monitoring-badge">Live</div>
          <table class="list-table">
            <tbody>
              <tr><th>Queue</th><td>${snapshot.monitoring?.queue_count || 0}</td></tr>
              <tr><th>Planning</th><td>${snapshot.monitoring?.planning_count || 0}</td></tr>
              <tr><th>Active</th><td>${snapshot.monitoring?.active_count || 0}</td></tr>
              <tr><th>Alerts</th><td>${snapshot.monitoring?.active_alerts || 0}</td></tr>
            </tbody>
          </table>
        </div>
        <div class="monitoring-card">
          <h3>Intervention</h3>
          <div class="monitoring-note">Pause or resume contact intake without changing code.</div>
          <div class="row-actions">
            <button type="button" class="btn-intervene" onclick="toggleContactIntake(${intakeEnabled ? 'false' : 'true'})">
              ${intakeEnabled ? 'Pause Intake' : 'Resume Intake'}
            </button>
            <button type="button" class="btn-subtle" onclick="refreshDashboardView({silent:true})">Refresh Now</button>
          </div>
          <div class="settings-note">Current status: ${intakeEnabled ? 'enabled' : 'paused'}</div>
        </div>
        <div class="monitoring-card">
          <h3>Operational Alerts</h3>
          <div class="audit-note">Queue: ${snapshot.alerts?.queue || 0}</div>
          <div class="audit-note">Planning: ${snapshot.alerts?.planning || 0}</div>
          <div class="audit-note">Active: ${snapshot.alerts?.active || 0}</div>
        </div>
      </div>
    `;
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function loadFinancialSummary() {
  const container = document.getElementById('financial-container');
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading financial report…</div>`;

  try {
    const data = await apiFetch('/admin/financial-summary');
    container.innerHTML = `
      <div class="admin-grid">
        <div class="control-card">
          <h3>Quotes</h3>
          <div class="control-stat">${data.total_quotes || 0}</div>
          <div class="control-subtext">Accepted: ${data.accepted_quotes || 0} · Pending: ${data.pending_quotes || 0}</div>
        </div>
        <div class="control-card">
          <h3>Conversion</h3>
          <div class="control-stat">${data.conversion_rate || 0}%</div>
          <div class="control-subtext">Quote acceptance rate.</div>
        </div>
        <div class="control-card">
          <h3>Appointments</h3>
          <div class="control-stat">${data.appointments || 0}</div>
          <div class="control-subtext">Total appointment records.</div>
        </div>
        <div class="control-card">
          <h3>Contacts</h3>
          <div class="control-stat">${data.contacts || 0}</div>
          <div class="control-subtext">Enquiries feeding the pipeline.</div>
        </div>
      </div>
      <div class="monitoring-card">
        <h3>Policy Reminder</h3>
        <div class="monitoring-note">This report is protected by the Financial Reports policy and can be limited by department.</div>
      </div>
    `;
    markDashboardSynced();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

async function savePermissionPolicy(featureKey) {
  const card = document.querySelector(`[data-feature-key="${featureKey}"]`);
  if (!card) return;

  const payload = {
    label: card.querySelector('[data-policy-field="label"]').value.trim(),
    allowed_roles: card.querySelector('[data-policy-field="allowed_roles"]').value.trim(),
    allowed_departments: card.querySelector('[data-policy-field="allowed_departments"]').value.trim(),
    description: card.querySelector('[data-policy-field="description"]').value.trim(),
    is_enabled: card.querySelector('[data-policy-field="is_enabled"]').checked,
  };

  await apiFetch(`/admin/permissions/${encodeURIComponent(featureKey)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  showToast('Permission policy saved.', 'success');
  await loadPermissionsHub();
}

async function saveSystemSetting(settingKey) {
  const card = document.querySelector(`[data-setting-key="${settingKey}"]`);
  if (!card) return;

  const payload = {
    value: card.querySelector('[data-setting-field="value"]').value,
  };

  await apiFetch(`/admin/settings/${encodeURIComponent(settingKey)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  showToast('Setting saved.', 'success');
  await loadSettingsHub();
}

async function saveAccessProfileDepartment(userId) {
  const row = document.querySelector(`[data-profile-user-id="${userId}"]`);
  if (!row) return;

  const payload = {
    department: row.querySelector('[data-profile-field="department"]').value.trim(),
    cost_center: row.querySelector('[data-profile-field="cost_center"]').value.trim(),
    notes: row.querySelector('[data-profile-field="notes"]').value.trim(),
  };

  await apiFetch(`/admin/users/${userId}/access-profile`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  showToast('Department assignment saved.', 'success');
  await loadPermissionsHub();
}

async function toggleContactIntake(enabled) {
  await apiFetch('/admin/settings/contact_intake_enabled', {
    method: 'PUT',
    body: JSON.stringify({ value: enabled ? 'true' : 'false' }),
  });
  showToast(`Contact intake ${enabled ? 'enabled' : 'paused'}.`, 'success');
  await loadMonitoringHub();
}

// ─── Work Order Detail Modal ──────────────────────────────────────────────────

async function openWorkOrderDetail(id) {
  workOrderDetailId = id;
  const overlay = document.getElementById('wo-modal');
  modalLastFocusedElement = document.activeElement;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');

  const body = document.getElementById('modal-body-content');
  body.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading…</div>`;

  try {
    const wo = await apiFetch(`/work-orders/${id}`);
    renderWorkOrderModal(wo);
    const closeBtn = document.getElementById('modal-close-btn');
    if (closeBtn) closeBtn.focus();
  } catch (err) {
    body.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function renderWorkOrderModal(wo) {
  document.getElementById('modal-title').textContent = `#${wo.id} – ${wo.title}`;

  const nextStatusMap = {
    incoming: ['reviewed', 'cancelled'],
    reviewed: ['planned', 'cancelled'],
    planned: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: ['verified'],
    verified: [],
    cancelled: [],
  };

  const statusOptions = [wo.status, ...(nextStatusMap[wo.status] || [])]
    .map((s, idx) => {
      const suffix = idx === 0 ? ' (current)' : '';
      return `<option value="${s}" ${s === wo.status ? 'selected' : ''}>${labelStatus(s)}${suffix}</option>`;
    })
    .join('');

  document.getElementById('modal-body-content').innerHTML = `
    <div class="detail-grid">
      <div class="detail-item">
        <label>Status</label>
        <span><span class="badge-status status-${wo.status}">${labelStatus(wo.status)}</span></span>
      </div>
      <div class="detail-item">
        <label>Priority</label>
        <span><span class="badge-priority priority-${wo.priority}">${esc(wo.priority)}</span></span>
      </div>
      <div class="detail-item">
        <label>Client</label>
        <span>${esc(wo.client_name)}</span>
      </div>
      <div class="detail-item">
        <label>Service Type</label>
        <span>${esc(wo.service_type || '—')}</span>
      </div>
      <div class="detail-item">
        <label>Phone</label>
        <span>${esc(wo.client_phone || '—')}</span>
      </div>
      <div class="detail-item">
        <label>Email</label>
        <span>${esc(wo.client_email || '—')}</span>
      </div>
      <div class="detail-item detail-full">
        <label>Property Address</label>
        <span>${esc(wo.property_address)}</span>
      </div>
      <div class="detail-item">
        <label>Target Date</label>
        <span>${wo.target_date ? formatDate(wo.target_date) : '—'}</span>
      </div>
      <div class="detail-item">
        <label>Created</label>
        <span>${formatDate(wo.created_at)}</span>
      </div>
      <div class="detail-item">
        <label>Started</label>
        <span>${wo.started_at ? formatDate(wo.started_at) : '—'}</span>
      </div>
      <div class="detail-item">
        <label>Completed</label>
        <span>${wo.completed_at ? formatDate(wo.completed_at) : '—'}</span>
      </div>
      ${wo.description ? `
      <div class="detail-item detail-full">
        <label>Description</label>
        <div class="detail-notes">${esc(wo.description)}</div>
      </div>` : ''}
      ${wo.supervisor_notes ? `
      <div class="detail-item detail-full">
        <label>Supervisor Notes</label>
        <div class="detail-notes">${esc(wo.supervisor_notes)}</div>
      </div>` : ''}
    </div>

    <div class="status-update-row" style="margin-top: 1.25rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <label for="modal-status-select" style="margin:0">Update Status:</label>
        <select id="modal-status-select">${statusOptions}</select>
        <button class="btn-save" onclick="saveStatusUpdate(${wo.id})">Save</button>
      </div>
      <div>
        <button class="btn-subtle" onclick="createInvoiceForWorkOrder(${wo.id})">
          <i class="fa-solid fa-file-invoice-dollar" style="color:var(--primary)"></i> Create Client Invoice
        </button>
      </div>
    </div>
  `;
}

async function saveStatusUpdate(id) {
  const select = document.getElementById('modal-status-select');
  const newStatus = select.value;

  try {
    await apiFetch(`/work-orders/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ status: newStatus }),
    });
    showToast(`Status updated to "${labelStatus(newStatus)}".`, 'success');
    closeModal();
    // Refresh current view
    await refreshDashboardView({ silent: true });
    // Refresh overview badge
    if (currentView !== 'overview') loadStats();
  } catch (err) {
    showToast(`Failed to update: ${err.message}`, 'error');
  }
}

function closeModal() {
  const overlay = document.getElementById('wo-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  workOrderDetailId = null;
  if (modalLastFocusedElement && typeof modalLastFocusedElement.focus === 'function') {
    modalLastFocusedElement.focus();
  }
  modalLastFocusedElement = null;
}

function getModalFocusableElements() {
  const modal = document.querySelector('#wo-modal .modal');
  if (!modal) return [];

  return [...modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
}

function handleModalKeydown(e) {
  const overlay = document.getElementById('wo-modal');
  if (!overlay.classList.contains('open')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal();
    return;
  }

  if (e.key !== 'Tab') return;

  const focusable = getModalFocusableElements();
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// ─── Mobile sidebar ───────────────────────────────────────────────────────────

function openMobileSidebar() {
  document.querySelector('.sidebar').classList.add('open');
  document.querySelector('.sidebar-overlay').classList.add('open');
}

function closeMobileSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  document.querySelector('.sidebar-overlay').classList.remove('open');
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function labelStatus(s) {
  const map = {
    incoming:    'Incoming',
    reviewed:    'Reviewed',
    planned:     'Planned',
    in_progress: 'In Progress',
    completed:   'Completed',
    verified:    'Verified',
    cancelled:   'Cancelled',
  };
  return map[s] || s;
}

function createSparklineSvg(points, tone = 'neutral') {
  const clean = Array.isArray(points) && points.length ? points.map(n => Number(n) || 0) : [0, 0, 0, 0, 0, 0, 0];
  const width = 140;
  const height = 34;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = Math.max(max - min, 1);
  const stepX = clean.length > 1 ? width / (clean.length - 1) : width;

  const coords = clean.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return `
    <svg class="sparkline spark-${tone}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${coords.join(' ')}"></polyline>
    </svg>
  `;
}

function trendDirection(points) {
  if (!Array.isArray(points) || points.length < 2) return 'steady';
  const first = Number(points[0]) || 0;
  const last = Number(points[points.length - 1]) || 0;
  if (last > first) return 'up';
  if (last < first) return 'down';
  return 'steady';
}

function trendSummary(points, positiveWhenDown = false) {
  const direction = trendDirection(points);
  if (direction === 'steady') return 'steady vs 7-day start';
  if (direction === 'up') return positiveWhenDown ? 'higher than 7-day start' : 'increasing over 7 days';
  return positiveWhenDown ? 'decreasing over 7 days' : 'lower than 7-day start';
}

function parseIsoTime(iso) {
  if (!iso) return null;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function activityTimeLabel(iso) {
  const dt = parseIsoTime(iso);
  if (!dt) return 'just now';
  return formatRelativeSyncTime(dt).replace('Synced ', '');
}

function hashAddressToPercent(address, axis = 'x') {
  const source = `${address || ''}:${axis}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = ((hash << 5) - hash) + source.charCodeAt(i);
    hash |= 0;
  }
  const normalized = Math.abs(hash % 1000) / 1000;
  return axis === 'x' ? (12 + normalized * 76) : (16 + normalized * 68);
}

function renderLiveFeed(queueItems, planningItems, activeItems) {
  const feedEl = document.getElementById('live-feed-container');
  if (!feedEl) return;

  const events = [];

  (activeItems || []).forEach(item => {
    events.push({
      tone: 'warning',
      label: 'Active Job',
      title: item.title,
      workOrderId: item.id,
      address: item.property_address,
      at: item.started_at || item.updated_at || item.created_at,
    });
  });

  (queueItems || []).forEach(item => {
    events.push({
      tone: 'info',
      label: 'New Request',
      title: item.title,
      workOrderId: item.id,
      address: item.property_address,
      at: item.created_at,
    });
  });

  (planningItems || []).forEach(item => {
    events.push({
      tone: 'success',
      label: 'Scheduled',
      title: item.title,
      workOrderId: item.id,
      address: item.property_address,
      at: item.target_date || item.updated_at || item.created_at,
    });
  });

  events.sort((a, b) => {
    const ta = parseIsoTime(a.at)?.getTime() || 0;
    const tb = parseIsoTime(b.at)?.getTime() || 0;
    return tb - ta;
  });

  const top = events.slice(0, 8);
  if (!top.length) {
    feedEl.innerHTML = '<div class="activity-empty">No live updates right now. You are fully caught up.</div>';
    return;
  }

  feedEl.innerHTML = top.map(event => `
    <div class="activity-item">
      <span class="dot dot-${event.tone}"></span>
      <div class="activity-main">
        <div class="activity-title">${esc(event.label)} · #${event.workOrderId} ${esc(event.title || '')}</div>
        <div class="activity-meta">${esc(event.address || 'Address pending')}</div>
      </div>
      <div class="activity-time">${esc(activityTimeLabel(event.at))}</div>
    </div>
  `).join('');
}

function renderMiniMap(queueItems, planningItems, activeItems) {
  const mapEl = document.getElementById('live-map-container');
  if (!mapEl) return;

  const locations = [
    ...(activeItems || []).map(item => ({ ...item, tone: 'warning' })),
    ...(planningItems || []).map(item => ({ ...item, tone: 'success' })),
    ...(queueItems || []).map(item => ({ ...item, tone: 'info' })),
  ];

  const uniqueByAddress = [];
  const seen = new Set();
  for (const loc of locations) {
    const key = String(loc.property_address || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueByAddress.push(loc);
    if (uniqueByAddress.length >= 10) break;
  }

  if (!uniqueByAddress.length) {
    mapEl.innerHTML = '<div class="activity-empty">No location points to render yet.</div>';
    return;
  }

  mapEl.innerHTML = `
    ${uniqueByAddress.map(loc => `
      <button type="button"
              class="map-marker ${loc.tone}"
              data-open-work-order="${loc.id}"
              style="left:${hashAddressToPercent(loc.property_address, 'x')}%;top:${hashAddressToPercent(loc.property_address, 'y')}%;"
              title="#${loc.id} ${esc(loc.title || '')} · ${esc(loc.property_address || '')}"></button>
    `).join('')}
    <div class="map-legend">${uniqueByAddress.length} active points · colored by urgency</div>
  `;
}

// ─── ERP: Inventory Management ───────────────────────────────────────────────

let inventoryList = [];

async function loadInventory() {
  const tbody = document.getElementById('tbody-inventory');
  tbody.innerHTML = `<tr><td colspan="10" class="empty-row"><span class="spinner"></span> Loading inventory catalog…</td></tr>`;

  try {
    const [invData, txns] = await Promise.all([
      apiFetch('/erp/inventory'),
      apiFetch('/erp/inventory/transactions').catch(() => [])
    ]);

    inventoryList = invData.items || [];
    const stats = invData.stats || {};

    // Update stats
    document.getElementById('inv-stat-sku-count').textContent = stats.total_items || inventoryList.length;
    document.getElementById('inv-stat-low-count').textContent = stats.low_stock_count || 0;
    document.getElementById('inv-stat-valuation').textContent = `$${(stats.total_inventory_valuation || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const invBadge = document.getElementById('inventory-badge');
    if (invBadge) {
      if (stats.low_stock_count > 0) {
        invBadge.textContent = `${stats.low_stock_count} LOW`;
        invBadge.style.display = 'inline-block';
      } else {
        invBadge.style.display = 'none';
      }
    }

    renderInventoryTable();
    renderInventoryTransactions(txns);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-row text-danger">Failed to load inventory: ${esc(err.message)}</td></tr>`;
  }
}

function renderInventoryTable() {
  const tbody = document.getElementById('tbody-inventory');
  const countEl = document.getElementById('count-inventory');
  const catFilter = document.getElementById('inventory-category-filter')?.value || 'all';
  const searchVal = (document.getElementById('inventory-search-input')?.value || '').toLowerCase().trim();

  let filtered = [...inventoryList];
  if (catFilter !== 'all') {
    filtered = filtered.filter(i => i.category === catFilter);
  }
  if (searchVal) {
    filtered = filtered.filter(i =>
      i.name.toLowerCase().includes(searchVal) ||
      i.sku.toLowerCase().includes(searchVal) ||
      (i.supplier && i.supplier.toLowerCase().includes(searchVal)) ||
      (i.location && i.location.toLowerCase().includes(searchVal))
    );
  }

  if (countEl) countEl.textContent = `${filtered.length} of ${inventoryList.length} items`;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-row">No inventory items matched your filter criteria.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(item => {
    const isLow = item.quantity_on_hand <= item.min_reorder_level;
    return `
      <tr class="${isLow ? 'table-row-danger' : ''}">
        <td>
          <div style="font-weight:700;color:var(--text-dark);">${esc(item.name)}</div>
          <div style="font-size:0.8rem;color:var(--text-light);">${esc(item.supplier || 'Standard Supplier')} · ${esc(item.unit)}</div>
        </td>
        <td><code>${esc(item.sku)}</code></td>
        <td><span class="badge" style="background:#e8e3dd;color:#1a1a1a;">${esc(item.category)}</span></td>
        <td>
          <span style="font-weight:800;font-size:1.05rem;color:${isLow ? 'var(--danger)' : 'var(--text-dark)'}">
            ${item.quantity_on_hand}
          </span>
          ${isLow ? '<span class="badge badge-urgent" style="font-size:0.7rem;margin-left:4px;">REORDER</span>' : ''}
        </td>
        <td>${item.min_reorder_level} ${esc(item.unit)}</td>
        <td>$${item.unit_cost.toFixed(2)}</td>
        <td>$${item.unit_price.toFixed(2)}</td>
        <td><i class="fa-solid fa-location-dot" style="font-size:0.8rem;color:var(--text-light)"></i> ${esc(item.location || 'Warehouse')}</td>
        <td>
          <span class="badge ${item.auto_reorder_enabled ? 'badge-success' : 'badge-neutral'}">
            ${item.auto_reorder_enabled ? '<i class="fa-solid fa-check"></i> Enabled' : 'Off'}
          </span>
        </td>
        <td>
          <button class="btn-sm btn-secondary" onclick="quickRestockItem('${item.id}', '${esc(item.name)}', ${item.reorder_quantity})">
            <i class="fa-solid fa-cart-plus"></i> Restock (+${item.reorder_quantity})
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

async function quickRestockItem(itemId, itemName, defaultQty) {
  const qtyStr = prompt(`Enter restock quantity for "${itemName}":`, defaultQty || 20);
  if (!qtyStr) return;
  const qty = parseFloat(qtyStr);
  if (isNaN(qty) || qty <= 0) {
    showToast('Please enter a valid positive quantity.', 'danger');
    return;
  }

  try {
    await apiFetch('/erp/inventory/restock', {
      method: 'POST',
      body: JSON.stringify({ item_id: itemId, quantity: qty, reason: 'Manual supervisor restock' })
    });
    showToast(`Restocked ${qty} units for ${itemName}`, 'success');
    await loadInventory();
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

function renderInventoryTransactions(txns) {
  const tbody = document.getElementById('tbody-inventory-txns');
  if (!tbody) return;

  if (!txns.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No material transactions recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = txns.map(t => `
    <tr>
      <td>${formatDate(t.timestamp)}</td>
      <td style="font-weight:600;">${esc(t.item_name || t.item_id)}</td>
      <td>
        <span class="badge ${t.type === 'consumption' ? 'badge-warning' : (t.type === 'auto_reorder' ? 'badge-info' : 'badge-success')}">
          ${t.type === 'auto_reorder' ? '<i class="fa-solid fa-robot"></i> Auto-PO' : esc(t.type)}
        </span>
      </td>
      <td style="font-weight:700;color:${t.type === 'consumption' ? 'var(--danger)' : 'var(--success)'}">
        ${t.type === 'consumption' ? '-' : '+'}${t.quantity} ${esc(t.unit || '')}
      </td>
      <td>${t.previous_qty} &rarr; <strong>${t.new_qty}</strong></td>
      <td style="font-size:0.85rem;">${esc(t.reason || 'Work order deduction')}</td>
      <td style="font-size:0.8rem;color:var(--text-light);">${esc(t.actor_email || 'system')}</td>
    </tr>
  `).join('');
}

// ─── ERP: Automated Payroll ───────────────────────────────────────────────────

let payrollEntries = [];

async function loadPayroll() {
  const tbody = document.getElementById('tbody-payroll');
  tbody.innerHTML = `<tr><td colspan="11" class="empty-row"><span class="spinner"></span> Loading payroll ledger…</td></tr>`;

  try {
    const data = await apiFetch('/erp/payroll');
    payrollEntries = data.entries || [];
    const stats = data.stats || {};

    document.getElementById('payroll-stat-employee-count').textContent = stats.total_employees || payrollEntries.length;
    document.getElementById('payroll-stat-hours').textContent = `${stats.total_hours_logged || 0} hrs`;
    document.getElementById('payroll-stat-gross').textContent = `$${(stats.total_gross_payroll || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('payroll-stat-net').textContent = `$${(stats.total_net_payroll || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    const countEl = document.getElementById('count-payroll');
    if (countEl) countEl.textContent = `${payrollEntries.length} payroll entries`;

    if (!payrollEntries.length) {
      tbody.innerHTML = `<tr><td colspan="11" class="empty-row">No payroll entries available for the active period.</td></tr>`;
      return;
    }

    tbody.innerHTML = payrollEntries.map(e => `
      <tr>
        <td><code>${esc(e.id)}</code></td>
        <td style="font-weight:700;color:var(--text-dark);">${esc(e.employee_name)}</td>
        <td><span class="badge" style="background:#e8e3dd;color:#1a1a1a;">${esc(e.role)}</span></td>
        <td style="font-size:0.85rem;">${e.pay_period_start} &rarr; ${e.pay_period_end}</td>
        <td>
          <strong>${e.regular_hours + e.overtime_hours} hrs</strong>
          ${e.overtime_hours > 0 ? `<div style="font-size:0.75rem;color:var(--warning)">(${e.overtime_hours} hrs OT @ 1.5x)</div>` : ''}
        </td>
        <td>$${e.hourly_rate.toFixed(2)}/hr</td>
        <td><span class="badge badge-info">${e.jobs_completed} jobs</span></td>
        <td style="color:${e.bonus > 0 ? 'var(--success)' : 'var(--text-light)'}">+$${e.bonus.toFixed(2)}</td>
        <td style="font-weight:700;">$${e.gross_pay.toFixed(2)}</td>
        <td style="font-weight:800;color:var(--success);font-size:1.05rem;">$${e.net_pay.toFixed(2)}</td>
        <td>
          <span class="badge ${e.status === 'approved' || e.status === 'processed' ? 'badge-success' : 'badge-warning'}">
            ${esc(e.status.toUpperCase())}
          </span>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-row text-danger">Failed to load payroll: ${esc(err.message)}</td></tr>`;
  }
}

async function approveAllPayroll() {
  try {
    await apiFetch('/erp/payroll/approve-all', { method: 'POST' });
    showToast('All pending draft payroll entries approved for disbursement', 'success');
    await loadPayroll();
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

// ─── ERP: Workflow Automation & Rules ─────────────────────────────────────────

let automationRules = [];

async function loadAutomationRules() {
  const tbodyRules = document.getElementById('tbody-automation-rules');
  const tbodyLogs = document.getElementById('tbody-automation-logs');
  tbodyRules.innerHTML = `<tr><td colspan="6" class="empty-row"><span class="spinner"></span> Loading rules…</td></tr>`;

  try {
    const data = await apiFetch('/erp/automation/rules');
    automationRules = data.rules || [];
    const logs = data.logs || [];
    const summary = data.summary || {};

    document.getElementById('auto-stat-active-rules').textContent = `${summary.active_rules || 0} / ${summary.total_rules || 0}`;
    document.getElementById('auto-stat-executions').textContent = summary.total_executions || 0;

    const countEl = document.getElementById('count-rules');
    if (countEl) countEl.textContent = `${automationRules.length} automated workflow triggers`;

    tbodyRules.innerHTML = automationRules.map(r => `
      <tr>
        <td>
          <div style="font-weight:700;color:var(--text-dark);">${esc(r.name)}</div>
          <div style="font-size:0.85rem;color:var(--text-medium);margin-top:2px;">${esc(r.description)}</div>
        </td>
        <td><code>${esc(r.trigger_event)}</code></td>
        <td><strong style="color:var(--accent-dark)">${r.execution_count}</strong> runs</td>
        <td style="font-size:0.85rem;">${r.last_triggered ? formatDate(r.last_triggered) : 'Never'}</td>
        <td>
          <span class="badge ${r.is_enabled ? 'badge-success' : 'badge-neutral'}">
            ${r.is_enabled ? '<i class="fa-solid fa-bolt"></i> ACTIVE' : 'PAUSED'}
          </span>
        </td>
        <td>
          <button class="btn-sm ${r.is_enabled ? 'btn-secondary' : 'btn-primary'}" onclick="toggleAutomationRule('${r.id}')">
            <i class="fa-solid ${r.is_enabled ? 'fa-pause' : 'fa-play'}"></i> ${r.is_enabled ? 'Pause' : 'Enable'}
          </button>
        </td>
      </tr>
    `).join('');

    if (!logs.length) {
      tbodyLogs.innerHTML = `<tr><td colspan="5" class="empty-row">No automation events logged yet.</td></tr>`;
    } else {
      tbodyLogs.innerHTML = logs.map(l => `
        <tr>
          <td>${formatDate(l.timestamp)}</td>
          <td><code>${esc(l.event_type)}</code></td>
          <td style="font-weight:600;">${esc(l.rule_name)}</td>
          <td style="font-size:0.85rem;">${esc(l.details)}</td>
          <td>
            <span class="badge ${l.status === 'success' ? 'badge-success' : (l.status === 'warning' ? 'badge-warning' : 'badge-danger')}">
              ${esc(l.status.toUpperCase())}
            </span>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    tbodyRules.innerHTML = `<tr><td colspan="6" class="empty-row text-danger">Failed to load automation rules: ${esc(err.message)}</td></tr>`;
  }
}

async function toggleAutomationRule(ruleId) {
  try {
    await apiFetch(`/erp/automation/rules/${ruleId}/toggle`, { method: 'PUT' });
    showToast('Automation rule status updated', 'success');
    await loadAutomationRules();
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

async function runFullErpSync() {
  const btn = document.getElementById('btn-trigger-erp-sync');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Running ERP Batch Sync…`;
  }

  try {
    const res = await apiFetch('/erp/automation/trigger-sync', { method: 'POST' });
    showToast(`ERP Batch Completed: ${res.invoices_synced || 0} invoices generated & timesheets synchronized!`, 'success');
    if (currentView === 'inventory') await loadInventory();
    else if (currentView === 'payroll') await loadPayroll();
    else if (currentView === 'automation') await loadAutomationRules();
    else if (currentView === 'invoices') await loadInvoices();
  } catch (err) {
    showToast(err.message, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-robot"></i> Run Full ERP Automation Sync`;
    }
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  initTheme();

  // Wire up login form
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const btn      = e.target.querySelector('button[type=submit]');

    clearLoginMessages();
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      await login(email, password);
      const user = await loadCurrentUser();
      if (!isDashboardRoleAllowed(user)) {
        handleUnauthorizedDashboardAccess();
        return;
      }
      showApp();
      navigate(getViewFromHash() || 'overview', { pushHash: false });
    } catch (err) {
      showLoginError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  // Wire up sidebar nav
  document.querySelectorAll('.sidebar-nav a[data-view]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      navigate(a.dataset.view);
    });
  });

  // Logout button
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('theme-toggle-btn')?.addEventListener('click', () => setTheme(!darkModeEnabled));

  initSidebarCollapsibles();

  // Hamburger
  document.querySelector('.hamburger-btn').addEventListener('click', openMobileSidebar);
  document.querySelector('.sidebar-overlay').addEventListener('click', closeMobileSidebar);

  document.querySelectorAll('.quick-action-card').forEach(card => {
    card.addEventListener('click', () => {
      const targetView = card.dataset.view;
      if (targetView) navigate(targetView);
    });
  });

  document.addEventListener('click', e => {
    const navButton = e.target.closest('[data-target-view]');
    if (!navButton) return;

    e.preventDefault();
    const targetView = navButton.getAttribute('data-target-view');
    if (targetView) navigate(targetView);
  });

  document.getElementById('refresh-btn').addEventListener('click', () => refreshDashboardView());
  document.getElementById('audit-search-btn')?.addEventListener('click', loadAuditTrail);
  document.getElementById('audit-search-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') loadAuditTrail();
  });

  // Invoicing & Billing event listeners
  document.getElementById('btn-create-invoice')?.addEventListener('click', () => openInvoiceForm());
  document.getElementById('invoice-status-filter')?.addEventListener('change', () => loadInvoices());
  
  let invSearchTimeout;
  document.getElementById('invoice-search-input')?.addEventListener('input', () => {
    clearTimeout(invSearchTimeout);
    invSearchTimeout = setTimeout(() => loadInvoices(), 300);
  });

  document.getElementById('btn-add-line-item')?.addEventListener('click', () => addLineItemRow());
  document.getElementById('inv-tax-rate')?.addEventListener('input', calculateFormTotals);
  document.getElementById('inv-discount-amount')?.addEventListener('input', calculateFormTotals);
  document.getElementById('inv-link-wo')?.addEventListener('change', e => {
    if (e.target.value) {
      autofillInvoiceFromWorkOrder(e.target.value);
    }
  });

  document.getElementById('invoice-form')?.addEventListener('submit', saveInvoice);
  document.getElementById('invoice-form-close-btn')?.addEventListener('click', closeInvoiceFormModal);
  document.getElementById('invoice-form-cancel-btn')?.addEventListener('click', closeInvoiceFormModal);
  document.getElementById('invoice-form-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('invoice-form-modal')) closeInvoiceFormModal();
  });

  document.getElementById('payment-form')?.addEventListener('submit', savePayment);
  document.getElementById('payment-modal-close-btn')?.addEventListener('click', closePaymentModal);
  document.getElementById('payment-cancel-btn')?.addEventListener('click', closePaymentModal);
  document.getElementById('payment-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('payment-modal')) closePaymentModal();
  });

  document.getElementById('invoice-view-close-btn')?.addEventListener('click', closeInvoiceViewModal);
  document.getElementById('btn-print-invoice-doc')?.addEventListener('click', () => window.print());
  document.getElementById('invoice-view-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('invoice-view-modal')) closeInvoiceViewModal();
  });

  // Modal close
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('wo-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('wo-modal')) closeModal();
  });
  document.getElementById('wo-modal').addEventListener('keydown', handleModalKeydown);

  // KPI period select
  document.getElementById('report-days-select').addEventListener('change', e => {
    loadReport(Number(e.target.value));
  });

  // Property search
  document.getElementById('property-search-btn').addEventListener('click', searchProperty);
  document.getElementById('property-search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') searchProperty();
  });

  // Keyboard: close modal on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      closeInvoiceFormModal();
      closePaymentModal();
      closeInvoiceViewModal();
      closeMobileSidebar();
    }
  });

  // ERP Event Listeners
  document.getElementById('inventory-category-filter')?.addEventListener('change', renderInventoryTable);
  
  let inventorySearchTimeout;
  document.getElementById('inventory-search-input')?.addEventListener('input', () => {
    clearTimeout(inventorySearchTimeout);
    inventorySearchTimeout = setTimeout(renderInventoryTable, 250);
  });

  document.getElementById('btn-trigger-erp-sync')?.addEventListener('click', runFullErpSync);
  document.getElementById('btn-approve-all-payroll')?.addEventListener('click', approveAllPayroll);

  window.quickRestockItem = quickRestockItem;
  window.toggleAutomationRule = toggleAutomationRule;

  // Check for existing session
  if (getToken()) {
    try {
      const user = await loadCurrentUser();
      if (!isDashboardRoleAllowed(user)) {
        handleUnauthorizedDashboardAccess();
        return;
      }
      setAdminVisibility(String(user.role || '').toLowerCase() === 'admin');
      showApp();
      navigate(getViewFromHash() || 'overview', { pushHash: false });
      startAutoRefresh();
    } catch {
      showLogin();
    }
  } else {
    showLogin();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && getToken() && currentUser) {
    refreshDashboardView({ silent: true });
  }
});

window.addEventListener('hashchange', () => {
  const targetView = getViewFromHash();
  if (!targetView || targetView === currentView) return;
  navigate(targetView, { pushHash: false });
});

document.addEventListener('DOMContentLoaded', init);
