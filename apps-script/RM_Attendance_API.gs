const RM_ATTENDANCE_API = Object.freeze({
  DATA_SPREADSHEET_ID: '16ZKz55oMD0wBUtv9-hMk_HrPfhxRAd9HQhtbY8981x0',
  VERIFY_SHEET: 'Student_Page_View',
  SOURCE_SHEET: 'Master Time Data',
  PUBLIC_CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTDHzGU8F-Mg7bl0Vs0Sk_8NABqRg6ZGJEidR-icifeg2DOBILIYc9lHVSR1e2npoSuIpFO57yRh2yC/pub?gid=550578481&single=true&output=csv',
  TZ: 'Asia/Seoul',
  CACHE_SECONDS: 120,
  VERIFY_END_ROW: 3000,
  SOURCE_END_ROW: 23000,
  MAX_ROWS: 300,
  BATCH_SIZE: 80
});

function doGet(e) {
  const started = Date.now();
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'attendance').trim();
  const name = rmText_(p.name);
  const phone4 = rmDigits_(p.phone4).slice(-4);

  if (action === 'health') {
    return rmJson_({ok:true,service:'rm-attendance',source:'RM Data Overview',elapsedMs:Date.now()-started});
  }

  try {
    if (action === 'restcheck') {
      const meta = rmSheetsFetchJson_('/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '?fields=properties.title');
      return rmJson_({ok:true,spreadsheet:meta.properties && meta.properties.title || '',mode:'rest',elapsedMs:Date.now()-started});
    }

    if (!name) return rmJson_({ok:false,error:'NAME_REQUIRED',elapsedMs:Date.now()-started});

    if (action === 'summary') {
      const rows = rmSummaryLookup_(name, phone4);
      return rmJson_({ok:true,count:rows.length,elapsedMs:Date.now()-started,rows:rows});
    }

    const verified = rmVerifyStudent_(name, phone4);
    if (!verified.ok) {
      verified.elapsedMs = Date.now()-started;
      return rmJson_(verified);
    }

    if (action === 'verify') {
      return rmJson_({ok:true,studentName:verified.name,stage:'verify-source',elapsedMs:Date.now()-started});
    }

    const rowNumbers = rmFindRows_(verified.name);

    if (action === 'findrows') {
      return rmJson_({ok:true,studentName:verified.name,stage:'findrows-source',count:rowNumbers.length,sampleRows:rowNumbers.slice(0,10),elapsedMs:Date.now()-started});
    }

    if (action !== 'attendance') {
      return rmJson_({ok:false,error:'UNKNOWN_ACTION',elapsedMs:Date.now()-started});
    }

    const rows = rmGetAttendance_(verified.name, rowNumbers);
    return rmJson_({
      ok:true,
      studentName:verified.name,
      lastLessonDate:rows.length ? rows[0].lessonDate : null,
      count:rows.length,
      elapsedMs:Date.now()-started,
      attendance:rows
    });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return rmJson_({ok:false,error:'SERVER_ERROR',detail:rmText_(err && err.message),elapsedMs:Date.now()-started});
  }
}

function authorizeRestAccess() {
  const token = ScriptApp.getOAuthToken();
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '?fields=properties.title';
  const resp = UrlFetchApp.fetch(url,{method:'get',headers:{Authorization:'Bearer '+token},muteHttpExceptions:true});
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error('AUTH_TEST_FAILED_' + code + ':' + text.slice(0,300));
  const payload = JSON.parse(text);
  console.log('REST authorization OK: ' + ((payload.properties && payload.properties.title) || 'spreadsheet'));
  return true;
}

