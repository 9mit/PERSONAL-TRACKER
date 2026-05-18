/**
 * App.js — Submission Form Logic (no inline handlers)
 */

let currentUser = null;
let currentDate = getTodayISO();
let currentSlots = [];
let socket = null;

(async () => {
  currentUser = await requireLogin();
  if (!currentUser) return;
  buildNav(currentUser, 'app');
  document.getElementById('work-date').value = currentDate;

  // Event listeners
  document.getElementById('work-date').addEventListener('change', onDateChange);
  document.getElementById('add-slot-btn').addEventListener('click', addSlotRow);
  document.getElementById('submit-form').addEventListener('submit', handleSubmit);
  document.getElementById('checkout-btn').addEventListener('click', handleCheckout);

  // Type selection
  document.querySelectorAll('#type-group .radio-option').forEach(opt => {
    opt.addEventListener('click', () => selectType(opt.dataset.type));
  });

  // Focus Task ID field by default for fast entry
  document.getElementById('task-id')?.focus();

  // Dispute toggle
  document.getElementById('dispute-option').addEventListener('click', toggleDispute);

  onDateChange();

  socket = connectSocket(currentUser.email, currentDate);
  if (socket) {
    socket.on('submission_new', (data) => {
      if (data.userEmail === currentUser.email && data.date === currentDate) {
        loadDayData();
        showToast('New submission recorded', 'success');
      }
    });
    socket.on('slots_updated', (data) => {
      if (data.userEmail === currentUser.email && data.date === currentDate) loadSlots();
    });
  }
})();

async function onDateChange() {
  currentDate = document.getElementById('work-date').value;
  if (!currentDate) return;
  document.getElementById('slot-date-label').textContent = formatDate(currentDate);
  document.getElementById('add-slot-btn').disabled = false;
  await loadSlots();
  await loadDayData();
}

async function loadSlots() {
  try {
    const data = await api(`/api/slots/${currentUser.email}/${currentDate}`);
    currentSlots = data.slots;
    renderSlots();
    renderSlotSummary();
  } catch (err) {
    console.error('Load slots error:', err);
  }
}

function renderSlots() {
  const container = document.getElementById('slots-container');
  if (currentSlots.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:12px">No slots configured. Click "+ Add Slot" to begin.</p>';
    return;
  }
  container.innerHTML = currentSlots.map(s => {
    const parseTime = (t24) => {
      if(!t24) return {h:'12',m:'00',a:'AM'};
      let [h, m] = t24.split(':').map(Number);
      const a = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return {h: String(h).padStart(2,'0'), m: String(m).padStart(2,'0'), a};
    };
    const st = parseTime(s.start_time);
    const et = parseTime(s.end_time);

    return `
    <div class="form-row" style="align-items:flex-end;margin-bottom:10px" data-slot="${s.slot_index}">
      <div style="min-width:70px;padding-bottom:12px">
        <span class="badge badge-fresh">Slot ${s.slot_index}</span>
      </div>
      <div class="form-group">
        <label class="form-label">Start</label>
        <div style="display:flex;gap:4px;align-items:center">
          <input class="form-input slot-start-h" type="number" min="1" max="12" value="${st.h}" style="width:52px;padding:6px;text-align:center">
          <span style="font-weight:bold">:</span>
          <input class="form-input slot-start-m" type="number" min="0" max="59" value="${st.m}" style="width:52px;padding:6px;text-align:center">
          <select class="form-select slot-start-a" style="padding:6px;width:65px">
            <option value="AM" ${st.a==='AM'?'selected':''}>AM</option>
            <option value="PM" ${st.a==='PM'?'selected':''}>PM</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">End</label>
        <div style="display:flex;gap:4px;align-items:center">
          <input class="form-input slot-end-h" type="number" min="1" max="12" value="${et.h}" style="width:52px;padding:6px;text-align:center">
          <span style="font-weight:bold">:</span>
          <input class="form-input slot-end-m" type="number" min="0" max="59" value="${et.m}" style="width:52px;padding:6px;text-align:center">
          <select class="form-select slot-end-a" style="padding:6px;width:65px">
            <option value="AM" ${et.a==='AM'?'selected':''}>AM</option>
            <option value="PM" ${et.a==='PM'?'selected':''}>PM</option>
          </select>
        </div>
      </div>
      <div style="padding-bottom:12px; display:flex; gap:4px">
        <button class="btn btn-sm btn-ghost slot-save" data-slot-index="${s.slot_index}" style="color:var(--success); font-weight:bold" title="Save slot">✓</button>
        <button class="btn btn-sm btn-ghost slot-remove" data-slot-index="${s.slot_index}" style="color:var(--danger)" title="Remove slot">✕</button>
      </div>
    </div>
    `;
  }).join('');

  // Attach event listeners to slot controls
  container.querySelectorAll('.slot-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.slotIndex);
      const row = btn.closest('.form-row');
      const start = getSlotTime(row, 'slot-start');
      const end = getSlotTime(row, 'slot-end');
      if (start && end) {
        saveSlot(idx, start, end);
      } else {
        showToast('Please fill valid start and end times', 'warning');
      }
    });
  });
  container.querySelectorAll('.slot-remove').forEach(btn => {
    btn.addEventListener('click', () => removeSlot(parseInt(btn.dataset.slotIndex)));
  });
}

