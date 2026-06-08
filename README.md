# ULC - Universal Library Cloud

ULC is a Firebase-backed, multi-tenant library SaaS for universities, independent colleges, and private libraries.

## V1 Scope

- Organization registration for `university`, `independent_college`, and `private_library`.
- Plan selection for Unlimited or Custom billing.
- Custom billing formula: `999 + (bookCount * 3) + (studentCount * 3)`.
- Yearly billing applies a 10% discount.
- Server-side Razorpay subscription creation with demo fallback when Razorpay env vars are not configured.
- Server-side organization, subscription, payment, and main-admin creation.
- Role-aware dashboard entry for:
  - `super_admin`
  - `university_admin`
  - `college_admin`
  - `library_admin`
  - `librarian`
  - `student`
- Tenant-scoped book and student/member management.
- Google Books and Open Library ISBN lookup from the dashboard.
- Barcode-based issue request, approve/reject, return, lost, and found Cloud Functions.
- Email event logging plus SendGrid or Resend support.
- Tenant-aware Firestore security rules.

## Important Files

- `public/index.html` - ULC landing and entry screen.
- `public/register.html` - organization subscription onboarding.
- `public/ulc-dashboard.html` - shared role-based ULC dashboard.
- `public/js/ulc-register.js` - pricing, Razorpay checkout, registration completion.
- `public/js/ulc-dashboard.js` - dashboard actions and external book lookup.
- `functions/index.js` - callable backend for billing, tenancy, books, people, issue/return/lost/found, email logs, audit logs.
- `firestore.rules` - strict role and tenant isolation rules.

Legacy MLSU screens remain in `public/*dashboard.html`, `public/signup.html`, and the older dashboard scripts.

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

If Razorpay variables are missing, registration uses a demo subscription id so local development can continue.

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

Firestore composite indexes may be requested for dashboard queries that combine `collectionGroup`, tenant filters, and ordering. Create the index links Firebase reports during testing.
