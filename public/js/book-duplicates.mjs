export const DUPLICATE_SAFE_METADATA_FIELDS = [
  "author",
  "title",
  "placePublisher",
  "publisher",
  "year",
  "pages",
  "volume",
  "source",
  "billNoDate",
  "cost",
  "isbn",
  "category",
  "subject"
];

const PROTECTED_STATUSES = new Set(["issued", "lost", "missing", "damaged"]);
const ACTIVE_REFERENCE_STATUSES = {
  bookIssues: new Set(["issued", "active", "overdue"]),
  issueRequests: new Set(["pending", "approved", "approved_for_pickup", "reserved"]),
  returnRequests: new Set(["pending", "approved"])
};

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeLogicalAccession(value) {
  let normalized = text(value).toUpperCase().replace(/\s+/g, "");
  normalized = normalized.replace(/^ACC[-_:]*/, "");
  if (/^\d+$/.test(normalized)) return normalized.replace(/^0+(?=\d)/, "");
  return normalized;
}

function accessionOf(book = {}) {
  return book.accessionNumber
    ?? book.blegal_num
    ?? book.blegalNumber
    ?? book.BLegalNumber
    ?? book.b_id
    ?? "";
}

function metadataScore(data = {}) {
  return DUPLICATE_SAFE_METADATA_FIELDS.reduce((score, field) => score + (text(data[field]) ? 1 : 0), 0);
}

function timestampValue(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (Number.isFinite(value.seconds)) return value.seconds * 1000;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function statusOf(data = {}) {
  return text(data.status || "available").toLowerCase();
}

function hasLocalProtection(data = {}) {
  return PROTECTED_STATUSES.has(statusOf(data))
    || Boolean(data.currentIssueId || data.issuedStudentUid || data.issuedTo);
}

function referenceIdentifiers(data = {}) {
  return [data.bookDocumentId, data.bookDocId, data.bookId, data.b_id]
    .map(text)
    .filter(Boolean);
}

function referenceAccession(data = {}) {
  return normalizeLogicalAccession(data.accessionNumber || data.blegal_num || data.barcodeValue);
}

function referenceIsActive(reference = {}) {
  const statuses = ACTIVE_REFERENCE_STATUSES[reference.collection];
  return statuses?.has(statusOf(reference.data)) === true;
}

function candidateIdentifiers(candidate) {
  return new Set([candidate.id, candidate.data?.b_id, candidate.data?.bookId].map(text).filter(Boolean));
}

function mergeSafeMetadata(canonical = {}, candidates = []) {
  const patch = {};
  DUPLICATE_SAFE_METADATA_FIELDS.forEach((field) => {
    if (text(canonical[field])) return;
    const donor = candidates.find((candidate) => text(candidate.data?.[field]));
    if (donor) patch[field] = donor.data[field];
  });
  return patch;
}

function canonicalSort(left, right) {
  if (left.protected !== right.protected) return left.protected ? -1 : 1;
  const scoreDifference = metadataScore(right.data) - metadataScore(left.data);
  if (scoreDifference) return scoreDifference;
  const createdDifference = timestampValue(left.data?.createdAt) - timestampValue(right.data?.createdAt);
  if (createdDifference) return createdDifference;
  return text(left.id).localeCompare(text(right.id), undefined, { sensitivity: "base" });
}

export function buildDuplicateCleanupPlan(books = [], references = []) {
  const grouped = new Map();
  (Array.isArray(books) ? books : []).forEach((book) => {
    const key = normalizeLogicalAccession(accessionOf(book.data || {}));
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ id: text(book.id), data: book.data || {} });
  });

  const groups = [];
  [...grouped.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }))
    .forEach(([accessionKey, candidates]) => {
      const candidateState = candidates.map((candidate) => ({
        ...candidate,
        identifiers: candidateIdentifiers(candidate),
        references: [],
        activeReferences: [],
        protected: hasLocalProtection(candidate.data)
      }));
      const ambiguousReferences = [];

      references.forEach((reference) => {
        const ids = referenceIdentifiers(reference.data || {});
        let matches = ids.length
          ? candidateState.filter((candidate) => ids.some((id) => candidate.identifiers.has(id)))
          : [];
        if (!matches.length && referenceAccession(reference.data || {}) === accessionKey) {
          matches = candidateState;
        }
        if (matches.length > 1) {
          ambiguousReferences.push(reference);
          return;
        }
        if (matches.length === 1) {
          matches[0].references.push(reference);
          if (referenceIsActive(reference)) matches[0].activeReferences.push(reference);
          matches[0].protected = true;
        }
      });

      const protectedCandidates = candidateState.filter((candidate) => candidate.protected);
      const sorted = [...candidateState].sort(canonicalSort);
      const canonical = sorted[0];
      const extraCandidates = sorted.slice(1);
      let manualReview = false;
      let manualReviewReason = "";

      if (ambiguousReferences.length) {
        manualReview = true;
        manualReviewReason = "A circulation record identifies only the shared accession number.";
      } else if (protectedCandidates.length > 1) {
        manualReview = true;
        manualReviewReason = "More than one duplicate has circulation, history, or protected status references.";
      } else if (extraCandidates.some((candidate) => candidate.protected || statusOf(candidate.data) !== "available")) {
        manualReview = true;
        manualReviewReason = "A record selected for removal has protected circulation state.";
      }

      groups.push({
        accessionKey,
        displayAccession: text(canonical.data.accessionNumber || canonical.data.blegal_num || canonical.data.b_id || accessionKey),
        canonical,
        candidates: sorted,
        deletions: manualReview ? [] : extraCandidates,
        metadataPatch: manualReview ? {} : mergeSafeMetadata(canonical.data, extraCandidates),
        manualReview,
        manualReviewReason,
        ambiguousReferenceCount: ambiguousReferences.length
      });
    });

  return {
    groups,
    duplicateGroupCount: groups.length,
    extraDuplicateCount: groups.reduce((total, group) => total + Math.max(0, group.candidates.length - 1), 0),
    deletableCount: groups.reduce((total, group) => total + group.deletions.length, 0),
    canonicalCount: groups.length,
    metadataMergeCount: groups.reduce((total, group) => total + Object.keys(group.metadataPatch).length, 0),
    skippedGroupCount: groups.filter((group) => group.manualReview).length,
    uniqueAccessionCount: grouped.size,
    totalBookCount: (Array.isArray(books) ? books : []).length
  };
}

export function duplicateCleanupSignature(plan = {}) {
  return (plan.groups || []).map((group) => [
    group.accessionKey,
    group.canonical?.id || "",
    group.manualReview ? "review" : "delete",
    ...group.deletions.map((item) => item.id).sort()
  ].join(":")).sort().join("|");
}
