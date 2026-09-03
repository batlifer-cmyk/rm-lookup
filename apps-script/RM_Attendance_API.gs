const RM_ATTENDANCE_API = Object.freeze({
  DATA_SPREADSHEET_ID: '16ZKz55oMD0wBUtv9-hMk_HrPfhxRAd9HQhtbY8981x0',
  SUMMARY_SPREADSHEET_ID: '1P42_8yxR0Tlys8g48Cq1h4SryRHzTlljE0A-bvngwnE',
  SUMMARY_SHEET: '공개조회가능 정보모음_V2',
  REGISTRATION_SHEET: '_DB_등록로그',
  REGISTRATION_CACHE_SHEET: '_API_Registration_Cache',
  VERIFY_SHEET: 'Student_Page_View',
  SOURCE_SHEET: 'Master Time Data',
  TZ: 'Asia/Seoul',
  CACHE_SECONDS: 120,
  REGISTRATION_END_ROW: 350,
  SUMMARY_END_ROW: 2000,
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

  if (action === 'health') return rmJson_({ok:true,service:'rm-attendance',source:'RM Data Overview',elapsedMs:Date.now()-started});

  try {
    if (action === 'restcheck') {
      const meta = rmSheetsFetchJson_('/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '?fields=properties.title');
      return rmJson_({ok:true,spreadsheet:meta.properties && meta.properties.title || '',mode:'rest',elapsedMs:Date.now()-started});
    }
    if (!name) return rmJson_({ok:false,error:'NAME_REQUIRED',elapsedMs:Date.now()-started});

    if (action === 'summary') {
      const rows = rmSummaryFromSource_(name, phone4);
      return rmJson_({ok:true,count:rows.length,elapsedMs:Date.now()-started,rows:rows});
    }

    const verified = rmVerifyStudent_(name, phone4);
    if (!verified.ok) { verified.elapsedMs = Date.now()-started; return rmJson_(verified); }
    if (action === 'verify') return rmJson_({ok:true,studentName:verified.name,stage:'verify-source',elapsedMs:Date.now()-started});

    const rowNumbers = rmFindRows_(verified.name);
    if (action === 'findrows') return rmJson_({ok:true,studentName:verified.name,stage:'findrows-source',count:rowNumbers.length,sampleRows:rowNumbers.slice(0,10),elapsedMs:Date.now()-started});
    if (action !== 'attendance') return rmJson_({ok:false,error:'UNKNOWN_ACTION',elapsedMs:Date.now()-started});

    const rows = rmGetAttendance_(verified.name, rowNumbers);
    return rmJson_({ok:true,studentName:verified.name,lastLessonDate:rows.length?rows[0].lessonDate:null,count:rows.length,elapsedMs:Date.now()-started,attendance:rows});
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

function rmSummaryFromSource_(query, phone4) {
  const candidates = rmFindPublicStudents_(query, phone4);
  const registrations = rmRegistrationCache_();
  const out = [];
  for (let i=0;i<candidates.length;i+=1) {
    const s = candidates[i];
    const progress = rmProgressFromStudentPage_(s.result8Unit);
    const registration = registrations[rmNormalize_(s.name)] || null;
    const regCount = registration ? rmNumber_(registration.count) : null;
    const total = regCount !== null ? regCount : progress.total;
    const remain = total !== null && progress.used !== null ? Math.max(0,total-progress.used) : null;
    const confirmed = rmText_(registration && registration.status) || (total === null ? '확인 필요' : '확정');
    out.push({
      '학생명':s.name,
      '전화번호':s.phone4,
      '등록횟수':total === null ? '' : total,
      '잔여':remain === null ? '' : remain,
      '최근등록일':registration ? registration.date : '',
      '졸업여부':s.status === 'graduate' ? '졸업' : '',
      '회차상태':confirmed,
      '안내':total === null || remain === null ? '최근 수업기록의 회차표기를 운영팀이 확인하고 있습니다.' : '',
      '마지막수업일':'',
      '상세키':'',
      '미납선수업':''
    });
  }
  return out;
}

function rmProgressFromStudentPage_(value) {
  const text = rmText_(value);
  const m = text.match(/\d+번째\s*(\d+(?:\.\d+)?)회권의\s*(\d+(?:\.\d+)?)회차/);
  if (!m) return {total:null,used:null};
  return {total:Number(m[1]),used:Number(m[2])};
}

function rmRegistrationCache_() {
  const range = "'" + RM_ATTENDANCE_API.REGISTRATION_CACHE_SHEET.replace(/'/g,"''") + "'!A2:E2000";
  let values = [];
  try {
    values = (rmValuesGet_(range,'FORMATTED_VALUE').values || []);
  } catch (err) {
    console.warn('Registration cache is unavailable: ' + rmText_(err && err.message));
    return {};
  }
  const registrations = {};
  for (let i=0;i<values.length;i+=1) {
    const r = values[i] || [];
    const name = rmText_(r[0]);
    if (!name) continue;
    registrations[rmNormalize_(name)] = {
      date:rmText_(r[1]),
      count:r[2],
      status:rmText_(r[3])
    };
  }
  return registrations;
}

function setupRegistrationCache() {
  const trigger = rmInstallRegistrationCacheTrigger_();
  const refresh = rmRefreshRegistrationCache_();
  return {ok:true,trigger:trigger,refresh:refresh};
}

function rmRefreshRegistrationCache_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return {ok:false,error:'REFRESH_ALREADY_RUNNING'};
  try {
    const sourceRange = "'" + RM_ATTENDANCE_API.REGISTRATION_SHEET.replace(/'/g,"''") + "'!A2:J" + RM_ATTENDANCE_API.REGISTRATION_END_ROW;
    const values = (rmValuesGetFrom_(RM_ATTENDANCE_API.SUMMARY_SPREADSHEET_ID,sourceRange,'FORMATTED_VALUE').values || []);
    const latest = {};
    for (let i=0;i<values.length;i+=1) {
      const r = values[i] || [];
      const name = rmText_(r[1]);
      const date = rmRegistrationDate_(r[0]);
      if (!name || !date) continue;
      const item = {name:name,date:date,count:r[4],status:rmText_(r[8])};
      const key = rmNormalize_(name);
      if (!latest[key] || date > latest[key].date) latest[key] = item;
    }

    const updatedAt = Utilities.formatDate(new Date(),RM_ATTENDANCE_API.TZ,'yyyy-MM-dd HH:mm:ss');
    const rows = Object.keys(latest).sort().map(key=>{
      const item = latest[key];
      return [item.name,item.date,item.count,item.status,updatedAt];
    });
    const spreadsheet = SpreadsheetApp.openById(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID);
    let sheet = spreadsheet.getSheetByName(RM_ATTENDANCE_API.REGISTRATION_CACHE_SHEET);
    if (!sheet) sheet = spreadsheet.insertSheet(RM_ATTENDANCE_API.REGISTRATION_CACHE_SHEET);
    sheet.clearContents();
    sheet.getRange(1,1,1,5).setValues([['student_name','latest_registration_date','registration_count','status','cache_updated_at']]);
    if (rows.length) sheet.getRange(2,1,rows.length,5).setValues(rows);
    if (!sheet.isSheetHidden()) sheet.hideSheet();
    return {ok:true,count:rows.length,updatedAt:updatedAt};
  } finally {
    lock.releaseLock();
  }
}

function rmInstallRegistrationCacheTrigger_() {
  const handler = 'rmRefreshRegistrationCache_';
  ScriptApp.getProjectTriggers().forEach(trigger=>{
    if (trigger.getHandlerFunction() === handler) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(handler).timeBased().everyHours(1).create();
  return {ok:true,handler:handler,interval:'1 hour'};
}

function rmRegistrationDate_(value) {
  const text = rmText_(value);
  const match = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!match) return '';
  return match[1] + '-' + String(Number(match[2])).padStart(2,'0') + '-' + String(Number(match[3])).padStart(2,'0');
}
function rmFindPublicStudents_(query, phone4) {
  const range = "'" + RM_ATTENDANCE_API.VERIFY_SHEET.replace(/'/g,"''") + "'!A2:L" + RM_ATTENDANCE_API.VERIFY_END_ROW;
  const values = (rmValuesGet_(range,'FORMATTED_VALUE').values || []);
  const q = rmNormalize_(query);
  let matches = [];
  for (let i=0;i<values.length;i+=1) {
    const r = values[i] || [];
    const isPublic = String(r[0] || '').toUpperCase() === 'TRUE';
    const displayName = rmText_(r[1]);
    if (!isPublic || rmNormalize_(displayName).indexOf(q) === -1) continue;
    matches.push({name:displayName,phone4:rmDigits_(r[3]).slice(-4),status:rmText_(r[7]).toLowerCase(),result8Unit:rmText_(r[8])});
  }
  if (phone4.length === 4) {
    const exact = matches.filter(r=>r.phone4===phone4);
    if (exact.length) matches = exact;
  }
  return matches.slice(0,10);
}

function rmVerifyStudent_(name, phone4) {
  const matches = rmFindPublicStudents_(name, phone4).filter(r=>rmNormalize_(r.name)===rmNormalize_(name));
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
  const key = 'rows:master:v3:' + Utilities.base64EncodeWebSafe(studentName,Utilities.Charset.UTF_8);
  const cached = cache.get(key);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }
  const range = "'" + RM_ATTENDANCE_API.SOURCE_SHEET.replace(/'/g,"''") + "'!F2:F" + RM_ATTENDANCE_API.SOURCE_END_ROW;
  const values = (rmValuesGet_(range,'FORMATTED_VALUE').values || []);
  const target = rmNormalize_(studentName);
  const rows = [];
  for (let i=0;i<values.length;i+=1) if (rmNormalize_(values[i] && values[i][0]) === target) rows.push(i+2);
  rows.sort((a,b)=>b-a);
  const safe = rows.slice(0,RM_ATTENDANCE_API.MAX_ROWS);
  try { cache.put(key,JSON.stringify(safe),RM_ATTENDANCE_API.CACHE_SECONDS); } catch(e) {}
  return safe;
}

function rmGetAttendance_(studentName,rowNumbers) {
  const cache = CacheService.getScriptCache();
  const key = 'att:master:v3:' + Utilities.base64EncodeWebSafe(studentName,Utilities.Charset.UTF_8);
  const cached = cache.get(key);
  if (cached) { try { return JSON.parse(cached); } catch(e) {} }
  if (!rowNumbers.length) return [];

  const sheetName = RM_ATTENDANCE_API.SOURCE_SHEET.replace(/'/g,"''");
  const rawRows = [];
  for (let offset=0;offset<rowNumbers.length;offset+=RM_ATTENDANCE_API.BATCH_SIZE) {
    const chunk = rowNumbers.slice(offset,offset+RM_ATTENDANCE_API.BATCH_SIZE);
    const filters = chunk.map(row=>({a1Range:"'"+sheetName+"'!A"+row+':K'+row}));
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
    result.push({lessonDate:lessonDate,teacher:rmText_(r[0]),classType:rmText_(r[9]),chargeUnits:chargeUnits,counter:counter,status:chargeUnits>0?'차감':'미차감'});
  }
  result.sort((a,b)=>b.lessonDate.localeCompare(a.lessonDate));
  try { cache.put(key,JSON.stringify(result),RM_ATTENDANCE_API.CACHE_SECONDS); } catch(e) {}
  return result;
}

function rmBatchGetByDataFilter_(dataFilters) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID) + '/values:batchGetByDataFilter';
  const resp = UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},payload:JSON.stringify({dataFilters:dataFilters,majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE'}),muteHttpExceptions:true});
  const code = resp.getResponseCode(), text = resp.getContentText();
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
function rmCounterDone_(counter){const m=rmText_(counter).match(/^(\d+(?:\.\d+)?)(?:\(|\/)/);return m?Number(m[1]):null;}
function rmCounterPackage_(counter){const m=rmText_(counter).match(/^\d+(?:\.\d+)?\((\d+(?:\.\d+)?)\)/);return m?Number(m[1]):null;}
function rmHoursToUnits_(value){const text=rmText_(value).toLowerCase();if(!text||text==='n')return 0;if(text==='s1')return 0.5;const n=Number(text);return Number.isFinite(n)&&n>0?n:0;}
function rmValuesGetFrom_(spreadsheetId,range,valueRenderOption){const path='/'+encodeURIComponent(spreadsheetId)+'/values/'+encodeURIComponent(range)+'?majorDimension=ROWS&valueRenderOption='+encodeURIComponent(valueRenderOption||'FORMATTED_VALUE');return rmSheetsFetchJson_(path);}
function rmValuesGet_(range,valueRenderOption){return rmValuesGetFrom_(RM_ATTENDANCE_API.DATA_SPREADSHEET_ID,range,valueRenderOption);}
function rmSheetsFetchJson_(path){const url='https://sheets.googleapis.com/v4/spreadsheets'+path;const resp=UrlFetchApp.fetch(url,{method:'get',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});const code=resp.getResponseCode(),text=resp.getContentText();if(code<200||code>=300)throw new Error('SHEETS_API_'+code+':'+text.slice(0,300));return JSON.parse(text);}
function rmDate_(value){const text=rmText_(value);if(!text)return'';const d=new Date(text);if(isNaN(d.getTime()))return'';return Utilities.formatDate(d,RM_ATTENDANCE_API.TZ,'yyyy-MM-dd');}
function rmFmt_(value){return Number.isInteger(value)?String(value):String(Number(value.toFixed(2)));}
function rmNumber_(value){const text=rmText_(value).replace(/,/g,'');if(!text)return null;const n=Number(text);return Number.isFinite(n)?n:null;}
function rmNormalize_(value){return rmText_(value).toLowerCase().replace(/\s+/g,'');}
function rmText_(value){return value===null||value===undefined?'':String(value).trim();}
function rmDigits_(value){return rmText_(value).replace(/\D/g,'');}
function rmJson_(payload){return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);}
function rmAttendanceScopeAnchor_(){SpreadsheetApp.getActive();}
