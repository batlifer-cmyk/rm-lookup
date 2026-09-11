# RM Session Ledger V3 — Shadow Architecture

Date: 2026-09-11 KST

## Purpose

Rebuild Ryan Members session-count lookup so operations and student-facing views use one deterministic calculation source without changing current production until validation is complete.

## Production safety

This branch and the new `RM Session Ledger V3 - SHADOW` spreadsheet are isolated. Do not change or deploy over current production during the shadow phase.

Protected production components:

- `RM Data Overview / Master Time Data`
- `RM 수강료 등록 현황 / 입금로그`
- legacy `_DB_등록로그`
- current rm-lookup web app deployment
- JANDI/Make/scanner
- current student lookup deployment

## Confirmed current split

The current rm-lookup reads summary/balance information from `RM 재등록 조기경보 테스트 / 공개조회가능 정보모음_V2`, while attendance detail is read separately from `RM Data Overview / Master Time Data`. The public summary itself is downstream of `_DB_회차원장_V2`, which depends on legacy registration/graduation/contact/master-derived data.

Separately, `Student_Page_Source` aggregates `Master Time Data` Hours by student name.

Therefore one lookup UI currently combines results produced by different calculation paths.

## Important charge-unit finding

The legacy/current student detail path contains an S1 interpretation inconsistent with operational evidence.

Evidence checked on 2026-09-11:

- Master rows with `S1` commonly advance teacher Note counters by one session.
- `S2` rows include examples such as `23, 24(32)` and `29, 30(32)`, indicating two units.
- The older `RM_회차_v3_테스트.gs` explicitly states that `S1/S1.5/S2` count as paid student lesson hours and `N/P/T` do not count.

V3 canonical parsing rule:

- positive numeric value -> same number of units
- `S1` -> 1
- `S1.5` -> 1.5
- `S2` -> 2
- `N`, `P`, `T` -> 0
- unknown text -> REVIEW, never silently 0

Do not use the old `S1 = 0.5` behavior in V3.

## Canonical identity

Use `student_id` from `RM Data Overview / 학생DB` as the canonical student key.

Names are display/search attributes only. Exact-name matching is allowed only as a migration aid and must produce review status for duplicate names or unmapped records.

`lookup_code` remains an external/student-page lookup key and must not replace `student_id`.

## Event model

### Students

Canonical identity and current operational status.

### Registration_Events

A registration event means package units became available to a student. Keep these separate:

- `event_recorded_at`
- `effective_registration_date`
- `payment_event_id`
- `package_units`

Payment time is evidence, not automatically the effective registration time.

### Payment_Events

Raw bank/card/Naver/payment events. Payer name may differ from student name. Do not auto-bind payer to student solely by exact text unless explicitly validated.

### Session_Events

One source lesson row with normalized `charge_units` and stable event key. `Note` is validation evidence only; it is not the canonical counter.

### Adjustments

Explicit audited +/- unit corrections. Never edit past session events to force a desired balance.

### Legacy_Anchors

Because historical registration-event completeness is not guaranteed, migrated students may start from a validated point-in-time balance and then move forward using canonical events.

Anchor values are not active until `anchor_status = VALIDATED`.

### Current_Balance

For a validated anchor:

`current_balance = anchor_remaining + confirmed registrations after anchor - chargeable sessions after anchor + active adjustments after anchor`

## Validation policy

Legacy output is a comparison value, not ground truth.

Useful independent signals:

1. latest teacher Note counter/package where present
2. raw Master lesson timeline
3. registration evidence
4. payment evidence
5. manual adjustments/known exceptions
6. legacy V2 output

Mismatch categories are retained in `Discrepancy`; no mismatch is silently overwritten.

## Shadow spreadsheet

`RM Session Ledger V3 - SHADOW`

Core tabs:

- README
- Config
- Students
- Registration_Events
- Payment_Events
- Session_Events
- Adjustments
- Legacy_Anchors
- Current_Balance
- QA_Summary
- Discrepancy
- Legacy_Mapping
- Test_Cases
- source snapshot tabs

The source snapshot tabs currently contain `IMPORTRANGE` fallback formulas. A safer automated snapshot implementation is in `apps-script/RM_Session_Ledger_V3_Shadow.gs`; when authorized, it reads via Sheets API and writes only to the shadow spreadsheet.

## Cutover gates

Do not replace production until all are true:

1. required source snapshots load reliably
2. active-student identity mapping has no unresolved duplicate identity
3. charge-unit parser tests pass
4. every production student has either a validated anchor or complete-history calculation
5. discrepancies are classified and material mismatches resolved
6. shadow result remains stable across new registrations and new lessons
7. operations and student UI both consume the same V3 balance API in staging
8. rollback path is documented and tested

## Registration-store migration

The separate `_DB_등록로그` migration should remain paused until V3 dependencies are fixed. Moving the writer first while legacy formula/readers still point at the old registration tab can freeze or stale downstream balances.

After V3 becomes the canonical reader, registration writer migration becomes simpler because old formula chains no longer need to be kept alive indefinitely.
