/**
 * Core API Routes (Async/Await for PostgreSQL)
 * 
 * POST /api/register       - Register new user
 * POST /api/login           - Login
 * POST /api/logout          - Logout
 * POST /api/slots           - Create/update slots
 * DELETE /api/slots         - Delete a slot
 * GET  /api/slots/:email/:date - Get slots for user/date
 * POST /api/submit          - Submit annotation (idempotent)
 * GET  /api/day/:email/:date - Get day record
 * GET  /api/history/:email  - Paginated history
 * GET  /api/dashboard       - Global dashboard
 * GET  /api/submissions     - All submissions (admin)
 * POST /api/reprocess       - Reprocess day aggregates (admin)
 * GET  /api/export/:email/:date - Download XLSX
 * GET  /api/audit           - Audit logs (admin)
 * GET  /api/me              - Current user info
 */

import { Router } from 'express';
import { 
  createUser, getUserByEmail, getAllUsers,
  upsertSlot, getSlots, getSlotCount, deleteSlot,
  insertSubmission, getSubmission, getSubmissionsByUserDate,
  getDayRecord, getUserHistory, getUserHistoryByRange,
  getAllSubmissions, addAuditLog, getAuditLogs,
  createShareLink, getShareLink, getUserShareLinks, revokeShareLink,
  getActiveShareLinkCount, recomputeDayRecordFromSubmissions,
  queryAll, queryOne, runSql
} from '../db/database.js';
import { createShortLink, deleteShortLink } from '../services/urlShortener.js';
import { assignSlot, validateSlot, checkSlotOverlap } from '../services/slotAssignment.js';
import { getDashboardMetrics, reprocessDate } from '../services/aggregation.js';
import { requireAuth, requireAdmin, isValidEmail, isValidDate, isValidPasswordStrength, getPasswordFeedback, hashPassword, verifyPassword } from '../middleware/auth.js';
import crypto from 'crypto';

const router = Router();

function canAccessEmail(req, email) {
  return req.user?.role === 'admin' || req.user?.email === email;
}

function parseInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

// ─── Health Check ──────────────────────────────────────────────────────────────

router.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Auth Routes ───────────────────────────────────────────────────────────────

router.post('/api/register', async (req, res) => {
  try {
    const { email, displayName, password, timezone } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const safeDisplayName = typeof displayName === 'string' ? displayName.trim() : '';
    const safeTimezone = typeof timezone === 'string' && timezone.trim() ? timezone.trim() : 'UTC';

    if (!normalizedEmail || !safeDisplayName || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email, display name, and password are required' });
    }

    if (safeDisplayName.length > 100) {
      return res.status(400).json({ error: 'Display name must be 100 characters or fewer' });
    }

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    if (!isValidPasswordStrength(password)) {
      const issues = getPasswordFeedback(password);
      return res.status(400).json({ 
        error: 'Password must contain: ' + issues.join(', ')
      });
    }

    const existing = await getUserByEmail(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = hashPassword(password);
    await createUser(normalizedEmail, safeDisplayName, passwordHash, safeTimezone);

    await addAuditLog('user_registered', normalizedEmail, null, { displayName: safeDisplayName });

    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.status(500).json({ error: 'Registration failed' });
      }

      // Auto-login after registration
      req.session.user = {
        email: normalizedEmail,
        displayName: safeDisplayName,
        timezone: safeTimezone,
        role: 'annotator'
      };

      // Explicitly save session to store before responding
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.status(500).json({ error: 'Registration failed' });
        }
        res.json({ success: true, user: req.session.user });
      });
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

    if (!normalizedEmail || typeof password !== 'string') {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await getUserByEmail(normalizedEmail);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Regenerate session ID to prevent session fixation attacks
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regeneration error:', err);
        return res.status(500).json({ error: 'Login failed' });
      }

      req.session.user = {
        email: user.email,
        displayName: user.display_name,
        timezone: user.timezone,
        role: user.role
      };

      // Explicitly save session to store before responding
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('Session save error:', saveErr);
          return res.status(500).json({ error: 'Login failed' });
        }

        addAuditLog('user_login', normalizedEmail, null, null)
          .catch(auditErr => console.error('Login audit error:', auditErr));

        res.json({ success: true, user: req.session.user });
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/api/logout', (req, res) => {
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  };
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid', cookieOptions);
    res.json({ success: true });
  });
});

