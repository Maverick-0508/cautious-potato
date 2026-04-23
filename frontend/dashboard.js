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
const API_BASE = (() => {
  if (typeof window === 'undefined') return '/api';
  if (window.DASHBOARD_API_BASE) return window.DASHBOARD_API_BASE;

  const { protocol, hostname, port } = window.location;
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';

  if (protocol === 'file:') return 'http://127.0.0.1:8000/api';
  if (isLocalHost && port && port !== '8000') return 'http://127.0.0.1:8000/api';

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
  exceptions: 'Exceptions',
  report: 'KPI Report',
  workorders: 'All Work Orders',
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

function authHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`,
  };
}

async function apiFetch(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: authHeaders(),
  });

  if (resp.status === 401) {
    handleSessionExpired();
    throw new Error('Session expired – please log in again.');
  }

  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${resp.status}`);
  }

  // 204 No Content
  if (resp.status === 204) return null;

  return resp.json();
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
    if (currentView !== 'overview') {
      navigate('overview', { pushHash });
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

  tbody.innerHTML = `<tr class="loading-row"><td colspan="7"><span class="spinner"></span> Searching…</td></tr>`;

  try {
    const data = await apiFetch(`/supervisor/property?address=${encodeURIComponent(query)}`);
    const items = Array.isArray(data) ? data : [];

    if (countEl) countEl.textContent = `${items.length} record${items.length !== 1 ? 's' : ''}`;

    if (items.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No work orders found for this address.</td></tr>`;
      return;
    }

    tbody.innerHTML = items.map(wo => renderWorkOrderRow(wo)).join('');
    markDashboardSynced();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="alert alert-danger">${err.message}</div></td></tr>`;
  }
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

    <div class="status-update-row">
      <label for="modal-status-select">Update Status</label>
      <select id="modal-status-select">${statusOptions}</select>
      <button class="btn-save" onclick="saveStatusUpdate(${wo.id})">Save</button>
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
      closeMobileSidebar();
    }
  });

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
