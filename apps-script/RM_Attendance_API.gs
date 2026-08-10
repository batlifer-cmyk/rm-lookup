const RM_ATTENDANCE_API = Object.freeze({
  DATA_SPREADSHEET_ID: '1P42_8yxR0Tlys8g48Cq1h4SryRHzTlljE0A-bvngwnE',
  SOURCE_SHEET: '_SRC_Master_Count_V2',
  VERIFY_SHEET: '공개조회가능 정보모음',
  TZ: 'Asia/Seoul',
  CACHE_SECONDS: 120,
  MAX_ROWS: 300,
  BATCH_SIZE: 70
});

function doGet(e) {
  const started = Date.now();
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'attendance').trim();
  if (action !== 'attendance') return rmAttendanceJson_({ok:false,error:'UNKNOWN_ACTION'});

  const name = rmAttendanceText_(p.name);
  const phone4 = rmAttendanceDigits_(p.phone4).slice(-4);
  if (!name) return rmAttendanceJson_({ok:false,error:'NAME_REQUIRED'});

  try {
    const ss = SpreadsheetApp.openById(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID);
    const verified = rmAttendanceVerifyStudent_(ss, name, phone4);
    if (!verified.ok) return rmAttendanceJson_(verified);

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
    console.error(err);
    return rmAttendanceJson_({ok:false,error:'SERVER_ERROR',elapsedMs:Date.now() - started});
  }
}

function rmAttendanceVerifyStudent_(ss, name, phone4) {
  const sheet = ss.getSheetByName(RM_ATTENDANCE_API.VERIFY_SHEET);
  if (!sheet) return {ok:false,error:'VERIFY_SHEET_MISSING'};
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {ok:false,error:'STUDENT_NOT_FOUND'};

  // 공개조회 시트는 작으므로 A:E를 한 번만 읽는다.
  const values = sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues();
  const target = rmAttendanceNormalize_(name);
  const matches = values.filter(r => rmAttendanceNormalize_(r[0]) === target);
  if (!matches.length) return {ok:false,error:'STUDENT_NOT_FOUND'};

  if (matches.length === 1) {
    if (phone4) {
      const stored = rmAttendanceDigits_(matches[0][4]).slice(-4);
      if (stored && stored !== phone4) return {ok:false,error:'PHONE_MISMATCH'};
    }
    return {ok:true,name:rmAttendanceText_(matches[0][0])};
  }

  if (phone4.length !== 4) return {ok:false,error:'PHONE4_REQUIRED',reason:'DUPLICATE_NAME'};
  const exact = matches.filter(r => rmAttendanceDigits_(r[4]).slice(-4) === phone4);
  if (!exact.length) return {ok:false,error:'PHONE_MISMATCH'};
  if (exact.length > 1) return {ok:false,error:'IDENTITY_AMBIGUOUS'};
  return {ok:true,name:rmAttendanceText_(exact[0][0])};
}

function rmAttendanceGetRows_(ss, studentName) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'att:v3:' + Utilities.base64EncodeWebSafe(studentName, Utilities.Charset.UTF_8);
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const sheet = ss.getSheetByName(RM_ATTENDANCE_API.SOURCE_SHEET);
  if (!sheet) throw new Error('SOURCE_SHEET_MISSING');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // 학생명 열(F)만 읽어 전체 16열 스캔을 피한다.
  const names = sheet.getRange(2, 6, lastRow - 1, 1).getDisplayValues();
  const target = rmAttendanceNormalize_(studentName);
  const rowNumbers = [];
  for (let i = 0; i < names.length; i += 1) {
    if (rmAttendanceNormalize_(names[i][0]) === target) rowNumbers.push(i + 2);
  }
  if (!rowNumbers.length) return [];

  // 최근 MAX_ROWS개까지만 비연속 행을 Sheets API batchGet으로 묶어 읽는다.
  const selected = rowNumbers.slice(-RM_ATTENDANCE_API.MAX_ROWS);
  const rawRows = rmAttendanceBatchGetRows_(selected);
  const result = [];

  for (let i = 0; i < rawRows.length; i += 1) {
    const r = rawRows[i];
    if (!r || r.length < 2) continue;
    const lessonDate = rmAttendanceDate_(r[1]);
    if (!lessonDate) continue;

    const chargeUnits = rmAttendanceNumber_(r[11]);
    const completed = rmAttendanceNumberOrNull_(r[12]);
    const pkg = rmAttendanceNumberOrNull_(r[13]);
    const counter = completed === null ? '' : (pkg === null
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

  result.sort((a,b) => (b.sortKey - a.sortKey) || b.lessonDate.localeCompare(a.lessonDate));
  const safe = result.map(r => ({
    lessonDate:r.lessonDate,
    teacher:r.teacher,
    classType:r.classType,
    chargeUnits:r.chargeUnits,
    counter:r.counter,
    status:r.status
  }));

  try { cache.put(cacheKey, JSON.stringify(safe), RM_ATTENDANCE_API.CACHE_SECONDS); } catch (e) {}
  return safe;
}

function rmAttendanceBatchGetRows_(rowNumbers) {
  const id = RM_ATTENDANCE_API.DATA_SPREADSHEET_ID;
  const sheetName = RM_ATTENDANCE_API.SOURCE_SHEET.replace(/'/g, "''");
  const token = ScriptApp.getOAuthToken();
  const out = [];

  for (let offset = 0; offset < rowNumbers.length; offset += RM_ATTENDANCE_API.BATCH_SIZE) {
    const chunk = rowNumbers.slice(offset, offset + RM_ATTENDANCE_API.BATCH_SIZE);
    const qs = chunk.map(row => 'ranges=' + encodeURIComponent("'" + sheetName + "'!A" + row + ':P' + row)).join('&');
    const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(id) + '/values:batchGet?' + qs + '&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';
    const resp = UrlFetchApp.fetch(url, {
      method:'get',
      headers:{Authorization:'Bearer ' + token},
      muteHttpExceptions:true
    });
    if (resp.getResponseCode() !== 200) throw new Error('BATCH_GET_' + resp.getResponseCode());
    const payload = JSON.parse(resp.getContentText());
    const ranges = payload.valueRanges || [];
    for (let i = 0; i < ranges.length; i += 1) {
      out.push((ranges[i].values && ranges[i].values[0]) ? ranges[i].values[0] : []);
    }
  }
  return out;
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
  // Sheets API의 날짜 serial number도 처리한다.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Math.round((value - 25569) * 86400 * 1000);
    return Utilities.formatDate(new Date(millis), RM_ATTENDANCE_API.TZ, 'yyyy-MM-dd');
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
