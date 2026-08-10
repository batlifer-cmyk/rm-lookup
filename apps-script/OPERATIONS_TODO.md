# RM Attendance API 운영 TODO

## 현재 상태
- 개인계정(bat.life)에서 Apps Script 웹앱 배포 완료
- 배포 URL: https://script.google.com/macros/s/AKfycbyYZJFzIq5pLRnwEthn3oecpRrgr6JxkibZxNmuIZKgv7q0Na6aedVjegg9KUnFqsURiQ/exec
- API 소스: `RM_Attendance_API.gs`
- 아직 실제 학생 조회 성공 여부 최종 검증 전

## 성공 확인 후 반드시 할 일
1. 회사 공용계정(rmhq)도 이 API를 운영할 수 있게 구성
2. 개인계정(bat.life) 단독 의존 제거
3. 두 계정 모두 원천 시트 읽기 권한 보유 확인
4. 운영 방식 결정
   - 권장: 회사 공용계정을 주 배포자/소유자로 두고 개인계정은 공동관리자
   - 대안: 동일 코드의 회사계정 백업 배포본 유지
5. 두 계정에서 코드 수정/재배포 가능한지 확인
6. 주 배포 URL과 백업 배포 URL을 문서화
7. 개인계정 권한 해제/장애 시 회사계정으로 복구 가능한지 테스트

## 원칙
- 학생 공개 조회 기능은 로그인 계정과 무관하게 정상 작동해야 함
- 데이터 원천은 비공개 유지
- 이름 + 전화번호 뒷4자리 검증 유지
- 전체 전화번호/자유메모 노출 금지
- read-only 유지
