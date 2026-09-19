'use strict';

const { readSnapshot, readAuthIndex } = require('../lib/google-sheets');
const { authenticate } = require('../lib/auth-index');
const { selectFreshSnapshot, lookupStudent, text } = require('../lib/snapshot');

const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 12;

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(body);
}

function allowed(req) {
  const ip = text(req.headers['x-forwarded-for']).split(',')[0] || 'unknown';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(time => now - time < WINDOW_MS);
  recent.push(now); hits.set(ip, recent);
  return recent.length <= MAX_HITS;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  if (!allowed(req)) return send(res, 429, { ok: false, error: 'TOO_MANY_ATTEMPTS' });
  const name = text(req.body && req.body.name);
  const phone4 = text(req.body && req.body.phone4).replace(/\D/g, '');
  if (!name || phone4.length !== 4) return send(res, 400, { ok: false, error: 'INVALID_INPUT' });
  try {
    const [values, authIndex] = await Promise.all([readSnapshot(process.env), readAuthIndex(process.env)]);
    const snapshot = selectFreshSnapshot(values, {
      expectedCount: Number(process.env.RM_SNAPSHOT_EXPECTED_COUNT || 110),
      maxAgeSeconds: Number(process.env.RM_SNAPSHOT_MAX_AGE_SECONDS || 7200)
    });
    const identity = authenticate(authIndex, name, phone4);
    const result = identity && lookupStudent(snapshot.entries, identity.studentName);
    // Do not reveal whether the name exists or only the phone suffix was wrong.
    if (!result) return send(res, 404, { ok: false, error: 'NOT_FOUND_OR_IDENTITY_MISMATCH' });
    return send(res, 200, { ok: true, result });
  } catch (error) {
    console.error('student lookup failed', error.message);
    return send(res, 503, { ok: false, error: 'LOOKUP_TEMPORARILY_UNAVAILABLE' });
  }
};
