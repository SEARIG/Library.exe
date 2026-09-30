import test from "node:test";
import assert from "node:assert/strict";

import {
  BOOK_CARD_THEMES,
  bookCardThemeStyle,
  getAccessionNumericValue,
  getBookCardTheme
} from "../public/js/book-card-theme.mjs";

const themeName = (accessionNumber) => getBookCardTheme({ accessionNumber }).name;

test("accession values are parsed without changing their stored representation", () => {
  assert.equal(getAccessionNumericValue({ accessionNumber: "01" }), 1);
  assert.equal(getAccessionNumericValue({ accessionNumber: "ACC-1801" }), 1801);
  assert.equal(getAccessionNumericValue({ accessionNumber: "001801" }), 1801);
  assert.equal(getAccessionNumericValue({ blegal_num: "18-01" }), 1801);
  assert.equal(getAccessionNumericValue({ accessionNumber: "not-readable" }), null);
});

test("themes change every 15 accession numbers and repeat after eight groups", () => {
  const expectations = new Map([
    [1, "blue"], [15, "blue"],
    [16, "orange"], [30, "orange"],
    [31, "green"], [45, "green"],
    [46, "purple"], [61, "coral"],
    [76, "teal"], [91, "gold"],
    [106, "pink"], [121, "blue"]
  ]);
  expectations.forEach((expected, accession) => assert.equal(themeName(accession), expected, String(accession)));
});

test("high accession register blocks remain deterministic", () => {
  assert.equal(themeName(1801), "blue");
  assert.equal(themeName(1815), "blue");
  assert.equal(themeName(1816), "orange");
  assert.equal(themeName(1830), "orange");
  assert.equal(themeName(1831), "green");
});

test("unparseable accessions fall back to blue and styles use CSS variables", () => {
  const theme = getBookCardTheme({ accessionNumber: "unknown" });
  assert.equal(theme.name, "blue");
  assert.equal(theme.colorIndex, 0);
  assert.equal(BOOK_CARD_THEMES.length, 8);
  assert.match(bookCardThemeStyle(theme), /--book-primary:#2563EB/);
  assert.match(bookCardThemeStyle(theme), /--book-dark:#1D4ED8/);
  assert.match(bookCardThemeStyle(theme), /--book-light:#DBEAFE/);
});
