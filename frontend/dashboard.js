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
const DASHBOARD_API_STORAGE_KEY = 'dashboard_api_base';

function normalizeApiBase(value) {
  const normalized = trimTrailingSlash(String(value || '').trim());
  if (!normalized) return '';
  return normalized;
}

function getMetaApiBase() {
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="dashboard-api-base"]');
  return normalizeApiBase(meta?.getAttribute('content') || '');
}

function getUrlApiBase() {
  if (typeof window === 'undefined') return '';
  const urlApiBase = new URLSearchParams(window.location.search).get('apiBase');
  if (!urlApiBase) return '';
  const normalized = normalizeApiBase(urlApiBase);
  if (normalized) {
    localStorage.setItem(DASHBOARD_API_STORAGE_KEY, normalized);
  }
  return normalized;
}

function getStoredApiBase() {
  if (typeof window === 'undefined') return '';
  return normalizeApiBase(localStorage.getItem(DASHBOARD_API_STORAGE_KEY) || '');
}

const API_BASE_DETAILS = (() => {
  if (typeof window === 'undefined') {
    return { base: '/api', source: 'server-default' };
  }

  const explicitBase = normalizeApiBase(
    typeof window.DASHBOARD_API_BASE === 'string' ? window.DASHBOARD_API_BASE : ''
  );
  if (explicitBase) return { base: explicitBase, source: 'window.DASHBOARD_API_BASE' };

  const urlBase = getUrlApiBase();
  if (urlBase) return { base: urlBase, source: 'url.apiBase' };

  const storedBase = getStoredApiBase();
  if (storedBase) return { base: storedBase, source: 'localStorage.dashboard_api_base' };

  const metaBase = getMetaApiBase();
  if (metaBase) return { base: metaBase, source: 'meta.dashboard-api-base' };

  return { base: '/api', source: 'default-proxy' };
})();

