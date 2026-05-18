/**
 * Google Sheets API Routes
 */

import { Router } from 'express';
import { requireAuth, isValidDate, isValidEmail } from '../middleware/auth.js';
import { createSheet, syncToSheet, shareSheet } from '../services/sheetsSync.js';
import { getDashboardMetrics } from '../services/aggregation.js';

const router = Router();

/**
 * POST /api/share-sheet
 * Create and share a Google Sheet with live data
 */
router.post('/api/share-sheet', requireAuth, async (req, res) => {
  try {
    const { date, shareWith, role } = req.body;
    const sheetsEnabled = process.env.GOOGLE_SHEETS_ENABLED === 'true';

    if (!isValidDate(date)) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    if (role && !['reader', 'writer'].includes(role)) {
      return res.status(400).json({ error: 'Role must be reader or writer' });
    }

    if (!sheetsEnabled) {
      return res.status(400).json({
        error: 'Google Sheets integration is not enabled',
        message: 'Set GOOGLE_SHEETS_ENABLED=true and configure Google credentials to use this feature.'
      });
    }

    // Create a new sheet
    const title = `Annotation Tracker - ${date}`;
    const sheet = await createSheet(title);

    if (!sheet.success) {
      return res.status(500).json({ error: sheet.error });
    }

    // Sync current data
    const metrics = await getDashboardMetrics(date);
    const syncResult = await syncToSheet(
      sheet.sheetId,
      metrics.users.map(user => ({ ...user, date }))
    );

    if (!syncResult.success) {
      return res.status(500).json({ error: syncResult.error });
    }

    // Share if requested
    if (shareWith) {
      const emails = Array.isArray(shareWith) ? shareWith : [shareWith];
      for (const email of emails) {
        if (!isValidEmail(email)) {
          return res.status(400).json({ error: `Invalid share email: ${email}` });
        }
        await shareSheet(sheet.sheetId, email, role || 'reader');
      }
    }

    res.json({
      success: true,
      sheetId: sheet.sheetId,
      link: sheet.link
    });
  } catch (err) {
    console.error('Share sheet error:', err);
    res.status(500).json({ error: 'Failed to create/share sheet' });
  }
});

export default router;
