/**
 * Google Sheets Sync Service (Stub)
 * 
 * This module provides the interface for syncing aggregated data to Google Sheets.
 * To enable, set GOOGLE_SHEETS_ENABLED=true and provide credentials in env.
 * 
 * For production:
 * 1. Create a Google Cloud project
 * 2. Enable Google Sheets API and Google Drive API
 * 3. Create a service account and download credentials JSON
 * 4. Set GOOGLE_APPLICATION_CREDENTIALS env var to the JSON path
 * 5. Set GOOGLE_SHEET_ID to the target spreadsheet ID
 */

const SHEETS_ENABLED = process.env.GOOGLE_SHEETS_ENABLED === 'true';

let sheetsClient = null;

export async function initSheetsSync() {
  if (!SHEETS_ENABLED) {
    console.log('[Sheets] Google Sheets sync is disabled. Set GOOGLE_SHEETS_ENABLED=true to enable.');
    return;
  }

  try {
    // Dynamic import to avoid crash when googleapis not installed
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    console.log('[Sheets] Google Sheets sync initialized');
  } catch (err) {
    console.error('[Sheets] Failed to initialize:', err.message);
  }
}

/**
 * Write dashboard data to a Google Sheet.
 * @param {string} sheetId - Google Sheet ID
 * @param {Array} records - Day records to write
 */
export async function syncToSheet(sheetId, records) {
  if (!sheetsClient) {
    return { success: false, error: 'Sheets client not initialized' };
  }

  try {
    const headers = ['Email', 'Name', 'Date', 'Slot 1 (Fresh)', 'Slot 2 (Fresh)', 
      'Slot 3 (Fresh)', 'Slot 4 (Fresh)', 'Total Fresh', 'Slot 1 (Return)', 
      'Slot 2 (Return)', 'Slot 3 (Return)', 'Slot 4 (Return)', 'Total Return', 'Quality %'];

    const rows = records.map(r => [
      r.email, r.displayName, r.date,
      r.slots.fresh[0], r.slots.fresh[1], r.slots.fresh[2], r.slots.fresh[3],
      r.totalFresh,
      r.slots.return[0], r.slots.return[1], r.slots.return[2], r.slots.return[3],
      r.totalReturn,
      r.quality
    ]);

    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Dashboard!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [headers, ...rows]
      }
    });

    return { success: true };
  } catch (err) {
    console.error('[Sheets] Sync error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Share a Google Sheet with another user.
 * @param {string} sheetId
 * @param {string} email - Email to share with
 * @param {string} role - 'reader' or 'writer'
 */
export async function shareSheet(sheetId, email, role = 'reader') {
  if (!SHEETS_ENABLED) {
    return { success: false, error: 'Sheets integration not enabled' };
  }

  try {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });

    await drive.permissions.create({
      fileId: sheetId,
      requestBody: {
        type: 'user',
        role: role,
        emailAddress: email
      },
      sendNotificationEmail: true
    });

    return { success: true, link: `https://docs.google.com/spreadsheets/d/${sheetId}` };
  } catch (err) {
    console.error('[Sheets] Share error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Create a new Google Sheet.
 */
export async function createSheet(title) {
  if (!sheetsClient) {
    return { success: false, error: 'Sheets client not initialized' };
  }

  try {
    const response = await sheetsClient.spreadsheets.create({
      requestBody: {
        properties: { title }
      }
    });

    return { 
      success: true, 
      sheetId: response.data.spreadsheetId,
      link: response.data.spreadsheetUrl
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
