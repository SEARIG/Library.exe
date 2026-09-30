export const BOOK_CARD_THEMES = Object.freeze([
  Object.freeze({ name: "blue", primary: "#2563EB", dark: "#1D4ED8", light: "#DBEAFE" }),
  Object.freeze({ name: "orange", primary: "#F97316", dark: "#EA580C", light: "#FFEDD5" }),
  Object.freeze({ name: "green", primary: "#16A34A", dark: "#15803D", light: "#DCFCE7" }),
  Object.freeze({ name: "purple", primary: "#7C3AED", dark: "#6D28D9", light: "#EDE9FE" }),
  Object.freeze({ name: "coral", primary: "#E85D5D", dark: "#DC4545", light: "#FEE2E2" }),
  Object.freeze({ name: "teal", primary: "#0D9488", dark: "#0F766E", light: "#CCFBF1" }),
  Object.freeze({ name: "gold", primary: "#D4A017", dark: "#B58105", light: "#FEF3C7" }),
  Object.freeze({ name: "pink", primary: "#DB2777", dark: "#BE185D", light: "#FCE7F3" })
]);

const ACCESSION_FIELDS = Object.freeze([
  "accessionNumber",
  "blegal_num",
  "blegalNumber",
  "BLegalNumber",
  "b_id"
]);

export function getAccessionNumericValue(book = {}) {
  const rawValue = ACCESSION_FIELDS
    .map((field) => book?.[field])
    .find((value) => String(value ?? "").trim());

  if (rawValue === undefined) return null;
  const digits = String(rawValue).match(/\d+/g)?.join("") || "";
  if (!digits) return null;

  const numericValue = Number.parseInt(digits, 10);
  return Number.isSafeInteger(numericValue) && numericValue > 0 ? numericValue : null;
}

export function getBookCardTheme(book = {}) {
  const accessionNumber = getAccessionNumericValue(book);
  const groupIndex = accessionNumber === null ? 0 : Math.floor((accessionNumber - 1) / 15);
  const colorIndex = groupIndex % BOOK_CARD_THEMES.length;
  return {
    ...BOOK_CARD_THEMES[colorIndex],
    accessionNumber,
    groupIndex,
    colorIndex
  };
}

export function bookCardThemeStyle(theme = BOOK_CARD_THEMES[0]) {
  return [
    `--book-primary:${theme.primary || BOOK_CARD_THEMES[0].primary}`,
    `--book-dark:${theme.dark || BOOK_CARD_THEMES[0].dark}`,
    `--book-light:${theme.light || BOOK_CARD_THEMES[0].light}`
  ].join(";");
}
