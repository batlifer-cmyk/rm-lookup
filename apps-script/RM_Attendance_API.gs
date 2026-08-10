const RM_ATTENDANCE_API = Object.freeze({
  DATA_SPREADSHEET_ID: '1P42_8yxR0Tlys8g48Cq1h4SryRHzTlljE0A-bvngwnE',
  SOURCE_SHEET: '_SRC_Master_Count_V2',
  VERIFY_SHEET: '공개조회가능 정보모음',
  TZ: 'Asia/Seoul',
  CACHE_SECONDS: 120,
  MAX_ROWS: 300,
  VERIFY_END_ROW: 5000,
  SOURCE_END_ROW: 40000,
  BATCH_SIZE: 80
});

function doGet(e) {
  const started = Date.now();
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'attendance').trim();
  const name = rmAttendanceText_(p.name);
  const phone4 = rmAttendanceDigits_(p.phone4).slice(-4);

  if (action === 'health') {
    return rmAttendanceJson_({ok:true,service:'rm-attendance',mode:'rest',elapsedMs:Date.now()-started});
  }

  try {
    if (action === 'restcheck') {
      const meta = rmAttendanceSheetsFetchJson_('/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '?fields=properties.title');
      return rmAttendanceJson_({ok:true,spreadsheet:meta.properties && meta.properties.title || '',mode:'rest',elapsedMs:Date.now()-started});
    }

    if (!name) return rmAttendanceJson_({ok:false,error:'NAME_REQUIRED',elapsedMs:Date.now()-started});

    const verified = rmAttendanceVerifyStudentRest_(name, phone4);
    if (!verified.ok) {
      verified.elapsedMs = Date.now() - started;
      return rmAttendanceJson_(verified);
    }

    if (action === 'verify') {
      return rmAttendanceJson_({ok:true,studentName:verified.name,stage:'verify-rest',elapsedMs:Date.now()-started});
    }

    const rowNumbers = rmAttendanceFindRowNumbersRest_(verified.name);

    if (action === 'findrows') {
      return rmAttendanceJson_({ok:true,studentName:verified.name,stage:'findrows-rest',count:rowNumbers.length,sampleRows:rowNumbers.slice(0,10),elapsedMs:Date.now()-started});
    }

    if (action !== 'attendance') {
      return rmAttendanceJson_({ok:false,error:'UNKNOWN_ACTION',elapsedMs:Date.now()-started});
    }

    const rows = rmAttendanceGetRowsRest_(verified.name, rowNumbers);
    return rmAttendanceJson_({
      ok:true,
      studentName:verified.name,
      lastLessonDate:rows.length ? rows[0].lessonDate : null,
      count:rows.length,
      elapsedMs:Date.now()-started,
      attendance:rows
    });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return rmAttendanceJson_({ok:false,error:'SERVER_ERROR',detail:rmAttendanceText_(err && err.message),elapsedMs:Date.now()-started});
  }
}

function rmAttendanceVerifyStudentRest_(name, phone4) {
  const range = "'" + RM_ATTENDANCE_API.VERIFY_SHEET.replace(/'/g,"''") + "'!A2:E" + RM_ATTENDANCE_API.VERIFY_END_ROW;
  const payload = rmAttendanceValuesGet_(range, 'FORMATTED_VALUE');
  const values = payload.values || [];
  const target = rmAttendanceNormalize_(name);
  const matches = [];

  for (let i = 0; i < values.length; i += 1) {
    const r = values[i] || [];
    const displayName = rmAttendanceText_(r[0]);
    if (rmAttendanceNormalize_(displayName) !== target) continue;
    matches.push({name:displayName,phone4:rmAttendanceDigits_(r[4]).slice(-4)});
  }

  if (!matches.length) return {ok:false,error:'STUDENT_NOT_FOUND'};
  if (matches.length === 1) {
    if (phone4 && matches[0].phone4 && matches[0].phone4 !== phone4) return {ok:false,error:'PHONE_MISMATCH'};
    return {ok:true,name:matches[0].name};
  }
  if (phone4.length !== 4) return {ok:false,error:'PHONE4_REQUIRED',reason:'DUPLICATE_NAME'};
  const exact = matches.filter(r => r.phone4 === phone4);
  if (!exact.length) return {ok:false,error:'PHONE_MISMATCH'};
  if (exact.length > 1) return {ok:false,error:'IDENTITY_AMBIGUOUS'};
  return {ok:true,name:exact[0].name};
}

function rmAttendanceFindRowNumbersRest_(studentName) {
  const cache = CacheService.getScriptCache();
  const key = 'rows:v1:' + Utilities.base64EncodeWebSafe(studentName, Utilities.Charset.UTF_8);
  const cached = cache.get(key);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const range = "'" + RM_ATTENDANCE_API.SOURCE_SHEET.replace(/'/g,"''") + "'!F2:F" + RM_ATTENDANCE_API.SOURCE_END_ROW;
  const payload = rmAttendanceValuesGet_(range, 'FORMATTED_VALUE');
  const values = payload.values || [];
  const target = rmAttendanceNormalize_(studentName);
  const rows = [];

  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] && values[i][0];
    if (rmAttendanceNormalize_(v) === target) rows.push(i + 2);
  }

  rows.sort((a,b)=>b-a);
  const safe = rows.slice(0, RM_ATTENDANCE_API.MAX_ROWS);
  try { cache.put(key, JSON.stringify(safe), RM_ATTENDANCE_API.CACHE_SECONDS); } catch (e) {}
  return safe;
}

