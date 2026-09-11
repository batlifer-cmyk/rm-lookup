const RM_LEDGER_V3 = Object.freeze({
  SHADOW_SPREADSHEET_ID: '1vRlKCZxUg31UoKyhaPaB57M9niNea227K8ygTR0QpOg',
  TZ: 'Asia/Seoul',
  WRITE_CHUNK_ROWS: 2000,
  SOURCES: Object.freeze([
    {key:'student_db', spreadsheetId:'16ZKz55oMD0wBUtv9-hMk_HrPfhxRAd9HQhtbY8981x0', range:"'학생DB'!A1:Z1000", target:'SRC_StudentDB', required:true},
    {key:'master', spreadsheetId:'16ZKz55oMD0wBUtv9-hMk_HrPfhxRAd9HQhtbY8981x0', range:"'Master Time Data'!A1:K23000", target:'SRC_Master', required:true},
    {key:'registration', spreadsheetId:'1lteVAxrMeI2GVJ95CpDuWUHw7cr5paoyJS8xwLWB-b8', range:"'_DB_등록로그'!A1:M3000", target:'SRC_Registration', required:true},
    {key:'payment', spreadsheetId:'1aEaCAmyapSQkPt6rL23gFDkB0CkMVkizbx-k9OAMlfU', range:"'입금로그'!A1:M3000", target:'SRC_Payment', required:true},
    {key:'legacy_balance', spreadsheetId:'1P42_8yxR0Tlys8g48Cq1h4SryRHzTlljE0A-bvngwnE', range:"'공개조회가능 정보모음_V2'!A1:J2000", target:'SRC_LegacyBalance', required:false},
    {key:'student_page', spreadsheetId:'16ZKz55oMD0wBUtv9-hMk_HrPfhxRAd9HQhtbY8981x0', range:"'Student_Page_View'!A1:L3000", target:'SRC_StudentPage', required:false}
  ])
});

/**
 * SHADOW ONLY.
 * Reads production sources, writes only RM Session Ledger V3 - SHADOW.
 * It never writes to Master Time Data, payment sheets, legacy registration sheets,
 * rm-lookup production deployment, scanner, JANDI, Make, or any other production store.
 */
function rmLedgerV3SyncShadowSources() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('RM_LEDGER_V3_SYNC_LOCKED');
  const startedAt = new Date();
  const report = [];
  try {
    const shadow = SpreadsheetApp.openById(RM_LEDGER_V3.SHADOW_SPREADSHEET_ID);
    RM_LEDGER_V3.SOURCES.forEach(src => {
      const item = {key:src.key,target:src.target,ok:false,rows:0,error:''};
      try {
        const values = rmLedgerV3SheetsValuesGet_(src.spreadsheetId, src.range);
        rmLedgerV3ReplaceSheetValues_(shadow, src.target, values);
        item.ok = true;
        item.rows = Math.max(0, values.length - 1);
      } catch (err) {
        item.error = String(err && err.message || err).slice(0,1000);
        if (src.required) report.push(item);
        else report.push(item);
      }
      if (!report.includes(item)) report.push(item);
    });
    SpreadsheetApp.flush();
    rmLedgerV3WriteSyncStatus_(shadow, startedAt, new Date(), report);
    const requiredFailures = report.filter((r,i) => !r.ok && RM_LEDGER_V3.SOURCES[i] && RM_LEDGER_V3.SOURCES[i].required);
    return {ok:requiredFailures.length===0, startedAt:startedAt.toISOString(), finishedAt:new Date().toISOString(), sources:report};
  } finally {
    lock.releaseLock();
  }
}

function rmLedgerV3SyncAndAudit() {
  const sync = rmLedgerV3SyncShadowSources();
  const ss = SpreadsheetApp.openById(RM_LEDGER_V3.SHADOW_SPREADSHEET_ID);
  SpreadsheetApp.flush();
  Utilities.sleep(1000);
  const audit = rmLedgerV3ReadAuditSummary_(ss);
  return {ok:sync.ok, sync:sync, audit:audit};
}

function rmLedgerV3ReadAuditSummary_(ss) {
  const out = {};
  ['Students','Registration_Events','Payment_Events','Session_Events','QA_Summary','Current_Balance','Discrepancy'].forEach(name => {
    const sh = ss.getSheetByName(name);
    out[name] = sh ? Math.max(0, sh.getLastRow()-1) : null;
  });
  const qa = ss.getSheetByName('QA_Summary');
  if (qa && qa.getLastRow() > 1) {
    const values = qa.getRange(2,13,qa.getLastRow()-1,3).getDisplayValues();
    const counts = {};
    values.forEach(r => {
      const key = r[0] || 'BLANK';
      counts[key] = (counts[key] || 0) + 1;
    });
    out.qaStatusCounts = counts;
  }
  return out;
}