function rmSummaryLookup_(name, phone4) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'summary:csv:v1';
  let csv = cache.get(cacheKey);

  if (!csv) {
    const resp = UrlFetchApp.fetch(RM_ATTENDANCE_API.PUBLIC_CSV_URL,{method:'get',muteHttpExceptions:true,followRedirects:true});
    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) throw new Error('SUMMARY_CSV_' + code);
    csv = resp.getContentText('UTF-8');
    try { cache.put(cacheKey,csv,RM_ATTENDANCE_API.CACHE_SECONDS); } catch(e) {}
  }

  const table = Utilities.parseCsv(csv);
  if (!table.length) return [];
  const headers = table[0].map(h=>rmText_(h));
  const nameIdx = headers.indexOf('학생명');
  const phoneIdx = headers.indexOf('전화번호');
  if (nameIdx < 0) throw new Error('SUMMARY_NAME_COLUMN_MISSING');

  const q = rmText_(name);
  let rows = [];
  for (let i=1;i<table.length;i+=1) {
    const r = table[i] || [];
    const studentName = rmText_(r[nameIdx]);
    if (!studentName || studentName.indexOf(q) === -1) continue;
    const obj = {};
    for (let c=0;c<headers.length;c+=1) {
      if (headers[c]) obj[headers[c]] = r[c] === undefined ? '' : r[c];
    }
    rows.push(obj);
  }

  if (phone4.length === 4 && phoneIdx >= 0) {
    const exact = rows.filter(r=>rmDigits_(r['전화번호']).slice(-4)===phone4);
    if (exact.length) rows = exact;
  }

  return rows;
}

function rmVerifyStudent_(name, phone4) {
  const range = "'" + RM_ATTENDANCE_API.VERIFY_SHEET.replace(/'/g,"''") + "'!A2:D" + RM_ATTENDANCE_API.VERIFY_END_ROW;
  const values = (rmValuesGet_(range,'FORMATTED_VALUE').values || []);
  const target = rmNormalize_(name);
  const matches = [];

  for (let i=0;i<values.length;i+=1) {
    const r = values[i] || [];
    const isPublic = String(r[0] || '').toUpperCase() === 'TRUE';
    const displayName = rmText_(r[1]);
    if (!isPublic || rmNormalize_(displayName) !== target) continue;
    matches.push({name:displayName,phone4:rmDigits_(r[3]).slice(-4)});
  }

  if (!matches.length) return {ok:false,error:'STUDENT_NOT_FOUND'};
  if (matches.length === 1) {
    if (phone4 && matches[0].phone4 && matches[0].phone4 !== phone4) return {ok:false,error:'PHONE_MISMATCH'};
    return {ok:true,name:matches[0].name};
  }
  if (phone4.length !== 4) return {ok:false,error:'PHONE4_REQUIRED',reason:'DUPLICATE_NAME'};
  const exact = matches.filter(r=>r.phone4===phone4);
  if (!exact.length) return {ok:false,error:'PHONE_MISMATCH'};
  if (exact.length > 1) return {ok:false,error:'IDENTITY_AMBIGUOUS'};
  return {ok:true,name:exact[0].name};
}

function rmFindRows_(studentName) {
  const cache = CacheService.getScriptCache();
  const key = 'rows:master:v2:' + Utilities.base64EncodeWebSafe(studentName,Utilities.Charset.UTF_8);
  const cached = cache.get(key);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }

  const range = "'" + RM_ATTENDANCE_API.SOURCE_SHEET.replace(/'/g,"''") + "'!F2:F" + RM_ATTENDANCE_API.SOURCE_END_ROW;
  const values = (rmValuesGet_(range,'FORMATTED_VALUE').values || []);
  const target = rmNormalize_(studentName);
  const rows = [];
  for (let i=0;i<values.length;i+=1) {
    if (rmNormalize_(values[i] && values[i][0]) === target) rows.push(i+2);
  }
  rows.sort((a,b)=>b-a);
  const safe = rows.slice(0,RM_ATTENDANCE_API.MAX_ROWS);
  try { cache.put(key,JSON.stringify(safe),RM_ATTENDANCE_API.CACHE_SECONDS); } catch(e) {}
  return safe;
}

function rmGetAttendance_(studentName,rowNumbers) {
  const cache = CacheService.getScriptCache();
  const key = 'att:master:v2:' + Utilities.base64EncodeWebSafe(studentName,Utilities.Charset.UTF_8);
  const cached = cache.get(key);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }
  if (!rowNumbers.length) return [];

  const sheetName = RM_ATTENDANCE_API.SOURCE_SHEET.replace(/'/g,"''");
  const rawRows = [];

  for (let offset=0;offset<rowNumbers.length;offset+=RM_ATTENDANCE_API.BATCH_SIZE) {
    const chunk = rowNumbers.slice(offset,offset+RM_ATTENDANCE_API.BATCH_SIZE);
    const filters = chunk.map(row => ({a1Range:"'"+sheetName+"'!A"+row+':K'+row}));
    const payload = rmBatchGetByDataFilter_(filters);
    const ranges = payload.valueRanges || [];
    for (let i=0;i<ranges.length;i+=1) {
      const vr = ranges[i] && ranges[i].valueRange;
      rawRows.push((vr && vr.values && vr.values[0]) ? vr.values[0] : []);
    }
  }

  const target = rmNormalize_(studentName);
  const result = [];
  for (let i=0;i<rawRows.length;i+=1) {
    const r = rawRows[i];
    if (!r || rmNormalize_(r[5]) !== target) continue;
    const lessonDate = rmDate_(r[1]);
    if (!lessonDate) continue;
    const chargeUnits = rmHoursToUnits_(r[6]);
    const counter = rmCounterFromNote_(r[10]);
    result.push({
      lessonDate:lessonDate,
      teacher:rmText_(r[0]),
      classType:rmText_(r[9]),
      chargeUnits:chargeUnits,
      counter:counter,
      status:chargeUnits>0?'차감':'미차감'
    });
  }

  result.sort((a,b)=>b.lessonDate.localeCompare(a.lessonDate));
  try { cache.put(key,JSON.stringify(result),RM_ATTENDANCE_API.CACHE_SECONDS); } catch(e) {}
  return result;
}

function rmBatchGetByDataFilter_(dataFilters) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
    encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) +
    '/values:batchGetByDataFilter';
  const body = {
    dataFilters:dataFilters,
    majorDimension:'ROWS',
    valueRenderOption:'FORMATTED_VALUE'
  };
  const resp = UrlFetchApp.fetch(url,{
    method:'post',
    contentType:'application/json',
    headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},
    payload:JSON.stringify(body),
    muteHttpExceptions:true
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error('SHEETS_API_' + code + ':' + text.slice(0,300));
  return JSON.parse(text);
}

