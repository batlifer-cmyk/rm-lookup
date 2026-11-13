# RM Attendance Detail API 배포

## 목적
`rm-lookup` 상세보기 버튼이 학생의 전체 출결기록을 필요할 때만 읽도록 하는 read-only API입니다.

## 소스
- `apps-script/RM_Attendance_API.gs`

## 배포
1. Google Apps Script에서 새 독립 프로젝트를 만듭니다.
2. 기본 `Code.gs` 내용을 모두 지우고 `RM_Attendance_API.gs` 전체를 붙여넣습니다.
3. 배포 → 새 배포 → 유형 `웹 앱`.
4. 실행 사용자: `나`.
5. 액세스 권한: `모든 사용자`.
6. 배포 후 `/exec` URL을 복사합니다.

## API 호출

```text
GET <WEB_APP_EXEC_URL>?action=attendance&name=김상도&phone4=1234
```

성공 예시:

```json
{
  "ok": true,
  "studentName": "김상도",
  "lastLessonDate": "2026-08-07",
  "count": 9,
  "attendance": [
    {
      "lessonDate": "2026-08-07",
      "teacher": "Matthew",
      "classType": "스몰톡",
      "chargeUnits": 1,
      "counter": "1(8)",
      "status": "차감"
    }
  ]
}
```

## 보안
- 상세 출결은 이름 + 전화번호 뒷4자리 일치 시에만 반환합니다.
- 전체 전화번호는 반환하지 않습니다.
- `Master Time Data` 자유메모는 반환하지 않습니다.
- 정규화된 `_SRC_Master_Count_V2` 필드만 반환합니다.
- 반환 필드: 수업일, 강사, 수업유형, 차감회차, 회차표시, 차감상태.
- 쓰기 작업은 없습니다.

## 성능
- 첫 호출은 V2 소스 읽기로 인해 수 초가 걸릴 수 있습니다.
- 동일 학생은 Script Cache 120초를 사용합니다.
- 상세보기는 기본 회차 조회와 분리되어 있어 첫 화면 속도에는 영향을 주지 않습니다.
- `공개조회가능 정보모음_V2` 표와 `Student_Page_View` 표는 30분(1800초) 동안 Script Cache에 보관해, 시트 읽기가 느려지는 시간대에도 요청마다 원본 시트를 다시 읽지 않습니다(표 크기가 95KB를 넘으면 캐시를 건너뜁니다).
- `?action=warmup`은 위 두 표를 미리 읽어 캐시에 올립니다. 학생 페이지가 열릴 때 자동으로 호출합니다.
- 원본 표 읽기는 값을 다시 계산하는 시점에 **20초 넘게** 걸립니다(2026-11-14 21~22초 관측, 바로 다음 호출은 0.8초). 그래서 캐시를 요청 경로 밖에서 채우는 트리거를 함께 설정해야 합니다.

## 2026-11-14 지연 대응 배포 절차
회차 조회가 8초를 넘겨 끊기는 문제로 API와 프론트를 함께 손봤습니다.

1. Apps Script 편집기에서 `RM_Attendance_API.gs` 내용을 이 저장소 파일 전체로 교체합니다.
2. 배포 → 배포 관리 → 기존 배포 오른쪽 연필(편집) → 버전 `새 버전` → 배포합니다. (URL은 그대로 유지됩니다.)
3. 아래로 동작을 확인합니다.

```text
GET <EXEC_URL>?action=warmup
→ {"ok":true,"stage":"warmup","summaryRows":...,"verifyRows":...,"elapsedMs":...}

GET <EXEC_URL>?action=summary&name=강수정
→ 기존과 같은 rows 응답, elapsedMs가 수백 ms대
```

4. 같은 배포를 두 번 연속 호출해 두 번째 `elapsedMs`가 줄어드는지 확인합니다(캐시 적중).
5. 편집기 왼쪽 ⏰ **트리거** → 트리거 추가 → 실행할 함수 `rmRefillCache`, 이벤트 소스 `시간 기반`, 시간 간격 `10분마다`로 저장합니다. 이 트리거가 20초짜리 표 읽기를 요청 경로 밖에서 처리해, 학생 화면은 항상 캐시를 맞습니다.
6. 트리거를 저장한 뒤 `rmRefillCache`를 한 번 수동 실행해 권한을 승인하고, 실행 기록에서 성공을 확인합니다.

배포를 미루더라도 `index.html` 수정본만 올리면 학생 화면의 8초 중단 오류는 사라집니다(12초 1차 → 30초 재시도).


## 프론트 연결
배포 URL을 받은 뒤 `index.html`의 출결 API 상수에 `/exec` URL을 넣고, 기존 `공개출결_V2` CSV 호출을 제거합니다.
