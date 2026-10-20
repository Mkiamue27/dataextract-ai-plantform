/**
 * ============================================================
 * DataExtract AI
 * validateCsvOutput.js
 *
 * UNIVERSAL + FINANCIAL CSV VALIDATION ENGINE
 *
 * Supports:
 * - Universal document extraction
 * - Dynamic column generation
 * - Financial document schemas
 * - CSV parsing and serialization
 * - Monetary validation
 * - Empty-row detection
 * - Document-aware validation
 *
 * ============================================================
 */


/* ============================================================
   FINANCIAL DOCUMENT SCHEMAS
============================================================ */

const FINANCIAL_SCHEMAS = {

  bank_statement: {

    documentType: "bank_statement",

    header: [
      "Bank/Institution Name",
      "Account ID",
      "Statement Period",
      "Beginning Balance",
      "Ending Balance",
      "Transaction Date",
      "Description",
      "Debit",
      "Credit",
      "Transaction Amount",
      "Running Balance",
      "Total Deposits",
      "Total Withdrawals",
      "Currency",
    ],

    monetaryColumns: [
      "Beginning Balance",
      "Ending Balance",
      "Debit",
      "Credit",
      "Transaction Amount",
      "Running Balance",
      "Total Deposits",
      "Total Withdrawals",
    ],

  },


  invoice: {

    documentType: "invoice",

    header: [
      "Vendor/Issuer Name",
      "Invoice Number",
      "Invoice Date",
      "Due Date",
      "Line Item Description",
      "Quantity",
      "Unit Price",
      "Discount",
      "Tax",
      "Line Total",
      "Subtotal",
      "Total Amount",
      "Amount Paid",
      "Amount Due",
      "Currency",
      "Issuer Contact Phone",
      "Issuer Mailing Address",
    ],

    monetaryColumns: [
      "Unit Price",
      "Discount",
      "Tax",
      "Line Total",
      "Subtotal",
      "Total Amount",
      "Amount Paid",
      "Amount Due",
    ],

  },


  medical_bill: {

    documentType: "medical_bill",

    header: [
      "Provider Name",
      "Account/Claim ID",
      "Service Date",
      "Line Item Description",
      "CPT/HCPCS Code",
      "Quantity",
      "Gross Charge",
      "Adjustment/Discount",
      "Insurance Payment",
      "Patient Responsibility",
      "Line Balance",
      "Total Charges",
      "Total Adjustments",
      "Total Insurance Payments",
      "Total Patient Responsibility",
      "Amount Due",
      "Currency",
      "Provider Contact Phone",
      "Provider Mailing Address",
    ],

    monetaryColumns: [
      "Gross Charge",
      "Adjustment/Discount",
      "Insurance Payment",
      "Patient Responsibility",
      "Line Balance",
      "Total Charges",
      "Total Adjustments",
      "Total Insurance Payments",
      "Total Patient Responsibility",
      "Amount Due",
    ],

  },


  receipt: {

    documentType: "receipt",

    header: [
      "Merchant Name",
      "Transaction Date",
      "Receipt/Transaction ID",
      "Item Description",
      "Quantity",
      "Unit Price",
      "Discount",
      "Tax",
      "Line Total",
      "Subtotal",
      "Total Amount",
      "Payment Method",
      "Currency",
      "Merchant Contact Phone",
      "Merchant Address",
    ],

    monetaryColumns: [
      "Unit Price",
      "Discount",
      "Tax",
      "Line Total",
      "Subtotal",
      "Total Amount",
    ],

  },


  generic_financial: {

    documentType: "generic_financial",

    header: [
      "Issuer Name",
      "Document ID",
      "Document Date",
      "Line Item Description",
      "Amount",
      "Subtotal",
      "Total Amount",
      "Amount Paid",
      "Amount Due",
      "Balance",
      "Currency",
      "Issuer Contact Phone",
      "Issuer Mailing Address",
    ],

    monetaryColumns: [
      "Amount",
      "Subtotal",
      "Total Amount",
      "Amount Paid",
      "Amount Due",
      "Balance",
    ],

  },

};


/* ============================================================
   SUPPORTED FINANCIAL TYPES
============================================================ */

const SUPPORTED_FINANCIAL_DOCUMENT_TYPES =
  new Set(Object.keys(FINANCIAL_SCHEMAS));


/* ============================================================
   LEGACY COMPATIBILITY
============================================================ */