router.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ─── Slot Routes ───────────────────────────────────────────────────────────────

router.post('/api/slots', requireAuth, async (req, res) => {
  try {
    const { date, slotIndex, startTime, endTime, startUtc, endUtc } = req.body;
    const userEmail = req.user.email;
    const normalizedSlotIndex = Number(slotIndex);

    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    if (!Number.isInteger(normalizedSlotIndex) || normalizedSlotIndex < 1 || normalizedSlotIndex > 4) {
      return res.status(400).json({ error: 'Slot index must be 1-4' });
    }

    // Validate slot times
    const validation = validateSlot(startUtc, endUtc);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Check max 4 slots
    const count = await getSlotCount(userEmail, date);
    const existingSlots = await getSlots(userEmail, date);
    const isUpdate = existingSlots.some(s => s.slot_index === normalizedSlotIndex);
    
    if (!isUpdate && count >= 4) {
      return res.status(400).json({ error: 'Maximum 4 slots per day' });
    }

    // Check overlap
    const overlap = checkSlotOverlap({ start_utc: startUtc, end_utc: endUtc }, existingSlots, normalizedSlotIndex);
    if (overlap.overlaps) {
      return res.status(400).json({ error: `Slot overlaps with Slot ${overlap.conflictWith}` });
    }

    await upsertSlot(userEmail, date, normalizedSlotIndex, startTime, endTime, startUtc, endUtc);

    await addAuditLog('slot_created', userEmail, null, { date, slotIndex: normalizedSlotIndex, startTime, endTime });

    // Broadcast update
    if (req.app.io) {
      req.app.io.to(`user:${userEmail}`).emit('slots_updated', { userEmail, date });
      req.app.io.to(`dashboard:${date}`).emit('slots_updated', { userEmail, date });
    }

    res.json({ success: true, slots: await getSlots(userEmail, date) });
  } catch (err) {
    console.error('Slot creation error:', err);
    res.status(500).json({ error: 'Failed to create slot' });
  }
});

router.delete('/api/slots', requireAuth, async (req, res) => {
  try {
    const { date, slotIndex } = req.body;
    const userEmail = req.user.email;
    const normalizedSlotIndex = Number(slotIndex);

    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    if (!Number.isInteger(normalizedSlotIndex) || normalizedSlotIndex < 1 || normalizedSlotIndex > 4) {
      return res.status(400).json({ error: 'Slot index must be 1-4' });
    }

    await deleteSlot(userEmail, date, normalizedSlotIndex);
    await addAuditLog('slot_deleted', userEmail, null, { date, slotIndex: normalizedSlotIndex });

    res.json({ success: true, slots: await getSlots(userEmail, date) });
  } catch (err) {
    console.error('Slot deletion error:', err);
    res.status(500).json({ error: 'Failed to delete slot' });
  }
});

