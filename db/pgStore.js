/**
 * PostgreSQL Session Store for express-session
 * Replaces the SQLite store with async PostgreSQL operations
 */

import session from 'express-session';
import { getSession, setSession, destroySession } from './database.js';

class PgStore extends session.Store {
  /**
   * Get session by ID
   */
  async get(sid, callback) {
    try {
      const sess = await getSession(sid);
      callback(null, sess);
    } catch (err) {
      callback(err);
    }
  }

  /**
   * Set session
   */
  async set(sid, sess, callback) {
    try {
      await setSession(sid, sess);
      if (typeof callback === 'function') callback();
    } catch (err) {
      if (typeof callback === 'function') callback(err);
    }
  }

  /**
   * Destroy session
   */
  async destroy(sid, callback) {
    try {
      await destroySession(sid);
      if (typeof callback === 'function') callback();
    } catch (err) {
      if (typeof callback === 'function') callback(err);
    }
  }

  /**
   * Touch session — refresh the expiry without modifying data
   */
  async touch(sid, sess, callback) {
    try {
      await setSession(sid, sess);
      if (typeof callback === 'function') callback();
    } catch (err) {
      if (typeof callback === 'function') callback(err);
    }
  }
}

export { PgStore };
