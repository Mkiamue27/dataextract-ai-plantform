/**
 * validateCsvOutput.js
 *
 * DataExtract AI adaptive financial CSV validator.
 *
 * Supports document-aware financial schemas:
 *
 * - bank_statement
 * - invoice
 * - medical_bill
 * - receipt
 * - generic_financial
 *
 * Also provides:
 *
 * - standards-compliant CSV parsing
 * - CSV serialization
 * - monetary validation
 * - monetary normalization
 * - short-row detection
 * - long-row detection
 * - duplicate-header removal
 * - Markdown fence cleanup
 */


/* ============================================================
   ADAPTIVE FINANCIAL SCHEMAS
============================================================ */

const FINANCIAL_SCHEMAS = {
  /* ==========================================================
     BANK STATEMENT
  ========================================================== */

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


  /* ==========================================================
     INVOICE
  ========================================================== */

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


  /* ==========================================================
     MEDICAL BILL / EOB
  ========================================================== */

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


  /* ==========================================================
     RECEIPT
  ========================================================== */

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


  /* ==========================================================
     GENERIC FINANCIAL
  ========================================================== */

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
   LEGACY HEADER

   Temporary compatibility export.

   routes/extraction.js currently imports HEADER.

   File 3 will remove that dependency and use the adaptive
   schema returned by getFinancialSchema().
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

const EXPECTED_COLUMNS =
  HEADER.length;

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
   SUPPORTED FINANCIAL DOCUMENT TYPES
============================================================ */

const SUPPORTED_FINANCIAL_DOCUMENT_TYPES =
  new Set(
    Object.keys(
      FINANCIAL_SCHEMAS
    )
  );


/* ============================================================
   NORMALIZE DOCUMENT TYPE
============================================================ */

function normalizeDocumentType(
  documentType
) {
  if (
    documentType == null
  ) {
    return "generic_financial";
  }

  const normalized =
    String(documentType)
      .trim()
      .toLowerCase()
      .replace(
        /[\s-]+/g,
        "_"
      );

  if (
    SUPPORTED_FINANCIAL_DOCUMENT_TYPES
      .has(normalized)
  ) {
    return normalized;
  }

  return "generic_financial";
}


/* ============================================================
   GET FINANCIAL SCHEMA
============================================================ */

function getFinancialSchema(
  documentType
) {
  const normalizedType =
    normalizeDocumentType(
      documentType
    );

  const schema =
    FINANCIAL_SCHEMAS[
      normalizedType
    ] ||
    FINANCIAL_SCHEMAS
      .generic_financial;

  return {
    documentType:
      schema.documentType,

    header:
      [...schema.header],

    monetaryColumns:
      [...schema.monetaryColumns],

    expectedColumns:
      schema.header.length,
  };
}


/* ============================================================
   CSV PARSER
============================================================ */

/**
 * Parse an entire CSV string.
 *
 * Supports:
 *
 * - quoted fields
 * - commas inside quoted fields
 * - escaped double quotes
 * - CRLF / LF
 * - line breaks inside quoted fields
 *
 * @param {string} csvText
 *
 * @returns {{
 *   rows: string[][],
 *   unterminatedQuote: boolean
 * }}
 */
function parseCsvRows(
  csvText
) {
  const rows = [];

  let row = [];
  let field = "";
  let inQuotes = false;

  const text =
    csvText == null
      ? ""
      : String(csvText);

  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    const char =
      text[i];

    const nextChar =
      text[i + 1];


    /* ========================================================
       INSIDE QUOTED FIELD
    ======================================================== */

    if (inQuotes) {
      if (
        char === '"' &&
        nextChar === '"'
      ) {
        field += '"';

        i++;

        continue;
      }


      if (
        char === '"'
      ) {
        inQuotes =
          false;

        continue;
      }


      field += char;

      continue;
    }


    /* ========================================================
       OUTSIDE QUOTED FIELD
    ======================================================== */

    if (
      char === '"'
    ) {
      inQuotes =
        true;

      continue;
    }


    if (
      char === ","
    ) {
      row.push(
        field
      );

      field = "";

      continue;
    }


    if (
      char === "\n" ||
      char === "\r"
    ) {
      /*
       * Treat Windows CRLF as one newline.
       */
      if (
        char === "\r" &&
        nextChar === "\n"
      ) {
        i++;
      }


      row.push(
        field
      );


      const hasContent =
        row.some(
          (value) =>
            String(
              value
            )
              .trim()
              .length >
            0
        );


      if (
        hasContent
      ) {
        rows.push(
          row
        );
      }


      row = [];

      field = "";

      continue;
    }


    field += char;
  }


  /* ============================================================
     FINAL FIELD / ROW
  ============================================================ */

  row.push(
    field
  );


  const hasFinalContent =
    row.some(
      (value) =>
        String(
          value
        )
          .trim()
          .length >
        0
    );


  if (
    hasFinalContent
  ) {
    rows.push(
      row
    );
  }


  return {
    rows,

    unterminatedQuote:
      inQuotes,
  };
}


