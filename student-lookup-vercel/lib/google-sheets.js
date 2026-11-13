'use strict';

const crypto = require('node:crypto');

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// 4s per Google call keeps the worst case (token + two reads) inside vercel.json maxDuration 10s.
const REQUEST_TIMEOUT_MS = 4000;

// A warm function instance reuses one token for both reads instead of signing a new JWT per call.
let cachedToken = null;

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function text(value) { return String(value ?? '').trim(); }

function resetTokenCache() { cachedToken = null; }

async function accessToken(env, fetchImpl = fetch) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  let credential;
  try {
    credential = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || '');
  } catch (_) {
    throw new Error('GOOGLE_CREDENTIALS_MISSING');
  }
  const email = credential.client_email;
  const privateKey = String(credential.private_key || '').replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('GOOGLE_CREDENTIALS_MISSING');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: TOKEN_URL, iat: now, exp: now + 3600
  }))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(privateKey, 'base64url');
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
  });
  if (!response.ok) throw new Error('GOOGLE_TOKEN_FAILED');
  const body = await response.json();
  if (!body.access_token) throw new Error('GOOGLE_TOKEN_FAILED');
  cachedToken = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
  return cachedToken.value;
}

async function getJson(url, token, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error('SHEETS_READ_FAILED');
  return response.json();
}

async function readSnapshot(env, token, fetchImpl = fetch) {
  const spreadsheetId = text(env.RM_SNAPSHOT_SPREADSHEET_ID);
  const sheet = text(env.RM_SNAPSHOT_SHEET) || '_API_Cutover_Snapshot';
  const expectedCount = Number(env.RM_SNAPSHOT_EXPECTED_COUNT || 110);
  if (!spreadsheetId || !Number.isInteger(expectedCount) || expectedCount < 1) throw new Error('SNAPSHOT_CONFIGURATION_INVALID');
  const range = `'${sheet.replace(/'/g, "''")}'!A1:F${expectedCount + 1}`;
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const body = await getJson(url, token, fetchImpl);
  return body.values || [];
}

async function readAuthIndex(env, token, fetchImpl = fetch) {
  // The index may live in its own spreadsheet so the snapshot can be shared without the main workbook.
  const spreadsheetId = text(env.RM_AUTH_INDEX_SPREADSHEET_ID) || text(env.RM_SNAPSHOT_SPREADSHEET_ID);
  const sheet = text(env.RM_AUTH_INDEX_SHEET) || '_DB_Student_Master';
  const expectedCount = Number(env.RM_AUTH_INDEX_COUNT || 110);
  if (!spreadsheetId || !Number.isInteger(expectedCount) || expectedCount < 1) throw new Error('AUTH_INDEX_CONFIGURATION_INVALID');

  const safeSheet = sheet.replace(/'/g, "''");
  const ranges = ['B', 'D', 'G'].map(column => `'${safeSheet}'!${column}1:${column}${expectedCount + 1}`);
  const query = ranges.map(range => `ranges=${encodeURIComponent(range)}`).join('&');
  const url = `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchGet?majorDimension=ROWS&${query}`;
  const body = await getJson(url, token, fetchImpl);
  const groups = body.valueRanges || [];
  const columns = groups.map(group => group.values || []);
  const names = columns[0] || [];
  const phones = columns[1] || [];
  const statuses = columns[2] || [];
  const records = [];
  for (let index = 1; index <= expectedCount; index += 1) {
    records.push({
      studentName: (names[index] || [])[0] || '',
      phone4: (phones[index] || [])[0] || '',
      status: (statuses[index] || [])[0] || ''
    });
  }
  return records;
}

module.exports = { accessToken, readSnapshot, readAuthIndex, resetTokenCache, REQUEST_TIMEOUT_MS };
