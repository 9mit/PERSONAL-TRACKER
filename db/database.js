/**
 * Database Layer using PostgreSQL with node-postgres (pg)
 * All operations are asynchronous.
 * Connection pooling enabled for high concurrency.
 */

import pg from 'pg';

const { Pool } = pg;

// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Max connections in pool (can handle 850k writes/day easily)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

// Log pool events
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err);
});

/**
 * Initialize the database and create schema if not exists
 */
export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        timezone TEXT DEFAULT 'UTC',
        role TEXT DEFAULT 'annotator',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create slots table
    await client.query(`
      CREATE TABLE IF NOT EXISTS slots (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        date TEXT NOT NULL,
        slot_index INTEGER NOT NULL CHECK(slot_index >= 1 AND slot_index <= 4),
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        start_utc TEXT NOT NULL,
        end_utc TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
        UNIQUE(user_email, date, slot_index)
      )
    `);

    // Create submissions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS submissions (
        submission_id TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        date TEXT NOT NULL,
        timestamp_utc TEXT NOT NULL,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('fresh', 'return')),
        is_dispute INTEGER DEFAULT 0,
        questions_count INTEGER NOT NULL CHECK(questions_count >= 0),
        assigned_slot_index INTEGER,
        return_confirmed INTEGER DEFAULT 0,
        raw_payload TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
      )
    `);

    // Create day_records table
    await client.query(`
      CREATE TABLE IF NOT EXISTS day_records (
        id SERIAL PRIMARY KEY,
        user_email TEXT NOT NULL,
        date TEXT NOT NULL,
        slot1_fresh INTEGER DEFAULT 0,
        slot2_fresh INTEGER DEFAULT 0,
        slot3_fresh INTEGER DEFAULT 0,
        slot4_fresh INTEGER DEFAULT 0,
        slot1_return INTEGER DEFAULT 0,
        slot2_return INTEGER DEFAULT 0,
        slot3_return INTEGER DEFAULT 0,
        slot4_return INTEGER DEFAULT 0,
        grand_total_fresh INTEGER DEFAULT 0,
        grand_total_return INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE,
        UNIQUE(user_email, date)
      )
    `);

    // Create audit_log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        user_email TEXT,
        submission_id TEXT,
        details TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create sessions table for express-session
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        expired TIMESTAMP NOT NULL,
        sess JSONB NOT NULL
      )
    `);

    // Create share_links table
    await client.query(`
      CREATE TABLE IF NOT EXISTS share_links (
        token TEXT PRIMARY KEY,
        user_email TEXT NOT NULL,
        date TEXT NOT NULL,
        label TEXT,
        expires_at TIMESTAMP NOT NULL,
        is_revoked INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
      )
    `);

    // Create short_links table (URL shortener mapping)
    await client.query(`
      CREATE TABLE IF NOT EXISTS short_links (
        slug TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        user_email TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY (token) REFERENCES share_links(token) ON DELETE CASCADE,
        FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
      )
    `);

    // Create indexes for performance at scale
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_sub_ud ON submissions(user_email, date)',
      'CREATE INDEX IF NOT EXISTS idx_sub_slot ON submissions(user_email, date, assigned_slot_index)',
      'CREATE INDEX IF NOT EXISTS idx_slot_ud ON slots(user_email, date)',
      'CREATE INDEX IF NOT EXISTS idx_dr_ud ON day_records(user_email, date)',
      'CREATE INDEX IF NOT EXISTS idx_audit_u ON audit_log(user_email)',
      'CREATE INDEX IF NOT EXISTS idx_share_user ON share_links(user_email, date)',
      'CREATE INDEX IF NOT EXISTS idx_short_token ON short_links(token)',
      'CREATE INDEX IF NOT EXISTS idx_short_user ON short_links(user_email)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)',
    ];

    for (const indexSql of indexes) {
      await client.query(indexSql);
    }

    await client.query('COMMIT');
    console.log('[DB] Schema initialization complete');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close the pool gracefully
 */
export async function closeDb() {
  await pool.end();
}


// ─── Query Helpers ─────────────────────────────────────────────────────────

export async function queryAll(sql, params = []) {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (err) {
    console.error('[DB] Query error:', err.message, { sql, params });
    throw err;
  }
}

export async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function runSql(sql, params = []) {
  try {
    const result = await pool.query(sql, params);
    return { changes: result.rowCount, success: true };
  } catch (err) {
    console.error('[DB] Execute error:', err.message, { sql, params });
    throw err;
  }
}

// ─── Users ─────────────────────────────────────────────────────────────────────

export async function createUser(email, displayName, passwordHash, timezone = 'UTC', role = 'annotator') {
  return runSql(
    'INSERT INTO users (email, display_name, password_hash, timezone, role) VALUES ($1, $2, $3, $4, $5)',
    [email, displayName, passwordHash, timezone, role]
  );
}

export async function getUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = $1', [email]);
}

