'use strict';

function text(value) { return String(value ?? '').trim(); }
function normalizeName(value) { return text(value).toLowerCase().replace(/[\s,，·]/g, ''); }
function digits(value) { return text(value).replace(/\D/g, ''); }

function generationMs(generationId) {
  const match = text(generationId).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/);
  if (!match) return NaN;
  return Date.UTC(...match.slice(1).map(Number).map((value, index) => index === 1 ? value - 1 : value));
}

function parseSlot(values, start, expectedCount) {
  const records = values.slice(1).map(row => [row[start], row[start + 1], row[start + 2]]);
  if (records.length !== expectedCount || records.some(row => !text(row[0]) || !text(row[1]) || !text(row[2]))) return null;
  const generationId = text(records[0][0]);
  if (records.some(row => text(row[0]) !== generationId)) return null;
  const entries = new Map();
  try {
    for (const [, key, encoded] of records) {
      if (entries.has(text(key))) return null;
      entries.set(text(key), JSON.parse(encoded));
    }
  } catch (_) { return null; }
  const generatedAtMs = generationMs(generationId);
  return Number.isFinite(generatedAtMs) ? { generationId, generatedAtMs, entries } : null;
}

function selectFreshSnapshot(values, { expectedCount, maxAgeSeconds, now = Date.now() }) {
  const slots = [parseSlot(values, 0, expectedCount), parseSlot(values, 3, expectedCount)].filter(Boolean);
  if (!slots.length) throw new Error('SNAPSHOT_UNAVAILABLE');
  slots.sort((a, b) => b.generatedAtMs - a.generatedAtMs);
  const snapshot = slots[0];
  if (Number.isFinite(maxAgeSeconds) && now - snapshot.generatedAtMs > maxAgeSeconds * 1000) throw new Error('SNAPSHOT_STALE');
  return snapshot;
}

function candidateForEntry(entry, normalizedName, phone4) {
  const identityRows = Array.isArray(entry.legacyRows) ? entry.legacyRows : [];
  const matchingIdentity = identityRows.filter(row =>
    normalizeName(row['학생명']) === normalizedName && digits(row['전화번호']).slice(-4) === phone4
  );
  if (matchingIdentity.length !== 1) return null;
  const rows = Array.isArray(entry.cutoverRows) && entry.cutoverRows.length ? entry.cutoverRows : identityRows;
  const output = rows.find(row => digits(row['전화번호']).slice(-4) === phone4) || rows.find(row => normalizeName(row['학생명']) === normalizedName);
  return output ? { identity: matchingIdentity[0], output } : null;
}

function lookupStudent(entries, name, phone4) {
  const normalizedName = normalizeName(name);
  const normalizedPhone = digits(phone4);
  if (!normalizedName || normalizedPhone.length !== 4) return null;
  const matches = [];
  for (const entry of entries.values()) {
    if (normalizeName(entry.studentName) !== normalizedName) continue;
    const candidate = candidateForEntry(entry, normalizedName, normalizedPhone);
    if (candidate) matches.push(candidate);
  }
  if (matches.length !== 1) return null;
  const row = matches[0].output;
  const state = text(row['회차상태']);
  const message = text(row['안내']);
  const notice = state && state !== '확정' ? (message || '수업회차 확인이 필요합니다. 운영팀에 문의해주세요.') : message || undefined;
  const remaining = Number(row['잔여']);
  const latestRegistration = Number(row['등록횟수']);
  return {
    studentName: text(row['학생명']),
    remainingLessons: Number.isFinite(remaining) ? remaining : null,
    lastLessonDate: text(row['마지막수업일']) || null,
    latestRegistrationLessons: Number.isFinite(latestRegistration) ? latestRegistration : null,
    ...(notice ? { notice } : {})
  };
}

module.exports = { text, normalizeName, selectFreshSnapshot, lookupStudent };

