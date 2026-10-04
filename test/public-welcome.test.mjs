import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("Register Digitizer UI and source files are removed", () => {
  const removed = [
    "public/register-digitizer.html",
    "public/js/register-digitizer.js",
    "public/js/register-digitizer.mjs",
    "public/js/local-register-ocr.mjs"
  ];
  removed.forEach((path) => assert.equal(existsSync(join(root, path)), false, path));

  const visibleSources = [
    read("public/index.html"),
    read("public/librarian-dashboard.html"),
    read("public/js/navbar.js")
  ].join("\n");
  assert.doesNotMatch(visibleSources, /register digitizer|register-digitizer|ocr digitizer/i);
});

test("welcome page exposes library, app, login, and production APK QR paths", () => {
  const home = read("public/index.html");
  assert.match(home, /href="library\.html"[^>]*>Browse Library Online</);
  assert.match(home, /href="\/downloads\/MLSU-LMS\.apk" download[^>]*>Download Student App</);
  assert.match(home, /href="login\.html"[^>]*>Login</);
  assert.match(home, /id="get-app"/);
  assert.match(home, /href="\/downloads\/MLSU-LMS\.apk" download/);
  assert.match(home, /src="\.\/assets\/mlsu-lms-apk-qr\.svg"/);
  assert.doesNotMatch(home, /signed release APK|official download path before deployment/i);
});

test("download page has local QR, APK link, and installation steps", () => {
  const page = read("public/download.html");
  assert.match(page, /Download Student App/);
  assert.match(page, /href="\/downloads\/MLSU-LMS\.apk" download/);
  assert.match(page, /Scan the QR code or tap Download Android App/);
  assert.match(page, /Allow installation from browser if asked/);
  assert.doesNotMatch(page, /signed release APK|before deployment|public\/downloads/i);

  const qr = read("public/assets/mlsu-lms-apk-qr.svg");
  assert.match(qr, /<svg[^>]+viewBox="0 0 256 256"/);
  assert.match(qr, /https:\/\/library-exe\.vercel\.app\/downloads\/MLSU-LMS\.apk/);
  assert.ok(qr.length > 5000, "QR SVG should contain a real encoded matrix");
});

test("download warning container and warning-only style are removed", () => {
  assert.doesNotMatch(read("public/index.html"), /class="install-note"/);
  assert.doesNotMatch(read("public/download.html"), /class="install-note"/);
  assert.doesNotMatch(read("public/css/style.css"), /\.install-note\s*\{/);
});

test("APK delivery uses attachment headers without redirecting to an HTML page", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.equal(config.rewrites, undefined);
  const apkHeaders = config.headers?.find((item) => item.source === "/downloads/MLSU-LMS.apk")?.headers || [];
  assert.ok(apkHeaders.some((item) => item.key === "Content-Type" && item.value === "application/vnd.android.package-archive"));
  assert.ok(apkHeaders.some((item) => item.key === "Content-Disposition" && /attachment/.test(item.value)));
  assert.ok(apkHeaders.some((item) => item.key === "Cache-Control" && /no-store/.test(item.value)));
});

test("the configured MLSU LMS APK exists and is non-empty", () => {
  const apkPath = join(root, "public/downloads/MLSU-LMS.apk");
  assert.equal(existsSync(apkPath), true);
  assert.ok(statSync(apkPath).size > 1_000_000, "APK should be a real application artifact");
});

test("accession register Excel import remains the staff digitization entry", () => {
  const dashboard = read("public/librarian-dashboard.html");
  assert.match(dashboard, /Import Accession Register Excel/);
  assert.match(dashboard, /Upload a verified Excel file containing accession register records/);
  assert.match(dashboard, /id="bookImportFile"[^>]+accept="\.xlsx,\.csv"/);
  assert.match(read("public/js/librarian-dashboard.js"), /accession register import complete/i);
});

test("public catalog output remains limited to safe book metadata", () => {
  const library = read("public/js/library.js");
  assert.doesNotMatch(library, /data\.(?:cost|billNoDate|issuedStudentUid|issuedStudentName|issuedStudentEmail|issuedTo|internalNotes)/);
  assert.match(read("public/library.html"), /Please login as a student to request this book/);
  assert.match(read("public/library.html"), /Download Student App/);
});

test("service worker bypasses APK downloads and live accession importer scripts", () => {
  const worker = read("public/service-worker.js");
  assert.match(worker, /url\.pathname\.startsWith\("\/downloads\/"\)/);
  assert.match(worker, /url\.pathname\.endsWith\("\.apk"\)/);
  assert.match(worker, /url\.pathname === "\/js\/accession-register\.mjs"/);
  assert.match(worker, /url\.pathname === "\/js\/librarian-dashboard\.js"/);
  assert.match(worker, /\/assets\/mlsu-lms-apk-qr\.svg/);
  assert.doesNotMatch(worker, /MLSU-LMS\.apk/);
});
