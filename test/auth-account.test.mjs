import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  normalizeIndianMobile,
  validateStaffAccount,
  validateStudentSignup
} from "../public/js/auth-utils.mjs";

const read = (path) => readFileSync(path, "utf8");

test("student signup requires the new account fields and always returns student role", () => {
  const signup = validateStudentSignup({
    fullName: "  Asha Sharma ",
    branch: " Computer Science ",
    email: " ASHA@example.com ",
    phone: "09876543210",
    password: "secret1",
    confirmPassword: "secret1"
  });
  assert.deepEqual(signup, {
    fullName: "Asha Sharma",
    branch: "Computer Science",
    email: "asha@example.com",
    phone: "+919876543210",
    password: "secret1",
    role: "student"
  });
  assert.equal(normalizeIndianMobile("+91 98765-43210"), "+919876543210");
  assert.throws(() => validateStudentSignup({}), /Full Name is required/);
  assert.throws(() => validateStudentSignup({ fullName: "A", branch: "CSE", email: "bad", phone: "9876543210", password: "secret1", confirmPassword: "secret1" }), /valid email/);
  assert.throws(() => validateStudentSignup({ fullName: "A", branch: "CSE", email: "a@b.com", phone: "123", password: "secret1", confirmPassword: "secret1" }), /valid 10-digit Indian mobile/);
  assert.throws(() => validateStudentSignup({ fullName: "A", branch: "CSE", email: "a@b.com", phone: "9876543210", password: "secret1", confirmPassword: "different" }), /Passwords do not match/);
});

test("staff account validation only accepts admin and librarian", () => {
  const base = {
    fullName: "Library Staff",
    email: "staff@example.com",
    phone: "9876543210",
    password: "secret1",
    confirmPassword: "secret1"
  };
  assert.equal(validateStaffAccount({ ...base, role: "admin" }).role, "admin");
  assert.equal(validateStaffAccount({ ...base, role: "librarian" }).role, "librarian");
  assert.throws(() => validateStaffAccount({ ...base, role: "student" }), /Admin or Librarian/);
  assert.throws(() => validateStaffAccount({ ...base, role: "super_admin" }), /Admin or Librarian/);
});

test("public signup has no year, roll number, enrollment, or role controls", () => {
  const signup = read("public/signup.html");
  for (const id of ["fullName", "branch", "email", "phone", "password", "confirmPassword"]) {
    assert.match(signup, new RegExp(`id="${id}"[^>]*required`));
  }
  assert.doesNotMatch(signup, /id="(?:year|rollNumber|enrollmentNumber|role)"/);

  const auth = read("public/js/auth.js");
  assert.match(auth, /role:\s*"student"/);
  assert.doesNotMatch(auth, /querySelector\("#(?:year|rollNumber|role)"\)/);
});

test("student-facing screens hide UID and academic year while showing branch", () => {
  const dashboard = read("public/js/student-dashboard.js");
  const scanPage = read("public/scan-book.html");
  assert.doesNotMatch(dashboard, /Student UID|Copy UID|<span>Year<\/span>/);
  assert.match(dashboard, /<span>Branch<\/span>/);
  assert.doesNotMatch(scanPage, /Student UID|requestStudentUid/);
});

test("admin staff creation uses isolated Firebase Auth and protects the current Admin", () => {
  const page = read("public/admin-dashboard.html");
  const script = read("public/js/admin-dashboard.js");
  assert.match(page, /\+ Create Librarian/);
  assert.match(page, /\+ Create Admin/);
  assert.match(script, /initializeApp\(firebaseConfig, `staff-account-/);
  assert.match(script, /inMemoryPersistence/);
  assert.match(script, /createUserWithEmailAndPassword\(secondaryAuth/);
  assert.match(script, /item\.id === session\.user\.uid/);
  assert.equal(existsSync("public/setup-users.html"), false);
  assert.equal(existsSync("public/js/setup-users.js"), false);
});

test("Firestore rules reject public privilege escalation and protect account fields", () => {
  const rules = read("firestore.rules");
  assert.match(rules, /studentAccountCreate\(uid\)/);
  assert.match(rules, /request\.resource\.data\.role == "student"/);
  assert.match(rules, /adminStaffCreate\(uid\)/);
  assert.match(rules, /request\.resource\.data\.role in \["admin", "librarian"\]/);
  assert.match(rules, /"role", "active", "status", "permissions", "claims"/);
  assert.match(rules, /request\.auth\.uid == uid/);
  assert.doesNotMatch(rules, /allow read, write:\s*if true/);
});