/* ============================================================
   PARSE SINGLE CSV ROW
============================================================ */

function parseCsvLine(
  line
) {
  const parsed =
    parseCsvRows(
      line
    );

  return (
    parsed.rows[0] ||
    []
  );
}


/* ============================================================
   CSV SERIALIZER
============================================================ */

/**
 * Serialize one row as standards-compliant CSV.
 *
 * Fields containing:
 *
 * - comma
 * - quote
 * - CR
 * - LF
 *
 * are wrapped in double quotes.
 */
function toCsvLine(
  fields
) {
  return fields
    .map(
      (field) => {

        const value =
          field == null
            ? ""
            : String(
                field
              );


        if (
          /[",\r\n]/
            .test(value)
        ) {
          return (
            '"' +
            value.replace(
              /"/g,
              '""'
            ) +
            '"'
          );
        }


        return value;
      }
    )
    .join(",");
}


/* ============================================================
   NORMALIZATION HELPERS
============================================================ */

function normalizeFields(
  fields
) {
  return fields.map(
    (field) =>
      String(
        field ?? ""
      )
        .trim()
        .toLowerCase()
  );
}


/* ============================================================
   HEADER CHECK
============================================================ */

function isHeaderRow(
  fields,
  expectedHeader
) {
  if (
    !Array.isArray(
      expectedHeader
    )
  ) {
    return false;
  }


  if (
    fields.length !==
    expectedHeader.length
  ) {
    return false;
  }


  const normalized =
    normalizeFields(
      fields
    );


  const expected =
    normalizeFields(
      expectedHeader
    );


  return normalized.every(
    (
      field,
      index
    ) =>
      field ===
      expected[index]
  );
}


/* ============================================================
   MARKDOWN CLEANUP
============================================================ */

function removeMarkdownFences(
  text
) {
  return String(
    text ?? ""
  )
    .split(
      /\r?\n/
    )
    .filter(
      (line) =>
        !line
          .trim()
          .startsWith(
            "```"
          )
    )
    .join("\n");
}


/* ============================================================
   MONETARY VALIDATION
============================================================ */

/**
 * Valid:
 *
 * 858.44
 * -236.00
 * 0.00
 * 593
 * -4.56
 *
 * Invalid:
 *
 * $858.44
 * USD 858.44
 * 858.44 dollars
 *
 * Empty values are valid.
 */
function isValidMonetaryValue(
  value
) {
  const normalized =
    String(
      value ?? ""
    )
      .trim();


  if (
    normalized === ""
  ) {
    return true;
  }


  return /^-?\d+(?:\.\d{1,2})?$/
    .test(
      normalized
    );
}


/* ============================================================
   NORMALIZE MONETARY VALUE
============================================================ */

function normalizeMonetaryValue(
  value
) {
  const normalized =
    String(
      value ?? ""
    )
      .trim();


  if (
    normalized === ""
  ) {
    return "";
  }


  if (
    !isValidMonetaryValue(
      normalized
    )
  ) {
    return normalized;
  }


  const numericValue =
    Number(
      normalized
    );


  if (
    !Number.isFinite(
      numericValue
    )
  ) {
    return normalized;
  }


  return numericValue
    .toFixed(2);
}


/* ============================================================
   GET MONETARY COLUMN INDEXES
============================================================ */

function getMonetaryColumnIndexes(
  header,
  monetaryColumns
) {
  if (
    !Array.isArray(header) ||
    !Array.isArray(
      monetaryColumns
    )
  ) {
    return [];
  }


  return monetaryColumns
    .map(
      (columnName) =>
        header.indexOf(
          columnName
        )
    )
    .filter(
      (index) =>
        index >= 0
    );
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
  const normalizedFields =
    [...fields];


  const monetaryIndexes =
    getMonetaryColumnIndexes(
      header,
      monetaryColumns
    );


  monetaryIndexes
    .forEach(
      (columnIndex) => {

        const value =
          normalizedFields[
            columnIndex
          ];


        const columnName =
          header[
            columnIndex
          ];


        if (
          !isValidMonetaryValue(
            value
          )
        ) {
          errors.push(
            `Row ${lineNumber}: invalid monetary value "${value}" ` +
            `in "${columnName}". Expected numeric value without currency symbols.`
          );

          return;
        }


        normalizedFields[
          columnIndex
        ] =
          normalizeMonetaryValue(
            value
          );
      }
    );


  return normalizedFields;
}


/* ============================================================
   BUILD CSV FROM JSON ROWS
============================================================ */

/**
 * Convert structured JSON rows to CSV according
 * to the selected document schema.
 *
 * @param {object[]} rows
 * @param {string} documentType
 *
 * @returns {string}
 */
function structuredRowsToCsv(
  rows,
  documentType
) {
  const schema =
    getFinancialSchema(
      documentType
    );


  const safeRows =
    Array.isArray(rows)
      ? rows
      : [];


  const csvRows =
    safeRows.map(
      (item) => {

        const fields =
          schema.header.map(
            (column) => {

              const value =
                item?.[
                  column
                ];


              return value == null
                ? ""
                : String(
                    value
                  );
            }
          );


        return toCsvLine(
          fields
        );
      }
    );


  return [
    toCsvLine(
      schema.header
    ),

    ...csvRows,
  ].join("\n");
}


/* ============================================================
   MAIN ADAPTIVE CSV VALIDATOR
============================================================ */

/**
 * Validate and normalize financial CSV.
 *
 * @param {string} rawCsv
 *
 * @param {object} options
 *
 * @param {string} options.documentType
 *
 * @param {boolean}
 * options.padShortRows=true
 *
 * @returns {{
 *   valid: boolean,
 *   documentType: string,
 *   header: string[],
 *   expectedColumns: number,
 *   rows: string[][],
 *   cleanedCsv: string,
 *   errors: string[],
 *   flaggedRows: {
 *     lineNumber: number,
 *     original: string,
 *     fieldCount: number
 *   }[]
 * }}
 */
function validateCsv(
  rawCsv,
  options = {}
) {
  const {
    documentType =
      "generic_financial",

    padShortRows =
      true,
  } = options;


  const schema =
    getFinancialSchema(
      documentType
    );


  const header =
    schema.header;


  const monetaryColumns =
    schema.monetaryColumns;


  const expectedColumns =
    schema.expectedColumns;


  const errors = [];

  const flaggedRows = [];

  const rows = [];


  /* ============================================================
     EMPTY RESPONSE CHECK
  ============================================================ */

  if (
    rawCsv == null ||
    String(
      rawCsv
    )
      .trim()
      .length ===
    0
  ) {
    return {
      valid:
        false,

      documentType:
        schema.documentType,

      header,

      expectedColumns,

      rows:
        [],

      cleanedCsv:
        "",

      errors: [
        "No content returned from extraction.",
      ],

      flaggedRows:
        [],
    };
  }


  /* ============================================================
     CLEAN INPUT
  ============================================================ */

  const cleanedInput =
    removeMarkdownFences(
      rawCsv
    );


  /* ============================================================
     PARSE CSV
  ============================================================ */

  const parsed =
    parseCsvRows(
      cleanedInput
    );


  if (
    parsed.unterminatedQuote
  ) {
    errors.push(
      "CSV contains an unterminated quoted field."
    );
  }


  if (
    parsed.rows.length ===
    0
  ) {
    return {
      valid:
        false,

      documentType:
        schema.documentType,

      header,

      expectedColumns,

      rows:
        [],

      cleanedCsv:
        "",

      errors: [
        "No CSV rows could be parsed from extraction output.",
      ],

      flaggedRows:
        [],
    };
  }


  /* ============================================================
     PROCESS ROWS
  ============================================================ */

  parsed.rows.forEach(
    (
      originalFields,
      index
    ) => {

      const lineNumber =
        index + 1;


      const fields =
        originalFields.map(
          (field) =>
            String(
              field
            )
              .replace(
                /^\*\*(.*)\*\*$/,
                "$1"
              )
              .replace(
                /^__(.*)__$/,
                "$1"
              )
        );


      /* ========================================================
         HEADER
      ======================================================== */

      if (
        isHeaderRow(
          fields,
          header
        )
      ) {
        /*
         * Header is regenerated below.
         */
        return;
      }


      /* ========================================================
         CORRECT FIELD COUNT
      ======================================================== */

      if (
        fields.length ===
        expectedColumns
      ) {
        const normalizedFields =
          validateMonetaryFields(
            fields,
            lineNumber,
            errors,
            header,
            monetaryColumns
          );


        rows.push(
          normalizedFields
        );


        return;
      }


      /* ========================================================
         FLAG INVALID FIELD COUNT
      ======================================================== */

      flaggedRows.push({
        lineNumber,

        original:
          fields.join(","),

        fieldCount:
          fields.length,
      });


      /* ========================================================
         SHORT ROW
      ======================================================== */

      if (
        fields.length <
        expectedColumns
      ) {
        errors.push(
          `Row ${lineNumber}: expected ${expectedColumns} fields, ` +
          `got ${fields.length}. Possible dropped blank field / column drift.`
        );


        if (
          padShortRows
        ) {
          const padded =
            [...fields];


          while (
            padded.length <
            expectedColumns
          ) {
            padded.push("");
          }


          const normalizedFields =
            validateMonetaryFields(
              padded,
              lineNumber,
              errors,
              header,
              monetaryColumns
            );


          rows.push(
            normalizedFields
          );
        }


        return;
      }


      /* ========================================================
         LONG ROW
      ======================================================== */

      errors.push(
        `Row ${lineNumber}: expected ${expectedColumns} fields, ` +
        `got ${fields.length}. Possible malformed or unescaped field.`
      );

      /*
       * Do not guess how extra fields should be merged.
       * Incorrect merging could silently move financial values
       * into the wrong columns.
       */
    }
  );


  /* ============================================================
     BUILD CLEAN CSV
  ============================================================ */

  const cleanedCsv =
    [
      header,

      ...rows,
    ]
      .map(
        toCsvLine
      )
      .join("\n");


  /* ============================================================
     RESULT
  ============================================================ */

  return {
    valid:
      errors.length ===
      0,

    documentType:
      schema.documentType,

    header,

    expectedColumns,

    rows,

    cleanedCsv,

    errors,

    flaggedRows,
  };
}


/* ============================================================
   EXPORTS
============================================================ */

module.exports = {
  /* Adaptive schema API */
  FINANCIAL_SCHEMAS,
  SUPPORTED_FINANCIAL_DOCUMENT_TYPES,
  normalizeDocumentType,
  getFinancialSchema,
  structuredRowsToCsv,

  /* CSV utilities */
  validateCsv,
  parseCsvLine,
  parseCsvRows,
  toCsvLine,

  /* Monetary utilities */
  isValidMonetaryValue,
  normalizeMonetaryValue,
  getMonetaryColumnIndexes,
  validateMonetaryFields,

  /* Temporary legacy exports */
  EXPECTED_COLUMNS,
  HEADER,
  MONETARY_COLUMNS,
};