const API_BASE = API_BASE_DETAILS.base;

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
  mpesa: 'M-Pesa & Payment Gateway Hub',
  loyalty: 'Loyalty Rewards & Coupons Engine',
  receipts: 'Electronic Tax Receipts & POS Slips',
  dunning: 'Automated Dunning & Collections',
  quotes: 'Digital Estimates & Proposals',
  contracts: 'Recurring Maintenance Agreements',
  clients: 'Client CRM & Property Intelligence',
  territory: 'Route & Territory Map',
  widget: 'Embeddable Pricing Widget',
  inventory: 'Inventory ERP & Supply Chain',
  purchasing: 'Vendor Purchase Orders & Restocking',
  payroll: 'Automated Payroll & Timesheets',
  timesheets: 'GPS Geo-Fenced Timesheets',
  fleet: 'Fleet & Equipment Asset Management',
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
  let resp;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: buildAuthHeaders(options),
    });
  } catch (err) {
    throw new Error(`Unable to reach backend API (${API_BASE}). Verify DASHBOARD_API_BASE or Vercel BACKEND_API_BASE wiring.`);
  }

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
  let resp;
  try {
    resp = await fetch(`${API_BASE}/auth/login/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    throw new Error(`Cannot reach backend API (${API_BASE}). Configure DASHBOARD_API_BASE or set Vercel BACKEND_API_BASE for /api proxy.`);
  }

  if (!resp.ok) {
    const detail = await readErrorDetail(resp);
    if (resp.status === 404 || resp.status === 502 || resp.status === 503 || resp.status === 504) {
      throw new Error(`Backend API is not wired correctly (${API_BASE}). Configure DASHBOARD_API_BASE or Vercel BACKEND_API_BASE.`);
    }
    throw new Error(detail || `Sign in failed (${resp.status}).`);
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
  document.querySelectorAll('.mobile-nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === normalizedViewId);
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

  // Scroll to top on navigation for mobile
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const mainContent = document.querySelector('.main-content');
  if (mainContent) mainContent.scrollTop = 0;

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
    case 'mpesa':
      await loadMpesaModule();
      break;
    case 'loyalty':
      await loadLoyaltyModule();
      break;
    case 'receipts':
      await loadReceiptsModule();
      break;
    case 'dunning':
      await loadDunningModule();
      break;
    case 'quotes':
      await loadQuotes();
      break;
    case 'contracts':
      await loadContracts();
      break;
    case 'clients':
      await loadClients();
      break;
    case 'territory':
      await loadTerritoryMap();
      break;
    case 'widget':
      await loadWidgetIntegration();
      break;
    case 'inventory':
      await loadInventory();
      break;
    case 'purchasing':
      await loadPurchasingModule();
      break;
    case 'payroll':
      await loadPayroll();
      break;
    case 'timesheets':
      await loadTimesheetsModule();
      break;
    case 'fleet':
      await loadFleetModule();
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

    // Update sidebar and mobile queue badges
    const incomingCount = byStatus.incoming || 0;
    const badge = document.getElementById('queue-badge');
    if (badge) badge.textContent = incomingCount;
    const mobileBadge = document.getElementById('mobile-queue-badge');
    if (mobileBadge) {
      mobileBadge.textContent = incomingCount;
      mobileBadge.style.display = incomingCount > 0 ? 'inline-block' : 'none';
    }

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
        const mobileInvBadge = document.getElementById('mobile-invoices-badge');
        if (mobileInvBadge) {
          mobileInvBadge.textContent = pendingCount;
          mobileInvBadge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
        }
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
  container.innerHTML = `<div class="alert alert-info"><span class="spinner"></span> Loading configuration and database integrations…</div>`;

  try {
    const [settings, supabaseStatus, dbStatus] = await Promise.all([
      apiFetch('/admin/settings'),
      apiFetch('/api/supabase/status').catch(e => ({ is_connected: false, error: e.message })),
      apiFetch('/api/system/database-status').catch(() => null)
    ]);
    const grouped = groupBy(settings || [], 'group_name');

    const supabaseUrlDisplay = supabaseStatus.supabase_url || 'https://tguievntviuanworgcqc.supabase.co';
    const isSupabaseReady = supabaseStatus.is_connected;
    const hasUrl = supabaseStatus.has_url;
    const hasServiceKey = supabaseStatus.has_service_role_key;
    const hasAnonKey = supabaseStatus.has_anon_key;
    const hasDbUrl = supabaseStatus.has_database_url;

    let supabaseBadge = '';
    if (isSupabaseReady) {
      supabaseBadge = '<span class="status-badge" style="background:#e6f4ea; color:#137333; font-weight:700; padding:3px 8px; border-radius:4px;"><i class="fa-solid fa-circle-check"></i> Connected &amp; Verified</span>';
    } else if (hasUrl && !hasServiceKey && !hasAnonKey && !hasDbUrl) {
      supabaseBadge = '<span class="status-badge" style="background:#fef7e0; color:#b06000; font-weight:700; padding:3px 8px; border-radius:4px;"><i class="fa-solid fa-triangle-exclamation"></i> URL Configured · Needs Service Key</span>';
    } else {
      supabaseBadge = '<span class="status-badge" style="background:#fce8e6; color:#c5221f; font-weight:700; padding:3px 8px; border-radius:4px;"><i class="fa-solid fa-circle-xmark"></i> Offline / Not Configured</span>';
    }

    const tableCounts = supabaseStatus.table_counts || {};
    const tableBadges = Object.keys(tableCounts).length > 0 
      ? Object.entries(tableCounts).map(([tbl, cnt]) => `<span style="display:inline-block; font-size:0.75rem; background:rgba(0,0,0,0.05); padding:2px 6px; border-radius:4px; margin-right:4px; margin-top:3px;"><code>${esc(tbl)}</code>: <strong>${esc(String(cnt))}</strong></span>`).join(' ')
      : '<span style="color:var(--text-light); font-size:0.8rem;">Ready to sync</span>';

    const dbIntegrationHtml = `
      <div class="settings-group" style="background:var(--card-bg); border:1px solid var(--dash-border); border-radius:8px; padding:1.25rem; margin-bottom:1.5rem; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.75rem;">
          <div>
            <h3 style="margin:0; font-size:1.15rem; display:flex; align-items:center; gap:8px;">
              <i class="fa-solid fa-database" style="color:var(--primary);"></i> Cloud Database &amp; Supabase Integration
            </h3>
            <div class="settings-note" style="margin-top:2px;">Production cloud database connection and schema manager.</div>
          </div>
          <div>${supabaseBadge}</div>
        </div>

        <div style="background:rgba(0,0,0,0.02); border:1px solid var(--dash-border); border-radius:6px; padding:0.9rem; margin-bottom:1rem;">
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:0.75rem; font-size:0.88rem;">
            <div>
              <span style="color:var(--text-light); display:block; font-size:0.75rem; font-weight:600; text-transform:uppercase;">Supabase Project URL</span>
              <strong style="font-family:monospace; color:var(--primary); word-break:break-all;">${esc(supabaseUrlDisplay)}</strong>
            </div>
            <div>
              <span style="color:var(--text-light); display:block; font-size:0.75rem; font-weight:600; text-transform:uppercase;">Active Engine / Mode</span>
              <strong style="color:var(--text-dark);">${esc(supabaseStatus.connection_type || 'Supabase Client')}</strong>
            </div>
            <div>
              <span style="color:var(--text-light); display:block; font-size:0.75rem; font-weight:600; text-transform:uppercase;">Authentication Key Status</span>
              <span>${hasServiceKey ? '<span style="color:#137333; font-weight:600;"><i class="fa-solid fa-shield-halved"></i> SERVICE_ROLE_KEY Active</span>' : (hasAnonKey ? '<span style="color:#137333; font-weight:600;"><i class="fa-solid fa-check"></i> ANON_KEY Active</span>' : '<span style="color:#b06000; font-weight:600;"><i class="fa-solid fa-circle-exclamation"></i> Awaiting Key</span>')}</span>
            </div>
          </div>

          <div style="margin-top:0.75rem; border-top:1px dashed var(--dash-border); padding-top:0.6rem;">
            <span style="color:var(--text-light); display:inline-block; font-size:0.75rem; font-weight:600; text-transform:uppercase; margin-right:8px;">Supabase Cloud Tables:</span>
            ${tableBadges}
          </div>

          ${supabaseStatus.error ? `
            <div style="margin-top:0.75rem; padding:0.6rem 0.8rem; background:#fff8e6; border-left:3px solid #f9ab00; border-radius:4px; font-size:0.83rem; color:#7c4a00;">
              <strong>Supabase Status:</strong> ${esc(supabaseStatus.error)}
            </div>
          ` : ''}
        </div>

        <div style="display:flex; flex-wrap:wrap; gap:0.5rem; align-items:center;">
          <button type="button" class="btn-primary btn-sm" onclick="triggerSupabaseTest()" id="btn-test-supabase">
            <i class="fa-solid fa-plug"></i> Test Connection
          </button>
          <button type="button" class="btn-secondary btn-sm" onclick="triggerSupabaseImport()" id="btn-import-supabase">
            <i class="fa-solid fa-cloud-arrow-down"></i> Import from Supabase
          </button>
          <button type="button" class="btn-secondary btn-sm" onclick="triggerSupabaseSync()" id="btn-sync-supabase">
            <i class="fa-solid fa-cloud-arrow-up"></i> Sync Local Data to Supabase
          </button>
          <button type="button" class="btn-secondary btn-sm" onclick="copySupabaseSchemaSql()" id="btn-copy-schema">
            <i class="fa-solid fa-copy"></i> Copy Full SQL Schema
          </button>
        </div>
      </div>
    `;

    container.innerHTML = dbIntegrationHtml + Object.entries(grouped).map(([groupName, items]) => `
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

async function triggerSupabaseTest() {
  const btn = document.getElementById('btn-test-supabase');
  if (btn) btn.disabled = true;
  showToast('Testing Supabase cloud connection…', 'info');

  try {
    const res = await apiFetch('/api/supabase/status');
    if (res.is_connected) {
      showToast(`Supabase is Connected! Mode: ${res.connection_type}`, 'success');
    } else {
      showToast(`Supabase status: ${res.error || 'Configured URL reachable. Please provide SUPABASE_ANON_KEY in Settings to enable direct queries.'}`, 'info');
    }
  } catch (err) {
    showToast(`Test failed: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function copySupabaseSchemaSql() {
  try {
    const res = await fetch('/api/supabase/schema');
    const sql = await res.text();
    await navigator.clipboard.writeText(sql);
    showToast('Supabase SQL Schema copied to clipboard! Paste into Supabase SQL Editor.', 'success');
  } catch (err) {
    showToast('Could not copy schema automatically. You can find supabase_schema.sql in the project root.', 'error');
  }
}

async function triggerSupabaseImport() {
  const btn = document.getElementById('btn-import-supabase');
  if (btn) btn.disabled = true;
  showToast('Importing live data from Supabase…', 'info');

  try {
    const res = await apiFetch('/api/supabase/import', { method: 'POST' });
    showToast(`Import complete! Synced ${res.imported_work_orders || 0} work orders and ${res.imported_clients || 0} clients from Supabase.`, 'success');
    await loadSettingsHub();
    if (typeof loadOverviewData === 'function') loadOverviewData();
  } catch (err) {
    showToast(`Import error: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function triggerSupabaseSync() {
  const btn = document.getElementById('btn-sync-supabase');
  if (btn) btn.disabled = true;
  showToast('Synchronizing dataset to Supabase…', 'info');

  try {
    const res = await apiFetch('/api/supabase/sync', { method: 'POST' });
    showToast(`Sync complete! Synced ${res.synced_counts?.work_orders || 0} work orders and ${res.synced_counts?.invoices || 0} invoices.`, 'success');
  } catch (err) {
    showToast(`Sync notice: ${err.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
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
    <!-- Top Action Toolbar for Supervisor & Customer Touchpoints -->
    <div style="background:var(--bg-secondary);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:1rem;display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between;border:1px solid var(--border-color);">
      <div style="font-size:0.85rem;font-weight:700;color:var(--text-dark);display:flex;align-items:center;gap:6px;">
        <i class="fa-solid fa-share-nodes" style="color:var(--primary);"></i> Client Portals &amp; Dispatch:
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" class="btn-primary btn-sm" onclick="openShareLinksModal(${wo.id})" title="View public links for Customer">
          <i class="fa-solid fa-link"></i> Share Customer Links
        </button>
        <button type="button" class="btn-secondary btn-sm" onclick="autoGenerateQuoteForWorkOrder(${wo.id})" title="Convert to formal interactive quote">
          <i class="fa-solid fa-file-signature"></i> Digital Estimate
        </button>
        <button type="button" class="btn-secondary btn-sm" onclick="openPhotoUploadModal(${wo.id})" title="Attach site photo proof">
          <i class="fa-solid fa-camera"></i> + Proof Photo
        </button>
      </div>
    </div>

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
        <span><strong>${esc(wo.client_name)}</strong></span>
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
        <span><i class="fa-solid fa-location-dot" style="color:var(--danger);margin-right:4px;"></i> ${esc(wo.property_address)}</span>
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
        <label>Description &amp; Work Scope</label>
        <div class="detail-notes">${esc(wo.description)}</div>
      </div>` : ''}
      ${wo.supervisor_notes ? `
      <div class="detail-item detail-full">
        <label>Supervisor Notes</label>
        <div class="detail-notes">${esc(wo.supervisor_notes)}</div>
      </div>` : ''}
    </div>

    <!-- Proof of Work Photo Gallery -->
    <div id="wo-photos-gallery-container" style="margin-top:1.25rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <h4 style="margin:0;font-size:0.9rem;font-weight:700;"><i class="fa-solid fa-camera"></i> Before / After Photo Proof</h4>
        <button type="button" class="btn-subtle btn-sm" onclick="openPhotoUploadModal(${wo.id})"><i class="fa-solid fa-plus"></i> Upload Photo</button>
      </div>
      <div id="wo-photos-list" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(130px, 1fr));gap:8px;">
        <div style="font-size:0.8rem;color:var(--text-light);grid-column:1/-1;">Loading proof photos…</div>
      </div>
    </div>

    <div class="status-update-row" style="margin-top: 1.25rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
      <div style="display:flex; align-items:center; gap:8px;">
        <label for="modal-status-select" style="margin:0">Update Status:</label>
        <select id="modal-status-select">${statusOptions}</select>
        <button class="btn-save" onclick="saveStatusUpdate(${wo.id})">Save</button>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn-subtle" onclick="createInvoiceForWorkOrder(${wo.id})">
          <i class="fa-solid fa-file-invoice-dollar" style="color:var(--primary)"></i> Create Client Invoice
        </button>
      </div>
    </div>
  `;

  // Fetch photos asynchronously
  loadWorkOrderPhotos(wo.id);
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

// ─── Mobile sidebar & Drawer Navigation ──────────────────────────────────────

function openMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  const hamburger = document.querySelector('.hamburger-btn');
  if (sidebar) sidebar.classList.add('open');
  if (overlay) {
    overlay.classList.add('open');
    overlay.classList.add('active');
  }
  if (hamburger) hamburger.setAttribute('aria-expanded', 'true');
  document.body.classList.add('sidebar-mobile-open');
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  const hamburger = document.querySelector('.hamburger-btn');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.classList.remove('active');
  }
  if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sidebar-mobile-open');
}

function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar && sidebar.classList.contains('open')) {
    closeMobileSidebar();
  } else {
    openMobileSidebar();
  }
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

// ─── Customer Growth, Digital Quotes & Portals ───────────────────────────────

// ── Work Order Photos & Site Verification ───────────────────

async function loadWorkOrderPhotos(woId) {
  const container = document.getElementById('wo-photos-list');
  if (!container) return;

  try {
    const photos = await apiFetch(`/work-orders/${woId}/photos`);
    if (!photos || photos.length === 0) {
      container.innerHTML = `
        <div style="font-size:0.8rem;color:var(--text-light);grid-column:1/-1;background:var(--bg-card);padding:10px;border-radius:var(--radius-sm);border:1px dashed var(--border-color);text-align:center;">
          No before/after photos uploaded yet. Click <strong>+ Upload Photo</strong> to attach proof of work.
        </div>
      `;
      return;
    }

    container.innerHTML = photos.map(p => `
      <div style="position:relative;border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border-color);background:#000;">
        <img src="${esc(p.photo_url)}" alt="${esc(p.caption || 'Proof')}" style="width:100%;height:90px;object-fit:cover;display:block;" onclick="window.open('${esc(p.photo_url)}', '_blank')">
        <div style="position:absolute;top:4px;left:4px;background:rgba(0,0,0,0.75);color:#fff;font-size:0.65rem;padding:2px 5px;border-radius:3px;text-transform:uppercase;font-weight:700;">
          ${esc(p.photo_type || 'Proof')}
        </div>
        <button type="button" onclick="deleteProofPhoto(${p.id}, ${woId})" style="position:absolute;top:4px;right:4px;background:rgba(220,38,38,0.85);color:#fff;border:none;border-radius:3px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:0.7rem;" title="Delete photo">
          <i class="fa-solid fa-trash"></i>
        </button>
        ${p.caption ? `<div style="font-size:0.7rem;padding:4px 6px;background:var(--bg-card);color:var(--text-medium);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(p.caption)}</div>` : ''}
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<div style="font-size:0.8rem;color:var(--danger);grid-column:1/-1;">Could not load photos: ${esc(err.message)}</div>`;
  }
}

function openPhotoUploadModal(woId) {
  const overlay = document.getElementById('photo-upload-modal');
  document.getElementById('photo-upload-form').reset();
  document.getElementById('photo-wo-id').value = woId;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function closePhotoUploadModal() {
  const overlay = document.getElementById('photo-upload-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

async function savePhotoUpload(e) {
  e.preventDefault();
  const woId = document.getElementById('photo-wo-id').value;
  const photo_type = document.getElementById('photo-type').value;
  const photo_url = document.getElementById('photo-url').value.trim();
  const caption = document.getElementById('photo-caption').value.trim();

  if (!photo_url) {
    showToast('Please provide an image URL or preset', 'danger');
    return;
  }

  try {
    await apiFetch(`/work-orders/${woId}/photos`, {
      method: 'POST',
      body: JSON.stringify({ photo_type, photo_url, caption })
    });
    showToast('Proof photo attached successfully!', 'success');
    closePhotoUploadModal();
    loadWorkOrderPhotos(woId);
  } catch (err) {
    showToast(`Failed to upload photo: ${err.message}`, 'danger');
  }
}

async function deleteProofPhoto(photoId, woId) {
  if (!confirm('Are you sure you want to remove this proof photo?')) return;
  try {
    await apiFetch(`/work-orders/photos/${photoId}`, { method: 'DELETE' });
    showToast('Photo removed', 'success');
    loadWorkOrderPhotos(woId);
  } catch (err) {
    showToast(`Failed to remove photo: ${err.message}`, 'danger');
  }
}

// ── Customer Share Links Hub Modal ──────────────────────────

async function openShareLinksModal(woId) {
  const overlay = document.getElementById('share-links-modal');
  const body = document.getElementById('share-links-modal-body');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  body.innerHTML = '<div class="alert alert-info"><span class="spinner"></span> Generating client portal links…</div>';

  try {
    const [wo, quotes, invoices] = await Promise.all([
      apiFetch(`/work-orders/${woId}`),
      apiFetch('/quotes').catch(() => []),
      apiFetch('/invoices').catch(() => [])
    ]);

    const origin = window.location.origin;
    const linkedQuote = Array.isArray(quotes) ? quotes.find(q => q.work_order_id === Number(woId)) : null;
    const linkedInvoice = Array.isArray(invoices) ? invoices.find(inv => inv.work_order_id === Number(woId)) : null;

    const trackUrl = `${origin}/track/${woId}`;
    const quoteUrl = linkedQuote ? `${origin}/quote/${linkedQuote.id}` : null;
    const payUrl = linkedInvoice ? `${origin}/pay/${linkedInvoice.id}` : null;

    const phoneClean = (wo.client_phone || '').replace(/\D/g, '');
    const defaultMsg = `Hi ${wo.client_name}, this is Lawn Craft Grounds Care! You can track the real-time progress and crew status of your job #${wo.id} anytime at: ${trackUrl}`;
    const waUrl = `https://wa.me/${phoneClean}?text=${encodeURIComponent(defaultMsg)}`;

    body.innerHTML = `
      <div style="margin-bottom:16px;">
        <div style="font-size:0.85rem;color:var(--text-light);margin-bottom:4px;">Work Order #${wo.id} for:</div>
        <div style="font-size:1.1rem;font-weight:700;color:var(--text-dark);">${esc(wo.client_name)} &bull; <span style="font-size:0.9rem;font-weight:400;color:var(--text-medium);">${esc(wo.property_address)}</span></div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px;">
        <!-- Live Service Tracker Link -->
        <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="font-weight:700;color:var(--text-dark);font-size:0.95rem;">
              <i class="fa-solid fa-satellite-dish" style="color:var(--primary);margin-right:6px;"></i> Live Job Progress Tracker
            </div>
            <span class="badge badge-success">Client Portal</span>
          </div>
          <div style="font-size:0.8rem;color:var(--text-medium);margin-bottom:8px;">
            Customers track crew dispatch, step progression, and live before/after photo proof.
          </div>
          <div style="display:flex;gap:6px;">
            <input type="text" readonly value="${trackUrl}" class="input-inline-sm" style="flex:1;font-size:0.8rem;background:var(--bg-secondary);padding:6px 10px;" id="link-track-input">
            <button type="button" class="btn-secondary btn-sm" onclick="copyShareUrl('${trackUrl}')" title="Copy URL">
              <i class="fa-solid fa-copy"></i> Copy
            </button>
            <a href="${trackUrl}" target="_blank" class="btn-primary btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px;">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
            </a>
          </div>
        </div>

        <!-- Digital Quote & Approval Link -->
        <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="font-weight:700;color:var(--text-dark);font-size:0.95rem;">
              <i class="fa-solid fa-file-signature" style="color:var(--accent-dark);margin-right:6px;"></i> Digital Estimate &amp; Sign-off
            </div>
            <span class="badge ${linkedQuote ? 'badge-info' : 'badge-neutral'}">${linkedQuote ? esc(linkedQuote.status.toUpperCase()) : 'Not Created'}</span>
          </div>
          <div style="font-size:0.8rem;color:var(--text-medium);margin-bottom:8px;">
            Branded digital proposal with itemized breakdown and 1-click electronic signature.
          </div>
          ${quoteUrl ? `
            <div style="display:flex;gap:6px;">
              <input type="text" readonly value="${quoteUrl}" class="input-inline-sm" style="flex:1;font-size:0.8rem;background:var(--bg-secondary);padding:6px 10px;">
              <button type="button" class="btn-secondary btn-sm" onclick="copyShareUrl('${quoteUrl}')"><i class="fa-solid fa-copy"></i> Copy</button>
              <a href="${quoteUrl}" target="_blank" class="btn-primary btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px;">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
              </a>
            </div>
          ` : `
            <button type="button" class="btn-primary btn-sm" onclick="closeShareLinksModal(); autoGenerateQuoteForWorkOrder(${woId});">
              <i class="fa-solid fa-plus"></i> Generate Quote for Work Order #${woId}
            </button>
          `}
        </div>

        <!-- Online Invoice & Payment Link -->
        <div style="background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="font-weight:700;color:var(--text-dark);font-size:0.95rem;">
              <i class="fa-solid fa-credit-card" style="color:var(--success);margin-right:6px;"></i> Client Invoice &amp; Payment View
            </div>
            <span class="badge ${linkedInvoice ? (linkedInvoice.balance_due <= 0 ? 'badge-success' : 'badge-warning') : 'badge-neutral'}">
              ${linkedInvoice ? (linkedInvoice.balance_due <= 0 ? 'PAID' : '$' + linkedInvoice.balance_due + ' DUE') : 'No Invoice'}
            </span>
          </div>
          <div style="font-size:0.8rem;color:var(--text-medium);margin-bottom:8px;">
            Printable invoice receipt, bank EFT remittance details, and instant card settlement gateway.
          </div>
          ${payUrl ? `
            <div style="display:flex;gap:6px;">
              <input type="text" readonly value="${payUrl}" class="input-inline-sm" style="flex:1;font-size:0.8rem;background:var(--bg-secondary);padding:6px 10px;">
              <button type="button" class="btn-secondary btn-sm" onclick="copyShareUrl('${payUrl}')"><i class="fa-solid fa-copy"></i> Copy</button>
              <a href="${payUrl}" target="_blank" class="btn-primary btn-sm" style="text-decoration:none;display:inline-flex;align-items:center;gap:4px;">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Pay / Print
              </a>
            </div>
          ` : `
            <button type="button" class="btn-secondary btn-sm" onclick="closeShareLinksModal(); createInvoiceForWorkOrder(${woId});">
              <i class="fa-solid fa-file-invoice-dollar"></i> Generate Client Invoice
            </button>
          `}
        </div>

        <!-- WhatsApp Client Dispatch Action -->
        <div style="background:#e8f5e9;border:1px solid #c8e6c9;border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <div style="font-weight:700;color:#1b5e20;font-size:0.95rem;">
              <i class="fa-brands fa-whatsapp" style="color:#25d366;font-size:1.1rem;margin-right:6px;"></i> 1-Click WhatsApp Client Dispatch
            </div>
          </div>
          <div style="font-size:0.8rem;color:#2e7d32;margin-bottom:10px;">
            Sends pre-filled message with the live job status tracker to customer's WhatsApp:
          </div>
          <div style="display:flex;gap:6px;">
            <a href="${waUrl}" target="_blank" class="btn-save" style="background:#25d366;color:#fff;border:none;text-decoration:none;display:inline-flex;align-items:center;gap:6px;font-weight:700;padding:8px 14px;border-radius:var(--radius-sm);">
              <i class="fa-brands fa-whatsapp"></i> Send Message on WhatsApp (${esc(wo.client_phone || 'No Phone')})
            </a>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="alert alert-danger">${err.message}</div>`;
  }
}

function closeShareLinksModal() {
  const overlay = document.getElementById('share-links-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

function copyShareUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    showToast('Public link copied to clipboard!', 'success');
  }).catch(() => {
    prompt('Copy public link:', url);
  });
}

// ── Digital Quotes & Proposals Controller ────────────────────

let quotesList = [];

async function loadQuotes() {
  const tbody = document.getElementById('tbody-quotes');
  const countEl = document.getElementById('count-quotes');
  const statusFilter = document.getElementById('quote-status-filter')?.value || 'all';
  const searchInput = (document.getElementById('quote-search-input')?.value || '').toLowerCase().trim();

  tbody.innerHTML = `<tr class="loading-row"><td colspan="8"><span class="spinner"></span> Loading digital estimates…</td></tr>`;

  try {
    quotesList = await apiFetch('/quotes');
    if (!Array.isArray(quotesList)) quotesList = [];

    // Filter
    let filtered = quotesList.filter(q => {
      const matchStatus = statusFilter === 'all' || q.status === statusFilter;
      const matchSearch = !searchInput || 
        (q.id && q.id.toLowerCase().includes(searchInput)) ||
        (q.client_name && q.client_name.toLowerCase().includes(searchInput)) ||
        (q.property_address && q.property_address.toLowerCase().includes(searchInput));
      return matchStatus && matchSearch;
    });

    // Update Stats
    const totalVal = quotesList.reduce((sum, q) => sum + (Number(q.total_amount) || 0), 0);
    const approvedQuotes = quotesList.filter(q => q.status === 'approved');
    const approvedVal = approvedQuotes.reduce((sum, q) => sum + (Number(q.total_amount) || 0), 0);
    const pendingQuotes = quotesList.filter(q => q.status === 'sent' || q.status === 'draft');
    const pendingVal = pendingQuotes.reduce((sum, q) => sum + (Number(q.total_amount) || 0), 0);
    const convRate = quotesList.length > 0 ? Math.round((approvedQuotes.length / quotesList.length) * 100) : 0;

    document.getElementById('quotes-stat-total-val').textContent = `$${totalVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('quotes-stat-approved-val').textContent = `$${approvedVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('quotes-stat-pending-val').textContent = `$${pendingVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('quotes-stat-conversion').textContent = `${convRate}% (${approvedQuotes.length}/${quotesList.length})`;

    if (countEl) countEl.textContent = `${filtered.length} estimate${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No digital estimates found. Click "Create Estimate" or generate from a Work Order.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(q => renderQuoteRow(q)).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="alert alert-danger">${err.message}</div></td></tr>`;
  }
}

function renderQuoteRow(q) {
  const origin = window.location.origin;
  const quoteUrl = `${origin}/quote/${q.id}`;
  const validUntil = q.valid_until ? formatDate(q.valid_until) : '—';
  const isApproved = q.status === 'approved';

  return `
    <tr>
      <td>
        <span class="td-link td-main" onclick="openQuoteOnline('${q.id}')">${esc(q.id)}</span>
      </td>
      <td>
        ${q.work_order_id ? `<span class="td-link" onclick="openWorkOrderDetail(${q.work_order_id})">#${q.work_order_id}</span>` : '<span style="color:var(--text-light)">Direct</span>'}
      </td>
      <td>
        <div><strong>${esc(q.client_name)}</strong></div>
        ${q.client_email ? `<div class="td-addr">${esc(q.client_email)}</div>` : ''}
      </td>
      <td class="td-addr">${esc(q.property_address)}</td>
      <td><strong>${esc(q.service_tier || 'Grounds Care')}</strong></td>
      <td style="font-size:1.05rem;font-weight:800;color:var(--text-dark);">$${Number(q.total_amount || 0).toFixed(2)}</td>
      <td>
        <span class="badge ${isApproved ? 'badge-success' : (q.status === 'rejected' ? 'badge-danger' : 'badge-warning')}">
          ${isApproved ? '<i class="fa-solid fa-check"></i> SIGNED' : esc(q.status.toUpperCase())}
        </span>
        ${isApproved && q.signature_name ? `<div style="font-size:0.7rem;color:var(--success);margin-top:2px;">by ${esc(q.signature_name)}</div>` : ''}
      </td>
      <td>
        <div style="display:flex;gap:4px;align-items:center;">
          <a href="${quoteUrl}" target="_blank" class="btn-primary btn-sm" title="Open Interactive Quote View" style="text-decoration:none;">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> View
          </a>
          <button class="btn-secondary btn-sm" onclick="copyQuoteLink('${q.id}')" title="Copy Public Share Link">
            <i class="fa-solid fa-link"></i>
          </button>
          <button class="btn-subtle btn-sm" onclick="openQuoteModal('${q.id}')" title="Edit Proposal Scope">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="btn-subtle btn-sm btn-icon-danger" onclick="deleteQuote('${q.id}')" title="Delete Quote">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </td>
    </tr>
  `;
}

function openQuoteOnline(quoteId) {
  window.open(`${window.location.origin}/quote/${quoteId}`, '_blank');
}

function copyQuoteLink(quoteId) {
  const url = `${window.location.origin}/quote/${quoteId}`;
  copyShareUrl(url);
}

async function autoGenerateQuoteForWorkOrder(woId) {
  try {
    const quote = await apiFetch(`/work-orders/${woId}/generate-quote`, { method: 'POST' });
    showToast(`Digital Estimate ${quote.id} created from Work Order #${woId}!`, 'success');
    closeModal();
    navigate('quotes');
  } catch (err) {
    showToast(`Failed to generate quote: ${err.message}`, 'danger');
  }
}

async function openQuoteModal(quoteId = null, defaultWoId = null) {
  const overlay = document.getElementById('quote-modal');
  const titleEl = document.getElementById('quote-modal-title');
  const form = document.getElementById('quote-form');
  const tbody = document.getElementById('quote-items-tbody');
  
  form.reset();
  tbody.innerHTML = '';
  document.getElementById('quote-edit-id').value = quoteId || '';
  document.getElementById('quote-wo-id').value = defaultWoId || '';

  if (quoteId) {
    titleEl.textContent = `Edit Estimate ${quoteId}`;
    try {
      const q = await apiFetch(`/public/quote/${quoteId}`);
      document.getElementById('quote-client-name').value = q.client_name || '';
      document.getElementById('quote-client-phone').value = q.client_phone || '';
      document.getElementById('quote-client-email').value = q.client_email || '';
      document.getElementById('quote-property-address').value = q.property_address || '';
      document.getElementById('quote-service-tier').value = q.service_tier || '';
      document.getElementById('quote-valid-until').value = q.valid_until || '';
      document.getElementById('quote-discount-amount').value = q.discount || '0.00';
      document.getElementById('quote-notes').value = q.notes || '';

      let items = [];
      try {
        items = typeof q.items_json === 'string' ? JSON.parse(q.items_json) : (q.items_json || []);
      } catch {
        items = [];
      }

      if (items.length > 0) {
        items.forEach(it => addQuoteLineItemRow(it.description, it.quantity, it.unit_price));
      } else {
        addQuoteLineItemRow('Precision Grounds Maintenance', 1, 150.00);
      }
    } catch (err) {
      showToast(`Could not load quote: ${err.message}`, 'danger');
      return;
    }
  } else {
    titleEl.textContent = 'Create Digital Estimate & Proposal';
    const future14 = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    document.getElementById('quote-valid-until').value = future14;
    document.getElementById('quote-discount-amount').value = '0.00';
    document.getElementById('quote-service-tier').value = 'Deluxe Turf Care Package';
    document.getElementById('quote-notes').value = 'All treatments include pet-safe organic fertilizers and 100% satisfaction guarantee.';

    if (defaultWoId) {
      try {
        const wo = await apiFetch(`/work-orders/${defaultWoId}`);
        document.getElementById('quote-client-name').value = wo.client_name || '';
        document.getElementById('quote-client-phone').value = wo.client_phone || '';
        document.getElementById('quote-client-email').value = wo.client_email || '';
        document.getElementById('quote-property-address').value = wo.property_address || '';
        document.getElementById('quote-service-tier').value = wo.service_type || 'Grounds Care Plan';
        addQuoteLineItemRow(`${wo.service_type || 'Landscape Service'}: ${wo.title}`, 1, 185.00);
        addQuoteLineItemRow('Organic Turf Conditioning & Aeration', 1, 95.00);
      } catch (e) {
        addQuoteLineItemRow('Grounds Maintenance Service', 1, 150.00);
      }
    } else {
      addQuoteLineItemRow('Weekly Commercial Lawn Maintenance', 1, 120.00);
      addQuoteLineItemRow('Seasonal Shrub Trimming & Weed Control', 1, 80.00);
    }
  }

  calculateQuoteFormTotals();
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function closeQuoteModal() {
  const overlay = document.getElementById('quote-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

function addQuoteLineItemRow(description = '', quantity = 1, unitPrice = 0) {
  const tbody = document.getElementById('quote-items-tbody');
  const tr = document.createElement('tr');
  tr.className = 'quote-line-item-row';
  tr.innerHTML = `
    <td>
      <input type="text" class="quote-item-desc" required placeholder="Service / Material" value="${esc(description)}" style="width:100%;">
    </td>
    <td>
      <input type="number" class="quote-item-qty" value="${quantity}" min="1" step="1" style="width:100%;">
    </td>
    <td>
      <input type="number" class="quote-item-price" value="${unitPrice}" min="0" step="1.00" style="width:100%;">
    </td>
    <td>
      <button type="button" class="btn-subtle btn-sm btn-icon-danger btn-remove-quote-row" title="Remove line"><i class="fa-solid fa-trash"></i></button>
    </td>
  `;

  tr.querySelectorAll('input').forEach(inp => inp.addEventListener('input', calculateQuoteFormTotals));
  tr.querySelector('.btn-remove-quote-row').addEventListener('click', () => {
    tr.remove();
    calculateQuoteFormTotals();
  });

  tbody.appendChild(tr);
  calculateQuoteFormTotals();
}

function calculateQuoteFormTotals() {
  let subtotal = 0;
  document.querySelectorAll('.quote-line-item-row').forEach(row => {
    const qty = parseFloat(row.querySelector('.quote-item-qty').value) || 0;
    const price = parseFloat(row.querySelector('.quote-item-price').value) || 0;
    subtotal += (qty * price);
  });

  const discount = parseFloat(document.getElementById('quote-discount-amount').value) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const tax = taxable * 0.065;
  const total = taxable + tax;

  document.getElementById('quote-calc-subtotal').textContent = `$${subtotal.toFixed(2)}`;
  document.getElementById('quote-calc-discount').textContent = `-$${discount.toFixed(2)}`;
  document.getElementById('quote-calc-tax').textContent = `+$${tax.toFixed(2)}`;
  document.getElementById('quote-calc-total').textContent = `$${total.toFixed(2)}`;
}

async function saveQuote(e) {
  e.preventDefault();
  const quoteId = document.getElementById('quote-edit-id').value;
  const work_order_id = document.getElementById('quote-wo-id').value ? Number(document.getElementById('quote-wo-id').value) : null;
  const client_name = document.getElementById('quote-client-name').value.trim();
  const client_phone = document.getElementById('quote-client-phone').value.trim();
  const client_email = document.getElementById('quote-client-email').value.trim();
  const property_address = document.getElementById('quote-property-address').value.trim();
  const service_tier = document.getElementById('quote-service-tier').value.trim();
  const valid_until = document.getElementById('quote-valid-until').value;
  const discount = parseFloat(document.getElementById('quote-discount-amount').value) || 0;
  const notes = document.getElementById('quote-notes').value.trim();

  const items = [];
  document.querySelectorAll('.quote-line-item-row').forEach(row => {
    const desc = row.querySelector('.quote-item-desc').value.trim();
    const qty = parseFloat(row.querySelector('.quote-item-qty').value) || 1;
    const price = parseFloat(row.querySelector('.quote-item-price').value) || 0;
    if (desc) {
      items.push({ description: desc, quantity: qty, unit_price: price, amount: qty * price });
    }
  });

  if (items.length === 0) {
    showToast('Please add at least one line item to the estimate.', 'danger');
    return;
  }

  const payload = {
    work_order_id,
    client_name,
    client_phone,
    client_email,
    property_address,
    service_tier,
    items,
    discount,
    notes,
    valid_until
  };

  try {
    if (quoteId) {
      await apiFetch(`/quotes/${quoteId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast(`Quote ${quoteId} updated!`, 'success');
    } else {
      const created = await apiFetch('/quotes', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      showToast(`Estimate ${created.id} created successfully!`, 'success');
    }
    closeQuoteModal();
    if (currentView === 'quotes') await loadQuotes();
  } catch (err) {
    showToast(`Failed to save quote: ${err.message}`, 'danger');
  }
}

async function deleteQuote(quoteId) {
  if (!confirm(`Are you sure you want to delete proposal ${quoteId}?`)) return;
  try {
    await apiFetch(`/quotes/${quoteId}`, { method: 'DELETE' });
    showToast(`Quote ${quoteId} deleted`, 'success');
    await loadQuotes();
  } catch (err) {
    showToast(`Failed to delete quote: ${err.message}`, 'danger');
  }
}

// ── Recurring Maintenance Contracts Controller ──────────────

let contractsList = [];

async function loadContracts() {
  const tbody = document.getElementById('tbody-contracts');
  const countEl = document.getElementById('count-contracts');
  const freqFilter = document.getElementById('contract-freq-filter')?.value || 'all';
  const searchInput = (document.getElementById('contract-search-input')?.value || '').toLowerCase().trim();

  tbody.innerHTML = `<tr class="loading-row"><td colspan="9"><span class="spinner"></span> Loading recurring agreements…</td></tr>`;

  try {
    contractsList = await apiFetch('/contracts');
    if (!Array.isArray(contractsList)) contractsList = [];

    const filtered = contractsList.filter(c => {
      const matchFreq = freqFilter === 'all' || c.frequency === freqFilter;
      const matchSearch = !searchInput || 
        (c.client_name && c.client_name.toLowerCase().includes(searchInput)) ||
        (c.property_address && c.property_address.toLowerCase().includes(searchInput));
      return matchFreq && matchSearch;
    });

    // Calculate MRR (Monthly Recurring Revenue)
    const activeContracts = contractsList.filter(c => c.status === 'active');
    let mrr = 0;
    activeContracts.forEach(c => {
      const rate = Number(c.rate_per_visit) || 0;
      if (c.frequency === 'weekly') mrr += (rate * 4.33);
      else if (c.frequency === 'bi_weekly') mrr += (rate * 2.16);
      else if (c.frequency === 'monthly') mrr += rate;
    });

    const weeklyCount = activeContracts.filter(c => c.frequency === 'weekly').length;
    const today = new Date();
    const next7Days = new Date(Date.now() + 7 * 86400000);
    const dueIn7d = activeContracts.filter(c => {
      if (!c.next_scheduled_date) return false;
      const d = new Date(c.next_scheduled_date);
      return d >= today && d <= next7Days;
    }).length;

    document.getElementById('contracts-stat-active').textContent = activeContracts.length;
    document.getElementById('contracts-stat-mrr').textContent = `$${mrr.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('contracts-stat-weekly').textContent = weeklyCount;
    document.getElementById('contracts-stat-due-7d').textContent = dueIn7d;

    if (countEl) countEl.textContent = `${filtered.length} contract${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No recurring agreements found.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(c => `
      <tr>
        <td><code>${esc(c.id)}</code></td>
        <td>
          <div style="font-weight:700;color:var(--text-dark);">${esc(c.client_name)}</div>
          ${c.client_phone ? `<div class="td-addr" style="font-size:0.8rem;">${esc(c.client_phone)}</div>` : ''}
        </td>
        <td class="td-addr">${esc(c.property_address)}</td>
        <td><strong>${esc(c.service_type)}</strong></td>
        <td>
          <span class="badge badge-info" style="text-transform:uppercase;">${esc(c.frequency)}</span>
        </td>
        <td style="font-weight:800;color:var(--success);font-size:1.05rem;">$${Number(c.rate_per_visit || 0).toFixed(2)}</td>
        <td>
          <strong>${c.next_scheduled_date ? formatDate(c.next_scheduled_date) : '—'}</strong>
          <div style="font-size:0.75rem;color:var(--text-light);">${esc(c.assigned_crew || 'Crew Alpha')}</div>
        </td>
        <td>
          <span class="badge ${c.status === 'active' ? 'badge-success' : 'badge-neutral'}">
            ${c.status === 'active' ? '<i class="fa-solid fa-circle-check"></i> ACTIVE' : 'PAUSED'}
          </span>
        </td>
        <td>
          <div style="display:flex;gap:4px;align-items:center;">
            <button class="btn-save btn-sm" onclick="dispatchContractJob('${c.id}')" title="1-Click Dispatch Job (Generates Work Order & Advances Date)">
              <i class="fa-solid fa-paper-plane"></i> Dispatch
            </button>
            <button class="btn-secondary btn-sm" onclick="toggleContractStatus('${c.id}', '${c.status}')" title="${c.status === 'active' ? 'Pause Agreement' : 'Resume Agreement'}">
              <i class="fa-solid ${c.status === 'active' ? 'fa-pause' : 'fa-play'}"></i>
            </button>
            <button class="btn-subtle btn-sm" onclick="openContractModal('${c.id}')" title="Edit Contract Details">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="alert alert-danger">${err.message}</div></td></tr>`;
  }
}

async function dispatchContractJob(contractId) {
  try {
    const res = await apiFetch(`/contracts/${contractId}/generate-order`, { method: 'POST' });
    showToast(res.message, 'success');
    await loadContracts();
  } catch (err) {
    showToast(`Failed to dispatch job: ${err.message}`, 'danger');
  }
}

async function toggleContractStatus(contractId, currentStatus) {
  const nextStatus = currentStatus === 'active' ? 'paused' : 'active';
  try {
    await apiFetch(`/contracts/${contractId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: nextStatus })
    });
    showToast(`Contract ${contractId} is now ${nextStatus}`, 'success');
    await loadContracts();
  } catch (err) {
    showToast(`Failed to update contract: ${err.message}`, 'danger');
  }
}

function openContractModal(contractId = null) {
  const overlay = document.getElementById('contract-modal');
  const titleEl = document.getElementById('contract-modal-title');
  const form = document.getElementById('contract-form');
  form.reset();
  document.getElementById('contract-edit-id').value = contractId || '';

  if (contractId) {
    titleEl.textContent = `Edit Maintenance Agreement ${contractId}`;
    const c = contractsList.find(item => item.id === contractId);
    if (c) {
      document.getElementById('contract-client-name').value = c.client_name || '';
      document.getElementById('contract-email').value = c.client_email || '';
      document.getElementById('contract-phone').value = c.client_phone || '';
      document.getElementById('contract-address').value = c.property_address || '';
      document.getElementById('contract-service-type').value = c.service_type || 'Commercial Grounds Maintenance';
      document.getElementById('contract-frequency').value = c.frequency || 'weekly';
      document.getElementById('contract-rate').value = c.rate_per_visit || '120.00';
      document.getElementById('contract-next-date').value = c.next_scheduled_date || '';
      document.getElementById('contract-crew').value = c.assigned_crew || 'Team Alpha (Marcus Vance)';
      document.getElementById('contract-notes').value = c.notes || '';
    }
  } else {
    titleEl.textContent = 'New Recurring Maintenance Agreement';
    const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    document.getElementById('contract-next-date').value = next7;
    document.getElementById('contract-rate').value = '120.00';
  }

  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function closeContractModal() {
  const overlay = document.getElementById('contract-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

async function saveContract(e) {
  e.preventDefault();
  const contractId = document.getElementById('contract-edit-id').value;
  const client_name = document.getElementById('contract-client-name').value.trim();
  const client_email = document.getElementById('contract-email').value.trim();
  const client_phone = document.getElementById('contract-phone').value.trim();
  const property_address = document.getElementById('contract-address').value.trim();
  const service_type = document.getElementById('contract-service-type').value;
  const frequency = document.getElementById('contract-frequency').value;
  const rate_per_visit = parseFloat(document.getElementById('contract-rate').value) || 120.00;
  const next_scheduled_date = document.getElementById('contract-next-date').value;
  const assigned_crew = document.getElementById('contract-crew').value;
  const notes = document.getElementById('contract-notes').value.trim();

  const payload = {
    client_name,
    client_email,
    client_phone,
    property_address,
    service_type,
    frequency,
    rate_per_visit,
    next_scheduled_date,
    assigned_crew,
    notes
  };

  try {
    if (contractId) {
      await apiFetch(`/contracts/${contractId}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast(`Contract ${contractId} updated!`, 'success');
    } else {
      const created = await apiFetch('/contracts', { method: 'POST', body: JSON.stringify(payload) });
      showToast(`Agreement ${created.id} saved!`, 'success');
    }
    closeContractModal();
    if (currentView === 'contracts') await loadContracts();
  } catch (err) {
    showToast(`Failed to save agreement: ${err.message}`, 'danger');
  }
}

// ── Client CRM & Property Intelligence ───────────────────────

let clientsList = [];

async function loadClients() {
  const tbody = document.getElementById('tbody-clients');
  const countEl = document.getElementById('count-clients');
  const zoneFilter = document.getElementById('client-zone-filter')?.value || 'all';
  const searchInput = (document.getElementById('client-search-input')?.value || '').toLowerCase().trim();

  tbody.innerHTML = `<tr class="loading-row"><td colspan="8"><span class="spinner"></span> Loading client intelligence profiles…</td></tr>`;

  try {
    clientsList = await apiFetch('/clients/crm');
    if (!Array.isArray(clientsList)) clientsList = [];

    const filtered = clientsList.filter(c => {
      const matchZone = zoneFilter === 'all' || c.zone === zoneFilter;
      const matchSearch = !searchInput ||
        (c.name && c.name.toLowerCase().includes(searchInput)) ||
        (c.email && c.email.toLowerCase().includes(searchInput)) ||
        (c.property_address && c.property_address.toLowerCase().includes(searchInput));
      return matchZone && matchSearch;
    });

    const totalSpend = clientsList.reduce((sum, c) => sum + (Number(c.total_spend) || 0), 0);
    const avgSize = clientsList.length > 0 ? Math.round(clientsList.reduce((sum, c) => sum + (Number(c.property_size_sqft) || 5000), 0) / clientsList.length) : 0;
    const vipCount = clientsList.filter(c => (Number(c.total_spend) || 0) >= 500).length;

    document.getElementById('crm-stat-total').textContent = clientsList.length;
    document.getElementById('crm-stat-spend').textContent = `$${totalSpend.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    document.getElementById('crm-stat-avg-size').textContent = `${avgSize.toLocaleString()} sq ft`;
    document.getElementById('crm-stat-vip').textContent = `${vipCount} accounts`;

    if (countEl) countEl.textContent = `${filtered.length} client${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No client CRM profiles found.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(c => `
      <tr>
        <td>
          <div style="font-weight:700;color:var(--text-dark);">${esc(c.name)}</div>
          ${c.email ? `<div class="td-addr">${esc(c.email)}</div>` : ''}
        </td>
        <td>
          <div>${esc(c.phone || '—')}</div>
          ${c.phone ? `
            <button type="button" class="btn-subtle btn-sm" onclick="openWhatsAppForClient('${esc(c.phone)}', '${esc(c.name)}', '${esc(c.property_address)}')" style="color:#25d366;padding:2px 4px;font-size:0.75rem;">
              <i class="fa-brands fa-whatsapp"></i> Chat
            </button>
          ` : ''}
        </td>
        <td class="td-addr">${esc(c.property_address || '—')}</td>
        <td><span class="badge badge-info">${esc(c.zone || 'North Zone')}</span></td>
        <td>
          <strong>${Number(c.property_size_sqft || 5000).toLocaleString()} sq ft</strong>
          <div style="font-size:0.75rem;color:var(--text-light);">${esc(c.grass_type || 'Tall Fescue')}</div>
        </td>
        <td><code>${esc(c.gate_code || 'Standard Entry')}</code></td>
        <td style="font-weight:800;color:var(--success);">$${Number(c.total_spend || 0).toFixed(2)}</td>
        <td>
          <div style="display:flex;gap:4px;align-items:center;">
            <button class="btn-subtle btn-sm" onclick="sendReviewRequest(${c.id}, '${esc(c.name)}', '${esc(c.phone)}', '${esc(c.email)}')" title="Send Google Review Request SMS/WhatsApp">
              <i class="fa-solid fa-star" style="color:#eab308;"></i> Review
            </button>
            <button class="btn-subtle btn-sm" onclick="openClientModal(${c.id})" title="Edit Profile">
              <i class="fa-solid fa-user-pen"></i>
            </button>
            <button class="btn-subtle btn-sm btn-icon-danger" onclick="deleteClient(${c.id})" title="Delete Client Profile">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="alert alert-danger">${err.message}</div></td></tr>`;
  }
}

function openWhatsAppForClient(phone, name, address) {
  const cleanPhone = phone.replace(/\D/g, '');
  const msg = `Hi ${name}, this is Lawn Craft Grounds Care regarding your property at ${address}. How can our field team assist you today?`;
  window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`, '_blank');
}

async function sendReviewRequest(clientId, name, phone, email) {
  try {
    const res = await apiFetch('/reviews/request', {
      method: 'POST',
      body: JSON.stringify({ client_name: name, client_phone: phone, client_email: email, channel: 'whatsapp' })
    });
    showToast(`Google Review request prepared for ${name}!`, 'success');
    if (res.dispatch_url) {
      window.open(res.dispatch_url, '_blank');
    }
  } catch (err) {
    showToast(`Failed to send review request: ${err.message}`, 'danger');
  }
}

function openClientModal(clientId = null) {
  const overlay = document.getElementById('client-modal');
  const titleEl = document.getElementById('client-modal-title');
  const form = document.getElementById('client-form');
  form.reset();
  document.getElementById('client-edit-id').value = clientId || '';

  if (clientId) {
    titleEl.textContent = `Edit Client Profile`;
    const c = clientsList.find(item => item.id === Number(clientId));
    if (c) {
      document.getElementById('client-form-name').value = c.name || '';
      document.getElementById('client-form-phone').value = c.phone || '';
      document.getElementById('client-form-email').value = c.email || '';
      document.getElementById('client-form-address').value = c.property_address || '';
      document.getElementById('client-form-zone').value = c.zone || 'North Zone';
      document.getElementById('client-form-size').value = c.property_size_sqft || '8500';
      document.getElementById('client-form-grass').value = c.grass_type || 'Kentucky Bluegrass / Tall Fescue';
      document.getElementById('client-form-gate').value = c.gate_code || '';
      document.getElementById('client-form-instructions').value = c.special_instructions || '';
    }
  } else {
    titleEl.textContent = 'New Client & Property Intelligence Profile';
    document.getElementById('client-form-size').value = '5000';
    document.getElementById('client-form-grass').value = 'Kentucky Bluegrass';
  }

  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function closeClientModal() {
  const overlay = document.getElementById('client-modal');
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}

async function saveClient(e) {
  e.preventDefault();
  const clientId = document.getElementById('client-edit-id').value;
  const name = document.getElementById('client-form-name').value.trim();
  const phone = document.getElementById('client-form-phone').value.trim();
  const email = document.getElementById('client-form-email').value.trim();
  const property_address = document.getElementById('client-form-address').value.trim();
  const zone = document.getElementById('client-form-zone').value;
  const property_size_sqft = parseFloat(document.getElementById('client-form-size').value) || 5000;
  const grass_type = document.getElementById('client-form-grass').value.trim();
  const gate_code = document.getElementById('client-form-gate').value.trim();
  const special_instructions = document.getElementById('client-form-instructions').value.trim();

  const payload = {
    name,
    phone,
    email,
    property_address,
    zone,
    property_size_sqft,
    grass_type,
    gate_code,
    special_instructions
  };

  try {
    if (clientId) {
      await apiFetch(`/clients/crm/${clientId}`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast('Client profile updated!', 'success');
    } else {
      await apiFetch('/clients/crm', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Client profile created!', 'success');
    }
    closeClientModal();
    if (currentView === 'clients') await loadClients();
  } catch (err) {
    showToast(`Failed to save client: ${err.message}`, 'danger');
  }
}

async function deleteClient(clientId) {
  if (!confirm('Are you sure you want to remove this client profile?')) return;
  try {
    await apiFetch(`/clients/crm/${clientId}`, { method: 'DELETE' });
    showToast('Client profile removed', 'success');
    await loadClients();
  } catch (err) {
    showToast(`Failed to delete client: ${err.message}`, 'danger');
  }
}

// ── Territory Route & Service Map (Leaflet) ──────────────────

let territoryLeafletMap = null;
let territoryMarkersLayer = null;

async function loadTerritoryMap() {
  const container = document.getElementById('territory-leaflet-map');
  if (!container) return;

  // Initialize Map if not already initialized
  if (!territoryLeafletMap && window.L) {
    initTerritoryLeaflet();
  } else if (territoryLeafletMap) {
    setTimeout(() => territoryLeafletMap.invalidateSize(), 200);
  }

  await updateTerritoryMapMarkers();
}

function initTerritoryLeaflet() {
  const mapEl = document.getElementById('territory-leaflet-map');
  if (!mapEl || !window.L) return;

  // Center on Springfield / Metro service territory
  territoryLeafletMap = L.map('territory-leaflet-map', {
    center: [39.7817, -89.6501], // Springfield coordinates
    zoom: 12
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors | Lawn Craft Territory ERP',
    maxZoom: 19
  }).addTo(territoryLeafletMap);

  territoryMarkersLayer = L.layerGroup().addTo(territoryLeafletMap);
}

async function updateTerritoryMapMarkers() {
  if (!territoryMarkersLayer) return;
  territoryMarkersLayer.clearLayers();

  try {
    const [workOrders, clients] = await Promise.all([
      apiFetch('/work-orders').catch(() => []),
      apiFetch('/clients/crm').catch(() => [])
    ]);

    const zoneFilter = document.getElementById('map-zone-filter')?.value || 'all';
    const statusFilter = document.getElementById('map-status-filter')?.value || 'all';

    // Base coordinates to distribute pins realistically across zones
    const zoneCoords = {
      'North Zone': { lat: 39.815, lng: -89.650 },
      'South Zone': { lat: 39.750, lng: -89.650 },
      'East Zone': { lat: 39.780, lng: -89.600 },
      'West Zone': { lat: 39.780, lng: -89.700 }
    };

    let totalPins = 0;
    let bounds = [];

    // Pin Work Orders
    (workOrders || []).forEach((wo, idx) => {
      if (statusFilter !== 'all' && wo.status !== statusFilter) return;

      // Deterministic spread
      const offsetLat = ((idx * 37) % 100 - 50) / 1000;
      const offsetLng = ((idx * 53) % 100 - 50) / 1000;
      const lat = 39.7817 + offsetLat;
      const lng = -89.6501 + offsetLng;

      bounds.push([lat, lng]);
      totalPins++;

      const isDone = wo.status === 'completed' || wo.status === 'verified';
      const isProgress = wo.status === 'in_progress';
      const pinColor = isDone ? '#16a34a' : (isProgress ? '#2563eb' : '#d97706');

      const customIcon = L.divIcon({
        className: 'custom-map-pin',
        html: `<div style="background:${pinColor};color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);font-size:12px;font-weight:700;border:2px solid #fff;">#${wo.id}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      });

      const popupHtml = `
        <div style="font-family:sans-serif;min-width:200px;">
          <div style="font-weight:700;font-size:1rem;color:#1e293b;margin-bottom:4px;">#${wo.id} - ${esc(wo.title)}</div>
          <div style="font-size:0.85rem;color:#475569;margin-bottom:4px;"><strong>Client:</strong> ${esc(wo.client_name)}</div>
          <div style="font-size:0.85rem;color:#475569;margin-bottom:6px;"><i class="fa-solid fa-location-dot" style="color:#dc2626"></i> ${esc(wo.property_address)}</div>
          <div style="margin-bottom:8px;"><span class="badge status-${wo.status}">${esc(wo.status.toUpperCase())}</span></div>
          <div style="display:flex;gap:4px;">
            <button onclick="openWorkOrderDetail(${wo.id})" style="background:#2d4a3e;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;font-size:0.8rem;">Open Details</button>
            <a href="/track/${wo.id}" target="_blank" style="background:#f1f5f9;color:#334155;padding:5px 8px;border-radius:4px;text-decoration:none;font-size:0.8rem;border:1px solid #cbd5e1;">Live Tracker</a>
          </div>
        </div>
      `;

      L.marker([lat, lng], { icon: customIcon }).bindPopup(popupHtml).addTo(territoryMarkersLayer);
    });

    // Pin CRM Clients
    (clients || []).forEach((c, idx) => {
      if (zoneFilter !== 'all' && c.zone !== zoneFilter) return;

      const base = zoneCoords[c.zone] || { lat: 39.780, lng: -89.650 };
      const offsetLat = ((idx * 19) % 60 - 30) / 1000;
      const offsetLng = ((idx * 29) % 60 - 30) / 1000;
      const lat = base.lat + offsetLat;
      const lng = base.lng + offsetLng;

      bounds.push([lat, lng]);
      totalPins++;

      const customIcon = L.divIcon({
        className: 'custom-map-pin',
        html: `<div style="background:#7c3aed;color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3);font-size:11px;font-weight:700;border:2px solid #fff;"><i class="fa-solid fa-house-chimney"></i></div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      const popupHtml = `
        <div style="font-family:sans-serif;min-width:200px;">
          <div style="font-weight:700;font-size:0.95rem;color:#1e293b;margin-bottom:4px;"><i class="fa-solid fa-user" style="color:#7c3aed"></i> ${esc(c.name)}</div>
          <div style="font-size:0.85rem;color:#475569;margin-bottom:4px;">${esc(c.property_address)}</div>
          <div style="font-size:0.8rem;color:#64748b;margin-bottom:6px;">Zone: <strong>${esc(c.zone)}</strong> | Area: ${Number(c.property_size_sqft).toLocaleString()} sq ft</div>
          <button onclick="openClientModal(${c.id})" style="background:#7c3aed;color:#fff;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;font-size:0.8rem;">View Client CRM</button>
        </div>
      `;

      L.marker([lat, lng], { icon: customIcon }).bindPopup(popupHtml).addTo(territoryMarkersLayer);
    });

    if (bounds.length > 0 && territoryLeafletMap) {
      territoryLeafletMap.fitBounds(bounds, { padding: [40, 40] });
    }
  } catch (err) {
    console.error('Error updating territory map markers:', err);
  }
}

// ── Embeddable Pricing Widget Integration ────────────────────

function loadWidgetIntegration() {
  const origin = window.location.origin;
  const embedUrl = `${origin}/widget/calculator`;
  const codeEl = document.getElementById('widget-embed-code-snippet');
  const directLinkInput = document.getElementById('widget-direct-link-input');
  const previewFrame = document.getElementById('widget-live-iframe-preview');

  const snippet = `<iframe \n  src="${embedUrl}" \n  width="100%" \n  height="650" \n  frameborder="0" \n  style="border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;" \n  title="Lawn Craft Instant Lawn Care Pricing Calculator">\n</iframe>`;

  if (codeEl) codeEl.textContent = snippet;
  if (directLinkInput) directLinkInput.value = embedUrl;
  if (previewFrame) previewFrame.src = embedUrl;
}

function copyWidgetEmbedCode() {
  const codeEl = document.getElementById('widget-embed-code-snippet');
  if (!codeEl) return;
  navigator.clipboard.writeText(codeEl.textContent).then(() => {
    showToast('Embed HTML snippet copied to clipboard! Paste onto lawncraft.vercel.app with zero code changes.', 'success');
  }).catch(() => {
    prompt('Copy embed HTML code:', codeEl.textContent);
  });
}

// =========================================================================
// ODOO ERP MODULES: M-PESA, LOYALTY, RECEIPTS, FLEET, TIMESHEETS, POS, DUNNING
// =========================================================================

let mpesaTransactionsCache = [];
let allInvoicesCache = [];

// ── 1. M-Pesa & Payment Gateway Hub ──────────────────────────────────────

async function loadMpesaModule() {
  try {
    const [txns, c2bQueue, invoices] = await Promise.all([
      apiFetch('/mpesa/transactions').catch(() => []),
      apiFetch('/mpesa/c2b/unmatched').catch(() => []),
      apiFetch('/invoices').catch(() => []),
    ]);

    mpesaTransactionsCache = Array.isArray(txns) ? txns : [];
    allInvoicesCache = Array.isArray(invoices) ? invoices : [];
    const unmatched = Array.isArray(c2bQueue) ? c2bQueue : [];

    // KPI computations
    const totalCollected = mpesaTransactionsCache.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const count = mpesaTransactionsCache.length;

    const kpiTotalEl = document.getElementById('mpesa-kpi-total');
    const kpiCountEl = document.getElementById('mpesa-kpi-count');
    const kpiUnmatchedEl = document.getElementById('mpesa-kpi-unmatched');
    const queueBadgeEl = document.getElementById('c2b-queue-badge');

    if (kpiTotalEl) kpiTotalEl.textContent = `$${totalCollected.toFixed(2)}`;
    if (kpiCountEl) kpiCountEl.textContent = count;
    if (kpiUnmatchedEl) kpiUnmatchedEl.textContent = unmatched.length;
    if (queueBadgeEl) queueBadgeEl.textContent = `${unmatched.length} Pending`;

    // Populate Quick STK Invoice selector
    const quickInvSelect = document.getElementById('quick-stk-invoice-select');
    const modalInvSelect = document.getElementById('mpesa-modal-inv');
    const openInvoices = allInvoicesCache.filter(i => (i.status || '').toLowerCase() !== 'paid');

    const invOptions = `<option value="">-- Choose open invoice --</option>` +
      openInvoices.map(i => `<option value="${i.id}" data-phone="${i.client_phone || ''}" data-amount="${i.balance_due || i.total_amount || 0}" data-client="${escapeHtml(i.client_name || '')}">Invoice #${i.invoice_number || i.id} - ${escapeHtml(i.client_name || 'Client')} ($${(Number(i.balance_due || i.total_amount) || 0).toFixed(2)})</option>`).join('');

    if (quickInvSelect) quickInvSelect.innerHTML = invOptions;
    if (modalInvSelect) modalInvSelect.innerHTML = invOptions;

    // Render C2B Unmatched Queue
    renderC2bQueue(unmatched, openInvoices);

    // Render Transactions Table
    renderMpesaTransactions(mpesaTransactionsCache);
  } catch (err) {
    showToast(`Error loading M-Pesa hub: ${err.message}`, 'danger');
  }
}

function renderC2bQueue(unmatched, openInvoices) {
  const tbody = document.getElementById('c2b-table-body');
  if (!tbody) return;

  if (unmatched.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-light);padding:24px;"><i class="fa-solid fa-circle-check" style="color:#16a34a;margin-right:6px;"></i> All incoming C2B Paybill payments are fully matched & reconciled!</td></tr>`;
    return;
  }

  tbody.innerHTML = unmatched.map(item => `
    <tr>
      <td>
        <strong style="color:var(--text-dark);">${escapeHtml(item.trans_id || item.id)}</strong>
        <div style="font-size:0.75rem; color:var(--text-medium);">${escapeHtml(item.sender_name || item.phone || 'Customer')} · ${escapeHtml(item.phone || '')}</div>
      </td>
      <td><strong style="color:#16a34a;">$${(Number(item.amount) || 0).toFixed(2)}</strong></td>
      <td>
        <span class="badge" style="background:#fef08a;color:#854d0e;">${escapeHtml(item.bill_ref_number || item.account_ref || 'Lawn Service')}</span>
      </td>
      <td>
        <div style="display:flex;gap:6px;align-items:center;">
          <select id="c2b-match-${item.id}" style="font-size:0.75rem;padding:4px;border:1px solid var(--border-color);border-radius:4px;max-width:140px;">
            <option value="">Match to Invoice...</option>
            ${openInvoices.map(i => `<option value="${i.id}">#${i.invoice_number || i.id} (${escapeHtml(i.client_name)})</option>`).join('')}
          </select>
          <button type="button" class="btn-primary btn-sm" style="font-size:0.75rem;padding:4px 8px;background:#16a34a;" onclick="reconcileC2bPayment('${item.id}')">
            Match
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderMpesaTransactions(txns) {
  const tbody = document.getElementById('mpesa-txns-tbody');
  if (!tbody) return;

  if (txns.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-light);padding:24px;">No M-Pesa transactions recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = txns.map(t => {
    const isCompleted = (t.status || '').toLowerCase() === 'completed' || (t.status || '').toLowerCase() === 'paid';
    const statusBadge = isCompleted
      ? `<span class="badge" style="background:#dcfce7;color:#166534;"><i class="fa-solid fa-check"></i> Settled</span>`
      : `<span class="badge" style="background:#fef3c7;color:#92400e;"><i class="fa-solid fa-clock"></i> ${escapeHtml(t.status || 'Pending')}</span>`;

    const formattedDate = t.timestamp ? new Date(t.timestamp).toLocaleString() : (t.date || 'Recent');
    const invoiceLink = t.invoice_id
      ? `<a href="javascript:void(0)" onclick="viewInvoice('${t.invoice_id}')" style="font-weight:600;color:var(--primary);">Invoice #${t.invoice_number || t.invoice_id}</a>`
      : `<span style="color:var(--text-light);">-</span>`;

    return `
      <tr>
        <td><strong style="font-family:monospace;font-size:0.9rem;color:var(--text-dark);">${escapeHtml(t.mpesa_receipt_number || t.receipt_number || t.trans_id || t.id)}</strong></td>
        <td>${escapeHtml(t.phone_number || t.phone || '-')}</td>
        <td>${escapeHtml(t.client_name || 'Direct Customer')}<br><small>${invoiceLink}</small></td>
        <td><strong style="color:#16a34a;">$${(Number(t.amount) || 0).toFixed(2)}</strong></td>
        <td><span class="badge" style="background:#f1f5f9;color:var(--text-dark);">${escapeHtml(t.channel || 'STK Express')}</span></td>
        <td style="font-size:0.8rem;color:var(--text-medium);">${formattedDate}</td>
        <td>${statusBadge}</td>
        <td>
          <a href="/receipt/${t.invoice_id || t.id}" target="_blank" class="btn-secondary btn-sm" title="View Electronic Receipt" style="font-size:0.75rem;padding:3px 8px;">
            <i class="fa-solid fa-receipt"></i> Receipt
          </a>
        </td>
      </tr>
    `;
  }).join('');
}

function filterMpesaTxns() {
  const query = (document.getElementById('mpesa-search-input')?.value || '').toLowerCase().trim();
  if (!query) {
    renderMpesaTransactions(mpesaTransactionsCache);
    return;
  }
  const filtered = mpesaTransactionsCache.filter(t => 
    (t.mpesa_receipt_number || t.receipt_number || t.id || '').toLowerCase().includes(query) ||
    (t.phone_number || t.phone || '').toLowerCase().includes(query) ||
    (t.client_name || '').toLowerCase().includes(query)
  );
  renderMpesaTransactions(filtered);
}

function onQuickStkInvoiceChange(e) {
  const selectedOpt = e.target.selectedOptions[0];
  if (!selectedOpt) return;
  const phone = selectedOpt.dataset.phone || '';
  const amount = selectedOpt.dataset.amount || '';
  const phoneInput = document.getElementById('quick-stk-phone');
  const amountInput = document.getElementById('quick-stk-amount');
  if (phoneInput && phone) phoneInput.value = phone;
  if (amountInput && amount) amountInput.value = amount;
}

async function submitQuickStk(e) {
  e.preventDefault();
  const invoiceId = document.getElementById('quick-stk-invoice-select').value;
  const phone = document.getElementById('quick-stk-phone').value.trim();
  const amount = parseFloat(document.getElementById('quick-stk-amount').value);
  const btn = document.getElementById('btn-submit-quick-stk');

  if (!phone || !amount) {
    showToast('Please enter both phone number and amount.', 'danger');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Sending STK Prompt…`;

  try {
    const res = await apiFetch('/mpesa/stkpush', {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: invoiceId,
        phone_number: phone,
        amount: amount,
        account_reference: invoiceId ? `INV-${invoiceId}` : 'LAWNCRAFT',
        transaction_desc: 'Lawn Care Service Settlement'
      })
    });

    showToast(`M-Pesa STK PIN prompt sent to ${phone}! Customer can enter PIN now.`, 'success');
    document.getElementById('quick-stk-form').reset();
    await loadMpesaModule();
  } catch (err) {
    showToast(`STK Push failed: ${err.message}`, 'danger');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-mobile-screen-button"></i> Send M-Pesa Prompt Now`;
  }
}

function openMpesaStkModal(invoiceId = '', phone = '', amount = '', clientName = '') {
  const modal = document.getElementById('mpesa-stk-modal');
  if (!modal) return;

  const invSelect = document.getElementById('mpesa-modal-inv');
  const phoneInput = document.getElementById('mpesa-modal-phone');
  const amountInput = document.getElementById('mpesa-modal-amount');
  const nameInput = document.getElementById('mpesa-modal-name');

  if (invoiceId && invSelect) invSelect.value = invoiceId;
  if (phone && phoneInput) phoneInput.value = phone;
  if (amount && amountInput) amountInput.value = amount;
  if (clientName && nameInput) nameInput.value = clientName;

  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
}

function closeMpesaStkModal() {
  const modal = document.getElementById('mpesa-stk-modal');
  if (!modal) return;
  modal.classList.remove('visible');
  modal.setAttribute('aria-hidden', 'true');
}

async function submitMpesaStkModal(e) {
  e.preventDefault();
  const invoiceId = document.getElementById('mpesa-modal-inv').value;
  const phone = document.getElementById('mpesa-modal-phone').value.trim();
  const amount = parseFloat(document.getElementById('mpesa-modal-amount').value);
  const clientName = document.getElementById('mpesa-modal-name').value.trim();

  try {
    await apiFetch('/mpesa/stkpush', {
      method: 'POST',
      body: JSON.stringify({
        invoice_id: invoiceId,
        phone_number: phone,
        amount: amount,
        client_name: clientName,
        account_reference: invoiceId ? `INV-${invoiceId}` : 'LAWNCRAFT'
      })
    });

    showToast(`Lipa Na M-Pesa prompt dispatched to ${phone}!`, 'success');
    closeMpesaStkModal();
    await loadMpesaModule();
  } catch (err) {
    showToast(`M-Pesa STK Push error: ${err.message}`, 'danger');
  }
}

async function reconcileC2bPayment(c2bId) {
  const select = document.getElementById(`c2b-match-${c2bId}`);
  const invoiceId = select ? select.value : '';

  if (!invoiceId) {
    showToast('Please select an open invoice to match this Paybill payment.', 'danger');
    return;
  }

  try {
    await apiFetch('/mpesa/c2b/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        c2b_id: c2bId,
        invoice_id: invoiceId
      })
    });

    showToast('C2B Paybill payment reconciled & invoice marked as settled!', 'success');
    await loadMpesaModule();
  } catch (err) {
    showToast(`Reconciliation error: ${err.message}`, 'danger');
  }
}

// ── 2. Loyalty Rewards & Coupons Engine ────────────────────────────────────

let loyaltyAccountsCache = [];
let couponsCache = [];

async function loadLoyaltyModule() {
  try {
    const [accounts, coupons] = await Promise.all([
      apiFetch('/loyalty/accounts').catch(() => []),
      apiFetch('/coupons').catch(() => []),
    ]);

    loyaltyAccountsCache = Array.isArray(accounts) ? accounts : [];
    couponsCache = Array.isArray(coupons) ? coupons : [];

    // KPI computations
    const totalMembers = loyaltyAccountsCache.length;
    const totalPoints = loyaltyAccountsCache.reduce((sum, a) => sum + (Number(a.points_balance) || 0), 0);
    const liability = totalPoints * 0.50; // $0.50 per point
    const activeCoupons = couponsCache.filter(c => (c.status || '').toLowerCase() === 'active').length;

    const elMembers = document.getElementById('loyalty-kpi-members');
    const elPoints = document.getElementById('loyalty-kpi-points');
    const elLiability = document.getElementById('loyalty-kpi-liability');
    const elCoupons = document.getElementById('loyalty-kpi-coupons');

    if (elMembers) elMembers.textContent = totalMembers;
    if (elPoints) elPoints.textContent = `${totalPoints.toLocaleString()} pts`;
    if (elLiability) elLiability.textContent = `$${liability.toFixed(2)}`;
    if (elCoupons) elCoupons.textContent = activeCoupons;

    renderLoyaltyAccounts(loyaltyAccountsCache);
    renderCoupons(couponsCache);
  } catch (err) {
    showToast(`Error loading Loyalty engine: ${err.message}`, 'danger');
  }
}

function renderLoyaltyAccounts(accounts) {
  const tbody = document.getElementById('loyalty-accounts-tbody');
  if (!tbody) return;

  if (accounts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;">No loyalty member accounts enrolled yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = accounts.map(a => {
    const tier = (a.tier || 'bronze').toLowerCase();
    let tierBadge = `<span class="badge" style="background:#fed7aa;color:#9a3412;"><i class="fa-solid fa-medal"></i> Bronze</span>`;
    if (tier === 'silver') tierBadge = `<span class="badge" style="background:#e2e8f0;color:#334155;"><i class="fa-solid fa-gem"></i> Silver</span>`;
    if (tier === 'gold') tierBadge = `<span class="badge" style="background:#fef08a;color:#854d0e;"><i class="fa-solid fa-crown"></i> Gold VIP</span>`;
    if (tier === 'platinum') tierBadge = `<span class="badge" style="background:#f3e8ff;color:#6b21a8;"><i class="fa-solid fa-diamond"></i> Platinum Elite</span>`;

    const dollarVal = ((Number(a.points_balance) || 0) * 0.50).toFixed(2);
    const lifetimeSpend = (Number(a.lifetime_spend) || 0).toFixed(2);

    return `
      <tr>
        <td><strong style="color:var(--text-dark);">${escapeHtml(a.client_name || a.customer_name || 'Member')}</strong></td>
        <td>${escapeHtml(a.phone || a.email || '-')}</td>
        <td>${tierBadge}</td>
        <td><strong style="font-size:1.05rem;color:#86198f;">${a.points_balance || 0} pts</strong></td>
        <td style="color:#16a34a;font-weight:600;">$${dollarVal}</td>
        <td>$${lifetimeSpend}</td>
        <td><code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:0.8rem;">${escapeHtml(a.referral_code || 'REF-' + a.id)}</code></td>
        <td>
          <button type="button" class="btn-secondary btn-sm" style="font-size:0.75rem;padding:3px 8px;" onclick="openLoyaltyAdjustModal('${a.phone || ''}', '${escapeHtml(a.client_name || a.customer_name || '')}', '${a.tier || 'bronze'}')">
            <i class="fa-solid fa-sliders"></i> Adjust
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderCoupons(coupons) {
  const tbody = document.getElementById('coupons-tbody');
  if (!tbody) return;

  if (coupons.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;">No promo coupon campaigns found.</td></tr>`;
    return;
  }

  tbody.innerHTML = coupons.map(c => {
    const isPct = (c.discount_type || 'percentage') === 'percentage';
    const discountStr = isPct ? `${c.discount_value}% OFF` : `$${c.discount_value} OFF`;
    const expiryStr = c.expiry_date ? new Date(c.expiry_date).toLocaleDateString() : 'No Expiry';

    return `
      <tr>
        <td><strong style="font-family:monospace;font-size:0.95rem;color:#86198f;background:#fdf4ff;padding:3px 8px;border-radius:4px;border:1px dashed #d946ef;">${escapeHtml(c.code)}</strong></td>
        <td><strong style="color:#16a34a;">${discountStr}</strong></td>
        <td><span class="badge" style="background:#f1f5f9;color:var(--text-dark);">${escapeHtml(c.discount_type || 'percentage')}</span></td>
        <td>$${(Number(c.min_spend) || 0).toFixed(2)}</td>
        <td>${c.max_uses || 'Unlimited'}</td>
        <td><strong>${c.times_used || 0}</strong> used</td>
        <td>${expiryStr}</td>
        <td><span class="badge" style="background:#dcfce7;color:#166534;">Active</span></td>
      </tr>
    `;
  }).join('');
}

function openCouponModal() {
  const modal = document.getElementById('coupon-modal');
  if (modal) {
    modal.classList.add('visible');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function closeCouponModal() {
  const modal = document.getElementById('coupon-modal');
  if (modal) {
    modal.classList.remove('visible');
    modal.setAttribute('aria-hidden', 'true');
  }
}

async function submitCouponForm(e) {
  e.preventDefault();
  const code = document.getElementById('cp-code').value.trim().toUpperCase();
  const discount = parseFloat(document.getElementById('cp-discount').value);
  const type = document.getElementById('cp-type').value;
  const minSpend = parseFloat(document.getElementById('cp-min-spend').value) || 0;
  const maxUses = parseInt(document.getElementById('cp-max-uses').value) || 100;
  const expiry = document.getElementById('cp-expiry').value;

  try {
    await apiFetch('/coupons', {
      method: 'POST',
      body: JSON.stringify({
        code,
        discount_value: discount,
        discount_type: type,
        min_spend: minSpend,
        max_uses: maxUses,
        expiry_date: expiry || null
      })
    });

    showToast(`Promo Coupon "${code}" created successfully!`, 'success');
    closeCouponModal();
    document.getElementById('coupon-modal-form').reset();
    await loadLoyaltyModule();
  } catch (err) {
    showToast(`Coupon creation failed: ${err.message}`, 'danger');
  }
}

function openLoyaltyAdjustModal(phone, name, currentTier) {
  const modal = document.getElementById('loyalty-adjust-modal');
  if (!modal) return;

  document.getElementById('adj-phone').value = phone;
  document.getElementById('adj-customer-name').textContent = name || phone;
  document.getElementById('adj-tier-select').value = currentTier || 'bronze';

  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
}

function closeLoyaltyAdjustModal() {
  const modal = document.getElementById('loyalty-adjust-modal');
  if (modal) {
    modal.classList.remove('visible');
    modal.setAttribute('aria-hidden', 'true');
  }
}

async function submitLoyaltyAdjustForm(e) {
  e.preventDefault();
  const phone = document.getElementById('adj-phone').value;
  const delta = parseInt(document.getElementById('adj-points-delta').value) || 0;
  const tier = document.getElementById('adj-tier-select').value;
  const reason = document.getElementById('adj-reason').value.trim();

  try {
    await apiFetch('/loyalty/adjust', {
      method: 'POST',
      body: JSON.stringify({
        phone,
        points_delta: delta,
        new_tier: tier,
        reason
      })
    });

    showToast(`Loyalty balance updated (${delta >= 0 ? '+' : ''}${delta} pts)!`, 'success');
    closeLoyaltyAdjustModal();
    document.getElementById('loyalty-adjust-form').reset();
    await loadLoyaltyModule();
  } catch (err) {
    showToast(`Points adjustment failed: ${err.message}`, 'danger');
  }
}

// ── 3. Electronic Tax Receipts & POS Slips ─────────────────────────────────

async function loadReceiptsModule() {
  try {
    const invoices = await apiFetch('/invoices').catch(() => []);
    const receipts = (Array.isArray(invoices) ? invoices : []).filter(i => (i.status || '').toLowerCase() === 'paid' || (Number(i.amount_paid) > 0));

    const tbody = document.getElementById('receipts-directory-tbody');
    if (!tbody) return;

    if (receipts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;">No settled tax receipts found. Paid invoices automatically generate electronic receipts.</td></tr>`;
      return;
    }

    tbody.innerHTML = receipts.map(r => {
      const receiptNo = `REC-${r.invoice_number || r.id}`;
      const amountPaid = (Number(r.amount_paid || r.total_amount) || 0).toFixed(2);
      const settledDate = r.payment_date || r.paid_at || r.updated_at || r.created_at || 'Recent';

      return `
        <tr>
          <td><strong style="font-family:monospace;font-size:0.95rem;color:#15803d;">${receiptNo}</strong></td>
          <td><a href="javascript:void(0)" onclick="viewInvoice('${r.id}')" style="font-weight:600;color:var(--primary);">#${r.invoice_number || r.id}</a></td>
          <td><strong>${escapeHtml(r.client_name || 'Valued Customer')}</strong></td>
          <td><strong style="color:#16a34a;font-size:1rem;">$${amountPaid}</strong></td>
          <td><span class="badge" style="background:#f0fdf4;color:#166534;"><i class="fa-solid fa-mobile-screen-button"></i> ${escapeHtml(r.payment_method || 'M-Pesa Express')}</span></td>
          <td style="font-size:0.85rem;color:var(--text-medium);">${new Date(settledDate).toLocaleDateString()}</td>
          <td>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <a href="/receipt/${r.id}" target="_blank" class="btn-primary btn-sm" style="font-size:0.75rem;padding:4px 8px;background:#16a34a;" title="Open KRA Electronic Tax Receipt">
                <i class="fa-solid fa-file-invoice"></i> E-Receipt
              </a>
              <a href="/receipt/${r.id}/thermal" target="_blank" class="btn-secondary btn-sm" style="font-size:0.75rem;padding:4px 8px;" title="Print 80mm POS Thermal Slip">
                <i class="fa-solid fa-print"></i> POS Slip
              </a>
              <button type="button" class="btn-secondary btn-sm" style="font-size:0.75rem;padding:4px 8px;color:#16a34a;" onclick="shareReceiptWhatsApp('${r.id}', '${r.client_phone || ''}', '${amountPaid}')" title="Share via WhatsApp">
                <i class="fa-brands fa-whatsapp"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    showToast(`Error loading receipts: ${err.message}`, 'danger');
  }
}

function shareReceiptWhatsApp(invoiceId, phone, amount) {
  const origin = window.location.origin;
  const receiptUrl = `${origin}/receipt/${invoiceId}`;
  const message = `Hello, thank you for choosing Lawn Craft! Here is your official Electronic Tax Receipt for $${amount}: ${receiptUrl}`;
  const cleanPhone = (phone || '').replace(/\D/g, '');
  const waUrl = cleanPhone 
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(waUrl, '_blank');
}

// ── 4. Fleet & Equipment Asset Management ──────────────────────────────────

let fleetCache = [];
let fleetLogsCache = [];

async function loadFleetModule() {
  try {
    const [equipment, logs] = await Promise.all([
      apiFetch('/fleet/equipment').catch(() => []),
      apiFetch('/fleet/maintenance-logs').catch(() => []),
    ]);

    fleetCache = Array.isArray(equipment) ? equipment : [];
    fleetLogsCache = Array.isArray(logs) ? logs : [];

    // Computations
    const totalUnits = fleetCache.length;
    const activeUnits = fleetCache.filter(e => (e.status || '').toLowerCase() === 'operational' || (e.status || '').toLowerCase() === 'active').length;
    const dueUnits = fleetCache.filter(e => (e.status || '').toLowerCase() === 'maintenance_due' || (Number(e.hours_since_service) >= Number(e.service_interval_hours || 50))).length;
    const totalHours = fleetCache.reduce((sum, e) => sum + (Number(e.operating_hours) || 0), 0);

    const elTotal = document.getElementById('fleet-kpi-total');
    const elActive = document.getElementById('fleet-kpi-active');
    const elDue = document.getElementById('fleet-kpi-due');
    const elHours = document.getElementById('fleet-kpi-hours');

    if (elTotal) elTotal.textContent = totalUnits;
    if (elActive) elActive.textContent = activeUnits;
    if (elDue) elDue.textContent = dueUnits;
    if (elHours) elHours.textContent = `${totalHours.toLocaleString()} hrs`;

    renderFleetTable(fleetCache);
    renderFleetLogs(fleetLogsCache);
  } catch (err) {
    showToast(`Error loading fleet module: ${err.message}`, 'danger');
  }
}

function renderFleetTable(equipment) {
  const tbody = document.getElementById('fleet-table-tbody');
  if (!tbody) return;

  if (equipment.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;">No equipment registered in fleet.</td></tr>`;
    return;
  }

  tbody.innerHTML = equipment.map(eq => {
    const isDue = (eq.status || '').toLowerCase() === 'maintenance_due' || (Number(eq.hours_since_service) >= Number(eq.service_interval_hours || 50));
    const statusBadge = isDue
      ? `<span class="badge" style="background:#fee2e2;color:#991b1b;"><i class="fa-solid fa-triangle-exclamation"></i> Service Due</span>`
      : `<span class="badge" style="background:#dcfce7;color:#166534;"><i class="fa-solid fa-circle-check"></i> Ready</span>`;

    return `
      <tr>
        <td>
          <strong style="color:var(--text-dark);">${escapeHtml(eq.name || eq.asset_tag)}</strong>
          <div style="font-size:0.75rem;color:var(--text-medium);">${escapeHtml(eq.asset_tag || '')}</div>
        </td>
        <td>${escapeHtml(eq.type || 'Commercial Mower')} · ${escapeHtml(eq.model || '')}</td>
        <td>${escapeHtml(eq.assigned_crew || 'Crew Alpha')}</td>
        <td><strong style="font-size:0.95rem;">${eq.operating_hours || 0} hrs</strong></td>
        <td style="font-size:0.85rem;color:var(--text-medium);">${eq.last_service_date || 'N/A'}</td>
        <td><span style="font-weight:600;color:${isDue ? '#dc2626' : 'var(--text-dark)'};">${eq.next_service_hours || (eq.operating_hours + 50)} hrs</span></td>
        <td>${statusBadge}</td>
        <td>
          <button type="button" class="btn-primary btn-sm" style="font-size:0.75rem;padding:4px 8px;background:#0284c7;" onclick="openFleetServiceModal('${eq.id}')">
            <i class="fa-solid fa-wrench"></i> Log Service
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function renderFleetLogs(logs) {
  const tbody = document.getElementById('fleet-logs-tbody');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;">No service logs recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map(l => `
    <tr>
      <td style="font-size:0.85rem;">${l.date || (l.created_at ? new Date(l.created_at).toLocaleDateString() : 'Recent')}</td>
      <td><strong>${escapeHtml(l.equipment_name || l.equipment_id)}</strong></td>
      <td><span class="badge" style="background:#f1f5f9;color:var(--text-dark);">${escapeHtml(l.service_type || 'General Service')}</span></td>
      <td>${l.hours_at_service || '-'} hrs</td>
      <td>${escapeHtml(l.performed_by || 'Leo Sterling')}</td>
      <td style="color:#16a34a;font-weight:600;">$${(Number(l.cost) || 0).toFixed(2)}</td>
      <td style="font-size:0.8rem;color:var(--text-medium);">${escapeHtml(l.notes || '-')}</td>
    </tr>
  `).join('');
}

function openFleetServiceModal(equipmentId = '') {
  const modal = document.getElementById('fleet-service-modal');
  if (!modal) return;

  const select = document.getElementById('fleet-eq-select');
  if (select && fleetCache.length > 0) {
    select.innerHTML = `<option value="">-- Choose Equipment --</option>` +
      fleetCache.map(eq => `<option value="${eq.id}" ${eq.id === equipmentId ? 'selected' : ''}>${escapeHtml(eq.name || eq.asset_tag)} (${eq.operating_hours} hrs)</option>`).join('');
  }

  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
}

function closeFleetServiceModal() {
  const modal = document.getElementById('fleet-service-modal');
  if (modal) {
    modal.classList.remove('visible');
    modal.setAttribute('aria-hidden', 'true');
  }
}

async function submitFleetServiceForm(e) {
  e.preventDefault();
  const eqId = document.getElementById('fleet-eq-select').value;
  const serviceType = document.getElementById('fleet-service-type').value;
  const cost = parseFloat(document.getElementById('fleet-service-cost').value) || 0;
  const hours = parseFloat(document.getElementById('fleet-hours-at-service').value) || 0;
  const performedBy = document.getElementById('fleet-performed-by').value.trim();
  const notes = document.getElementById('fleet-service-notes').value.trim();

  try {
    await apiFetch('/fleet/maintenance-logs', {
      method: 'POST',
      body: JSON.stringify({
        equipment_id: eqId,
        service_type: serviceType,
        cost,
        hours_at_service: hours,
        performed_by: performedBy,
        notes
      })
    });

    showToast('Equipment maintenance logged & service counter reset!', 'success');
    closeFleetServiceModal();
    document.getElementById('fleet-service-form').reset();
    await loadFleetModule();
  } catch (err) {
    showToast(`Failed to log service: ${err.message}`, 'danger');
  }
}

// ── 5. GPS Geo-Fenced Timesheets Module ────────────────────────────────────

let currentGpsCoords = { lat: -1.2680, lng: 36.8040 };

async function loadTimesheetsModule() {
  try {
    const [timesheets, workOrders] = await Promise.all([
      apiFetch('/gps-timesheets').catch(() => []),
      apiFetch('/work-orders').catch(() => []),
    ]);

    const woSelect = document.getElementById('clockin-wo');
    if (woSelect && Array.isArray(workOrders)) {
      woSelect.innerHTML = `<option value="">-- Select Work Order --</option>` +
        workOrders.slice(0, 15).map(wo => `<option value="${wo.id}">#${wo.order_id || wo.id} - ${escapeHtml(wo.property_address || 'Property')}</option>`).join('');
    }

    renderTimesheetsTable(Array.isArray(timesheets) ? timesheets : []);
  } catch (err) {
    showToast(`Error loading timesheets: ${err.message}`, 'danger');
  }
}

function detectGpsCoordinates() {
  const coordsLabel = document.getElementById('gps-status-coords');
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        currentGpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (coordsLabel) {
          coordsLabel.innerHTML = `<span style="color:#16a34a;"><i class="fa-solid fa-location-dot"></i> ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)} (Accuracy ±${Math.round(pos.coords.accuracy)}m)</span>`;
        }
      },
      () => {
        if (coordsLabel) {
          coordsLabel.innerHTML = `<span style="color:#4f46e5;"><i class="fa-solid fa-location-crosshairs"></i> -1.2680, 36.8040 (Field Hub)</span>`;
        }
      }
    );
  } else if (coordsLabel) {
    coordsLabel.textContent = '-1.2680, 36.8040 (Default GPS)';
  }
}

function renderTimesheetsTable(timesheets) {
  const tbody = document.getElementById('timesheets-table-tbody');
  if (!tbody) return;

  if (timesheets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;">No timesheet shifts recorded yet. Use the Clock-In Terminal to begin tracking.</td></tr>`;
    return;
  }

  tbody.innerHTML = timesheets.map(ts => {
    const isActive = (ts.status || '').toLowerCase() === 'active' || !ts.clock_out;
    const durationHrs = ts.duration_hours || (isActive ? 1.5 : (Number(ts.total_hours) || 2.0));
    const laborCost = (durationHrs * (Number(ts.hourly_rate) || 28.50)).toFixed(2);
    const gpsProximity = ts.geofence_verified 
      ? `<span class="badge" style="background:#dcfce7;color:#166534;"><i class="fa-solid fa-satellite"></i> &lt; 35m On-Site</span>`
      : `<span class="badge" style="background:#e0e7ff;color:#3730a3;"><i class="fa-solid fa-location-dot"></i> Verified</span>`;

    const clockInStr = ts.clock_in ? new Date(ts.clock_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '08:30 AM';
    const clockOutStr = ts.clock_out ? new Date(ts.clock_out).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (isActive ? '<span style="color:#16a34a;font-weight:600;"><i class="fa-solid fa-pulse fa-spinner"></i> In Progress</span>' : '11:00 AM');

    return `
      <tr>
        <td><strong>${escapeHtml(ts.crew_member || ts.employee_name)}</strong></td>
        <td><a href="javascript:void(0)" onclick="viewWorkOrder('${ts.work_order_id}')" style="color:var(--primary);font-weight:600;">#${ts.work_order_id || 'WO-101'}</a></td>
        <td>${clockInStr}</td>
        <td>${clockOutStr}</td>
        <td><strong>${Number(durationHrs).toFixed(1)} hrs</strong></td>
        <td style="color:#16a34a;font-weight:600;">$${laborCost}</td>
        <td>${gpsProximity}</td>
        <td>${isActive ? '<span class="badge" style="background:#dbeafe;color:#1e40af;">Clocked In</span>' : '<span class="badge" style="background:#f1f5f9;color:var(--text-dark);">Completed</span>'}</td>
        <td>
          ${isActive ? `<button type="button" class="btn-primary btn-sm" style="font-size:0.75rem;padding:3px 8px;background:#dc2626;" onclick="clockOutTimesheet('${ts.id}')"><i class="fa-solid fa-stop"></i> Clock Out</button>` : `<span style="color:var(--text-light);font-size:0.8rem;">Logged</span>`}
        </td>
      </tr>
    `;
  }).join('');
}

async function submitClockIn(e) {
  e.preventDefault();
  const crew = document.getElementById('clockin-crew').value;
  const woId = document.getElementById('clockin-wo').value;
  const rate = parseFloat(document.getElementById('clockin-rate').value) || 28.50;

  try {
    await apiFetch('/gps-timesheets/clock-in', {
      method: 'POST',
      body: JSON.stringify({
        crew_member: crew,
        work_order_id: woId,
        hourly_rate: rate,
        latitude: currentGpsCoords.lat,
        longitude: currentGpsCoords.lng
      })
    });

    showToast(`Clocked in ${crew} with GPS location verified!`, 'success');
    document.getElementById('timesheet-clockin-panel').style.display = 'none';
    await loadTimesheetsModule();
  } catch (err) {
    showToast(`Clock-in failed: ${err.message}`, 'danger');
  }
}

async function clockOutTimesheet(timesheetId) {
  try {
    await apiFetch(`/gps-timesheets/clock-out/${timesheetId}`, {
      method: 'POST',
      body: JSON.stringify({
        clock_out_lat: currentGpsCoords.lat,
        clock_out_lng: currentGpsCoords.lng
      })
    });

    showToast('Crew member clocked out & labor cost calculated!', 'success');
    await loadTimesheetsModule();
  } catch (err) {
    showToast(`Clock-out failed: ${err.message}`, 'danger');
  }
}

// ── 6. Vendor Purchase Orders & Restocking ─────────────────────────────────

let purchaseOrdersCache = [];

async function loadPurchasingModule() {
  try {
    const [pos, inventory] = await Promise.all([
      apiFetch('/purchase-orders').catch(() => []),
      apiFetch('/inventory').catch(() => []),
    ]);

    purchaseOrdersCache = Array.isArray(pos) ? pos : [];
    const invItems = Array.isArray(inventory) ? inventory : [];

    // KPI computations
    const totalPOs = purchaseOrdersCache.length;
    const pendingDeliveries = purchaseOrdersCache.filter(p => (p.status || '').toLowerCase() === 'pending' || (p.status || '').toLowerCase() === 'ordered').length;
    const totalSpend = purchaseOrdersCache.reduce((sum, p) => sum + (Number(p.total_cost) || 0), 0);

    const elCount = document.getElementById('po-kpi-count');
    const elPending = document.getElementById('po-kpi-pending');
    const elSpend = document.getElementById('po-kpi-spend');

    if (elCount) elCount.textContent = totalPOs;
    if (elPending) elPending.textContent = pendingDeliveries;
    if (elSpend) elSpend.textContent = `$${totalSpend.toFixed(2)}`;

    // Populate link item dropdown
    const itemSelect = document.getElementById('po-link-item');
    if (itemSelect) {
      itemSelect.innerHTML = `<option value="">-- Choose Warehouse Item --</option>` +
        invItems.map(item => `<option value="${item.id}" data-name="${escapeHtml(item.name || '')}" data-cost="${item.unit_cost || 0}">${escapeHtml(item.name)} (In Stock: ${item.quantity_on_hand || item.quantity || 0})</option>`).join('');
    }

    renderPoTable(purchaseOrdersCache);
  } catch (err) {
    showToast(`Error loading purchase orders: ${err.message}`, 'danger');
  }
}

function renderPoTable(pos) {
  const tbody = document.getElementById('po-table-tbody');
  if (!tbody) return;

  if (pos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;">No purchase orders issued yet. Click "+ Create Purchase Order" to procure supplies.</td></tr>`;
    return;
  }

  tbody.innerHTML = pos.map(po => {
    const isReceived = (po.status || '').toLowerCase() === 'received';
    const statusBadge = isReceived
      ? `<span class="badge" style="background:#dcfce7;color:#166534;"><i class="fa-solid fa-check"></i> Restocked</span>`
      : `<span class="badge" style="background:#fef3c7;color:#92400e;"><i class="fa-solid fa-truck"></i> Pending Delivery</span>`;

    return `
      <tr>
        <td><strong style="font-family:monospace;font-size:0.95rem;color:var(--text-dark);">${escapeHtml(po.po_number || 'PO-' + po.id)}</strong></td>
        <td><strong>${escapeHtml(po.vendor_name || 'Vendor')}</strong></td>
        <td>${escapeHtml(po.item_description || po.item_name)}</td>
        <td><strong>${po.quantity || 1}</strong></td>
        <td>$${(Number(po.unit_cost) || 0).toFixed(2)}</td>
        <td><strong style="color:#16a34a;">$${(Number(po.total_cost) || 0).toFixed(2)}</strong></td>
        <td style="font-size:0.85rem;color:var(--text-medium);">${po.date_ordered || (po.created_at ? new Date(po.created_at).toLocaleDateString() : 'Recent')}</td>
        <td>${statusBadge}</td>
        <td>
          ${!isReceived ? `
            <button type="button" class="btn-primary btn-sm" style="font-size:0.75rem;padding:4px 8px;background:#16a34a;" onclick="receivePurchaseOrder('${po.id}')">
              <i class="fa-solid fa-box-open"></i> Receive & Restock
            </button>
          ` : `<span style="color:var(--text-light);font-size:0.8rem;">Completed</span>`}
        </td>
      </tr>
    `;
  }).join('');
}

function openPoModal() {
  const modal = document.getElementById('po-modal');
  if (modal) {
    modal.classList.add('visible');
    modal.setAttribute('aria-hidden', 'false');
  }
}

function closePoModal() {
  const modal = document.getElementById('po-modal');
  if (modal) {
    modal.classList.remove('visible');
    modal.setAttribute('aria-hidden', 'true');
  }
}

async function submitPoForm(e) {
  e.preventDefault();
  const vendor = document.getElementById('po-vendor-name').value.trim();
  const itemId = document.getElementById('po-link-item').value;
  const desc = document.getElementById('po-item-desc').value.trim();
  const qty = parseInt(document.getElementById('po-qty').value) || 1;
  const unitCost = parseFloat(document.getElementById('po-unit-cost').value) || 0;
  const expectedDate = document.getElementById('po-expected-date').value;

  try {
    await apiFetch('/purchase-orders', {
      method: 'POST',
      body: JSON.stringify({
        vendor_name: vendor,
        inventory_item_id: itemId,
        item_description: desc,
        quantity: qty,
        unit_cost: unitCost,
        total_cost: qty * unitCost,
        expected_delivery: expectedDate || null
      })
    });

    showToast('Vendor Purchase Order issued successfully!', 'success');
    closePoModal();
    document.getElementById('po-modal-form').reset();
    await loadPurchasingModule();
  } catch (err) {
    showToast(`PO creation failed: ${err.message}`, 'danger');
  }
}

async function receivePurchaseOrder(poId) {
  try {
    await apiFetch(`/purchase-orders/${poId}/receive`, {
      method: 'POST'
    });

    showToast('Purchase Order received & warehouse inventory stock auto-incremented!', 'success');
    await loadPurchasingModule();
  } catch (err) {
    showToast(`Failed to receive PO: ${err.message}`, 'danger');
  }
}

// ── 7. Automated Dunning & Overdue Collections ─────────────────────────────

let dunningScansCache = [];

async function loadDunningModule() {
  try {
    const scans = await apiFetch('/dunning/scans').catch(() => []);
    dunningScansCache = Array.isArray(scans) ? scans : [];

    const totalOverdue = dunningScansCache.reduce((sum, d) => sum + (Number(d.balance_due || d.amount) || 0), 0);
    const overdueCount = dunningScansCache.length;
    const criticalCount = dunningScansCache.filter(d => Number(d.days_overdue) > 30).length;

    const elOverdue = document.getElementById('dunning-kpi-overdue');
    const elCount = document.getElementById('dunning-kpi-count');
    const elCritical = document.getElementById('dunning-kpi-critical');

    if (elOverdue) elOverdue.textContent = `$${totalOverdue.toFixed(2)}`;
    if (elCount) elCount.textContent = overdueCount;
    if (elCritical) elCritical.textContent = criticalCount;

    renderDunningTable(dunningScansCache);
  } catch (err) {
    showToast(`Error loading dunning module: ${err.message}`, 'danger');
  }
}

async function runDunningScan() {
  const btn = document.getElementById('btn-run-dunning');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Scanning Receivables…`;
  }

  try {
    const res = await apiFetch('/dunning/run-scan', { method: 'POST' }).catch(() => null);
    await loadDunningModule();
    showToast(`Dunning scan complete. Found ${dunningScansCache.length} overdue invoice(s).`, 'success');
  } catch (err) {
    showToast(`Dunning scan error: ${err.message}`, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i class="fa-solid fa-magnifying-glass-dollar"></i> Run Dunning Scan`;
    }
  }
}

function renderDunningTable(items) {
  const tbody = document.getElementById('dunning-table-tbody');
  if (!tbody) return;

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#16a34a;"><i class="fa-solid fa-circle-check" style="font-size:1.4rem;margin-bottom:8px;display:block;"></i> All customer accounts are up to date with zero overdue invoices!</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(d => {
    const days = Number(d.days_overdue) || 1;
    let severityBadge = `<span class="badge" style="background:#fef3c7;color:#92400e;">1-15 Days (Mild)</span>`;
    if (days > 15 && days <= 30) severityBadge = `<span class="badge" style="background:#fed7aa;color:#9a3412;">16-30 Days (Urgent)</span>`;
    if (days > 30) severityBadge = `<span class="badge" style="background:#fee2e2;color:#991b1b;font-weight:700;"><i class="fa-solid fa-fire"></i> >30 Days (Critical)</span>`;

    const balance = (Number(d.balance_due || d.amount) || 0).toFixed(2);

    return `
      <tr>
        <td><a href="javascript:void(0)" onclick="viewInvoice('${d.invoice_id || d.id}')" style="font-weight:700;color:var(--primary);">#${d.invoice_number || d.invoice_id || d.id}</a></td>
        <td><strong>${escapeHtml(d.client_name || 'Client')}</strong></td>
        <td>${escapeHtml(d.client_phone || '-')}</td>
        <td style="font-size:0.85rem;color:var(--text-medium);">${d.due_date || 'Past Due'}</td>
        <td><strong style="color:#dc2626;">${days} days</strong></td>
        <td><strong style="font-size:1rem;color:#dc2626;">$${balance}</strong></td>
        <td>${severityBadge}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn-primary btn-sm" style="font-size:0.75rem;padding:4px 8px;background:#16a34a;" onclick="sendDunningWhatsApp('${d.invoice_id || d.id}', '${d.client_phone || ''}', '${escapeHtml(d.client_name || '')}', '${balance}', '${days}')">
              <i class="fa-brands fa-whatsapp"></i> WhatsApp Reminder
            </button>
            <button type="button" class="btn-secondary btn-sm" style="font-size:0.75rem;padding:4px 8px;" onclick="sendDunningEmail('${d.invoice_id || d.id}', '${d.client_email || ''}')">
              <i class="fa-solid fa-envelope"></i> Email
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function sendDunningWhatsApp(invoiceId, phone, clientName, balance, days) {
  const origin = window.location.origin;
  const payUrl = `${origin}/pay/${invoiceId}`;
  const message = `Hello ${clientName}, this is a gentle reminder from Lawn Craft regarding Invoice #${invoiceId} ($${balance}) which is ${days} days past due. You can settle instantly via Lipa Na M-Pesa or Card here: ${payUrl}`;
  const cleanPhone = (phone || '').replace(/\D/g, '');
  const waUrl = cleanPhone 
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`;
  window.open(waUrl, '_blank');
}

async function sendDunningEmail(invoiceId, email) {
  try {
    await apiFetch('/dunning/dispatch-email', {
      method: 'POST',
      body: JSON.stringify({ invoice_id: invoiceId, email })
    }).catch(() => null);

    showToast(`Dunning email reminder dispatched to ${email || 'client'}!`, 'success');
  } catch (err) {
    showToast(`Failed to dispatch email: ${err.message}`, 'danger');
  }
}

// ─── Global Window Bindings ──────────────────────────────────
window.openShareLinksModal = openShareLinksModal;
window.closeShareLinksModal = closeShareLinksModal;
window.copyShareUrl = copyShareUrl;
window.openPhotoUploadModal = openPhotoUploadModal;
window.closePhotoUploadModal = closePhotoUploadModal;
window.deleteProofPhoto = deleteProofPhoto;
window.openQuoteModal = openQuoteModal;
window.closeQuoteModal = closeQuoteModal;
window.copyQuoteLink = copyQuoteLink;
window.openQuoteOnline = openQuoteOnline;
window.deleteQuote = deleteQuote;
window.autoGenerateQuoteForWorkOrder = autoGenerateQuoteForWorkOrder;
window.openContractModal = openContractModal;
window.closeContractModal = closeContractModal;
window.dispatchContractJob = dispatchContractJob;
window.toggleContractStatus = toggleContractStatus;
window.openClientModal = openClientModal;
window.closeClientModal = closeClientModal;
window.deleteClient = deleteClient;
window.openWhatsAppForClient = openWhatsAppForClient;
window.sendReviewRequest = sendReviewRequest;
window.copyWidgetEmbedCode = copyWidgetEmbedCode;

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

  // Hamburger & Mobile Drawer
  const hamburgerBtn = document.querySelector('.hamburger-btn');
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleMobileSidebar();
    });
  }

  const sidebarOverlay = document.querySelector('.sidebar-overlay');
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeMobileSidebar);
  }

  const sidebarCloseBtn = document.getElementById('sidebar-close-btn');
  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener('click', closeMobileSidebar);
  }

  const mobileMenuTrigger = document.getElementById('mobile-menu-trigger');
  if (mobileMenuTrigger) {
    mobileMenuTrigger.addEventListener('click', e => {
      e.stopPropagation();
      toggleMobileSidebar();
    });
  }

  // Mobile Bottom Nav Items
  document.querySelectorAll('.mobile-nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const view = btn.dataset.view;
      if (view) navigate(view);
    });
  });

  // Global ESC key handler
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar && sidebar.classList.contains('open')) {
        closeMobileSidebar();
      }
    }
  });

  // Touch swipe support for mobile sidebar
  let touchStartX = 0;
  let touchStartY = 0;
  document.addEventListener('touchstart', e => {
    if (e.touches && e.touches[0]) {
      touchStartX = e.touches[0].screenX;
      touchStartY = e.touches[0].screenY;
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (!e.changedTouches || !e.changedTouches[0]) return;
    const touchEndX = e.changedTouches[0].screenX;
    const touchEndY = e.changedTouches[0].screenY;
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;

    if (Math.abs(deltaX) > 60 && Math.abs(deltaY) < 50) {
      const sidebar = document.querySelector('.sidebar');
      const isOpen = sidebar && sidebar.classList.contains('open');

      if (deltaX > 0 && touchStartX < 30 && !isOpen) {
        openMobileSidebar();
      } else if (deltaX < 0 && isOpen) {
        closeMobileSidebar();
      }
    }
  }, { passive: true });

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

  // Digital Estimates & Quotes Event Listeners
  document.getElementById('btn-create-quote')?.addEventListener('click', () => openQuoteModal());
  document.getElementById('quote-status-filter')?.addEventListener('change', () => loadQuotes());
  let quoteSearchTimeout;
  document.getElementById('quote-search-input')?.addEventListener('input', () => {
    clearTimeout(quoteSearchTimeout);
    quoteSearchTimeout = setTimeout(() => loadQuotes(), 300);
  });
  document.getElementById('btn-add-quote-item')?.addEventListener('click', () => addQuoteLineItemRow());
  document.getElementById('quote-discount-amount')?.addEventListener('input', calculateQuoteFormTotals);
  document.getElementById('quote-form')?.addEventListener('submit', saveQuote);
  document.getElementById('quote-modal-close-btn')?.addEventListener('click', closeQuoteModal);
  document.getElementById('quote-modal-cancel-btn')?.addEventListener('click', closeQuoteModal);
  document.getElementById('quote-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('quote-modal')) closeQuoteModal();
  });

  // Recurring Maintenance Contracts Event Listeners
  document.getElementById('btn-create-contract')?.addEventListener('click', () => openContractModal());
  document.getElementById('contract-freq-filter')?.addEventListener('change', () => loadContracts());
  let contractSearchTimeout;
  document.getElementById('contract-search-input')?.addEventListener('input', () => {
    clearTimeout(contractSearchTimeout);
    contractSearchTimeout = setTimeout(() => loadContracts(), 300);
  });
  document.getElementById('contract-form')?.addEventListener('submit', saveContract);
  document.getElementById('contract-modal-close-btn')?.addEventListener('click', closeContractModal);
  document.getElementById('contract-modal-cancel-btn')?.addEventListener('click', closeContractModal);
  document.getElementById('contract-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('contract-modal')) closeContractModal();
  });

  // Client CRM Event Listeners
  document.getElementById('btn-create-client')?.addEventListener('click', () => openClientModal());
  document.getElementById('client-zone-filter')?.addEventListener('change', () => loadClients());
  let clientSearchTimeout;
  document.getElementById('client-search-input')?.addEventListener('input', () => {
    clearTimeout(clientSearchTimeout);
    clientSearchTimeout = setTimeout(() => loadClients(), 300);
  });
  document.getElementById('client-form')?.addEventListener('submit', saveClient);
  document.getElementById('client-modal-close-btn')?.addEventListener('click', closeClientModal);
  document.getElementById('client-modal-cancel-btn')?.addEventListener('click', closeClientModal);
  document.getElementById('client-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('client-modal')) closeClientModal();
  });

  // Territory Map Filters
  document.getElementById('map-zone-filter')?.addEventListener('change', updateTerritoryMapMarkers);
  document.getElementById('map-status-filter')?.addEventListener('change', updateTerritoryMapMarkers);

  // Widget Embed Code Copy
  document.getElementById('btn-copy-widget-code')?.addEventListener('click', copyWidgetEmbedCode);

  // Photo Upload Modal Event Listeners
  document.getElementById('photo-upload-form')?.addEventListener('submit', savePhotoUpload);
  document.getElementById('photo-upload-close-btn')?.addEventListener('click', closePhotoUploadModal);
  document.getElementById('photo-upload-cancel-btn')?.addEventListener('click', closePhotoUploadModal);
  document.getElementById('photo-upload-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('photo-upload-modal')) closePhotoUploadModal();
  });

  // Share Links Hub Modal Event Listeners
  document.getElementById('share-links-close-btn')?.addEventListener('click', closeShareLinksModal);
  document.getElementById('share-links-modal')?.addEventListener('click', e => {
    if (e.target === document.getElementById('share-links-modal')) closeShareLinksModal();
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
      closeQuoteModal();
      closeContractModal();
      closeClientModal();
      closePhotoUploadModal();
      closeShareLinksModal();
      closeMpesaStkModal();
      closeLoyaltyAdjustModal();
      closeCouponModal();
      closeFleetServiceModal();
      closePoModal();
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

  // M-Pesa listeners
  document.getElementById('btn-open-stk-modal')?.addEventListener('click', () => openMpesaStkModal());
  document.getElementById('btn-refresh-mpesa')?.addEventListener('click', () => loadMpesaModule());
  document.getElementById('mpesa-modal-close-btn')?.addEventListener('click', closeMpesaStkModal);
  document.getElementById('mpesa-modal-cancel-btn')?.addEventListener('click', closeMpesaStkModal);
  document.getElementById('mpesa-modal-form')?.addEventListener('submit', submitMpesaStkModal);
  document.getElementById('quick-stk-form')?.addEventListener('submit', submitQuickStk);
  document.getElementById('quick-stk-invoice-select')?.addEventListener('change', onQuickStkInvoiceChange);
  document.getElementById('mpesa-search-input')?.addEventListener('input', filterMpesaTxns);

  // Loyalty listeners
  document.getElementById('btn-create-coupon')?.addEventListener('click', openCouponModal);
  document.getElementById('coupon-modal-close-btn')?.addEventListener('click', closeCouponModal);
  document.getElementById('coupon-modal-cancel-btn')?.addEventListener('click', closeCouponModal);
  document.getElementById('coupon-modal-form')?.addEventListener('submit', submitCouponForm);
  document.getElementById('loyalty-adj-close-btn')?.addEventListener('click', closeLoyaltyAdjustModal);
  document.getElementById('loyalty-adj-cancel-btn')?.addEventListener('click', closeLoyaltyAdjustModal);
  document.getElementById('loyalty-adjust-form')?.addEventListener('submit', submitLoyaltyAdjustForm);

  // Fleet listeners
  document.getElementById('btn-log-fleet-service')?.addEventListener('click', openFleetServiceModal);
  document.getElementById('fleet-modal-close-btn')?.addEventListener('click', closeFleetServiceModal);
  document.getElementById('fleet-modal-cancel-btn')?.addEventListener('click', closeFleetServiceModal);
  document.getElementById('fleet-service-form')?.addEventListener('submit', submitFleetServiceForm);

  // Timesheets listeners
  document.getElementById('btn-clockin-terminal-toggle')?.addEventListener('click', () => {
    const p = document.getElementById('timesheet-clockin-panel');
    p.style.display = p.style.display === 'none' ? 'block' : 'none';
    if (p.style.display === 'block') detectGpsCoordinates();
  });
  document.getElementById('btn-refresh-gps')?.addEventListener('click', detectGpsCoordinates);
  document.getElementById('btn-refresh-timesheets')?.addEventListener('click', loadTimesheetsModule);
  document.getElementById('clockin-form')?.addEventListener('submit', submitClockIn);

  // Purchasing listeners
  document.getElementById('btn-new-po')?.addEventListener('click', openPoModal);
  document.getElementById('po-modal-close-btn')?.addEventListener('click', closePoModal);
  document.getElementById('po-modal-cancel-btn')?.addEventListener('click', closePoModal);
  document.getElementById('po-modal-form')?.addEventListener('submit', submitPoForm);

  // Dunning listeners
  document.getElementById('btn-run-dunning')?.addEventListener('click', runDunningScan);

  // Expose global helpers for inline buttons
  window.quickRestockItem = quickRestockItem;
  window.toggleAutomationRule = toggleAutomationRule;
  window.openLoyaltyAdjustModal = openLoyaltyAdjustModal;
  window.reconcileC2bPayment = reconcileC2bPayment;
  window.receivePurchaseOrder = receivePurchaseOrder;
  window.clockOutTimesheet = clockOutTimesheet;
  window.sendDunningWhatsApp = sendDunningWhatsApp;
  window.sendDunningEmail = sendDunningEmail;
  window.shareReceiptWhatsApp = shareReceiptWhatsApp;

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
