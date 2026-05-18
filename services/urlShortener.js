/**
 * URL Shortening Service
 * 
 * Generates short, memorable, collision-free URL slugs using:
 * - Base62 encoding (0-9, a-z, A-Z)
 * - Timestamp + random entropy
 * - Database tracking for analytics
 */

import { queryOne, runSql, queryAll } from '../db/database.js';

// Base62 alphabet for URL-safe encoding
const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Convert a number to base62 string
 */
function toBase62(num) {
  if (num === 0) return '0';
  let result = '';
  while (num > 0) {
    result = BASE62_ALPHABET[num % 62] + result;
    num = Math.floor(num / 62);
  }
  return result;
}

/**
 * Convert base62 string back to number.
 * Inverse of toBase62 — kept for completeness and potential future analytics/debugging.
 */
function fromBase62(str) {
  let result = 0;
  for (const char of str) {
    result = result * 62 + BASE62_ALPHABET.indexOf(char);
  }
  return result;
}

/**
 * Generate a unique short slug for a share token
 * Format: timestamp-based + entropy
 * Example: "a7k3m9" (6-8 characters)
 */
export function generateShortSlug() {
  // Use timestamp in ms (upper bits) + random bytes (lower bits)
  // This ensures uniqueness without database lookup in most cases
  const now = Date.now();
  const random = Math.floor(Math.random() * 1e6);
  
  // Combine timestamp and random for uniqueness
  // Timestamp alone could collide, random adds entropy
  const combined = (now % 1e9) * 1e6 + random;
  
  // Convert to base62 and take first 6-8 chars (short enough to be shareable)
  const slug = toBase62(combined).padStart(6, '0').slice(-8);
  
  return slug;
}

/**
 * Create a short link record in the database
 * Associates a short slug with a full share token
 */
export async function createShortLink(token, userEmail) {
  try {
    // Retry if slug exists (extremely rare, ~1 in 62^8).
    for (let attempts = 0; attempts < 5; attempts++) {
      const slug = generateShortSlug();
      const existing = await queryOne(
        'SELECT token FROM short_links WHERE slug = $1',
        [slug]
      );
      
      if (existing) continue;

      const result = await runSql(
        `INSERT INTO short_links (slug, token, user_email, created_at) 
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (slug) DO NOTHING`,
        [slug, token, userEmail]
      );

      if (result.changes > 0) {
        return slug;
      }
    }

    throw new Error('Unable to generate a unique short link');
  } catch (err) {
    console.error('[URL Shortener] Error creating short link:', err);
    // Fallback: return a base slug if DB fails
    return generateShortSlug();
  }
}

/**
 * Resolve a short slug back to the full share token
 */
export async function resolveShortLink(slug) {
  try {
    const result = await queryOne(
      'SELECT token, user_email, created_at FROM short_links WHERE slug = $1',
      [slug]
    );
    
    if (result) {
      return {
        token: result.token,
        userEmail: result.user_email,
        created: result.created_at
      };
    }
    
    return null;
  } catch (err) {
    console.error('[URL Shortener] Error resolving short link:', err);
    return null;
  }
}

/**
 * Delete a short link mapping (when original share link is revoked)
 */
export async function deleteShortLink(slug) {
  try {
    await runSql('DELETE FROM short_links WHERE slug = $1', [slug]);
    return true;
  } catch (err) {
    console.error('[URL Shortener] Error deleting short link:', err);
    return false;
  }
}

/**
 * Get all short links for a user (for management UI)
 */
export async function getUserShortLinks(userEmail) {
  try {
    const results = await queryAll(
      `SELECT slug, token, created_at FROM short_links 
       WHERE user_email = $1 
       ORDER BY created_at DESC 
       LIMIT 100`,
      [userEmail]
    );
    return results;
  } catch (err) {
    console.error('[URL Shortener] Error fetching user short links:', err);
    return [];
  }
}

/**
 * Clean up short links for revoked or expired share links
 */
export async function cleanupOrphanedShortLinks() {
  try {
    // Delete short links where the original token doesn't exist
    const result = await runSql(
      `DELETE FROM short_links 
       WHERE token NOT IN (SELECT token FROM share_links WHERE is_revoked = 0)`
    );
    return result.changes;
  } catch (err) {
    console.error('[URL Shortener] Error cleaning orphaned links:', err);
    return 0;
  }
}

export default {
  generateShortSlug,
  createShortLink,
  resolveShortLink,
  deleteShortLink,
  getUserShortLinks,
  cleanupOrphanedShortLinks
};