export async function getAllUsers() {
  return queryAll('SELECT email, display_name, timezone, role, created_at FROM users');
}

// ─── Slots ─────────────────────────────────────────────────────────────────────

export async function upsertSlot(userEmail, date, slotIndex, startTime, endTime, startUtc, endUtc) {
  return runSql(
    `INSERT INTO slots (user_email, date, slot_index, start_time, end_time, start_utc, end_utc)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(user_email, date, slot_index) DO UPDATE SET
       start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
       start_utc = EXCLUDED.start_utc, end_utc = EXCLUDED.end_utc`,
    [userEmail, date, slotIndex, startTime, endTime, startUtc, endUtc]
  );
}

export async function getSlots(userEmail, date) {
  return queryAll('SELECT * FROM slots WHERE user_email = $1 AND date = $2 ORDER BY slot_index', [userEmail, date]);
}

export async function getSlotCount(userEmail, date) {
  const r = await queryOne('SELECT COUNT(*) as cnt FROM slots WHERE user_email = $1 AND date = $2', [userEmail, date]);
  return r ? parseInt(r.cnt) : 0;
}

export async function deleteSlot(userEmail, date, slotIndex) {
  return runSql('DELETE FROM slots WHERE user_email = $1 AND date = $2 AND slot_index = $3', [userEmail, date, slotIndex]);
}

// ─── Submissions ───────────────────────────────────────────────────────────────

export async function insertSubmission(sub) {
  return runSql(
    `INSERT INTO submissions 
     (submission_id, user_email, date, timestamp_utc, task_id, type, is_dispute, questions_count, assigned_slot_index, return_confirmed, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (submission_id) DO NOTHING`,
    [sub.submission_id, sub.user_email, sub.date, sub.timestamp_utc, sub.task_id,
     sub.type, sub.is_dispute ? 1 : 0, sub.questions_count, sub.assigned_slot_index,
     sub.return_confirmed ? 1 : 0, JSON.stringify(sub)]
  );
}

export async function getSubmission(submissionId) {
  return queryOne('SELECT * FROM submissions WHERE submission_id = $1', [submissionId]);
}

export async function getSubmissionsByUserDate(userEmail, date) {
  return queryAll('SELECT * FROM submissions WHERE user_email = $1 AND date = $2 ORDER BY timestamp_utc', [userEmail, date]);
}

