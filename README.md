# MLSU Library Management System

MLSU Library Management System is a Firebase-backed smart library app for students, librarians, and administrators.

## V1 Scope

- Student account creation and role-based access for student, librarian, and admin workflows.
- Role-aware dashboard entry for:
  - `admin`
  - `librarian`
  - `student`
- MLSU book and student management.
- Google Books and Open Library ISBN lookup from the dashboard.
- Barcode-based issue request, approve/reject, return, lost, and found Cloud Functions.
- Email event logging plus SendGrid or Resend support.
- Firestore security rules for MLSU Library roles and workflows.

## Important Files

- `public/index.html` - MLSU Library landing and entry screen.
- `public/student-dashboard.html` - student issued books, requests, returns, penalties, and activity.
- `public/librarian-dashboard.html` - librarian book, issue, return, barcode, and import workflows.
- `public/admin-dashboard.html` - admin users, imports, reports, and notification tools.
- `functions/index.js` - callable backend experiments and future server-side extensions.
- `firestore.rules` - strict role and workflow security rules.

MLSU screens live in `public/*dashboard.html`, `public/signup.html`, and the dashboard scripts.

## Environment Variables

Do not put secret keys in frontend files. Configure these for Cloud Functions:

```bash
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_MONTHLY_PLAN_ID=
RAZORPAY_YEARLY_PLAN_ID=
SENDGRID_API_KEY=
RESEND_API_KEY=
EMAIL_FROM=
```

Razorpay variables are not part of the MLSU Library landing/signup flow.

## Local Preview

From the project root, serve the frontend with any static server:

```bash
python -m http.server 4173 --bind 127.0.0.1 --directory public
```

Then open:

```text
http://127.0.0.1:4173/
```

## Deployment Notes

Install/update function dependencies before deployment:

```bash
cd functions
npm install
```

Deploy with Firebase CLI after credentials and rules are reviewed:

```bash
firebase deploy --only hosting,functions,firestore:rules
```

Firestore composite indexes may be requested for dashboard queries that combine filters and ordering. Create the index links Firebase reports during testing.

## MLSU Smart Library Management System

### Project Progress Update

#### Completed Features

##### Authentication & Roles

- Firebase Authentication
- Student Login
- Librarian Login
- Admin Login
- Role-Based Access Control

##### Library Management

- Book Database
- Add Book Manually
- Auto B_ID Generation
- Library Barcode Generation
- Barcode Scanning
- Book Status Tracking

##### Issue & Return System

- Student Book Requests
- Librarian Approval/Rejection
- Book Issue Workflow
- Book Return Workflow
- Lost Book Management
- Found Book Recovery

##### Metadata System

- Google Books Integration
- Open Library Integration
- Self-Learning Metadata Database
- Local Metadata Caching

##### Notifications

- EmailJS Integration
- Book Issued Notifications
- Book Returned Notifications
- Penalty Notifications
- Reminder Notification Framework

##### Reporting & Tracking

- Activity Tracking
- Penalty Tracking
- Issue History
- Return History

#### In Progress

- Excel Book Import
- Excel Book Export
- Bulk Barcode Printing
- Public Library Catalogue
- Advanced Dashboard UI
- Library Bookshelf Theme
- Student Import System

#### Planned Features

- Due Reminder Automation
- No Dues Certificate Verification
- Advanced Reports
- Multi-Source Metadata Lookup
- Library Analytics
- Mobile APK Version

#### Innovation Highlights

- Dual Barcode Architecture
- Self-Learning Metadata Repository
- Cloud-Based Firestore Integration
- Automated Library Workflows
- Smart Inventory Tracking

#### Authors

- Nakul Singh Rajawat
- Prakshat Sharma
- Puneet Sharma

#### Institution

Mohanlal Sukhadia University (MLSU)

#### Version

Development Build v1.0

Last Updated: June 2026
