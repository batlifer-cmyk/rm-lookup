'use strict';

const crypto = require('node:crypto');

function base64url(value) { return Buffer.from(value).toString('base64url'); }

async function accessToken(env, fetchImpl = fetch) {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = String(env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !privateKey) throw new Error('GOOGLE_CREDENTIALS_MISSING');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(privateKey, 'base64url');
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
  });
  if (!response.ok) throw new Error('GOOGLE_TOKEN_FAILED');
  const body = await response.json();
  if (!body.access_token) throw new Error('GOOGLE_TOKEN_FAILED');
  return body.access_token;
}

async function readSnapshot(env, fetchImpl = fetch) {
  const spreadsheetId = env.RM_SNAPSHOT_SPREADSHEET_ID;
  const sheet = env.RM_SNAPSHOT_SHEET || '_API_Cutover_Snapshot';
  const expectedCount = Number(env.RM_SNAPSHOT_EXPECTED_COUNT || 110);
  if (!spreadsheetId || !Number.isInteger(expectedCount) || expectedCount < 1) throw new Error('SNAPSHOT_CONFIGURATION_INVALID');
  const token = await accessToken(env, fetchImpl);
  const range = `'${sheet.replace(/'/g, "''")}'!A1:F${expectedCount + 1}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error('SNAPSHOT_READ_FAILED');
  const body = await response.json();
  return body.values || [];
}

module.exports = { readSnapshot };

