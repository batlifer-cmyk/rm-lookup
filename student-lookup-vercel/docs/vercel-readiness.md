# Vercel 경량 조회 전환 준비 상태 (2026-11-14 확인)

이 문서는 `student-lookup-vercel`을 실제로 배포하려면 남은 것이 무엇인지 정리한 것입니다.
코드와 테스트는 준비되어 있지만, **아래 1번 때문에 지금 배포하면 모든 조회가 503으로 실패합니다.**

## 1. 막고 있는 것: 스냅샷이 9월 18일 이후 갱신되지 않음

`_API_Cutover_Snapshot` 실제 상태(2026-11-14 확인):

| 항목 | 확인값 |
| --- | --- |
| 위치 | 데이터 스프레드시트 `16ZKz…8981x0` (탭 101개) 안 |
| 레이아웃 | A~C 첫 슬롯, D~F 둘째 슬롯 (`generation_id`, `entry_key`, `entry_json`) |
| 행 수 | 슬롯마다 110행, `entry_key` 중복 없음, JSON 파싱 정상 |
| 마지막 generation | `20260918102725_9fdb8964`, `20260918092816_53435e76` = **2026-09-18** |
| 신선도 | 오늘 기준 57일 경과. `RM_SNAPSHOT_MAX_AGE_SECONDS=7200`(2시간)이면 `SNAPSHOT_STALE` → 503 |
| 값 정합성 | 스냅샷의 한 학생 `잔여`가 6.5인데 현재 라이브 조회는 0 — 두 달치 수업이 반영되지 않은 값 |
| 누락 필드 | 110행 전부 `마지막수업일` 빈값, `회차상태` 전부 `확정` |

저장소 어디에도 스냅샷 생성 코드가 없습니다(GitHub 코드 검색 0건). 시트 안 `_DB_AppsScript_Code` 탭에 원본 자동화 코드가 있을 가능성이 있으니, 먼저 그 코드가 스냅샷을 쓰는지 확인해야 합니다.

필요한 것: 하루 1회(또는 몇 시간마다) `_API_Cutover_Snapshot` 두 슬롯을 번갈아 다시 쓰는 작업. 생성 주기가 정해지면 `RM_SNAPSHOT_MAX_AGE_SECONDS`를 주기 + 여유(예: 하루 1회면 `90000`)로 맞춥니다. 값을 늘리면 그만큼 오래된 회차가 보입니다.

## 2. 배포 전에 정해야 하는 것

1. **스냅샷 위치**: 지금은 서비스 계정에 101탭 원본 전체(수업기록·연락처 포함)를 뷰어로 공유해야 합니다. 스냅샷만 담은 경량 스프레드시트를 따로 두는 편이 안전합니다. 그렇게 하면 `RM_SNAPSHOT_SPREADSHEET_ID`는 새 파일, `RM_AUTH_INDEX_SPREADSHEET_ID`는 지금 파일로 나눠 넣습니다.
2. **ACTIVE만 허용할지**: `_DB_Student_Master` 110행 중 `current_status=ACTIVE`는 71행입니다. 나머지 39명은 전환 후 조회가 막힙니다. 졸업생·휴원생에게 계속 보여줄지 정해야 합니다.
3. **전화번호 뒷4자리 필수화**: 지금 학생 페이지는 동명이인이 아니면 이름만으로 조회됩니다. Vercel 함수는 이름 + 뒷4자리를 모두 요구합니다. 학부모가 뒷4자리를 모르면 조회가 막히므로, 안내 문구를 바꾸거나 이름만으로도 되게 인증 규칙을 조정해야 합니다. (`_DB_Student_Master`의 `phone_last4`에 `#REF!` 1건도 있어 그 학생은 인증 불가)
4. **상세보기(전체 출결기록)**: Vercel 쪽 페이지에는 없습니다. 1차에서 빼도 되는지, 아니면 별도 API로 옮길지 정해야 합니다.
5. **주소**: 지금 배포된 `https://batlifer-cmyk.github.io/rm-lookup/` 링크를 학부모가 쓰고 있다면, 새 도메인으로 옮길 때 리다이렉트나 안내가 필요합니다.

## 3. 준비물 체크리스트

- [ ] Google Cloud 프로젝트에서 서비스 계정 생성, 역할 없이 `spreadsheets.readonly` 스코프만 사용
- [ ] 스냅샷 시트(권장: 별도 파일)에 서비스 계정 이메일을 **뷰어**로 공유, 공개 링크는 만들지 않음
- [ ] Vercel 프로젝트 생성, Root Directory를 `student-lookup-vercel`로 지정, Node 20 런타임
- [ ] Preview 환경변수 입력 (아래 표). `GOOGLE_SERVICE_ACCOUNT_JSON`은 암호화된 환경변수로만, 파일로 커밋 금지
- [ ] `npm test` 통과 (Node 20 이상)
- [ ] Preview에서 스모크 테스트 5종 (README 참고)
- [ ] Vercel Firewall에서 `POST /api/lookup` IP당 10분 12회 레이트리밋 (함수 내 제한은 인스턴스별 임시 방어일 뿐)
- [ ] 프로덕션 배포 후 같은 스모크 테스트 반복
- [ ] 기존 GitHub Pages 주소 처리(리다이렉트 또는 안내문)

### 환경변수

| 변수 | 값 | 비고 |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 서비스 계정 키 JSON 전체 | Vercel 암호화 변수 |
| `RM_SNAPSHOT_SPREADSHEET_ID` | 스냅샷이 있는 파일 ID | 지금은 `16ZKz…8981x0` |
| `RM_SNAPSHOT_SHEET` | `_API_Cutover_Snapshot` | |
| `RM_SNAPSHOT_EXPECTED_COUNT` | `110` | 실제 행 수와 일치 확인됨 |
| `RM_SNAPSHOT_MAX_AGE_SECONDS` | 생성 주기 + 여유 | 지금 값 7200은 스냅샷이 2시간마다 갱신될 때만 유효 |
| `RM_AUTH_INDEX_SHEET` | `_DB_Student_Master` | |
| `RM_AUTH_INDEX_COUNT` | `110` | 실제 행 수와 일치 확인됨 |
| `RM_AUTH_INDEX_SPREADSHEET_ID` | (선택) 인증 인덱스 전용 파일 ID | 없으면 스냅샷 파일 ID 사용 |

## 4. 이번에 코드에서 손본 것

- 서비스 계정 토큰을 요청마다 두 번 받던 것을 한 번으로 줄이고, 데운 인스턴스에서는 재사용 (요청당 약 0.3초 절감)
- Google API 호출에 4초 abort 타임아웃 추가 (없으면 함수가 `maxDuration` 10초까지 매달림. 토큰 4초 + 병렬 읽기 4초 = 최악 8초로 함수 상한 안에 들어옴)
- 인증 인덱스를 별도 스프레드시트에서 읽을 수 있게 `RM_AUTH_INDEX_SPREADSHEET_ID` 추가
- `test/sheets.test.js` 추가: 토큰 1회 발급, 토큰 재사용, 별도 인덱스 파일, abort 신호, 자격증명/토큰/읽기 실패 시 fail-closed
