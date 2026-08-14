// middleware.js
//
// This is the "security guard" that stands in front of protected routes
// like /api/data. It checks: does this browser have a valid, logged-in
// session? If not, it rejects the request before any data is touched.

export function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    // Logged in — let the request through.
    return next();
  }

  // Not logged in — reject with 401, no data is returned.
  return res.status(401).json({ error: 'Not authenticated' });
}

// Very basic rate limiting for the /login endpoint, to slow down
// brute-force password guessing. This is intentionally simple —
// it tracks failed attempts per IP address in memory.
const failedAttempts = new Map(); // ip -> { count, firstAttemptAt }

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const record = failedAttempts.get(ip);

  if (record && now - record.firstAttemptAt > WINDOW_MS) {
    failedAttempts.delete(ip);
  }

  const current = failedAttempts.get(ip);
  if (current && current.count >= MAX_ATTEMPTS) {
    return res
      .status(429)
      .json({ error: 'Too many login attempts. Please try again later.' });
  }

  next();
}

export function recordFailedLogin(ip) {
  const now = Date.now();
  const current = failedAttempts.get(ip);
  if (!current) {
    failedAttempts.set(ip, { count: 1, firstAttemptAt: now });
  } else {
    current.count += 1;
  }
}

export function clearFailedLogins(ip) {
  failedAttempts.delete(ip);
}