export async function getAllSubmissions(limit = 100, offset = 0) {
  return queryAll('SELECT * FROM submissions ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
}

// ─── Day Records ───────────────────────────────────────────────────────────────

export async function upsertDayRecord(userEmail, date, freshSlots, returnSlots) {
  const grandFresh = freshSlots.reduce((a, b) => a + b, 0);
  const grandReturn = returnSlots.reduce((a, b) => a + b, 0);
  return runSql(
    `INSERT INTO day_records (user_email, date, slot1_fresh, slot2_fresh, slot3_fresh, slot4_fresh,
       slot1_return, slot2_return, slot3_return, slot4_return, grand_total_fresh, grand_total_return, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT(user_email, date) DO UPDATE SET
       slot1_fresh=EXCLUDED.slot1_fresh, slot2_fresh=EXCLUDED.slot2_fresh,
       slot3_fresh=EXCLUDED.slot3_fresh, slot4_fresh=EXCLUDED.slot4_fresh,
       slot1_return=EXCLUDED.slot1_return, slot2_return=EXCLUDED.slot2_return,
       slot3_return=EXCLUDED.slot3_return, slot4_return=EXCLUDED.slot4_return,
       grand_total_fresh=EXCLUDED.grand_total_fresh, grand_total_return=EXCLUDED.grand_total_return,
       updated_at=NOW()`,
    [userEmail, date, ...freshSlots, ...returnSlots, grandFresh, grandReturn]
  );
}

export async function getDayRecord(userEmail, date) {
  return queryOne('SELECT * FROM day_records WHERE user_email = $1 AND date = $2', [userEmail, date]);
}

export async function getUserHistory(userEmail, limit = 30, offset = 0) {
  return queryAll('SELECT * FROM day_records WHERE user_email = $1 ORDER BY date DESC LIMIT $2 OFFSET $3', [userEmail, limit, offset]);
}

export async function getUserHistoryByRange(userEmail, startDate, endDate) {
  return queryAll('SELECT * FROM day_records WHERE user_email = $1 AND date >= $2 AND date <= $3 ORDER BY date DESC', [userEmail, startDate, endDate]);
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

export async function getGlobalDashboard(date) {
  return queryAll(
    `SELECT dr.*, u.display_name FROM day_records dr
     JOIN users u ON dr.user_email = u.email WHERE dr.date = $1 ORDER BY dr.user_email`,
    [date]
  );
}

// ─── Audit ─────────────────────────────────────────────────────────────────────

export async function addAuditLog(action, userEmail, submissionId, details) {
  return runSql(
    'INSERT INTO audit_log (action, user_email, submission_id, details) VALUES ($1, $2, $3, $4)',
    [action, userEmail, submissionId, typeof details === 'object' ? JSON.stringify(details) : details]
  );
}

export async function getAuditLogs(limit = 100, offset = 0) {
  return queryAll('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);
}

// ─── Share Links ────────────────────────────────────────────────────────────────

export async function createShareLink(token, userEmail, date, label, expiresAt) {
  // Sanitize label: trim, cap at 60 chars, strip control characters
  const safeLabel = label
    ? label.trim().slice(0, 60).replace(/[\x00-\x1f\x7f]/g, '')
    : null;
  return runSql(
    'INSERT INTO share_links (token, user_email, date, label, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [token, userEmail, date, safeLabel, expiresAt]
  );
}

export async function getActiveShareLinkCount(userEmail) {
  const row = await queryOne(
    'SELECT COUNT(*) as cnt FROM share_links WHERE user_email = $1 AND is_revoked = 0 AND expires_at > NOW()',
    [userEmail]
  );
  return row ? parseInt(row.cnt) : 0;
}

export async function getShareLink(token) {
  return queryOne(
    `SELECT sl.*, u.display_name FROM share_links sl
     JOIN users u ON sl.user_email = u.email
     WHERE sl.token = $1 AND sl.is_revoked = 0 AND sl.expires_at > NOW()`,
    [token]
  );
}

export async function getUserShareLinks(userEmail) {
  return queryAll(
    'SELECT token, date, label, expires_at, is_revoked, created_at FROM share_links WHERE user_email = $1 ORDER BY created_at DESC LIMIT 50',
    [userEmail]
  );
}

export async function revokeShareLink(token, userEmail) {
  return runSql(
    'UPDATE share_links SET is_revoked = 1 WHERE token = $1 AND user_email = $2',
    [token, userEmail]
  );
}

export async function cleanExpiredShareLinks() {
  return runSql('DELETE FROM share_links WHERE expires_at < NOW() OR is_revoked = 1', []);
}

// ─── Session Store ──────────────────────────────────────────────────────────────

export async function getSession(sid) {
  const row = await queryOne('SELECT sess FROM sessions WHERE sid = $1 AND expired > NOW()', [sid]);
  if (!row) return null;
  return typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
}

export async function setSession(sid, session) {
  const maxAge = session.cookie?.originalMaxAge || 86400000;
  const expired = new Date(Date.now() + maxAge).toISOString();
  return runSql('INSERT INTO sessions (sid, expired, sess) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET expired = EXCLUDED.expired, sess = EXCLUDED.sess', [sid, expired, JSON.stringify(session)]);
}

export async function destroySession(sid) {
  return runSql('DELETE FROM sessions WHERE sid = $1', [sid]);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────────

export async function cleanOldData(daysToKeep = 8) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];
  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    let deletedCount = 0;

    const sub = await client.query('DELETE FROM submissions WHERE date < $1', [cutoffStr]);
    deletedCount += sub.rowCount;

    const dr = await client.query('DELETE FROM day_records WHERE date < $1', [cutoffStr]);
    deletedCount += dr.rowCount;

    const slots = await client.query('DELETE FROM slots WHERE date < $1', [cutoffStr]);
    deletedCount += slots.rowCount;

    const audit = await client.query('DELETE FROM audit_log WHERE created_at < $1', [cutoffStr + ' 00:00:00']);
    deletedCount += audit.rowCount;

    await client.query('COMMIT');

    return { success: true, cutoff: cutoffStr, deleted: deletedCount };
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[DB] Cleanup rollback error:', rollbackErr);
      }
    }
    console.error('[DB] Cleanup error:', err);
    return { success: false, error: err.message };
  } finally {
    if (client) client.release();
  }
}

// ─── Aggregation Helper ──────────────────────────────────────────────────────────

/**
 * Recompute day record aggregates from raw submissions.
 * This replaces the trigger-based approach for better control with async operations.
 */
export async function recomputeDayRecordFromSubmissions(userEmail, date) {
  const submissions = await getSubmissionsByUserDate(userEmail, date);

  const freshSlots = [0, 0, 0, 0];
  const returnSlots = [0, 0, 0, 0];

  for (const sub of submissions) {
    if (sub.assigned_slot_index && sub.assigned_slot_index >= 1 && sub.assigned_slot_index <= 4) {
      const slotIdx = sub.assigned_slot_index - 1;
      if (sub.type === 'fresh') {
        freshSlots[slotIdx] += sub.questions_count;
      } else if (sub.type === 'return') {
        returnSlots[slotIdx] += sub.questions_count;
      }
    }
  }

  await upsertDayRecord(userEmail, date, freshSlots, returnSlots);

  return {
    freshSlots,
    returnSlots,
    grandFresh: freshSlots.reduce((a, b) => a + b, 0),
    grandReturn: returnSlots.reduce((a, b) => a + b, 0)
  };
}

export { pool };