router.get('/api/slots/:email/:date', requireAuth, async (req, res) => {
  try {
    const { email, date } = req.params;
    if (!isValidEmail(email) || !isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid email or date' });
    }
    if (!canAccessEmail(req, email)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const slots = await getSlots(email, date);
    res.json({ slots });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

// ─── Submission Route ──────────────────────────────────────────────────────────

router.post('/api/submit', requireAuth, async (req, res) => {
  try {
    const {
      submission_id,
      date,
      task_id,
      type,
      is_dispute,
      questions_count,
      return_confirmed
    } = req.body;
    const userEmail = req.user.email;

    // Validation
    if (!submission_id || typeof submission_id !== 'string' || submission_id.length > 100) {
      return res.status(400).json({ error: 'Submission ID (idempotency key) is required' });
    }

    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    if (!task_id || typeof task_id !== 'string' || task_id.trim().length === 0 || task_id.trim().length > 100) {
      return res.status(400).json({ error: 'Task ID is required' });
    }

    if (!['fresh', 'return'].includes(type)) {
      return res.status(400).json({ error: 'Type must be "fresh" or "return"' });
    }

    const qCount = Number(questions_count);
    if (!Number.isInteger(qCount) || qCount < 1 || qCount > 9999) {
      return res.status(400).json({ error: 'Questions count must be a whole number between 1 and 9999' });
    }

    // Business rule: return + questions > 10 requires confirmation
    if (type === 'return' && qCount > 10 && !return_confirmed) {
      return res.status(422).json({ 
        error: 'confirmation_required',
        message: 'You selected return with more than 10 questions. Confirm this is a return task.'
      });
    }

    // Idempotency check
    const existing = await getSubmission(submission_id);
    if (existing) {
      // Return the existing submission result (idempotent)
      return res.json({ 
        success: true, 
        duplicate: true, 
        submission: existing,
        message: 'Submission already processed'
      });
    }

    // Get slots and assign
    const slots = await getSlots(userEmail, date);
    const timestampUtc = new Date().toISOString();
    const { slotIndex, rule } = assignSlot(timestampUtc, slots);

    if (slotIndex === null) {
      return res.status(400).json({ error: 'No time slots defined for this date. Please add slots first.' });
    }

    // Insert submission
    const submission = {
      submission_id,
      user_email: userEmail,
      date,
      timestamp_utc: timestampUtc,
      task_id: task_id.trim(),
      type,
      is_dispute: type === 'return' ? !!is_dispute : false,
      questions_count: qCount,
      assigned_slot_index: slotIndex,
      return_confirmed: type === 'return' ? !!return_confirmed : false
    };

    await insertSubmission(submission);

    // Recompute day record from submissions
    let dayResult;
    try {
      dayResult = await recomputeDayRecordFromSubmissions(userEmail, date);
    } catch (aggErr) {
      console.error('[Submit] AGGREGATION ERROR:', aggErr);
      dayResult = { freshSlots: [0,0,0,0], returnSlots: [0,0,0,0], grandFresh: 0, grandReturn: 0 };
    }

    // Audit log
    await addAuditLog('submission_accepted', userEmail, submission_id, {
      task_id, type, questions_count: qCount, assigned_slot: slotIndex, rule
    });

    // Broadcast real-time update
    if (req.app.io) {
      const newSubmissionPayload = {
        userEmail,
        date,
        submission,
        dayRecord: dayResult,
        slotRule: rule
      };
      req.app.io.to(`user:${userEmail}`).emit('submission_new', newSubmissionPayload);
      req.app.io.to(`dashboard:${date}`).emit('submission_new', newSubmissionPayload);

      // Push full payload to shared link viewers
      try {
        const activeLinks = (await getUserShareLinks(userEmail))
          .filter(l => l.date === date && !l.is_revoked && new Date(l.expires_at) > new Date());
        if (activeLinks.length > 0) {
          const slotsData = await getSlots(userEmail, date);
          const submissionsData = await getSubmissionsByUserDate(userEmail, date);
          const user = await getUserByEmail(userEmail);
          const sharedPayload = {
            owner: user?.display_name || userEmail,
            date,
            dayRecord: dayResult,
            slots: slotsData,
            submissions: submissionsData.map(s => ({
              task_id: s.task_id,
              type: s.type,
              questions_count: s.questions_count,
              assigned_slot_index: s.assigned_slot_index,
              timestamp_utc: s.timestamp_utc
            }))
          };
          for (const link of activeLinks) {
            req.app.io.to(`shared:${link.token}`).emit('shared_update', sharedPayload);
          }
        }
      } catch (shareErr) {
        console.error('[WS] Share broadcast error:', shareErr);
      }
    }

    res.json({
      success: true,
      submission: {
        ...submission,
        assigned_slot_rule: rule
      },
      dayRecord: dayResult
    });
  } catch (err) {
    console.error('Submission error:', err);
    res.status(500).json({ error: 'Submission failed' });
  }
});

// ─── Day Record / History Routes ───────────────────────────────────────────────

router.get('/api/day/:email/:date', requireAuth, async (req, res) => {
  try {
    const { email, date } = req.params;
    if (!isValidEmail(email) || !isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid email or date' });
    }
    if (!canAccessEmail(req, email)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const dayRecord = await getDayRecord(email, date);
    const submissions = await getSubmissionsByUserDate(email, date);
    const slots = await getSlots(email, date);

    res.json({ dayRecord, submissions, slots });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch day record' });
  }
});

router.get('/api/history/:email', requireAuth, async (req, res) => {
  try {
    const { email } = req.params;
    const { startDate, endDate, limit = 30, offset = 0 } = req.query;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (!canAccessEmail(req, email)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if ((startDate && !isValidDate(startDate)) || (endDate && !isValidDate(endDate))) {
      return res.status(400).json({ error: 'Invalid date range' });
    }

    let history;
    if (startDate && endDate) {
      history = await getUserHistoryByRange(email, startDate, endDate);
    } else {
      history = await getUserHistory(
        email,
        parseInteger(limit, 30, { min: 1, max: 365 }),
        parseInteger(offset, 0, { min: 0 })
      );
    }

    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ─── Dashboard Route ───────────────────────────────────────────────────────────

router.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const date = req.query.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    // ISOLATION: Only fetch dashboard metrics for the logged-in user
    const metrics = await getDashboardMetrics(date, req.user.email);
    res.json({ date, ...metrics });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

router.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const date = req.query.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    // Fetch dashboard metrics for ALL users (passing null for email)
    const metrics = await getDashboardMetrics(date, null);
    res.json({ date, ...metrics });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin global dashboard' });
  }
});

// ─── Admin Routes ──────────────────────────────────────────────────────────────

router.get('/api/submissions', requireAdmin, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const submissions = await getAllSubmissions(
      parseInteger(limit, 100, { min: 1, max: 1000 }),
      parseInteger(offset, 0, { min: 0 })
    );
    res.json({ submissions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch submissions' });
  }
});

router.post('/api/reprocess', requireAdmin, async (req, res) => {
  try {
    const { date } = req.body;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    const results = await reprocessDate(date);
    await addAuditLog('reprocess_date', req.user.email, null, { date, usersProcessed: results.length });

    if (req.app.io) {
      req.app.io.to(`dashboard:${date}`).emit('dashboard_refresh', { date });

      // Also notify shared link viewers after admin reprocess
      try {
        const allUsers = await getAllUsers();
        for (const u of allUsers) {
          const links = (await getUserShareLinks(u.email))
            .filter(l => l.date === date && !l.is_revoked && new Date(l.expires_at) > new Date());
          if (links.length > 0) {
            const dayRecord = await getDayRecord(u.email, date);
            const slotsData = await getSlots(u.email, date);
            const submissionsData = await getSubmissionsByUserDate(u.email, date);
            const payload = {
              owner: u.display_name,
              date,
              dayRecord,
              slots: slotsData,
              submissions: submissionsData.map(s => ({
                task_id: s.task_id, type: s.type,
                questions_count: s.questions_count,
                assigned_slot_index: s.assigned_slot_index,
                timestamp_utc: s.timestamp_utc
              }))
            };
            for (const link of links) {
              req.app.io.to(`shared:${link.token}`).emit('shared_update', payload);
            }
          }
        }
      } catch (e) { console.error('[WS] Reprocess share broadcast error:', e); }
    }

    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: 'Reprocess failed' });
  }
});

router.get('/api/audit', requireAdmin, async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const logs = await getAuditLogs(
      parseInteger(limit, 100, { min: 1, max: 1000 }),
      parseInteger(offset, 0, { min: 0 })
    );
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

router.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── Export Route ──────────────────────────────────────────────────────────────

router.get('/api/export/:email/:date', requireAuth, async (req, res) => {
  try {
    const { email, date } = req.params;
    const format = req.query.format || 'xlsx';

    if (!isValidEmail(email) || !isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid email or date' });
    }
    if (!canAccessEmail(req, email)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!['xlsx', 'csv'].includes(format)) {
      return res.status(400).json({ error: 'Format must be xlsx or csv' });
    }

    const dayRecord = await getDayRecord(email, date);
    const submissions = await getSubmissionsByUserDate(email, date);
    const slots = await getSlots(email, date);
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Dynamic import xlsx
    const XLSX = await import('xlsx');

    const numSlots = Math.max(1, ...slots.map(slot => slot.slot_index));
    const headerRow = [''];
    const freshRow = ['Fresh'];
    const returnRow = ['Return'];
    
    for (let i = 1; i <= numSlots; i++) {
      headerRow.push(`Slot ${i}`);
      freshRow.push(dayRecord ? dayRecord[`slot${i}_fresh`] : 0);
      returnRow.push(dayRecord ? dayRecord[`slot${i}_return`] : 0);
    }
    
    headerRow.push('Grand Total');
    freshRow.push(dayRecord ? dayRecord.grand_total_fresh : 0);
    returnRow.push(dayRecord ? dayRecord.grand_total_return : 0);

    const sheetData = [
      ['Date', date],
      ['Mail', email],
      [''],
      headerRow,
      freshRow,
      returnRow
    ];

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    
    const colWidths = [{ wch: 15 }];
    for (let i = 0; i <= numSlots; i++) {
      colWidths.push({ wch: 15 });
    }
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Daily Summary');

    // Add Sheet 2: Detailed Task Log — full proof-of-work with user identity
    const taskLogData = [
      ['Name', 'Mail', 'Role', 'Date', 'Task ID', 'No. of Questions', 'Type', 'Dispute Subtype', 'Time of Submission (UTC)', 'Assigned Slot', 'Return Confirmed']
    ];

    for (const s of submissions) {
      taskLogData.push([
        user.display_name,
        email,
        user.role || 'annotator',
        date,
        s.task_id,
        s.questions_count,
        s.type,
        s.is_dispute ? 'Yes' : 'No',
        s.timestamp_utc,
        s.assigned_slot_index !== null ? `Slot ${s.assigned_slot_index}` : 'Unassigned',
        s.return_confirmed ? 'Yes' : 'No'
      ]);
    }

    const wsDetails = XLSX.utils.aoa_to_sheet(taskLogData);
    const detailWidths = [
      { wch: 20 }, { wch: 28 }, { wch: 12 }, { wch: 14 },
      { wch: 22 }, { wch: 16 }, { wch: 10 }, { wch: 16 },
      { wch: 26 }, { wch: 16 }, { wch: 16 }
    ];
    wsDetails['!cols'] = detailWidths;
    XLSX.utils.book_append_sheet(wb, wsDetails, 'Task Details Log');

    if (format === 'csv') {
      const csv = XLSX.utils.sheet_to_csv(ws);
      
      // PURGE database submissions for this user & date on download success
      if (submissions.length > 0) {
        const subIds = submissions.map(s => s.submission_id);
        await runSql('DELETE FROM submissions WHERE submission_id = ANY($1)', [subIds]);
      }
      
      // Audit log
      await addAuditLog('user_export_purge', email, null, { date, format, submissionsPurged: submissions.length });
      
      // Build filename: Name_DDMMYY.csv
      const safeName = user.display_name.replace(/[^a-zA-Z0-9]/g, '') || 'Report';
      const [y, m, d] = date.split('-');
      const dateTag = `${d}${m}${y.slice(2)}`; // DDMMYY

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${dateTag}.csv"`);
      return res.send(csv);
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // PURGE database submissions for this user & date on download success
    if (submissions.length > 0) {
      const subIds = submissions.map(s => s.submission_id);
      await runSql('DELETE FROM submissions WHERE submission_id = ANY($1)', [subIds]);
    }

    // Audit log
    await addAuditLog('user_export_purge', email, null, { date, format, submissionsPurged: submissions.length });

    // Build filename: Name_DDMMYY.xlsx
    const safeName = user.display_name.replace(/[^a-zA-Z0-9]/g, '') || 'Report';
    const [y, m, d] = date.split('-');
    const dateTag = `${d}${m}${y.slice(2)}`; // DDMMYY

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${dateTag}.xlsx"`);
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ─── Share Link Routes ─────────────────────────────────────────────────────────

/**
 * POST /api/share — Create a shareable public link for a user's day dashboard.
 * Body: { date, label?, expiresInHours? }
 * Returns: { token, url, shortUrl, expiresAt }
 */
router.post('/api/share', requireAuth, async (req, res) => {
  try {
    const { date, label, expiresInHours = 24 } = req.body;
    const userEmail = req.user.email;
    const displayName = req.user.displayName || userEmail.split('@')[0];
    const safeLabel = typeof label === 'string' ? label : undefined;

    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    // Per-user active link cap to prevent mass generation abuse
    const MAX_ACTIVE_LINKS = 10;
    const activeCount = await getActiveShareLinkCount(userEmail);
    if (activeCount >= MAX_ACTIVE_LINKS) {
      return res.status(429).json({ 
        error: `Maximum ${MAX_ACTIVE_LINKS} active share links allowed. Revoke an existing link first.` 
      });
    }

    // Clamp expiry: minimum 1 hour, maximum 7 days (168 hours)
    const hours = parseInteger(expiresInHours, 24, { min: 1, max: 168 });
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

    // Generate a cryptographically secure URL-safe token
    const token = crypto.randomBytes(32).toString('base64url');

    await createShareLink(token, userEmail, date, safeLabel, expiresAt);
    
    // Generate short URL slug
    const slug = await createShortLink(token, userEmail);
    
    await addAuditLog('share_created', userEmail, null, { date, slug, expiresAt });

    // Build the full shareable URLs
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('host');
    // URL-safe version of the display name (lowercase, no spaces/special chars)
    const urlName = displayName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'user';
    const longUrl = `${protocol}://${host}/shared/${token}`;
    const shortUrl = `${protocol}://${host}/s/${urlName}/${slug}`;

    res.json({
      success: true,
      token,
      slug,
      url: shortUrl,        // Short personalized URL is primary
      longUrl,              // Long URL as fallback
      shortUrl,
      expiresAt,
      date
    });
  } catch (err) {
    console.error('Share creation error:', err);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

/**
 * GET /api/shares — Get all share links for the current user.
 */
router.get('/api/shares', requireAuth, async (req, res) => {
  try {
    const links = await getUserShareLinks(req.user.email);
    res.json({ links });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch share links' });
  }
});

/**
 * DELETE /api/share/:token — Revoke a share link.
 */
router.delete('/api/share/:token', requireAuth, async (req, res) => {
  try {
    const token = req.params.token;
    if (!token || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    await revokeShareLink(token, req.user.email);
    
    // Also find and delete the short link
    try {
      const shortLink = await queryOne(
        'SELECT slug FROM short_links WHERE token = $1',
        [token]
      );
      if (shortLink) {
        await deleteShortLink(shortLink.slug);
      }
    } catch (e) {
      console.warn('[API] Failed to clean short link:', e.message);
    }
    
    await addAuditLog('share_revoked', req.user.email, null, { token: token.slice(0, 8) + '...' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke share link' });
  }
});

/**
 * GET /api/shared/:token — PUBLIC endpoint (no auth).
 * Returns the dashboard data for the shared link.
 */
router.get('/api/shared/:token', async (req, res) => {
  try {
    // Validate token format before DB query (prevent junk queries)
    const token = req.params.token;
    if (!token || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      return res.status(400).json({ error: 'Invalid token format' });
    }

    const link = await getShareLink(token);

    if (!link) {
      return res.status(404).json({ error: 'Share link not found, expired, or revoked' });
    }

    const { user_email, date, display_name, expires_at } = link;
    const dayRecord = await getDayRecord(user_email, date);
    const slots = await getSlots(user_email, date);
    const submissions = await getSubmissionsByUserDate(user_email, date);

    res.json({
      owner: display_name,
      date,
      expiresAt: expires_at,
      dayRecord,
      slots,
      submissions: submissions.map(s => ({
        task_id: s.task_id,
        type: s.type,
        questions_count: s.questions_count,
        assigned_slot_index: s.assigned_slot_index,
        timestamp_utc: s.timestamp_utc
      }))
    });
  } catch (err) {
    console.error('Shared data error:', err);
    res.status(500).json({ error: 'Failed to fetch shared data' });
  }
});

/**
 * GET /api/resolve/:slug — PUBLIC endpoint.
 * Resolves a short URL slug to the full share token.
 * Returns the token so client can redirect to /shared/:token
 */
router.get('/api/resolve/:slug', async (req, res) => {
  try {
    const { resolveShortLink } = await import('../services/urlShortener.js');
    const slug = req.params.slug;
    
    if (!slug || slug.length > 20 || !/^[a-zA-Z0-9]+$/.test(slug)) {
      return res.status(400).json({ error: 'Invalid slug format' });
    }
    
    const resolved = await resolveShortLink(slug);
    
    if (!resolved) {
      return res.status(404).json({ error: 'Short link not found' });
    }
    
    res.json({
      success: true,
      token: resolved.token,
      created: resolved.created
    });
  } catch (err) {
    console.error('Short link resolution error:', err);
    res.status(500).json({ error: 'Failed to resolve short link' });
  }
});

// ─── Admin Export & Purge Route ────────────────────────────────────────────────
/**
 * GET /api/admin/export-purge
 * Downloads today's master report (Summary + detailed submissions) for all users,
 * and clears the raw submissions table from the database to keep storage free.
 */
router.get('/api/admin/export-purge', requireAdmin, async (req, res) => {
  try {
    const { date } = req.query;
    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD' });
    }

    // 1. Fetch all submissions for the date
    const submissions = await queryAll(
      'SELECT * FROM submissions WHERE date = $1 ORDER BY user_email, timestamp_utc',
      [date]
    );

    if (submissions.length === 0) {
      return res.status(404).json({ error: `No submissions found for ${date}` });
    }

    // 2. Fetch all day records for the date
    const dayRecords = await queryAll(
      `SELECT dr.*, u.display_name FROM day_records dr 
       JOIN users u ON dr.user_email = u.email 
       WHERE dr.date = $1 ORDER BY dr.user_email`,
      [date]
    );

    // 3. Fetch all slots for the date
    const slots = await queryAll(
      'SELECT * FROM slots WHERE date = $1 ORDER BY user_email, slot_index',
      [date]
    );

    // Dynamic import xlsx
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();

    // --- SHEET 1: SUMMARY DASHBOARD ---
    const summaryData = [
      ['Date', date],
      ['Master Summary Report (All Users)'],
      [''],
      ['Email', 'Display Name', 'S1 Fresh', 'S2 Fresh', 'S3 Fresh', 'S4 Fresh', 'Total Fresh', 'S1 Return', 'S2 Return', 'S3 Return', 'S4 Return', 'Total Return', 'Grand Total']
    ];

    for (const dr of dayRecords) {
      const grandTotal = dr.grand_total_fresh + dr.grand_total_return;
      summaryData.push([
        dr.user_email,
        dr.display_name,
        dr.slot1_fresh,
        dr.slot2_fresh,
        dr.slot3_fresh,
        dr.slot4_fresh,
        dr.grand_total_fresh,
        dr.slot1_return,
        dr.slot2_return,
        dr.slot3_return,
        dr.slot4_return,
        dr.grand_total_return,
        grandTotal
      ]);
    }

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Daily Summary');

    // --- SHEET 2: DETAILED SUBMISSIONS ---
    const submissionData = [
      ['Submission ID', 'User Email', 'Timestamp (UTC)', 'Task ID', 'Type', 'Dispute', 'Questions', 'Slot Index', 'Return Confirmed']
    ];

    for (const sub of submissions) {
      submissionData.push([
        sub.submission_id,
        sub.user_email,
        sub.timestamp_utc,
        sub.task_id,
        sub.type,
        sub.is_dispute ? 'Yes' : 'No',
        sub.questions_count,
        sub.assigned_slot_index || 'Unassigned',
        sub.return_confirmed ? 'Yes' : 'No'
      ]);
    }

    const wsDetails = XLSX.utils.aoa_to_sheet(submissionData);
    XLSX.utils.book_append_sheet(wb, wsDetails, 'Raw Submissions Log');

    // Generate buffer
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // 4. PURGE Submissions for this date ONLY AFTER generating Excel successfully
    if (submissions.length > 0) {
      const subIds = submissions.map(s => s.submission_id);
      await runSql('DELETE FROM submissions WHERE submission_id = ANY($1)', [subIds]);
    }

    // 5. Add Audit Log
    await addAuditLog('export_purge_completed', req.user.email, null, {
      date,
      submissionsPurged: submissions.length,
      summaryRecords: dayRecords.length
    });

    // 6. Send the file — filename: MASTER_DDMMYY.xlsx
    const [y, m, d] = date.split('-');
    const dateTag = `${d}${m}${y.slice(2)}`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="MASTER_${dateTag}.xlsx"`);
    res.send(Buffer.from(buf));

  } catch (err) {
    console.error('Export & Purge error:', err);
    res.status(500).json({ error: 'Export and purge failed' });
  }
});

export default router;