const HEADER = [
  "Document Type",
  "Provider/Issuer Name",
  "Document/Account ID",
  "Transaction Date",
  "Line Item Description",
  "Quantity",
  "CPT/Procedure Code",
  "Gross Amount",
  "Adjustments/Discounts/Tax",
  "Net Responsibility",
  "Subtotal",
  "Total Amount",
  "Amount Due",
  "Amount Due Now",
  "Current Balance",
  "Previous Balance",
  "Payments/Credits",
  "Patient Responsibility",
  "Currency",
  "Issuer Contact Phone",
  "Issuer Mailing Address",
];

const EXPECTED_COLUMNS = HEADER.length;

const MONETARY_COLUMNS = [
  "Gross Amount",
  "Adjustments/Discounts/Tax",
  "Net Responsibility",
  "Subtotal",
  "Total Amount",
  "Amount Due",
  "Amount Due Now",
  "Current Balance",
  "Previous Balance",
  "Payments/Credits",
  "Patient Responsibility",
];


/* ============================================================
   NORMALIZE FINANCIAL DOCUMENT TYPE
============================================================ */

function normalizeDocumentType(documentType) {

  if (
    documentType == null ||
    String(documentType).trim() === ""
  ) {
    return "unsupported_document";
  }

  const normalized = String(documentType)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (
    SUPPORTED_FINANCIAL_DOCUMENT_TYPES.has(normalized)
  ) {
    return normalized;
  }

  return "unsupported_document";
}


/* ============================================================
   GET FINANCIAL SCHEMA
============================================================ */

function getFinancialSchema(documentType) {

  const normalizedType =
    normalizeDocumentType(documentType);

  const schema =
    FINANCIAL_SCHEMAS[normalizedType];

  if (!schema) {

    throw new Error(
      `No financial schema available for: ${documentType}`
    );

  }

  return {

    documentType: schema.documentType,

    header: [...schema.header],

    monetaryColumns: [...schema.monetaryColumns],

    expectedColumns: schema.header.length,

  };

}


/* ============================================================
   NORMALIZE UNIVERSAL DOCUMENT TYPE
============================================================ */

function normalizeUniversalDocumentType(documentType) {

  if (
    documentType == null ||
    String(documentType).trim() === ""
  ) {
    return "unsupported_document";
  }

  return String(documentType)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") ||
    "unsupported_document";

}


/* ============================================================
   CSV SERIALIZATION
============================================================ */