function rmAttendanceGetRowsRest_(studentName, rowNumbers) {
  const cache = CacheService.getScriptCache();
  const key = 'att:rest:v1:' + Utilities.base64EncodeWebSafe(studentName, Utilities.Charset.UTF_8);
  const cached = cache.get(key);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  if (!rowNumbers.length) return [];

  const sheetName = RM_ATTENDANCE_API.SOURCE_SHEET.replace(/'/g,"''");
  const rawRows = [];

  for (let offset = 0; offset < rowNumbers.length; offset += RM_ATTENDANCE_API.BATCH_SIZE) {
    const chunk = rowNumbers.slice(offset, offset + RM_ATTENDANCE_API.BATCH_SIZE);
    const qs = chunk.map(row => 'ranges=' + encodeURIComponent("'" + sheetName + "'!A" + row + ':P' + row)).join('&');
    const path = '/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '/values:batchGet?' + qs + '&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';
    const payload = rmAttendanceSheetsFetchJson_(path);
    const ranges = payload.valueRanges || [];
    for (let i = 0; i < ranges.length; i += 1) {
      rawRows.push((ranges[i].values && ranges[i].values[0]) ? ranges[i].values[0] : []);
    }
  }

  const target = rmAttendanceNormalize_(studentName);
  const result = [];
  for (let i = 0; i < rawRows.length; i += 1) {
    const r = rawRows[i];
    if (!r || r.length < 2) continue;
    if (rmAttendanceNormalize_(r[5]) !== target) continue;
    const lessonDate = rmAttendanceDate_(r[1]);
    if (!lessonDate) continue;
    const chargeUnits = rmAttendanceNumber_(r[11]);
    const completed = rmAttendanceNumberOrNull_(r[12]);
    const pkg = rmAttendanceNumberOrNull_(r[13]);
    const counter = completed === null ? '' : (pkg === null ? rmAttendanceFmt_(completed) + '/' : rmAttendanceFmt_(completed) + '(' + rmAttendanceFmt_(pkg) + ')');
    result.push({lessonDate:lessonDate,teacher:rmAttendanceText_(r[0]),classType:rmAttendanceText_(r[9]),chargeUnits:chargeUnits,counter:counter,status:chargeUnits>0?'차감':'미차감',sortKey:rmAttendanceNumber_(r[15])});
  }

  result.sort((a,b)=>(b.sortKey-a.sortKey)||b.lessonDate.localeCompare(a.lessonDate));
  const safe = result.map(r=>({lessonDate:r.lessonDate,teacher:r.teacher,classType:r.classType,chargeUnits:r.chargeUnits,counter:r.counter,status:r.status}));
  try { cache.put(key, JSON.stringify(safe), RM_ATTENDANCE_API.CACHE_SECONDS); } catch (e) {}
  return safe;
}

function rmAttendanceValuesGet_(range, valueRenderOption) {
  const path = '/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '/values/' + encodeURIComponent(range) + '?majorDimension=ROWS&valueRenderOption=' + encodeURIComponent(valueRenderOption || 'FORMATTED_VALUE');
  return rmAttendanceSheetsFetchJson_(path);
}

function rmAttendanceSheetsFetchJson_(path) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets' + path;
  const resp = UrlFetchApp.fetch(url, {
    method:'get',
    headers:{Authorization:'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions:true
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error('SHEETS_API_' + code + ':' + text.slice(0,300));
  return JSON.parse(text);
}

function rmAttendanceNumber_(value){const n=Number(value);return Number.isFinite(n)&&n>=0?n:0;}
function rmAttendanceNumberOrNull_(value){if(value===''||value===null||value===undefined)return null;const n=Number(value);return Number.isFinite(n)?n:null;}
function rmAttendanceFmt_(value){return Number.isInteger(value)?String(value):String(Number(value.toFixed(2)));}
function rmAttendanceDate_(value){
  if(value instanceof Date&&!isNaN(value.getTime()))return Utilities.formatDate(value,RM_ATTENDANCE_API.TZ,'yyyy-MM-dd');
  if(typeof value==='number'&&Number.isFinite(value)){const millis=Math.round((value-25569)*86400*1000);return Utilities.formatDate(new Date(millis),RM_ATTENDANCE_API.TZ,'yyyy-MM-dd');}
  const text=rmAttendanceText_(value);if(!text)return'';const parsed=new Date(text);if(isNaN(parsed.getTime()))return'';return Utilities.formatDate(parsed,RM_ATTENDANCE_API.TZ,'yyyy-MM-dd');
}
function rmAttendanceNormalize_(value){return rmAttendanceText_(value).toLowerCase().replace(/\s+/g,'');}
function rmAttendanceText_(value){return value===null||value===undefined?'':String(value).trim();}
function rmAttendanceDigits_(value){return rmAttendanceText_(value).replace(/\D/g,'');}
function rmAttendanceJson_(payload){return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);}

// Scope anchor: keeps spreadsheet OAuth scope available without executing SpreadsheetApp at runtime.
function rmAttendanceScopeAnchor_(){
  SpreadsheetApp.getActive();
}
