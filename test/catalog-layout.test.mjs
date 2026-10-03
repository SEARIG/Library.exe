import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const libraryScript = fs.readFileSync("public/js/library.js", "utf8");
const libraryPage = fs.readFileSync("public/library.html", "utf8");
const styles = fs.readFileSync("public/css/style.css", "utf8");

test("catalog pages contain four complete rows of six books", () => {
  assert.match(libraryScript, /const pageSize = 24;/);
  assert.match(libraryPage, /library\.js\?v=13/);
  assert.match(libraryScript, /No books have been added yet\./);
});

test("catalog grid uses stable desktop and responsive column counts", () => {
  assert.match(styles, /\.catalog-grid\s*{[^}]*grid-template-columns:\s*repeat\(6,/s);
  assert.match(styles, /min-width:\s*1025px[^}]*max-width:\s*1279px[\s\S]*?\.catalog-grid\s*{[^}]*repeat\(5,/);
  assert.match(styles, /min-width:\s*769px[^}]*max-width:\s*1024px[\s\S]*?\.catalog-grid\s*{[^}]*repeat\(4,/);
  assert.match(styles, /min-width:\s*641px[^}]*max-width:\s*1024px[\s\S]*?\.catalog-grid\s*{[^}]*repeat\(3,/);
});

test("catalog cards use equal-height rows with bottom-aligned actions", () => {
  assert.match(styles, /\.catalog-grid\s*{[^}]*grid-auto-rows:\s*1fr/s);
  assert.match(styles, /\.book-card\s*{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
  assert.match(styles, /\.book-card details\s*{[^}]*margin-top:\s*auto/s);
  assert.match(styles, /\.book-card \.request-issue-btn\s*{[^}]*width:\s*100%/s);
});
