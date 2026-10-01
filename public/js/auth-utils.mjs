const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDIAN_MOBILE_PATTERN = /^[6-9]\d{9}$/;

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeIndianMobile(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!INDIAN_MOBILE_PATTERN.test(digits)) {
    throw new Error("Enter a valid 10-digit Indian mobile number.");
  }
  return `+91${digits}`;
}

function required(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function validatePassword(password, confirmPassword) {
  if (!password) throw new Error("Password is required.");
  if (String(password).length < 6) throw new Error("Use a password with at least 6 characters.");
  if (password !== confirmPassword) throw new Error("Passwords do not match.");
  return password;
}

export function validateStudentSignup(input = {}) {
  const fullName = required(input.fullName, "Full Name");
  const branch = required(input.branch, "Branch");
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) throw new Error("Enter a valid email address.");
  const phone = normalizeIndianMobile(input.phone);
  const password = validatePassword(input.password, input.confirmPassword);
  return { fullName, branch, email, phone, password, role: "student" };
}

export function validateStaffAccount(input = {}) {
  const fullName = required(input.fullName, "Full Name");
  const email = normalizeEmail(input.email);
  if (!EMAIL_PATTERN.test(email)) throw new Error("Enter a valid email address.");
  const phone = normalizeIndianMobile(input.phone);
  const password = validatePassword(input.password, input.confirmPassword);
  const role = String(input.role || "").trim().toLowerCase();
  if (!["admin", "librarian"].includes(role)) {
    throw new Error("Role must be Admin or Librarian.");
  }
  return { fullName, email, phone, password, role };
}