function toCsvLine(fields) {

  if (!Array.isArray(fields)) {
    throw new Error("CSV fields must be an array.");
  }

  return fields.map((field) => {

    const value =
      field == null ? "" : String(field);

    if (/[",\r\n]/.test(value)) {

      return (
        '"' +
        value.replace(/"/g, '""') +
        '"'
      );

    }

    return value;

  }).join(",");

}


/* ============================================================
   CSV PARSER
============================================================ */

function parseCsvRows(csvText) {

  const text = String(csvText ?? "");

  const rows = [];

  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {

    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {

      if (char === '"' && next === '"') {

        field += '"';
        i++;

      } else if (char === '"') {

        inQuotes = false;

      } else {

        field += char;

      }

      continue;
    }

    if (char === '"') {

      inQuotes = true;

    } else if (char === ",") {

      row.push(field);
      field = "";

    } else if (
      char === "\n" ||
      char === "\r"
    ) {

      if (char === "\r" && next === "\n") {
        i++;
      }

      row.push(field);

      if (
        row.some(
          (value) => String(value).trim() !== ""
        )
      ) {
        rows.push(row);
      }

      row = [];
      field = "";

    } else {

      field += char;

    }

  }

  row.push(field);

  if (
    row.some(
      (value) => String(value).trim() !== ""
    )
  ) {
    rows.push(row);
  }

  return {
    rows,
    unterminatedQuote: inQuotes,
  };

}


/* ============================================================
   PARSE SINGLE CSV LINE
============================================================ */

function parseCsvLine(line) {

  const parsed = parseCsvRows(line);

  return parsed.rows[0] || [];

}


/* ============================================================
   REMOVE MARKDOWN FENCES
============================================================ */

function removeMarkdownFences(text) {

  return String(text ?? "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.trim().startsWith("```")
    )
    .join("\n");

}


/* ============================================================
   MONETARY VALIDATION
============================================================ */

function isValidMonetaryValue(value) {

  const normalized =
    String(value ?? "").trim();

  if (normalized === "") {
    return true;
  }

  return /^-?\d+(?:\.\d{1,2})?$/.test(
    normalized
  );

}


/* ============================================================
   MONETARY NORMALIZATION
============================================================ */

function normalizeMonetaryValue(value) {

  const normalized =
    String(value ?? "").trim();

  if (normalized === "") {
    return "";
  }

  if (!isValidMonetaryValue(normalized)) {
    return normalized;
  }

  const number = Number(normalized);

  if (!Number.isFinite(number)) {
    return normalized;
  }

  return number.toFixed(2);

}


/* ============================================================
   MONETARY COLUMN INDEXES
============================================================ */

function getMonetaryColumnIndexes(
  header,
  monetaryColumns
) {

  if (
    !Array.isArray(header) ||
    !Array.isArray(monetaryColumns)
  ) {
    return [];
  }

  return monetaryColumns
    .map((column) => header.indexOf(column))
    .filter((index) => index >= 0);

}


/* ============================================================
   VALIDATE MONETARY FIELDS
============================================================ */

function validateMonetaryFields(
  fields,
  lineNumber,
  errors,
  header,
  monetaryColumns
) {

  const normalizedFields = [...fields];

  const indexes = getMonetaryColumnIndexes(
    header,
    monetaryColumns
  );

  for (const index of indexes) {

    const value = normalizedFields[index];

    if (!isValidMonetaryValue(value)) {

      errors.push(
        `Row ${lineNumber}: invalid monetary value ` +
        `"${value}" in "${header[index]}".`
      );

      continue;
    }

    normalizedFields[index] =
      normalizeMonetaryValue(value);

  }

  return normalizedFields;

}


/* ============================================================
   END OF PART 1
============================================================ */

/* ============================================================
   UNIVERSAL EXTRACTION VALIDATION
============================================================ */

function validateUniversalExtraction(extraction) {

  const errors = [];

  if (
    !extraction ||
    typeof extraction !== "object" ||
    Array.isArray(extraction)
  ) {

    return {
      valid: false,
      documentType: "unsupported_document",
      columns: [],
      rows: [],
      errors: [
        "Universal extraction must be a JSON object."
      ],
    };

  }

  const documentType =
    normalizeUniversalDocumentType(
      extraction.documentType
    );

  const columns = extraction.columns;
  const rows = extraction.rows;

  if (documentType === "unsupported_document") {

    return {
      valid: false,
      documentType,
      columns: [],
      rows: [],
      errors: [
        "No supported structured information was extracted."
      ],
    };

  }

  if (!Array.isArray(columns)) {

    errors.push(
      "The extraction must contain a columns array."
    );

  }

  if (!Array.isArray(rows)) {

    errors.push(
      "The extraction must contain a rows array."
    );

  }

  if (errors.length > 0) {

    return {
      valid: false,
      documentType,
      columns: [],
      rows: [],
      errors,
    };

  }

  if (columns.length === 0) {

    errors.push(
      "No columns were identified."
    );

  }

  if (rows.length === 0) {

    errors.push(
      "No meaningful data rows were extracted."
    );

  }

  const normalizedColumns = columns.map(
    (column) => String(column ?? "").trim()
  );

  const seenColumns = new Set();

  for (let i = 0; i < normalizedColumns.length; i++) {

    const column = normalizedColumns[i];

    if (column === "") {

      errors.push(
        `Column ${i + 1} has an empty name.`
      );

      continue;

    }

    if (seenColumns.has(column)) {

      errors.push(
        `Duplicate column name: "${column}".`
      );

    }

    seenColumns.add(column);

  }

  const normalizedRows = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {

    const row = rows[rowIndex];

    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row)
    ) {

      errors.push(
        `Row ${rowIndex + 1} must be a JSON object.`
      );

      continue;

    }

    const rowKeys = Object.keys(row);

    const missingColumns = normalizedColumns.filter(
      (column) =>
        !Object.prototype.hasOwnProperty.call(
          row,
          column
        )
    );

    const extraColumns = rowKeys.filter(
      (key) => !seenColumns.has(key)
    );

    if (missingColumns.length > 0) {

      errors.push(
        `Row ${rowIndex + 1} is missing columns: ` +
        missingColumns.join(", ")
      );

    }

    if (extraColumns.length > 0) {

      errors.push(
        `Row ${rowIndex + 1} contains unexpected columns: ` +
        extraColumns.join(", ")
      );

    }

    if (
      missingColumns.length > 0 ||
      extraColumns.length > 0
    ) {
      continue;
    }

    const normalizedRow = {};

    let meaningfulCells = 0;

    for (const column of normalizedColumns) {

      const value = row[column];

      if (
        value !== null &&
        typeof value === "object"
      ) {

        errors.push(
          `Row ${rowIndex + 1}, column "${column}" ` +
          "must contain a scalar value."
        );

        continue;

      }

      const normalizedValue =
        value == null ? "" : String(value).trim();

      normalizedRow[column] = normalizedValue;

      if (normalizedValue !== "") {
        meaningfulCells++;
      }

    }

    if (meaningfulCells === 0) {

      errors.push(
        `Row ${rowIndex + 1} contains no meaningful data.`
      );

      continue;

    }

    normalizedRows.push(normalizedRow);

  }

  return {
    valid: errors.length === 0,
    documentType,
    columns: normalizedColumns,
    rows: normalizedRows,
    errors,
  };

}


/* ============================================================
   UNIVERSAL STRUCTURED ROWS TO CSV
============================================================ */

function universalRowsToCsv(extraction) {

  const validation =
    validateUniversalExtraction(extraction);

  if (!validation.valid) {

    throw new Error(
      "Universal extraction validation failed: " +
      validation.errors.join("; ")
    );

  }

  const { columns, rows } = validation;

  const csvLines = [
    toCsvLine(columns),
  ];

  for (const row of rows) {

    csvLines.push(
      toCsvLine(
        columns.map(
          (column) => row[column]
        )
      )
    );

  }

  return csvLines.join("\r\n");

}


/* ============================================================
   FINANCIAL STRUCTURED ROWS TO CSV
============================================================ */

function structuredRowsToCsv(
  rows,
  documentType = "generic_financial"
) {

  if (!Array.isArray(rows)) {

    throw new Error(
      "Financial rows must be an array."
    );

  }

  const schema =
    getFinancialSchema(documentType);

  const csvLines = [
    toCsvLine(schema.header),
  ];

  for (const row of rows) {

    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row)
    ) {

      throw new Error(
        "Each financial row must be an object."
      );

    }

    const fields = schema.header.map(
      (column) => {

        const value = row[column];

        return value == null
          ? ""
          : String(value).trim();

      }
    );

    csvLines.push(
      toCsvLine(fields)
    );

  }

  return csvLines.join("\r\n");

}


/* ============================================================
   FINANCIAL CSV VALIDATION
============================================================ */

function validateCsv(
  rawCsv,
  options = {}
) {

  const errors = [];
  const flaggedRows = [];

  const documentType =
    normalizeDocumentType(
      options.documentType ||
      "generic_financial"
    );

  if (documentType === "unsupported_document") {

    return {
      valid: false,
      documentType,
      header: [],
      expectedColumns: 0,
      rows: [],
      cleanedCsv: "",
      errors: [
        "Unsupported financial document type."
      ],
      flaggedRows,
    };

  }

  const schema =
    getFinancialSchema(documentType);

  const header = schema.header;
  const expectedColumns =
    schema.expectedColumns;

  const text = removeMarkdownFences(
    rawCsv
  ).trim();

  if (!text) {

    return {
      valid: false,
      documentType,
      header,
      expectedColumns,
      rows: [],
      cleanedCsv: "",
      errors: [
        "CSV output is empty."
      ],
      flaggedRows,
    };

  }

  const parsed = parseCsvRows(text);

  if (parsed.unterminatedQuote) {

    errors.push(
      "CSV contains an unterminated quoted field."
    );

  }

  const parsedRows = parsed.rows;

  if (parsedRows.length === 0) {

    errors.push(
      "CSV contains no rows."
    );

  }

  const actualHeader =
    parsedRows[0] || [];

  const headerMatches =
    actualHeader.length === header.length &&
    actualHeader.every(
      (value, index) =>
        String(value).trim() === header[index]
    );

  if (!headerMatches) {

    errors.push(
      "CSV header does not match the required " +
      `${documentType} schema.`
    );

  }

  if (parsedRows.length <= 1) {

    errors.push(
      "CSV contains headers but no data rows."
    );

  }

  const cleanedRows = [];

  for (
    let rowIndex = 1;
    rowIndex < parsedRows.length;
    rowIndex++
  ) {

    const originalFields =
      [...parsedRows[rowIndex]];

    const lineNumber = rowIndex + 1;

    if (
      originalFields.length >
      expectedColumns
    ) {

      errors.push(
        `Row ${lineNumber} has too many columns. ` +
        `Expected ${expectedColumns}, ` +
        `received ${originalFields.length}.`
      );

      flaggedRows.push({
        rowNumber: lineNumber,
        reason: "too_many_columns",
      });

      continue;

    }

    while (
      originalFields.length <
      expectedColumns
    ) {

      originalFields.push("");

    }

    const fields =
      originalFields.map(
        (value) => String(value ?? "").trim()
      );

    const meaningfulCells =
      fields.filter(
        (value) => value !== ""
      ).length;

    if (meaningfulCells === 0) {

      errors.push(
        `Row ${lineNumber} is empty.`
      );

      flaggedRows.push({
        rowNumber: lineNumber,
        reason: "empty_row",
      });

      continue;

    }

    const validatedFields =
      validateMonetaryFields(
        fields,
        lineNumber,
        errors,
        header,
        schema.monetaryColumns
      );

    cleanedRows.push(
      validatedFields
    );

  }

  if (cleanedRows.length === 0) {

    errors.push(
      "No meaningful financial rows were extracted."
    );

  }

  const cleanedCsv = [
    toCsvLine(header),
    ...cleanedRows.map(toCsvLine),
  ].join("\r\n");

  return {
    valid: errors.length === 0,
    documentType,
    header,
    expectedColumns,
    rows: cleanedRows,
    cleanedCsv,
    errors,
    flaggedRows,
  };

}


/* ============================================================
   UNIVERSAL CSV VALIDATION
============================================================ */

function validateUniversalCsv(
  rawCsv,
  options = {}
) {

  const errors = [];
  const flaggedRows = [];

  const documentType =
    normalizeUniversalDocumentType(
      options.documentType ||
      "general_document"
    );

  const text = removeMarkdownFences(
    rawCsv
  ).trim();

  if (!text) {

    return {
      valid: false,
      documentType,
      header: [],
      expectedColumns: 0,
      rows: [],
      cleanedCsv: "",
      errors: [
        "Universal CSV output is empty."
      ],
      flaggedRows,
    };

  }

  const parsed = parseCsvRows(text);

  if (parsed.unterminatedQuote) {

    errors.push(
      "CSV contains an unterminated quoted field."
    );

  }

  const parsedRows = parsed.rows;

  const header =
    (parsedRows[0] || []).map(
      (value) => String(value).trim()
    );

  if (header.length === 0) {

    errors.push(
      "Universal CSV has no header columns."
    );

  }

  const seenColumns = new Set();

  for (const column of header) {

    if (column === "") {

      errors.push(
        "Universal CSV contains an empty column name."
      );

    }

    if (seenColumns.has(column)) {

      errors.push(
        `Duplicate CSV column: "${column}".`
      );

    }

    seenColumns.add(column);

  }

  if (parsedRows.length <= 1) {

    errors.push(
      "Universal CSV contains no data rows."
    );

  }

  const expectedColumns =
    header.length;

  const cleanedRows = [];

  for (
    let rowIndex = 1;
    rowIndex < parsedRows.length;
    rowIndex++
  ) {

    const fields =
      parsedRows[rowIndex].map(
        (value) => String(value ?? "").trim()
      );

    const lineNumber =
      rowIndex + 1;

    if (
      fields.length !== expectedColumns
    ) {

      errors.push(
        `Row ${lineNumber} contains ` +
        `${fields.length} columns; ` +
        `${expectedColumns} expected.`
      );

      flaggedRows.push({
        rowNumber: lineNumber,
        reason: "column_count_mismatch",
      });

      continue;

    }

    const meaningfulCells =
      fields.filter(
        (value) => value !== ""
      ).length;

    if (meaningfulCells === 0) {

      errors.push(
        `Row ${lineNumber} is empty.`
      );

      flaggedRows.push({
        rowNumber: lineNumber,
        reason: "empty_row",
      });

      continue;

    }

    cleanedRows.push(fields);

  }

  if (cleanedRows.length === 0) {

    errors.push(
      "Universal CSV contains no meaningful data rows."
    );

  }

  const cleanedCsv = [
    toCsvLine(header),
    ...cleanedRows.map(toCsvLine),
  ].join("\r\n");

  return {
    valid: errors.length === 0,
    documentType,
    header,
    expectedColumns,
    rows: cleanedRows,
    cleanedCsv,
    errors,
    flaggedRows,
  };

}


/* ============================================================
   MODULE EXPORTS
============================================================ */

module.exports = {

  // Financial schemas
  FINANCIAL_SCHEMAS,
  SUPPORTED_FINANCIAL_DOCUMENT_TYPES,

  // Document classification
  normalizeDocumentType,
  normalizeUniversalDocumentType,

  // Financial schema helpers
  getFinancialSchema,

  // CSV conversion
  structuredRowsToCsv,
  universalRowsToCsv,

  // Validation
  validateCsv,
  validateUniversalCsv,
  validateUniversalExtraction,

  // CSV utilities
  parseCsvLine,
  parseCsvRows,
  toCsvLine,

  // Monetary utilities
  isValidMonetaryValue,
  normalizeMonetaryValue,
  getMonetaryColumnIndexes,
  validateMonetaryFields,

  // Legacy compatibility
  EXPECTED_COLUMNS,
  HEADER,
  MONETARY_COLUMNS,

};
