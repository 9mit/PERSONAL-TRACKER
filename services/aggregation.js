/**
 * Aggregation Service
 * 
 * Recomputes day records from raw submissions.
 * - Only fresh tasks contribute to per-slot annotation sums
 * - Return tasks are tracked separately
 * - Idempotent: recomputing always yields the same result from raw data
 */

import { getGlobalDashboard, queryAll, recomputeDayRecordFromSubmissions } from '../db/database.js';

/**
 * Compute quality score as a percentage.
 */
export function computeQualityScore(fresh, returns) {
  const total = fresh + returns;
  if (total === 0) return 100;
  return Math.round((fresh / total) * 100 * 100) / 100;
}

/**
 * Get global dashboard metrics for a specific date, securely isolated to the requested user.
 */
export async function getDashboardMetrics(date, userEmail = null) {
  let records = await getGlobalDashboard(date);
  
  // ISOLATION: Filter records to only include the specific user's data
  if (userEmail) {
    records = records.filter(r => r.user_email === userEmail);
  }

  // Fetch all slot counts/max indexes for this date in a single batch query to avoid N+1 query storm
  let slotsData = await queryAll(
    'SELECT user_email, MAX(slot_index) as max_slot FROM slots WHERE date = $1 GROUP BY user_email',
    [date]
  );
  
  if (userEmail) {
    slotsData = slotsData.filter(s => s.user_email === userEmail);
  }

  const slotsMap = new Map();
  for (const s of slotsData) {
    slotsMap.set(s.user_email, s.max_slot || 0);
  }

  let totalFresh = 0;
  let totalReturn = 0;
  let maxSlots = 0;

  const users = [];

  for (const r of records) {
    const userMaxSlot = slotsMap.get(r.user_email) || 0;
    if (userMaxSlot > maxSlots) maxSlots = userMaxSlot;

    totalFresh += r.grand_total_fresh;
    totalReturn += r.grand_total_return;
    
    users.push({
      email: r.user_email,
      displayName: r.display_name,
      configuredSlots: userMaxSlot,
      slots: {
        fresh: [r.slot1_fresh, r.slot2_fresh, r.slot3_fresh, r.slot4_fresh],
        return: [r.slot1_return, r.slot2_return, r.slot3_return, r.slot4_return]
      },
      totalFresh: r.grand_total_fresh,
      totalReturn: r.grand_total_return,
      quality: computeQualityScore(r.grand_total_fresh, r.grand_total_return)
    });
  }

  // Ensure maxSlots is at least 1 so UI renders cleanly
  if (maxSlots === 0 && users.length > 0) maxSlots = 1;

  return {
    users,
    totalFresh,
    totalReturn,
    qualityScore: computeQualityScore(totalFresh, totalReturn),
    maxSlots
  };
}

/**
 * Reprocess all day records for a given date (admin function).
 */
export async function reprocessDate(date) {
  const users = await queryAll('SELECT DISTINCT user_email FROM submissions WHERE date = $1', [date]);

  const results = [];
  for (const { user_email } of users) {
    const result = await recomputeDayRecordFromSubmissions(user_email, date);
    results.push({ user_email, ...result });
  }
  return results;
}
