function accessionText(value) {
  return String(value ?? "").trim();
}

export function normalizeAccessionNumber(value) {
  let normalized = accessionText(value).toUpperCase().replace(/\s+/g, "");
  normalized = normalized.replace(/^ACC[-_:]*/, "");
  if (/^\d+$/.test(normalized)) return normalized.replace(/^0+(?=\d)/, "");
  return normalized;
}

export function accessionNumberValue(book = {}) {
  return book.accessionNumber
    ?? book.blegal_num
    ?? book.blegalNumber
    ?? book.BLegalNumber
    ?? "";
}
