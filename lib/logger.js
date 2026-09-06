/**
 * Logs a structured event to stdout as one JSON line. No file writes -
 * Vercel (and most serverless platforms) run on a read-only filesystem
 * outside of /tmp, which is itself ephemeral and not shared across
 * invocations/instances, so a project-relative log file can never work
 * reliably in production. Vercel automatically captures stdout/stderr into
 * its own Logs dashboard, which is the right place for this anyway.
 */
function logEvent(event) {
  const entry = { timestamp: new Date().toISOString(), ...event };
  console.log(`[thibault-forwarder] ${JSON.stringify(entry)}`);
}

module.exports = { logEvent };
