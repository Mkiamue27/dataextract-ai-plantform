/* ============================================================
   DATAEXTRACT AI - APPLICATION CONSTANTS
============================================================ */

/* ============================================================
   PLAN LIMITS
============================================================ */

const PLAN_LIMITS = {
  free: 5,
  starter: 100,
  pro: Infinity,
  business: Infinity,
};


/* ============================================================
   UPLOAD LIMITS
============================================================ */

const MAX_FILES_PER_BATCH = 25;

const MAX_FILE_SIZE_MB = 50;

const MAX_FILE_SIZE_BYTES =
  MAX_FILE_SIZE_MB * 1024 * 1024;


/* ============================================================
   PROCESSING MODES
============================================================ */

const PROCESSING_MODES = {
  PDF_CSV: "pdf_csv",
  PDF_EXCEL: "pdf_excel",
  PDF_JSON: "pdf_json",
  PDF_SHEETS: "pdf_sheets",
  OCR_PDF: "ocr_pdf",
  AI_TABLE: "ai_table",
  CLEAN_DATA: "clean_data",
};

const SUPPORTED_PROCESSING_MODES =
  new Set(Object.values(PROCESSING_MODES));


/* ============================================================
   DEFAULTS
============================================================ */

const DEFAULT_PROCESSING_MODE =
  PROCESSING_MODES.PDF_CSV;


/* ============================================================
   EXPORTS
============================================================ */

module.exports = {
  PLAN_LIMITS,

  MAX_FILES_PER_BATCH,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,

  PROCESSING_MODES,
  SUPPORTED_PROCESSING_MODES,

  DEFAULT_PROCESSING_MODE,
};