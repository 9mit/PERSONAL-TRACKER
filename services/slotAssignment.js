/**
 * Slot Assignment Service
 * 
 * Deterministic slot assignment rules:
 * 1. Primary: slot_start <= submission_time <= slot_end → assign to that slot
 * 2. If outside all slots: assign to next slot whose start > submission_time
 * 3. If no future slot exists: assign to the last slot of the day
 */

/**
 * Assign a submission timestamp to a slot index.
 * 
 * @param {string} submissionTimeUtc - ISO UTC timestamp of the submission
 * @param {Array<{slot_index: number, start_utc: string, end_utc: string}>} slots - Available slots sorted by slot_index
 * @returns {{ slotIndex: number, rule: string }} - Assigned slot index and the rule that matched
 */
export function assignSlot(submissionTimeUtc, slots) {
  if (!slots || slots.length === 0) {
    return { slotIndex: null, rule: 'no_slots' };
  }

  const subTime = new Date(submissionTimeUtc).getTime();

  // Sort by slot_index to ensure deterministic ordering
  const sortedSlots = [...slots].sort((a, b) => a.slot_index - b.slot_index);

  // Rule 1: Primary — find slot where start <= submission <= end
  for (const slot of sortedSlots) {
    const start = new Date(slot.start_utc).getTime();
    const end = new Date(slot.end_utc).getTime();
    if (subTime >= start && subTime <= end) {
      return { slotIndex: slot.slot_index, rule: 'primary_within_slot' };
    }
  }

  // Rule 2: Outside all slots — find next slot whose start > submission_time
  for (const slot of sortedSlots) {
    const start = new Date(slot.start_utc).getTime();
    if (start > subTime) {
      return { slotIndex: slot.slot_index, rule: 'next_future_slot' };
    }
  }

  // Rule 3: No future slot — assign to last slot
  const lastSlot = sortedSlots[sortedSlots.length - 1];
  return { slotIndex: lastSlot.slot_index, rule: 'last_slot_fallback' };
}

/**
 * Validate slot boundaries.
 * @param {string} startTime - Start time string
 * @param {string} endTime - End time string
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSlot(startTime, endTime) {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();

  if (isNaN(start) || isNaN(end)) {
    return { valid: false, error: 'Invalid time format' };
  }

  if (start >= end) {
    return { valid: false, error: 'Start time must be before end time' };
  }

  return { valid: true };
}

/**
 * Check if a new slot overlaps with any existing slots.
 * @param {{ start_utc: string, end_utc: string }} newSlot
 * @param {Array<{ slot_index: number, start_utc: string, end_utc: string }>} existingSlots
 * @param {number|null} excludeIndex - Slot index to exclude from overlap check (for updates)
 * @returns {{ overlaps: boolean, conflictWith?: number }}
 */
export function checkSlotOverlap(newSlot, existingSlots, excludeIndex = null) {
  const newStart = new Date(newSlot.start_utc).getTime();
  const newEnd = new Date(newSlot.end_utc).getTime();

  for (const slot of existingSlots) {
    if (excludeIndex !== null && slot.slot_index === excludeIndex) continue;

    const existStart = new Date(slot.start_utc).getTime();
    const existEnd = new Date(slot.end_utc).getTime();

    // Overlap check: two intervals overlap if start1 < end2 AND start2 < end1
    if (newStart < existEnd && existStart < newEnd) {
      return { overlaps: true, conflictWith: slot.slot_index };
    }
  }

  return { overlaps: false };
}
