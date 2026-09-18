# Ryan Members student lookup

Vercel serves both the static student page and `POST /api/lookup`. The browser sends a name and phone suffix only; the API reads the protected `_API_Cutover_Snapshot` using a read-only Google service account, selects the newest complete snapshot generation, and returns one allow-listed student response.

It does not call the legacy Apps Script Web App or calculate lessons. It does not expose Google Sheets, snapshot rows, phone numbers, or the service-account credential to the browser.

## Preview configuration

1. Create a dedicated Google service account with only `spreadsheets.readonly` scope. Share only the spreadsheet containing `_API_Cutover_Snapshot` with its email as Viewer; do not make the sheet public.
2. In the Vercel **Preview** environment add the variables in `.env.example`. `GOOGLE_PRIVATE_KEY` must be stored as an encrypted Vercel environment variable.
3. Deploy a Preview, then run `npm test` and perform the five smoke tests below against Preview.

## Required Preview smoke tests

- Correct name + suffix: only one response, containing the five permitted fields.
- Incorrect suffix and an unknown name: same generic “not found” UI.
- Same-name test data: each valid suffix returns only that student.
- Student with zero balance: shows `0회 남음`, not a missing value.
- A snapshot row with `회차상태=확인 필요` or `안내`: shows its notice.

## Production gate

Before production, configure a Vercel Firewall rate-limit rule for `POST /api/lookup` (per IP, for example 12 requests / 10 minutes) and repeat the Preview smoke tests. The in-function limiter is a fallback only and is not a distributed rate limiter.

