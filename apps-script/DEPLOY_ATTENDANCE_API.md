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

## 프론트 연결
배포 URL을 받은 뒤 `index.html`의 출결 API 상수에 `/exec` URL을 넣고, 기존 `공개출결_V2` CSV 호출을 제거합니다.
