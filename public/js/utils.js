/**
 * Shared Utilities for Annotation Tracker Pro
 */

// ─── API Helper ─────────────────────────────────────────────────────────────────

async function api(url, options = {}) {
  const defaults = {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  };
  const config = { ...defaults, ...options };
  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, config);
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

// ─── Toast Notifications ────────────────────────────────────────────────────────

function showToast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  
  // Use textContent to prevent XSS attacks
  const iconSpan = document.createElement('span');
  iconSpan.textContent = icons[type] || 'ℹ';
  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  
  toast.appendChild(iconSpan);
  toast.appendChild(msgSpan);
  
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = '0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Modal ──────────────────────────────────────────────────────────────────────

function showModal({ icon = '⚠️', title, text, confirmText = 'Confirm', cancelText = 'Cancel', onConfirm, onCancel }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  
  const modal = document.createElement('div');
  modal.className = 'modal';
  
  const iconDiv = document.createElement('div');
  iconDiv.className = 'modal-icon';
  iconDiv.textContent = icon;
  
  const titleDiv = document.createElement('div');
  titleDiv.className = 'modal-title';
  titleDiv.textContent = title;
  
  const textDiv = document.createElement('div');
  textDiv.className = 'modal-text';
  textDiv.textContent = text;
  
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'modal-actions';
  
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.id = 'modal-cancel';
  cancelBtn.textContent = cancelText;
  
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn btn-primary';
  confirmBtn.id = 'modal-confirm';
  confirmBtn.textContent = confirmText;
  
  actionsDiv.appendChild(cancelBtn);
  actionsDiv.appendChild(confirmBtn);
  
  modal.appendChild(iconDiv);
  modal.appendChild(titleDiv);
  modal.appendChild(textDiv);
  modal.appendChild(actionsDiv);
  
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  
  overlay.querySelector('#modal-confirm').onclick = () => {
    overlay.remove();
    if (onConfirm) onConfirm();
  };
  overlay.querySelector('#modal-cancel').onclick = () => {
    overlay.remove();
    if (onCancel) onCancel();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); if (onCancel) onCancel(); }
  });
}

// ─── Date Utilities ─────────────────────────────────────────────────────────────

function getTodayISO() {
  // Use Asia/Kolkata timezone and treat hours before 5 AM as previous day's shift
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', hour12: false
  });
  const parts = istFormatter.formatToParts(now);
  const partMap = {};
  parts.forEach(p => partMap[p.type] = p.value);
  
  const hour = parseInt(partMap.hour, 10);
  let dt = new Date(`${partMap.year}-${partMap.month}-${partMap.day}T00:00:00Z`);
  
  // If it's before 5 AM, consider it the previous day's shift
  if (hour < 5) {
    dt.setUTCDate(dt.getUTCDate() - 1);
  }
  
  return dt.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTime12(time24) {
  if (!time24) return '';
  const [h, m] = time24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function localToUTC(dateStr, timeStr, addDays = 0) {
  // Force interpretation as Indian Standard Time (UTC+05:30)
  const dt = new Date(`${dateStr}T${timeStr}:00+05:30`);
  if (addDays > 0) dt.setDate(dt.getDate() + addDays);
  return dt.toISOString();
}

// ─── UUID Generator ─────────────────────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ─── Escape HTML ────────────────────────────────────────────────────────────────

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Auth Check ─────────────────────────────────────────────────────────────────

async function checkAuth() {
  try {
    const data = await api('/api/me');
    return data.user;
  } catch {
    return null;
  }
}

async function requireLogin() {
  const user = await checkAuth();
  if (!user) {
    window.location.href = '/';
    return null;
  }
  return user;
}

// ─── Nav Builder ────────────────────────────────────────────────────────────────

function buildNav(user, activePage) {
  const nav = document.getElementById('top-nav');
  if (!nav) return;
  const initial = user.displayName ? user.displayName.charAt(0).toUpperCase() : '?';
  const isAdmin = user.role === 'admin';
  nav.innerHTML = `
    <div class="nav-brand">📊 PERSONAL<span>TRACKER</span></div>
    <div class="nav-links">
      <a href="/app" class="${activePage === 'app' ? 'active' : ''}">Submit</a>
      <a href="/dashboard" class="${activePage === 'dashboard' ? 'active' : ''}">Dashboard</a>
      <a href="/history" class="${activePage === 'history' ? 'active' : ''}">History</a>
      ${isAdmin ? `<a href="/admin" class="${activePage === 'admin' ? 'active' : ''}">Admin</a>` : ''}
    </div>
    <div class="nav-user">
      <span>${escapeHTML(user.displayName)}</span>
      <div class="avatar">${initial}</div>
      <button class="btn-logout" id="logout-btn">Logout</button>
    </div>
  `;
  // Attach logout handler via addEventListener (CSP-safe — no inline handler)
  document.getElementById('logout-btn').addEventListener('click', logout);
}

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (e) {
    // Even if the API call fails, redirect to login page
    console.warn('Logout API error:', e);
  }
  window.location.href = '/';
}

// ─── Socket.IO Helper ───────────────────────────────────────────────────────────

function connectSocket(userEmail, date) {
  if (typeof io === 'undefined') return null;
  const socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    console.log('[WS] Connected');
    if (userEmail) socket.emit('join_user', userEmail);
    if (date) socket.emit('join_dashboard', date);
  });
  socket.on('reconnect', () => {
    console.log('[WS] Reconnected, requesting backfill with jitter');
    const jitter = Math.floor(Math.random() * 3000); // 0-3s jitter
    setTimeout(() => {
      if (userEmail && date) socket.emit('backfill', { email: userEmail, date });
    }, jitter);
  });
  return socket;
}
