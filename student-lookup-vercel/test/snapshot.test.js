'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectFreshSnapshot, lookupStudent } = require('../lib/snapshot');
const { authenticate, allowedPhone4s } = require('../lib/auth-index');
const handler = require('../api/lookup');

function entry(name, phone4, { remaining = 3, state = '확정', notice = '', lastLessonDate = '2026-09-18', registration = 8 } = {}) {
  const row = {'학생명':name,'전화번호':phone4,'잔여':remaining,'회차상태':state,'안내':notice,'마지막수업일':lastLessonDate,'등록횟수':registration};
  return {studentName:name,legacyRows:[row],cutoverRows:[{...row}]};
}
function slot(generation, records) { return [ ['generation_id','entry_key','entry_json'], ...records.map(([key,value])=>[generation,key,JSON.stringify(value)]) ]; }
function values(left, right) { return left.map((row,index)=>[...(row||[]),...((right[index])||[])]); }
const now = Date.UTC(2026,8,19,2,0,0);

test('latest complete generation is selected even while the other slot is incomplete', () => {
  const old = slot('20260919010000_old0001',[['a',entry('가나','1111')],['b',entry('나다','2222')]]);
  const incomplete = [['generation_id','entry_key','entry_json'],['20260919020000_new0001','a',JSON.stringify(entry('가나','1111'))]];
  const snapshot = selectFreshSnapshot(values(old,incomplete),{expectedCount:2,maxAgeSeconds:7200,now});
  assert.equal(snapshot.generationId,'20260919010000_old0001');
});

test('snapshot lookup returns only the permitted fields after identity is authenticated separately', () => {
  const record = entry('김학생','1234');
  record.cutoverRows[0]['전화번호'] = '010-1234-1234';
  record.cutoverRows[0].paymentEventId = 'PAY-synthetic';
  const result = lookupStudent(new Map([['kim',record]]),' 김 학생 ');
  assert.deepEqual(result,{studentName:'김학생',remainingLessons:3,lastLessonDate:'2026-09-18',latestRegistrationLessons:8});
  assert.deepEqual(Object.keys(result).sort(),['lastLessonDate','latestRegistrationLessons','remainingLessons','studentName']);
  assert.equal(JSON.stringify(result).includes('010-1234-1234'),false);
  assert.equal(JSON.stringify(result).includes('PAY-synthetic'),false);
});

test('wrong phone and nonexistent student have the identical no-result outcome', () => {
  const index = [{studentName:'김학생',phone4:'1234',status:'ACTIVE'}];
  assert.equal(authenticate(index,'김학생','9999'),null);
  assert.equal(authenticate(index,'없는학생','1234'),null);
});

test('same-name different phones authenticate separately but snapshot lookup remains fail-closed without a safe join key', () => {
  const entries = new Map([['lee-a',entry('이학생','1111',{remaining:1})],['lee-b',entry('이학생','2222',{remaining:7})]]);
  const index = [{studentName:'이학생',phone4:'1111',status:'ACTIVE'},{studentName:'이학생',phone4:'2222',status:'ACTIVE'}];
  assert.equal(authenticate(index,'이학생','9999'),null);
  assert.equal(authenticate(index,'이학생','1111').phone4,'1111');
  assert.equal(lookupStudent(entries,'이학생'),null);
});

test('zero remaining is preserved and confirmation-needed returns a notice', () => {
  const zero = new Map([['park',entry('박학생','3333',{remaining:0})]]);
  assert.equal(lookupStudent(zero,'박학생').remainingLessons,0);
  const review = new Map([['choi',entry('최학생','4444',{state:'확인 필요',notice:'운영팀 확인이 필요합니다.'})]]);
  assert.equal(lookupStudent(review,'최학생').notice,'운영팀 확인이 필요합니다.');
});

test('inactive and duplicate index rows never authenticate', () => {
  assert.equal(authenticate([{studentName:'김학생',phone4:'1234',status:'INACTIVE'}],'김학생','1234'),null);
  assert.equal(authenticate([{studentName:'김학생',phone4:'1234',status:'ACTIVE'},{studentName:'김학생',phone4:'1234',status:'ACTIVE'}],'김학생','1234'),null);
});

test('blank numeric snapshot values are null while explicit zero remains zero', () => {
  const blank = entry('빈값학생','5555',{remaining:'   ',registration:null});
  const blankResult = lookupStudent(new Map([['blank',blank]]),'빈값학생');
  assert.equal(blankResult.remainingLessons,null);
  assert.equal(blankResult.latestRegistrationLessons,null);
  const zero = entry('영회학생','6666',{remaining:0,registration:'0'});
  const zeroResult = lookupStudent(new Map([['zero',zero]]),'영회학생');
  assert.equal(zeroResult.remainingLessons,0);
  assert.equal(zeroResult.latestRegistrationLessons,0);
});

