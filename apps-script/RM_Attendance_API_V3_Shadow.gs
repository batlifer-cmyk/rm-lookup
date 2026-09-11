const RM_ATTENDANCE_V3_SHADOW = Object.freeze({
  SPREADSHEET_ID: '1vRlKCZxUg31UoKyhaPaB57M9niNea227K8ygTR0QpOg',
  BALANCE_SHEET: 'Current_Balance',
  STUDENTS_SHEET: 'Students',
  SESSIONS_SHEET: 'Session_Events',
  MAX_DETAIL_ROWS: 300,
  TZ: 'Asia/Seoul'
});

/**
 * STAGING/SHADOW ONLY.
 * Deploy in a separate Apps Script project if testing over HTTP.
 * Do NOT paste this file into the current production project next to another doGet.
 */
function doGet(e) {
  const started = Date.now();
  const p = (e && e.parameter) || {};
  const action = String(p.action || 'summary').trim();
  const name = rmV3Text_(p.name);
  const phone4 = rmV3Digits_(p.phone4).slice(-4);

  try {
    if (action === 'health') return rmV3Json_({ok:true,service:'rm-session-ledger-v3-shadow',mode:'SHADOW',elapsedMs:Date.now()-started});
    if (!name) return rmV3Json_({ok:false,error:'NAME_REQUIRED',elapsedMs:Date.now()-started});

    const identity = rmV3ResolveStudent_(name, phone4);
    if (!identity.ok) {
      identity.elapsedMs = Date.now()-started;
      return rmV3Json_(identity);
    }

    if (action === 'summary') {
      const summary = rmV3GetBalance_(identity.studentId);
      return rmV3Json_({ok:true,studentId:identity.studentId,studentName:identity.studentName,summary:summary,elapsedMs:Date.now()-started});
    }
    if (action === 'attendance') {
      const rows = rmV3GetSessions_(identity.studentId);
      return rmV3Json_({ok:true,studentId:identity.studentId,studentName:identity.studentName,count:rows.length,attendance:rows,elapsedMs:Date.now()-started});
    }
    if (action === 'full') {
      const summary = rmV3GetBalance_(identity.studentId);
      const rows = rmV3GetSessions_(identity.studentId);
      return rmV3Json_({ok:true,studentId:identity.studentId,studentName:identity.studentName,summary:summary,count:rows.length,attendance:rows,elapsedMs:Date.now()-started});
    }
    return rmV3Json_({ok:false,error:'UNKNOWN_ACTION',elapsedMs:Date.now()-started});
  } catch (err) {
    return rmV3Json_({ok:false,error:'SERVER_ERROR',detail:rmV3Text_(err && err.message),elapsedMs:Date.now()-started});
  }
}

function rmV3ResolveStudent_(name, phone4) {
  const ss = SpreadsheetApp.openById(RM_ATTENDANCE_V3_SHADOW.SPREADSHEET_ID);
  const sh = ss.getSheetByName(RM_ATTENDANCE_V3_SHADOW.STUDENTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return {ok:false,error:'STUDENT_SOURCE_EMPTY'};
  const rows = sh.getRange(2,1,sh.getLastRow()-1,12).getDisplayValues();
  const q = rmV3Norm_(name);
  let matches = rows.filter(r => r[0] && rmV3Norm_(r[1]) === q && String(r[11]).toUpperCase() !== 'FALSE');
  if (phone4.length === 4) {
    const exact = matches.filter(r => rmV3Digits_(r[2]).slice(-4) === phone4);
    if (exact.length) matches = exact;
  }
  if (!matches.length) return {ok:false,error:'STUDENT_NOT_FOUND'};
  if (matches.length > 1 && phone4.length !== 4) return {ok:false,error:'PHONE4_REQUIRED',reason:'DUPLICATE_NAME'};
  if (matches.length > 1) return {ok:false,error:'IDENTITY_AMBIGUOUS'};
  if (phone4.length === 4 && matches[0][2] && rmV3Digits_(matches[0][2]).slice(-4) !== phone4) return {ok:false,error:'PHONE_MISMATCH'};
  return {ok:true,studentId:matches[0][0],studentName:matches[0][1]};
}

function rmV3GetBalance_(studentId) {
  const ss = SpreadsheetApp.openById(RM_ATTENDANCE_V3_SHADOW.SPREADSHEET_ID);
  const sh = ss.getSheetByName(RM_ATTENDANCE_V3_SHADOW.BALANCE_SHEET);
  if (!sh || sh.getLastRow() < 2) throw new Error('BALANCE_SOURCE_EMPTY');
  const rows = sh.getRange(2,1,sh.getLastRow()-1,24).getDisplayValues();
  const r = rows.find(row => row[0] === studentId);
  if (!r) throw new Error('BALANCE_NOT_FOUND');
  const status = r[12];
  const balance = rmV3Number_(r[6]);
  return {
    currentBalance: balance,
    calcStatus: status,
    displayState: status === 'OK' && balance !== null ? 'CONFIRMED' : 'REVIEW',
    anchorRemaining: rmV3Number_(r[2]),
    registrationsAfterAnchor: rmV3Number_(r[3]),
    sessionsAfterAnchor: rmV3Number_(r[4]),
    adjustmentsAfterAnchor: rmV3Number_(r[5]),
    lastRegistrationDate: r[7] || '',
    lastSessionDate: r[8] || '',
    packageUnits: rmV3Number_(r[9]),
    packageUsed: rmV3Number_(r[10]),
    packageRemaining: rmV3Number_(r[11]),
    legacyBalance: rmV3Number_(r[15]),
    deltaVsLegacy: rmV3Number_(r[16]),
    discrepancyStatus: r[17] || '',
    studentStatus: r[18] || '',
    evidence: r[21] || ''
  };
}

function rmV3GetSessions_(studentId) {
  const ss = SpreadsheetApp.openById(RM_ATTENDANCE_V3_SHADOW.SPREADSHEET_ID);
  const sh = ss.getSheetByName(RM_ATTENDANCE_V3_SHADOW.SESSIONS_SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getRange(2,1,sh.getLastRow()-1,22).getDisplayValues();
  return values
    .filter(r => r[1] === studentId)
    .map(r => ({
      sessionEventId:r[0],
      lessonDate:r[4] || r[3],
      teacher:r[5],
      hoursRaw:r[6],
      chargeUnits:rmV3Number_(r[7]),
      classType:r[8],
      note:r[9],
      chargeStatus:r[13],
      noteCounter:r[16],
      notePackage:r[17],
      validationStatus:r[18]
    }))
    .sort((a,b) => String(b.lessonDate).localeCompare(String(a.lessonDate)))
    .slice(0,RM_ATTENDANCE_V3_SHADOW.MAX_DETAIL_ROWS);
}

function rmV3Number_(v) {
  const t = String(v === null || v === undefined ? '' : v).replace(/,/g,'').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function rmV3Text_(v){return v===null||v===undefined?'':String(v).trim();}
function rmV3Digits_(v){return rmV3Text_(v).replace(/\D/g,'');}
function rmV3Norm_(v){return rmV3Text_(v).toLowerCase().replace(/\s+/g,'');}
function rmV3Json_(v){return ContentService.createTextOutput(JSON.stringify(v)).setMimeType(ContentService.MimeType.JSON);}
