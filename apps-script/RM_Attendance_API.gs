const RM_ATTENDANCE_API = Object.freeze({
  DATA_SPREADSHEET_ID: '1P42_8yxR0Tlys8g48Cq1h4SryRHzTlljE0A-bvngwnE',
  SOURCE_SHEET: '_SRC_Master_Count_V2',
  VERIFY_SHEET: '공개조회가능 정보모음',
  TZ: 'Asia/Seoul',
  CACHE_SECONDS: 120,
  MAX_ROWS: 300
});

function doGet(e) {
  const started = Date.now();
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'attendance').trim();
  const name = rmAttendanceText_(p.name);
  const phone4 = rmAttendanceDigits_(p.phone4).slice(-4);

  if (action === 'health') {
    return rmAttendanceJson_({ok:true,service:'rm-attendance',elapsedMs:Date.now() - started});
  }

  try {
    const ss = SpreadsheetApp.openById(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID);

    if (action === 'open') {
      return rmAttendanceJson_({ok:true,spreadsheet:ss.getName(),elapsedMs:Date.now() - started});
    }

    if (!name) {
      return rmAttendanceJson_({ok:false,error:'NAME_REQUIRED',elapsedMs:Date.now() - started});
    }

    const verified = rmAttendanceVerifyStudent_(ss, name, phone4);
    if (!verified.ok) {
      verified.elapsedMs = Date.now() - started;
      return rmAttendanceJson_(verified);
    }

    if (action === 'verify') {
      return rmAttendanceJson_({ok:true,studentName:verified.name,stage:'verify',elapsedMs:Date.now() - started});
    }

    if (action === 'findrows') {
      const rowNumbers = rmAttendanceFindRowNumbers_(ss, verified.name);
      return rmAttendanceJson_({
        ok:true,
        studentName:verified.name,
        stage:'findrows',
        count:rowNumbers.length,
        sampleRows:rowNumbers.slice(0,10),
        elapsedMs:Date.now() - started
      });
    }

    if (action !== 'attendance') {
      return rmAttendanceJson_({ok:false,error:'UNKNOWN_ACTION',elapsedMs:Date.now() - started});
    }

    const rows = rmAttendanceGetRows_(ss, verified.name);
    return rmAttendanceJson_({
      ok:true,
      studentName:verified.name,
      lastLessonDate:rows.length ? rows[0].lessonDate : null,
      count:rows.length,
      elapsedMs:Date.now() - started,
      attendance:rows
    });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return rmAttendanceJson_({
      ok:false,
      error:'SERVER_ERROR',
      detail:rmAttendanceText_(err && err.message),
      elapsedMs:Date.now() - started
    });
  }
}

function rmAttendanceVerifyStudent_(ss, name, phone4) {
  const sheet = ss.getSheetByName(RM_ATTENDANCE_API.VERIFY_SHEET);
  if (!sheet) return {ok:false,error:'VERIFY_SHEET_MISSING'};

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {ok:false,error:'STUDENT_NOT_FOUND'};

  const target = rmAttendanceNormalize_(name);
  const hits = sheet
    .getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(name)
    .matchEntireCell(true)
    .matchCase(false)
    .findAll();

  const matches = [];
  for (let i = 0; i < hits.length; i += 1) {
    const row = hits[i].getRow();
    const pair = sheet.getRange(row, 1, 1, 5).getDisplayValues()[0];
    const displayName = rmAttendanceText_(pair[0]);
    if (rmAttendanceNormalize_(displayName) !== target) continue;
    matches.push({
      name:displayName,
      phone4:rmAttendanceDigits_(pair[4]).slice(-4)
    });
  }

  if (!matches.length) return {ok:false,error:'STUDENT_NOT_FOUND'};

  if (matches.length === 1) {
    if (phone4 && matches[0].phone4 && matches[0].phone4 !== phone4) {
      return {ok:false,error:'PHONE_MISMATCH'};
    }
    return {ok:true,name:matches[0].name};
  }

  if (phone4.length !== 4) {
    return {ok:false,error:'PHONE4_REQUIRED',reason:'DUPLICATE_NAME'};
  }

  const exact = matches.filter(r => r.phone4 === phone4);
  if (!exact.length) return {ok:false,error:'PHONE_MISMATCH'};
  if (exact.length > 1) return {ok:false,error:'IDENTITY_AMBIGUOUS'};
  return {ok:true,name:exact[0].name};
}

function rmAttendanceFindRowNumbers_(ss, studentName) {
  const sheet = ss.getSheetByName(RM_ATTENDANCE_API.SOURCE_SHEET);
  if (!sheet) throw new Error('SOURCE_SHEET_MISSING');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const hits = sheet
    .getRange(2, 6, lastRow - 1, 1)
    .createTextFinder(studentName)
    .matchEntireCell(true)
    .matchCase(false)
    .findAll();

  return hits
    .map(r => r.getRow())
    .sort((a, b) => b - a)
    .slice(0, RM_ATTENDANCE_API.MAX_ROWS);
}

function rmAttendanceGetRows_(ss, studentName) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'att:v5:' + Utilities.base64EncodeWebSafe(studentName, Utilities.Charset.UTF_8);
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const sheet = ss.getSheetByName(RM_ATTENDANCE_API.SOURCE_SHEET);
  if (!sheet) throw new Error('SOURCE_SHEET_MISSING');

  const target = rmAttendanceNormalize_(studentName);
  const rowNumbers = rmAttendanceFindRowNumbers_(ss, studentName);
  if (!rowNumbers.length) return [];

  const result = [];
  for (let i = 0; i < rowNumbers.length; i += 1) {
    const row = rowNumbers[i];
    const r = sheet.getRange(row, 1, 1, 16).getValues()[0];
    if (rmAttendanceNormalize_(r[5]) !== target) continue;

    const lessonDate = rmAttendanceDate_(r[1]);
    if (!lessonDate) continue;

    const chargeUnits = rmAttendanceNumber_(r[11]);
    const completed = rmAttendanceNumberOrNull_(r[12]);
    const pkg = rmAttendanceNumberOrNull_(r[13]);
    const counter = completed === null
      ? ''
      : (pkg === null
          ? rmAttendanceFmt_(completed) + '/'
          : rmAttendanceFmt_(completed) + '(' + rmAttendanceFmt_(pkg) + ')');

    result.push({
      lessonDate:lessonDate,
      teacher:rmAttendanceText_(r[0]),
      classType:rmAttendanceText_(r[9]),
      chargeUnits:chargeUnits,
      counter:counter,
      status:chargeUnits > 0 ? '차감' : '미차감',
      sortKey:rmAttendanceNumber_(r[15])
    });
  }

  result.sort((a, b) => (b.sortKey - a.sortKey) || b.lessonDate.localeCompare(a.lessonDate));

  const safe = result.map(r => ({
    lessonDate:r.lessonDate,
    teacher:r.teacher,
    classType:r.classType,
    chargeUnits:r.chargeUnits,
    counter:r.counter,
    status:r.status
  }));

  try {
    cache.put(cacheKey, JSON.stringify(safe), RM_ATTENDANCE_API.CACHE_SECONDS);
  } catch (e) {}

  return safe;
}

function rmAttendanceNumber_(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function rmAttendanceNumberOrNull_(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rmAttendanceFmt_(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
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
