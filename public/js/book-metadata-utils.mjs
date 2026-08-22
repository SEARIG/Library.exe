export const PRIVATE_BOOK_METADATA_FIELDS = [
  "accessionNumber",
  "blegal_num",
  "blegalNumber",
  "BLegalNumber",
  "accessionDate",
  "acquisitionSource",
  "billNoDate",
  "cost",
  "classNo",
  "bookNo",
  "withdrawalRemarks",
  "notes",
  "barcodeValue",
  "bookBarcodeValue",
  "barcodeDataUrl",
  "barcodePrinted",
  "barcodePrintedAt",
  "barcodePrintedBy",
  "barcodePrintBatchId",
  "issuedStudentUid",
  "issuedTo",
  "issuedToName",
  "issuedToEmail",
  "currentIssueId",
  "status",
  "b_id",
  "bookId",
  "importBatchId"
];

const PUBLIC_METADATA_FIELDS = [
  "isbn",
  "publisherBarcode",
  "author",
  "title",
  "placePublisher",
  "publisher",
  "year",
  "pages",
  "volume",
  "imageUrl",
  "category",
  "subject"
];

function text(value) {
  return String(value ?? "").trim();
}

function firstText(...values) {
  return text(values.find((value) => text(value)) || "");
}

export function normalizeIsbn(value) {
  return text(value)
    .replace(/[-\s]/g, "")
    .replace(/[^0-9Xx]/g, "")
    .toUpperCase();
}

export function normalizeBarcode(value) {
  return text(value)
    .replace(/[-\s]/g, "")
    .toUpperCase();
}

export function normalizeTextKey(value) {
  return text(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

export function createMetadataKey(type, value) {
  const normalizedValue = type === "isbn"
    ? normalizeIsbn(value)
    : type === "publisherBarcode"
      ? normalizeBarcode(value)
      : normalizeTextKey(value);
  const safeValue = normalizedValue.replace(/[/\\?#\[\]*]/g, "_");
  return safeValue ? `${type}:${safeValue}` : "";
}

export function titleAuthorKeyValue(metadata = {}) {
  return `${metadata.title || ""} ${metadata.author || ""}`;
}

export function titleKeywords(title = "") {
  return normalizeTextKey(title)
    .split("_")
    .filter((word) => word.length >= 3)
    .slice(0, 12);
}

export function collectReusableMetadata(record = {}) {
  const title = firstText(record.title, record.bname, record.bookTitle);
  const placePublisher = firstText(record.placePublisher, record.publisher);
  return {
    isbn: normalizeIsbn(firstText(record.isbn, record.isbn13, record.isbn10)),
    publisherBarcode: normalizeBarcode(firstText(record.publisherBarcode)),
    author: firstText(record.author, record.authors),
    title,
    placePublisher,
    publisher: placePublisher,
    year: firstText(record.year, record.publishedDate, record.publishDate),
    pages: firstText(record.pages, record.pageCount, record.numberOfPages),
    volume: firstText(record.volume, record.vol),
    imageUrl: firstText(record.imageUrl, record.coverUrl, record.thumbnail),
    category: firstText(record.category),
    subject: firstText(record.subject)
  };
}

export function hasReusableMetadata(metadata = {}) {
  return Boolean(text(metadata.title) || text(metadata.author));
}

export function metadataKeyCandidates(metadata = {}) {
  const keys = [];
  const seen = new Set();
  const add = (keyType, key) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push({ key, keyType });
  };

  add("isbn", createMetadataKey("isbn", metadata.isbn));
  add("publisherBarcode", createMetadataKey("publisherBarcode", metadata.publisherBarcode));

  if (!keys.length && hasReusableMetadata(metadata)) {
    add("titleAuthor", createMetadataKey("titleAuthor", titleAuthorKeyValue(metadata)));
  }

  return keys;
}

export function confidenceForKeyType(keyType) {
  if (keyType === "isbn" || keyType === "publisherBarcode") return "high";
  if (keyType === "titleAuthor") return "low";
  return "medium";
}

export function normalizeProviderSource(source = "manual", existingSource = "") {
  const value = text(source).toLowerCase();
  const normalized = value === "google" || value === "google books" || value === "google_books"
    ? "google_books"
    : value === "openlibrary" || value === "open library" || value === "open_library"
      ? "open_library"
      : value === "local" || value === "local_book" || value === "existing_book" || value === "accession_register_import"
        ? "local_book"
        : value === "merged"
          ? "merged"
          : "manual";
  return existingSource && existingSource !== normalized ? "merged" : normalized;
}

export function withoutBlankValues(record = {}) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (typeof value === "string" && !value.trim()) return false;
      return true;
    })
  );
}

export function mergeReusableMetadata(existing = {}, incoming = {}) {
  const merged = {};
  for (const field of PUBLIC_METADATA_FIELDS) {
    const incomingValue = text(incoming[field]);
    const existingValue = text(existing[field]);
    merged[field] = incomingValue || existingValue || "";
  }
  return withoutBlankValues(merged);
}

export function reusableMetadataPayload(metadata = {}, keyInfo = {}, options = {}) {
  const source = normalizeProviderSource(options.source, options.existingSource);
  const mergedPublic = mergeReusableMetadata(options.existing || {}, metadata);
  return withoutBlankValues({
    key: keyInfo.key,
    keyType: keyInfo.keyType,
    ...mergedPublic,
    source,
    confidence: options.confidence || confidenceForKeyType(keyInfo.keyType),
    titleKeywords: titleKeywords(mergedPublic.title || metadata.title || ""),
    titleAuthorKey: normalizeTextKey(titleAuthorKeyValue(mergedPublic))
  });
}

export function assertNoPrivateMetadataFields(record = {}) {
  return !PRIVATE_BOOK_METADATA_FIELDS.some((field) => Object.hasOwn(record, field));
}
