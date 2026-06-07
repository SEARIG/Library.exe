# MLSU Library SMS Backend

Legacy Express backend for MLSU Library SMS notifications using MSG91 Flow API, Firebase Admin SDK, and a daily `node-cron` reminder job.

SMS is currently disabled in favor of the free EmailJS notification flow in the main web app. Do not deploy this backend with a real MSG91 key unless SMS is intentionally re-enabled later.

The frontend can stay on Vercel. This backend should run on a server platform such as Render or Railway so MSG91 and Firebase service account secrets remain server-side.

## Features

- `GET /` health check
- `POST /send-issue-sms` to send book issue SMS through MSG91 Flow API
- `POST /send-return-sms` to send book return SMS through MSG91 Flow API
- `POST /send-reminder-sms` to manually send a 15-day, 30-day, or 45-day reminder SMS
- Daily 9 AM cron job for 15-day, 30-day, and 45-day book issue reminders
- `POST /test-reminders` to manually run the reminder job once
- Firebase Admin SDK initialized from environment variables
- MSG91 auth key never exposed to frontend code

## Install

```bash
cd mlsu-library-backend
npm install
```

## Environment Setup

Create a local `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Add these variables:

```env
PORT=3000
FRONTEND_URL=http://localhost:3000
MSG91_AUTH_KEY=your_msg91_auth_key
MSG91_ISSUE_FLOW_ID=replace_with_issue_flow_id
MSG91_RETURN_FLOW_ID=replace_with_return_flow_id
MSG91_REMINDER15_FLOW_ID=replace_with_15_day_flow_id
MSG91_REMINDER30_FLOW_ID=replace_with_30_day_flow_id
MSG91_REMINDER45_FLOW_ID=replace_with_45_day_flow_id
MSG91_SENDER_ID=MLSLIB
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_service_account_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_KEY\n-----END PRIVATE KEY-----\n"
```

Do not commit `.env` or `serviceAccountKey.json`.

## Create MSG91 Flows

Create five MSG91 Flow API templates in your MSG91 account:

- Issue flow: variables `name`, `book`, `dueDate`
- Return flow: variables `name`, `book`, `returnDate`, `penalty`
- 15-day reminder flow: variables `name`, `book`, `dueDate`
- 30-day reminder flow: variables `name`, `book`, `dueDate`
- 45-day reminder flow: variables `name`, `book`, `dueDate`

Copy each MSG91 `flow_id` into the matching environment variable:

- `MSG91_ISSUE_FLOW_ID`
- `MSG91_RETURN_FLOW_ID`
- `MSG91_REMINDER15_FLOW_ID`
- `MSG91_REMINDER30_FLOW_ID`
- `MSG91_REMINDER45_FLOW_ID`

## Run Locally

```bash
npm run dev
```

Open:

```text
http://localhost:3000/
```

Expected response:

```text
MLSU Library SMS Backend Running
```

## Test SMS Routes

```bash
curl -X POST http://localhost:3000/send-issue-sms ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\":\"9876543210\",\"name\":\"Student Name\",\"book\":\"Book Name\",\"dueDate\":\"22/07/2026\"}"
```

```bash
curl -X POST http://localhost:3000/send-return-sms ^
  -H "Content-Type: application/json" ^
  -d "{\"phone\":\"9876543210\",\"name\":\"Student Name\",\"book\":\"Book Name\",\"returnDate\":\"23/07/2026\",\"penalty\":\"0\"}"
```

```bash
curl -X POST http://localhost:3000/send-reminder-sms ^
  -H "Content-Type: application/json" ^
  -d "{\"reminderDay\":15,\"phone\":\"9876543210\",\"name\":\"Student Name\",\"book\":\"Book Name\",\"dueDate\":\"22/07/2026\"}"
```

Issue and reminder flows send these variables to MSG91:

```json
{
  "name": "Student Name",
  "book": "Book Name",
  "dueDate": "22/07/2026"
}
```

Return flow sends:

```json
{
  "name": "Student Name",
  "book": "Book Name",
  "returnDate": "23/07/2026",
  "penalty": "0"
}
```

Make sure your MSG91 flow variables match these names exactly.

## Test Reminders Manually

```bash
curl -X POST http://localhost:3000/test-reminders
```

Response:

```json
{
  "checked": 10,
  "sent": 2,
  "skipped": 8
}
```

## Reminder Logic

The cron job runs daily at 9 AM:

```js
cron.schedule("0 9 * * *", async () => {
  // checks Firestore reminders
});
```

It reads:

```text
bookIssues where status == "issued"
```

For each issue:

- Loads `students/{studentUid}`
- Calculates days since `issueDate`
- Sends reminder when:
  - `daysPassed >= 15` and `reminder15Sent != true`
  - `daysPassed >= 30` and `reminder30Sent != true`
  - `daysPassed >= 45` and `reminder45Sent != true`
- Uses the matching MSG91 flow ID for 15, 30, or 45 days
- Updates the matching reminder flag after SMS is sent

## Deploy on Render

1. Push this project to GitHub.
2. Create a new Render Web Service.
3. Set root directory to `mlsu-library-backend`.
4. Build command:

```bash
npm install
```

5. Start command:

```bash
npm start
```

6. Add all environment variables from `.env.example`.
7. Set `FRONTEND_URL` to your Vercel frontend URL in production.

## Deploy on Railway

1. Create a new Railway project from GitHub.
2. Set the service root directory to `mlsu-library-backend` if needed.
3. Add all environment variables from `.env.example`.
4. Set `FRONTEND_URL` to your Vercel frontend URL in production.
5. Railway will run:

```bash
npm start
```

## Frontend Usage

The Vercel frontend should call the backend URL, not MSG91 directly:

```js
await fetch("https://your-backend-url/send-issue-sms", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    phone: "9876543210",
    name: "Student Name",
    book: "Book Name",
    dueDate: "22/07/2026"
  })
});
```

For return SMS, call:

```js
await fetch("https://your-backend-url/send-return-sms", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    phone: "9876543210",
    name: "Student Name",
    book: "Book Name",
    returnDate: "23/07/2026",
    penalty: "0"
  })
});
```

Keep `MSG91_AUTH_KEY`, Firebase service account values, and all provider credentials only in backend environment variables.
