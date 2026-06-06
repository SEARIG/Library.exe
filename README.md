# MLSU Library Management Web App

Responsive Firebase app for student book issue requests, librarian approvals, returns, penalties, and scheduled SMS reminder placeholders.

## Stack

- Firebase Auth
- Cloud Firestore
- Firebase Hosting
- Firebase Cloud Functions
- HTML, CSS, JavaScript

## Project Structure

- `public/` - hosted web app pages and browser JavaScript
- `firestore.rules` - role-based Firestore security rules
- `functions/index.js` - callable approval, rejection, return, and scheduled reminder functions
- `firebase.json` - Hosting, Firestore, and Functions configuration

## Setup

1. Create a Firebase project.
2. Enable Email/Password authentication in Firebase Auth.
3. Create a Cloud Firestore database.
4. Install the Firebase CLI:

   ```bash
   npm install -g firebase-tools
   ```

5. Login and select your project:

   ```bash
   firebase login
   firebase use --add
   ```

6. The Firebase web app config is already set in `public/js/firebase-config.js`.
7. Install Cloud Functions dependencies:

   ```bash
   cd functions
   npm install
   cd ..
   ```

8. Deploy rules, hosting, and functions:

   ```bash
   firebase deploy
   ```

## Local Development

Run the Firebase emulator suite:

```bash
firebase emulators:start
```

Or serve only the static app:

```bash
firebase serve --only hosting
```

## GitHub and Vercel

This repo is ready to push to GitHub. Keep Firebase secrets and local emulator files out of Git with the included `.gitignore`.

For Vercel, import the GitHub repo and use `public` as the output directory. The static app can run on Vercel, but callable Cloud Functions, scheduled reminders, Firestore rules, and Firebase Auth still belong to the Firebase project and must be deployed with Firebase CLI.

## First Admin

Student signup intentionally creates only `student` accounts. To create the default admin and librarian accounts, use either the local script or the setup page.

Local script:

```bash
cd functions
npm install
cd ..
node create-default-users.js
```

Setup page:

```text
public/setup-users.html
```

The setup page calls Cloud Functions and does not expose default passwords in frontend JavaScript.

Manual fallback:

1. Sign up normally.
2. In Firestore, open `users/{uid}` for that account.
3. Change `role` from `student` to `admin`.
4. Keep `active` set to `true`.

After the first admin exists, use `admin-dashboard.html` to promote librarians or manage accounts.

## Core Flow

1. Student signs up and gets records in `users/{uid}` and `students/{uid}`.
2. Student opens `scan-book.html`, scans or enters a book barcode, reviews the auto-filled popup, confirms ownership, and submits an `issueRequests` record.
3. Librarian opens `librarian-dashboard.html`, approves or rejects pending requests.
4. Approval runs in a Cloud Function transaction, creates `bookIssues/{issueId}`, updates the book to `issued`, and marks the request `approved`.
5. Librarian scans or enters the book barcode for returns. The Cloud Function calculates late days and creates a penalty when the issue exceeds 45 days.

## SMS Reminder Placeholder

`sendIssueReminders` runs daily at 09:00 and calls `sendSms(phoneNumber, message)` for day 15, day 30, and day 45 reminders. Replace the placeholder with your SMS provider SDK or HTTP API.

## Security Notes

- Students cannot create `bookIssues`.
- Students can create only their own pending `issueRequests`.
- Librarian/admin approvals and returns are handled by Cloud Functions using Firestore transactions.
- Students can read only their own student, request, issue, and penalty records.
- Admins can manage users and delete protected records where rules allow it.
