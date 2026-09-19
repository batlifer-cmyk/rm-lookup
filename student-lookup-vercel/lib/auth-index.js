'use strict';

const { normalizeName, text } = require('./snapshot');

function digits(value) { return text(value).replace(/\D/g, ''); }

function authenticate(records, name, phone4) {
  const normalizedName = normalizeName(name);
  const normalizedPhone = digits(phone4);
  if (!normalizedName || normalizedPhone.length !== 4) return null;
  const matches = records.filter(record =>
    text(record.status).toUpperCase() === 'ACTIVE' &&
    normalizeName(record.studentName) === normalizedName &&
    digits(record.phone4).slice(-4) === normalizedPhone
  );
  return matches.length === 1 ? matches[0] : null;
}

module.exports = { authenticate };