function addSlotRow() {
  if (currentSlots.length >= 4) {
    showToast('Maximum 4 slots per day', 'warning');
    return;
  }
  const nextIndex = currentSlots.length + 1;
  saveSlot(nextIndex, '09:00', '11:00');
}

function getSlotTime(row, prefix) {
  let h = parseInt(row.querySelector(`.${prefix}-h`).value);
  let m = parseInt(row.querySelector(`.${prefix}-m`).value) || 0;
  const a = row.querySelector(`.${prefix}-a`).value;
  if (isNaN(h)) return null;
  if (a === 'PM' && h < 12) h += 12;
  if (a === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

async function saveSlot(slotIndex, startTime, endTime) {
  try {
    let startUtc, endUtc;
    const rows = Array.from(document.querySelectorAll('.form-row[data-slot]'));
    let currentDayOffset = 0;
    let previousTime = null;

    for (const row of rows) {
      const idx = parseInt(row.dataset.slot);
      const st = getSlotTime(row, 'slot-start');
      const et = getSlotTime(row, 'slot-end');
      
      if (!st || !et) continue;

      let stOffset = currentDayOffset;
      if (previousTime && st < previousTime) {
        currentDayOffset++;
        stOffset = currentDayOffset;
      }
      
      let etOffset = currentDayOffset;
      if (et < st) {
        etOffset = currentDayOffset + 1;
        currentDayOffset++;
      }
      previousTime = et;

      if (idx === slotIndex) {
        startUtc = localToUTC(currentDate, startTime, stOffset);
        endUtc = localToUTC(currentDate, endTime, etOffset);
      }
    }

    if (!startUtc || !endUtc) {
      startUtc = localToUTC(currentDate, startTime);
      endUtc = localToUTC(currentDate, endTime, endTime < startTime ? 1 : 0);
    }
    await api('/api/slots', {
      method: 'POST',
      body: { date: currentDate, slotIndex, startTime, endTime, startUtc, endUtc }
    });
    await loadSlots();
    showToast(`Slot ${slotIndex} saved`, 'success');
  } catch (err) {
    showToast(err.error || 'Failed to save slot', 'error');
  }
}

async function removeSlot(slotIndex) {
  try {
    await api('/api/slots', { method: 'DELETE', body: { date: currentDate, slotIndex } });
    await loadSlots();
    showToast(`Slot ${slotIndex} removed`, 'info');
  } catch (err) {
    showToast(err.error || 'Failed to remove slot', 'error');
  }
}

function renderSlotSummary() {
  const container = document.getElementById('slot-summary');
  if (currentSlots.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:16px"><p style="font-size:.8rem">No slots configured</p></div>';
    return;
  }
  container.innerHTML = currentSlots.map(s => `
    <div class="slot-chip active">
      <div class="slot-num">Slot ${s.slot_index}</div>
      <div class="slot-val" id="slot-val-${s.slot_index}">0</div>
      <div class="slot-time">${formatTime12(s.start_time)} – ${formatTime12(s.end_time)}</div>
    </div>
  `).join('');
}

// ─── Type Selection ─────────────────────────────────────────────────────────────

function selectType(type) {
  document.querySelectorAll('#type-group .radio-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.type === type);
    el.querySelector('input').checked = el.dataset.type === type;
  });
  document.getElementById('dispute-group').style.display = type === 'return' ? 'block' : 'none';
  if (type === 'fresh') {
    document.getElementById('is-dispute').checked = false;
    document.getElementById('dispute-option').classList.remove('selected');
  }
}

function toggleDispute() {
  const cb = document.getElementById('is-dispute');
  cb.checked = !cb.checked;
  document.getElementById('dispute-option').classList.toggle('selected', cb.checked);
}

// ─── Submit ─────────────────────────────────────────────────────────────────────

async function handleSubmit(e) {
  e.preventDefault();
  const type = document.querySelector('input[name="type"]:checked').value;
  const questionsCount = parseInt(document.getElementById('questions-count').value);
  const taskId = document.getElementById('task-id').value.trim();

  if (currentSlots.length === 0) {
    showToast('Please configure at least one time slot first', 'warning');
    return;
  }

  // Return confirmation check
  if (type === 'return' && questionsCount > 10) {
    showModal({
      icon: '⚠️',
      title: 'Return Task Confirmation',
      text: `You selected <strong>return</strong> with <strong>${questionsCount}</strong> questions (more than 10). Please confirm this is indeed a return task.`,
      confirmText: "Yes, it's a Return",
      cancelText: 'Cancel',
      onConfirm: () => doSubmit(taskId, type, questionsCount, true)
    });
    return;
  }

  doSubmit(taskId, type, questionsCount, false);
}

async function doSubmit(taskId, type, questionsCount, returnConfirmed) {
  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const result = await api('/api/submit', {
      method: 'POST',
      body: {
        submission_id: generateUUID(),
        date: currentDate,
        task_id: taskId,
        type,
        is_dispute: document.getElementById('is-dispute').checked,
        questions_count: questionsCount,
        return_confirmed: returnConfirmed
      }
    });

    if (result.duplicate) {
      showToast('Task already recorded (duplicate)', 'info');
    } else {
      showToast(`Task ${taskId || ''} logged successfully! (Slot ${result.submission.assigned_slot_index})`, 'success');
    }

    document.getElementById('task-id').value = '';
    // Keep questions count for convenience, but refocus task-id
    document.getElementById('task-id').focus();
    await loadDayData();
  } catch (err) {
    if (err.error === 'confirmation_required') {
      showModal({
        icon: '⚠️', title: 'Confirmation Required', text: err.message,
        confirmText: 'Confirm Return', cancelText: 'Cancel',
        onConfirm: () => doSubmit(taskId, type, questionsCount, true)
      });
    } else {
      showToast(err.error || 'Submission failed', 'error');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Annotation';
  }
}

// ─── Load Day Data ──────────────────────────────────────────────────────────────

async function loadDayData() {
  try {
    const data = await api(`/api/day/${currentUser.email}/${currentDate}`);
    const { dayRecord, submissions } = data;

    if (dayRecord) {
      for (let i = 1; i <= 4; i++) {
        const el = document.getElementById(`slot-val-${i}`);
        if (el) el.textContent = dayRecord[`slot${i}_fresh`] || 0;
      }
      document.getElementById('stat-fresh').textContent = dayRecord.grand_total_fresh || 0;
      document.getElementById('stat-return').textContent = dayRecord.grand_total_return || 0;
    } else {
      document.getElementById('stat-fresh').textContent = '0';
      document.getElementById('stat-return').textContent = '0';
    }

    const container = document.getElementById('recent-submissions');
    document.getElementById('sub-count').textContent = `${submissions.length} today`;

    if (submissions.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:16px"><div class="empty-icon">📋</div><p style="font-size:.82rem">No submissions yet</p></div>';
      return;
    }

    container.innerHTML = submissions.slice().reverse().map(s => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-size:.85rem;font-weight:600">${escapeHTML(s.task_id)}</div>
          <div style="font-size:.72rem;color:var(--text-muted)">Slot ${s.assigned_slot_index} · ${s.questions_count} questions</div>
        </div>
        <span class="badge badge-${s.type}">${s.type}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Load day data error:', err);
  }
}

async function handleCheckout() {
  if (currentSlots.length === 0) {
    showToast('You have no time slots configured for today', 'warning');
    return;
  }

  const date = currentDate;
  
  if (!confirm(`🏁 Confirm Daily Checkout:\n\nThis will download your Daily Excel spreadsheet for ${formatDate(date)} and PERMANENTLY CLEAR your raw submission task logs from the database to keep the system fast.\n\nMake sure to keep your downloaded Excel sheet safe! Do you want to proceed?`)) {
    return;
  }

  const btn = document.getElementById('checkout-btn');
  btn.disabled = true;
  btn.textContent = 'Checking out...';

  try {
    const response = await fetch(`/api/export/${currentUser.email}/${date}?format=xlsx`, { 
      credentials: 'same-origin' 
    });
    
    if (!response.ok) throw new Error('Checkout failed');
    
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; 
    const safeName = (currentUser.displayName || 'Report').replace(/[^a-zA-Z0-9]/g, '');
    const [y, m, d] = date.split('-');
    a.download = `${safeName}_${d}${m}${y.slice(2)}.xlsx`; 
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('Checkout complete! Daily report downloaded.', 'success');
    
    // Refresh the day data
    await loadDayData();
  } catch (err) {
    showToast('Checkout failed. Please try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⬇ Download XLSX & Purge Logs';
  }
}
