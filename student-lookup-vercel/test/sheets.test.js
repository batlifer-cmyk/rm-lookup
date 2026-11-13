'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { accessToken, readSnapshot, readAuthIndex, resetTokenCache } = require('../lib/google-sheets');

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

function env(extra = {}) {
  return {
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'lookup@example.iam.gserviceaccount.com', private_key: privateKey }),
    RM_SNAPSHOT_SPREADSHEET_ID: 'snapshot-sheet-id',
    RM_SNAPSHOT_SHEET: '_API_Cutover_Snapshot',
    RM_SNAPSHOT_EXPECTED_COUNT: '2',
    RM_AUTH_INDEX_SHEET: '_DB_Student_Master',
    RM_AUTH_INDEX_COUNT: '2',
    ...extra
  };
}

function responder(seen) {
  return async (url, options) => {
    seen.push(String(url));
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return { ok: true, json: async () => ({ access_token: 'token-1', expires_in: 3600 }) };
    }
    if (String(url).includes('values:batchGet')) {
      return { ok: true, json: async () => ({ valueRanges: [
        { values: [['student_name'], ['김학생'], ['이학생']] },
        { values: [['phone_last4'], ['1234'], []] },
        { values: [['current_status'], ['ACTIVE'], ['ACTIVE']] }
      ] }) };
    }
    return { ok: true, json: async () => ({ values: [['generation_id', 'entry_key', 'entry_json', 'generation_id', 'entry_key', 'entry_json'], ['20260919010000_abc', 'a', '{}', 'g', 'b', '{}']] }) };
  };
}

test('one token request serves both snapshot and auth-index reads', async () => {
  resetTokenCache();
  const seen = [];
  const fetchImpl = responder(seen);
  const token = await accessToken(env(), fetchImpl);
  await Promise.all([readSnapshot(env(), token, fetchImpl), readAuthIndex(env(), token, fetchImpl)]);
  const tokenCalls = seen.filter(url => url.includes('oauth2.googleapis.com/token'));
  assert.equal(tokenCalls.length, 1);
  assert.equal(token, 'token-1');
  assert.equal(seen.filter(url => url.includes('snapshot-sheet-id')).length, 2, 'both reads hit the snapshot spreadsheet by default');
});

test('a second request in the same warm instance reuses the token', async () => {
  resetTokenCache();
  const seen = [];
  const fetchImpl = responder(seen);
  await accessToken(env(), fetchImpl);
  await accessToken(env(), fetchImpl);
  assert.equal(seen.filter(url => url.includes('oauth2.googleapis.com/token')).length, 1);
});

test('the auth index can live in its own spreadsheet', async () => {
  resetTokenCache();
  const seen = [];
  const fetchImpl = responder(seen);
  const token = await accessToken(env({ RM_AUTH_INDEX_SPREADSHEET_ID: 'index-only-sheet-id' }), fetchImpl);
  await readAuthIndex(env({ RM_AUTH_INDEX_SPREADSHEET_ID: 'index-only-sheet-id' }), token, fetchImpl);
  assert.ok(seen.some(url => url.includes('index-only-sheet-id')), 'auth index read from its own spreadsheet');
});

test('every outbound Google call carries an abort timeout', async () => {
  resetTokenCache();
  const signals = [];
  const fetchImpl = async (url, options) => {
    signals.push(Boolean(options && options.signal));
    return responder([])(url, options);
  };
  const token = await accessToken(env(), fetchImpl);
  await readSnapshot(env(), token, fetchImpl);
  assert.deepEqual(signals, [true, true]);
});

test('missing credentials and a rejected token fail closed', async () => {
  resetTokenCache();
  await assert.rejects(() => accessToken({}, async () => ({ ok: true, json: async () => ({ access_token: 'x' }) })), /GOOGLE_CREDENTIALS_MISSING/);
  resetTokenCache();
  await assert.rejects(
    () => accessToken(env(), async () => ({ ok: false, json: async () => ({}) })),
    /GOOGLE_TOKEN_FAILED/
  );
});

test('an unreadable sheet fails instead of returning empty data', async () => {
  resetTokenCache();
  const token = await accessToken(env(), responder([]));
  await assert.rejects(
    () => readSnapshot(env(), token, async () => ({ ok: false, json: async () => ({}) })),
    /SHEETS_READ_FAILED/
  );
});