function rmCounterFromNote_(note) {
  const text = rmText_(note);
  if (!text) return '';
  let m = text.match(/(\d+(?:\.\d+)?)\s*\(\s*(\d+(?:\.\d+)?)/);
  if (m) return rmFmt_(Number(m[1])) + '(' + rmFmt_(Number(m[2])) + ')';
  m = text.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*\//);
  if (m) return rmFmt_(Number(m[1])) + '/';
  return '';
}

function rmHoursToUnits_(value) {
  const text = rmText_(value).toLowerCase();
  if (!text || text === 'n') return 0;
  if (text === 's1') return 0.5;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function rmValuesGet_(range,valueRenderOption) {
  const path = '/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '/values/' + encodeURIComponent(range) + '?majorDimension=ROWS&valueRenderOption=' + encodeURIComponent(valueRenderOption || 'FORMATTED_VALUE');
  return rmSheetsFetchJson_(path);
}

function rmSheetsFetchJson_(path) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets' + path;
  const resp = UrlFetchApp.fetch(url,{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error('SHEETS_API_' + code + ':' + text.slice(0,300));
  return JSON.parse(text);
}

function rmDate_(value) {
  const text = rmText_(value);
  if (!text) return '';
  const d = new Date(text);
  if (isNaN(d.getTime())) return '';
  return Utilities.formatDate(d,RM_ATTENDANCE_API.TZ,'yyyy-MM-dd');
}
function rmFmt_(value){return Number.isInteger(value)?String(value):String(Number(value.toFixed(2)));}
function rmNormalize_(value){return rmText_(value).toLowerCase().replace(/\s+/g,'');}
function rmText_(value){return value===null||value===undefined?'':String(value).trim();}
function rmDigits_(value){return rmText_(value).replace(/\D/g,'');}
function rmJson_(payload){return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);}

function rmAttendanceScopeAnchor_(){SpreadsheetApp.getActive();}
