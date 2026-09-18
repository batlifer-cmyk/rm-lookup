'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectFreshSnapshot, lookupStudent } = require('../lib/snapshot');

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

test('correct identity returns only the permitted fields', () => {
  const entries = new Map([['kim',entry('김학생','1234')]]);
  assert.deepEqual(lookupStudent(entries,' 김 학생 ','1234'),{studentName:'김학생',remainingLessons:3,lastLessonDate:'2026-09-18',latestRegistrationLessons:8});
});

test('wrong phone and nonexistent student have the identical no-result outcome', () => {
  const entries = new Map([['kim',entry('김학생','1234')]]);
  assert.equal(lookupStudent(entries,'김학생','9999'),null);
  assert.equal(lookupStudent(entries,'없는학생','1234'),null);
});

test('same-name entries require a unique matching phone suffix', () => {
  const entries = new Map([['lee-a',entry('이학생','1111',{remaining:1})],['lee-b',entry('이학생','2222',{remaining:7})]]);
  assert.equal(lookupStudent(entries,'이학생','9999'),null);
  assert.equal(lookupStudent(entries,'이학생','1111').remainingLessons,1);
});

test('zero remaining is preserved and confirmation-needed returns a notice', () => {
  const zero = new Map([['park',entry('박학생','3333',{remaining:0})]]);
  assert.equal(lookupStudent(zero,'박학생','3333').remainingLessons,0);
  const review = new Map([['choi',entry('최학생','4444',{state:'확인 필요',notice:'운영팀 확인이 필요합니다.'})]]);
  assert.equal(lookupStudent(review,'최학생','4444').notice,'운영팀 확인이 필요합니다.');
});

