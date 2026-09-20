'use strict';

const { normalizeName, text } = require('./snapshot');

function allowedPhone4s(value) {
  const raw = text(value);
  if (!raw) return [];
  const tokens = raw.split(/[;,|\s]+/).filter(Boolean);
  if (tokens.some(token => !/^\d{4}$/.test(token))) return [];
  return [...new Set(tokens)];
}

function authenticate(records, name, phone4) {
  const normalizedName = normalizeName(name);
  const normalizedPhone = text(phone4);
  if (!normalizedName || !/^\d{4}$/.test(normalizedPhone)) return null;
  const matches = records.filter(record =>
    text(record.status).toUpperCase() === 'ACTIVE' &&
    normalizeName(record.studentName) === normalizedName &&
    allowedPhone4s(record.phone4).includes(normalizedPhone)
  );
  return matches.length === 1 ? matches[0] : null;
}

module.exports = { authenticate, allowedPhone4s };