test('same name and same phone suffix in multiple index rows fails closed', () => {
  const records = [
    {studentName:'동명이인',phone4:'7777',status:'ACTIVE'},
    {studentName:'동명이인',phone4:'7777',status:'ACTIVE'}
  ];
  assert.equal(authenticate(records,'동명이인','7777'),null);
});

test('missing or malformed index phone values never authenticate', () => {
  assert.equal(authenticate([{studentName:'미확보',phone4:'',status:'ACTIVE'}],'미확보','1234'),null);
  assert.equal(authenticate([{studentName:'오류번호',phone4:'12x',status:'ACTIVE'}],'오류번호','1234'),null);
});

test('single, student, and guardian suffixes authenticate from one index cell', () => {
  const records = [{studentName:'테스트학생',phone4:'1357,2468',status:'ACTIVE'}];
  assert.equal(authenticate([{studentName:'단일학생',phone4:'1111',status:'ACTIVE'}],'단일학생','1111').studentName,'단일학생');
  assert.equal(authenticate(records,'테스트학생','1357').studentName,'테스트학생');
  assert.equal(authenticate(records,'테스트학생','2468').studentName,'테스트학생');
  assert.equal(authenticate(records,'테스트학생','9999'),null);
});

test('mixed separators and duplicate suffixes form one allowed suffix set', () => {
  const value = '1357;2468 | 3690\n1357';
  assert.deepEqual(allowedPhone4s(value),['1357','2468','3690']);
  const record = [{studentName:'구분학생',phone4:value,status:'ACTIVE'}];
  assert.equal(authenticate(record,'구분학생','1357').studentName,'구분학생');
});

test('malformed or full-phone tokens never become allowed suffixes', () => {
  assert.deepEqual(allowedPhone4s('1357abc'),[]);
  assert.deepEqual(allowedPhone4s('12345678901'),[]);
  assert.equal(authenticate([{studentName:'오류학생',phone4:'12345678901',status:'ACTIVE'}],'오류학생','8901'),null);
});

test('malformed JSON and duplicate snapshot keys make a slot unavailable', () => {
  const malformed = [['generation_id','entry_key','entry_json'],['20260919010000_bad0001','a','{']];
  assert.throws(() => selectFreshSnapshot(values(malformed,[]),{expectedCount:1,maxAgeSeconds:7200,now}),/SNAPSHOT_UNAVAILABLE/);
  const duplicate = slot('20260919010000_dup0001',[['a',entry('가나','1111')],['a',entry('나다','2222')]]);
  assert.throws(() => selectFreshSnapshot(values(duplicate,[]),{expectedCount:2,maxAgeSeconds:7200,now}),/SNAPSHOT_UNAVAILABLE/);
});

test('stale complete snapshot is rejected', () => {
  const old = slot('20260918010000_old0001',[['a',entry('가나','1111')]]);
  assert.throws(() => selectFreshSnapshot(values(old,[]),{expectedCount:1,maxAgeSeconds:1,now}),/SNAPSHOT_STALE/);
});

test('안내 status returns its notice', () => {
  const advised = entry('안내학생','8888',{state:'안내',notice:'다음 등록 전 운영팀에 문의해주세요.'});
  assert.equal(lookupStudent(new Map([['advised',advised]]),'안내학생').notice,'다음 등록 전 운영팀에 문의해주세요.');
});

function responseRecorder() {
  const state = {headers:{},statusCode:null,body:null};
  return {
    state,
    setHeader(key,value) { state.headers[key] = value; },
    status(code) { state.statusCode = code; return this; },
    json(body) { state.body = body; return body; }
  };
}

test('non-POST requests are rejected before any backend read', async () => {
  const res = responseRecorder();
  await handler({method:'GET',headers:{}},res);
  assert.equal(res.state.statusCode,405);
  assert.deepEqual(res.state.body,{ok:false,error:'METHOD_NOT_ALLOWED'});
});

test('invalid input is rejected before any backend read', async () => {
  const res = responseRecorder();
  await handler({method:'POST',headers:{},body:{name:'학생',phone4:'12'}},res);
  assert.equal(res.state.statusCode,400);
  assert.deepEqual(res.state.body,{ok:false,error:'INVALID_INPUT'});
});
