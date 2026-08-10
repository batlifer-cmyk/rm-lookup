const RM_ATTENDANCE_API = Object.freeze({
  MASTER_SPREADSHEET_ID: '16ZKz55oMD0wBUtv9-hMk_HrPfhxRAd9HQhtbY8981x0',
  MASTER_SHEET: 'Master Time Data',
  VERIFY_SPREADSHEET_ID: '1P42_8yxR0Tlys8g48Cq1h4SryRHzTlljE0A-bvngwnE',
  VERIFY_SHEET: '공개조회가능 정보모음',
  TZ: 'Asia/Seoul',
  CACHE_SECONDS: 120,
  MAX_ROWS: 300
});

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'attendance').trim();
  if (action !== 'attendance') return rmAttendanceJson_({ok:false,error:'UNKNOWN_ACTION'});

  const name = rmAttendanceText_(p.name);
  const phone4 = rmAttendanceDigits_(p.phone4).slice(-4);
  if (!name) return rmAttendanceJson_({ok:false,error:'NAME_REQUIRED'});
  if (phone4.length !== 4) return rmAttendanceJson_({ok:false,error:'PHONE4_REQUIRED'});

  try {
    const verified = rmAttendanceVerifyStudent_(name, phone4);
    if (!verified.ok) return rmAttendanceJson_(verified);

    const rows = rmAttendanceGetRows_(verified.name);
    return rmAttendanceJson_({
      ok:true,
      studentName:verified.name,
      lastLessonDate:rows.length ? rows[0].lessonDate : null,
      count:rows.length,
      attendance:rows
    });
  } catch (err) {
    console.error(err);
    return rmAttendanceJson_({ok:false,error:'SERVER_ERROR'});
  }
}

function rmAttendanceVerifyStudent_(name, phone4) {
  const ss = SpreadsheetApp.openById(RM_ATTENDANCE_API.VERIFY_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(RM_ATTENDANCE_API.VERIFY_SHEET);
  if (!sheet) return {ok:false,error:'VERIFY_SHEET_MISSING'};

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {ok:false,error:'STUDENT_NOT_FOUND'};
  const values = sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues();
  const target = rmAttendanceNormalize_(name);
  const matches = values.filter(r => rmAttendanceNormalize_(r[0]) === target);
  if (!matches.length) return {ok:false,error:'STUDENT_NOT_FOUND'};

  const exact = matches.filter(r => rmAttendanceDigits_(r[4]).slice(-4) === phone4);
  if (!exact.length) return {ok:false,error:'PHONE_MISMATCH'};
  if (exact.length > 1) return {ok:false,error:'IDENTITY_AMBIGUOUS'};
  return {ok:true,name:rmAttendanceText_(exact[0][0])};
}

function rmAttendanceGetRows_(studentName) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'att:' + Utilities.base64EncodeWebSafe(studentName, Utilities.Charset.UTF_8);
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const ss = SpreadsheetApp.openById(RM_ATTENDANCE_API.MASTER_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(RM_ATTENDANCE_API.MASTER_SHEET);
  if (!sheet) throw new Error('MASTER_SHEET_MISSING');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // Master Time Data columns used only:
  // A Teacher, B Date, F Student, J Class type, G Hours, K Note.
  // K is read only to derive a safe counter token; raw note is never returned.
  const values = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const target = rmAttendanceNormalize_(studentName);
  const result = [];

  for (let i = 0; i < values.length; i += 1) {
    const r = values[i];
    if (rmAttendanceNormalize_(r[5]) !== target) continue;

    const lessonDate = rmAttendanceDate_(r[1]);
    if (!lessonDate) continue;

    const chargeUnits = rmAttendanceChargeUnits_(r[6], r[10]);
    const counter = rmAttendanceCounter_(r[10]);
    result.push({
      lessonDate:lessonDate,
      teacher:rmAttendanceText_(r[0]),
      classType:rmAttendanceText_(r[9]),
      chargeUnits:chargeUnits,
      counter:counter,
      status:chargeUnits > 0 ? '차감' : '미차감'
    });
  }

  result.sort((a,b) => b.lessonDate.localeCompare(a.lessonDate));
  const safe = result.slice(0, RM_ATTENDANCE_API.MAX_ROWS);
  try { cache.put(cacheKey, JSON.stringify(safe), RM_ATTENDANCE_API.CACHE_SECONDS); } catch (e) {}
  return safe;
}

function rmAttendanceChargeUnits_(hours, note) {
  const h = rmAttendanceText_(hours).toLowerCase();
  if (!h || h === 'n') return 0;
  if (h === 's1') return 0.5;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n;

  // If Hours is malformed, do not infer a positive charge from free-form notes.
  return 0;
}

function rmAttendanceCounter_(note) {
  const text = rmAttendanceText_(note);
  if (!text) return '';

  // Safe structured counter only. Examples: 8(8), 27, 28(32), 23.5(25), 7.5/
  const paren = text.match(/(?:^|\s|,)(\d+(?:\.\d+)?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)/);
  if (paren) return paren[1] + '(' + paren[2] + ')';
  const slash = text.match(/(?:^|\s|,)(\d+(?:\.\d+)?)\s*\//);
  if (slash) return slash[1] + '/';
  return '';
}

function rmAttendanceDate_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, RM_ATTENDANCE_API.TZ, 'yyyy-MM-dd');
  }
  const text = rmAttendanceText_(value);
  if (!text) return '';
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return '';
  return Utilities.formatDate(parsed, RM_ATTENDANCE_API.TZ, 'yyyy-MM-dd');
}

function rmAttendanceNormalize_(value) {
  return rmAttendanceText_(value).toLowerCase().replace(/\s+/g, '');
}

function rmAttendanceText_(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function rmAttendanceDigits_(value) {
  return rmAttendanceText_(value).replace(/\D/g, '');
}

function rmAttendanceJson_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