function rmLedgerV3SheetsValuesGet_(spreadsheetId, a1Range) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(spreadsheetId)
    + '/values/' + encodeURIComponent(a1Range)
    + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';
  const resp = UrlFetchApp.fetch(url, {
    method:'get',
    headers:{Authorization:'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions:true
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error('SHEETS_API_' + code + ':' + text.slice(0,500));
  const json = JSON.parse(text);
  return Array.isArray(json.values) ? json.values : [];
}

function rmLedgerV3ReplaceSheetValues_(ss, sheetName, values) {
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('TARGET_SHEET_NOT_FOUND:' + sheetName);
  sh.clearContents();
  if (!values.length) return;
  const width = values.reduce((m,r) => Math.max(m,(r||[]).length),0);
  if (!width) return;
  if (sh.getMaxRows() < values.length) sh.insertRowsAfter(sh.getMaxRows(), values.length - sh.getMaxRows());
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  for (let offset=0; offset<values.length; offset += RM_LEDGER_V3.WRITE_CHUNK_ROWS) {
    const chunk = values.slice(offset, offset + RM_LEDGER_V3.WRITE_CHUNK_ROWS)
      .map(r => Array.from({length:width},(_,i) => (r && i < r.length ? r[i] : '')));
    sh.getRange(offset+1,1,chunk.length,width).setValues(chunk);
  }
}

function rmLedgerV3WriteSyncStatus_(ss, startedAt, finishedAt, report) {
  const cfg = ss.getSheetByName('Config');
  if (!cfg) return;
  const row = Math.max(cfg.getLastRow()+2, 18);
  const values = [
    ['last_sync_started', Utilities.formatDate(startedAt,RM_LEDGER_V3.TZ,'yyyy-MM-dd HH:mm:ss'), 'RUNTIME', ''],
    ['last_sync_finished', Utilities.formatDate(finishedAt,RM_LEDGER_V3.TZ,'yyyy-MM-dd HH:mm:ss'), 'RUNTIME', ''],
    ['last_sync_required_ok', report.every(r => r.ok || !RM_LEDGER_V3.SOURCES.find(s=>s.key===r.key).required), 'RUNTIME', ''],
    ['last_sync_report', JSON.stringify(report), 'RUNTIME', 'Shadow source snapshot result']
  ];
  cfg.getRange(row,1,values.length,4).setValues(values);
}

/**
 * Canonical unit parser for V3.
 * Evidence from Master Time Data + legacy V3:
 * - numeric 1/1.5/2/... -> same units
 * - S1 -> 1, S1.5 -> 1.5, S2 -> 2
 * - N/P/T -> 0
 * Unknown text must not silently become 0; it is a review condition.
 */
function rmLedgerV3ParseChargeUnits(value) {
  if (value === null || value === undefined || String(value).trim() === '') return {ok:false,units:null,code:'EMPTY'};
  const text = String(value).trim().toUpperCase();
  if (/^(N|P|T)$/.test(text)) return {ok:true,units:0,code:text};
  const s = text.match(/^S(\d+(?:\.\d+)?)$/);
  if (s) return {ok:true,units:Number(s[1]),code:text};
  const n = Number(text);
  if (Number.isFinite(n) && n >= 0) return {ok:true,units:n,code:'NUMERIC'};
  return {ok:false,units:null,code:'UNRECOGNIZED'};
}

function rmLedgerV3TestChargeParser() {
  const cases = [
    [1,1], [1.5,1.5], ['S1',1], ['s1',1], ['S1.5',1.5], ['S2',2],
    ['N',0], ['P',0], ['T',0]
  ];
  const failures = [];
  cases.forEach(([input,expected]) => {
    const got = rmLedgerV3ParseChargeUnits(input);
    if (!got.ok || Math.abs(got.units-expected) > 1e-9) failures.push({input,expected,got});
  });
  const unknown = rmLedgerV3ParseChargeUnits('취소');
  if (unknown.ok || unknown.units !== null) failures.push({input:'취소',expected:'review',got:unknown});
  if (failures.length) throw new Error('RM_LEDGER_V3_PARSER_TEST_FAILED:' + JSON.stringify(failures));
  return {ok:true,count:cases.length+1};
}
