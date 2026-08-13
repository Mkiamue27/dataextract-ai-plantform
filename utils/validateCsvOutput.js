/**
 * validateCsvOutput.js
 *
 * DataExtract AI fixed-schema financial CSV validator.
 *
 * Used for:
 * - pdf_csv
 * - pdf_excel
 * - pdf_sheets
 *
 * NOT used for:
 * - pdf_json
 * - ocr_pdf
 * - ai_table
 * - clean_data
 *
 * Responsibilities:
 * - Enforce the fixed 21-column financial schema.
 * - Remove duplicate header rows.
 * - Detect short/long rows.
 * - Pad short rows when configured.
 * - Preserve valid quoted commas, quotes, and line breaks.
 * - Re-serialize cleaned output as valid CSV.
 * - Validate structured monetary fields without inventing values.
 */


/* ============================================================
   FIXED FINANCIAL SCHEMA
============================================================ */

const EXPECTED_COLUMNS = 21;

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


/* ============================================================
   MONETARY FIELD CONFIGURATION
============================================================ */

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

const MONETARY_COLUMN_INDEXES =
  MONETARY_COLUMNS.map(
    (columnName) =>
      HEADER.indexOf(columnName)
  );


/* ============================================================
   CSV PARSER
============================================================ */

/**
 * Parse an entire CSV string.
 *
 * Supports:
 * - quoted fields
 * - commas inside quoted fields
 * - escaped double quotes
 * - CRLF / LF
 * - line breaks inside quoted fields
 *
 * @param {string} csvText
 * @returns {{
 *   rows: string[][],
 *   unterminatedQuote: boolean
 * }}
 */
function parseCsvRows(csvText) {
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
    const char = text[i];
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


      if (char === '"') {
        inQuotes = false;
        continue;
      }


      field += char;
      continue;
    }


    /* ========================================================
       OUTSIDE QUOTED FIELD
    ======================================================== */

    if (char === '"') {
      inQuotes = true;
      continue;
    }


    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }


    if (
      char === "\n" ||
      char === "\r"
    ) {

      /*
       * Handle Windows CRLF as one newline.
       */
      if (
        char === "\r" &&
        nextChar === "\n"
      ) {
        i++;
      }

      row.push(field);

      const hasContent =
        row.some(
          (value) =>
            String(value)
              .trim()
              .length > 0
        );

      if (hasContent) {
        rows.push(row);
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

  row.push(field);

  const hasFinalContent =
    row.some(
      (value) =>
        String(value)
          .trim()
          .length > 0
    );

  if (hasFinalContent) {
    rows.push(row);
  }


  return {
    rows,
    unterminatedQuote:
      inQuotes,
  };
}


/**
 * Parse a single CSV row.
 *
 * Kept for compatibility with existing imports.
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const parsed =
    parseCsvRows(line);

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
 * - comma
 * - quote
 * - CR
 * - LF
 *
 * are wrapped in double quotes.
 *
 * @param {Array} fields
 * @returns {string}
 */
function toCsvLine(fields) {
  return fields
    .map((field) => {

      const value =
        field == null
          ? ""
          : String(field);


      if (
        /[",\r\n]/.test(value)
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
    })
    .join(",");
}


/* ============================================================
   NORMALIZATION HELPERS
============================================================ */

function normalizeFields(fields) {
  return fields.map(
    (field) =>
      String(field ?? "")
        .trim()
        .toLowerCase()
  );
}


function isHeaderRow(fields) {
  if (
    fields.length !==
    EXPECTED_COLUMNS
  ) {
    return false;
  }

  const normalized =
    normalizeFields(fields);

  const expected =
    normalizeFields(HEADER);

  return normalized.every(
    (field, index) =>
      field ===
      expected[index]
  );
}


/* ============================================================
   MARKDOWN CLEANUP
============================================================ */

/**
 * Models occasionally return Markdown fences despite instructions.
 *
 * Only remove fence-only lines.
 * Do not remove legitimate backticks inside fields.
 */
function removeMarkdownFences(text) {
  return String(text)
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line
          .trim()
          .startsWith("```")
    )
    .join("\n");
}


/* ============================================================
   MONETARY VALIDATION HELPERS
============================================================ */

/**
 * Acceptable monetary examples:
 *
 * 858.44
 * -236.00
 * 0.00
 * 593
 * -4.56
 *
 * Reject examples:
 *
 * $858.44
 * USD 858.44
 * 858.44 dollars
 *
 * Empty values are allowed.
 */
function isValidMonetaryValue(value) {
  const normalized =
    String(value ?? "")
      .trim();

  if (normalized === "") {
    return true;
  }

  return /^-?\d+(?:\.\d{1,2})?$/.test(
    normalized
  );
}


/**
 * Normalize valid monetary values to exactly two decimals.
 *
 * Empty values remain empty.
 * Invalid values are preserved so they can be flagged instead
 * of silently changed.
 */
function normalizeMonetaryValue(value) {
  const normalized =
    String(value ?? "")
      .trim();

  if (normalized === "") {
    return "";
  }

  if (
    !isValidMonetaryValue(normalized)
  ) {
    return normalized;
  }

  const numericValue =
    Number(normalized);

  if (
    !Number.isFinite(numericValue)
  ) {
    return normalized;
  }

  return numericValue.toFixed(2);
}


/**
 * Validate and normalize monetary fields in one row.
 *
 * @param {string[]} fields
 * @param {number} lineNumber
 * @param {string[]} errors
 * @returns {string[]}
 */
function validateMonetaryFields(
  fields,
  lineNumber,
  errors
) {
  const normalizedFields =
    [...fields];

  MONETARY_COLUMN_INDEXES.forEach(
    (columnIndex) => {

      if (columnIndex < 0) {
        return;
      }

      const value =
        normalizedFields[columnIndex];

      const columnName =
        HEADER[columnIndex];


      if (
        !isValidMonetaryValue(value)
      ) {
        errors.push(
          `Row ${lineNumber}: invalid monetary value "${value}" ` +
          `in "${columnName}". Expected numeric value without currency symbols.`
        );

        return;
      }


      normalizedFields[columnIndex] =
        normalizeMonetaryValue(value);
    }
  );

  return normalizedFields;
}


/* ============================================================
   MAIN VALIDATOR
============================================================ */

/**
 * Validate and normalize financial CSV.
 *
 * @param {string} rawCsv
 * @param {object} [options]
 * @param {boolean} [options.padShortRows=true]
 *
 * @returns {{
 *   valid: boolean,
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
    padShortRows = true,
  } = options;


  const errors = [];
  const flaggedRows = [];
  const rows = [];


  /* ============================================================
     EMPTY RESPONSE CHECK
  ============================================================ */

  if (
    rawCsv == null ||
    String(rawCsv)
      .trim()
      .length === 0
  ) {
    return {
      valid: false,
      rows: [],
      cleanedCsv: "",
      errors: [
        "No content returned from extraction.",
      ],
      flaggedRows: [],
    };
  }


  /* ============================================================
     CLEAN MODEL OUTPUT
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


  if (parsed.unterminatedQuote) {
    errors.push(
      "CSV contains an unterminated quoted field."
    );
  }


  if (
    parsed.rows.length === 0
  ) {
    return {
      valid: false,
      rows: [],
      cleanedCsv: "",
      errors: [
        "No CSV rows could be parsed from extraction output.",
      ],
      flaggedRows: [],
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


      /*
       * Remove stray Markdown emphasis around entire values.
       *
       * We avoid aggressive formatting removal that could alter
       * legitimate content.
       */
      const fields =
        originalFields.map(
          (field) =>
            String(field)
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
        isHeaderRow(fields)
      ) {
        /*
         * Header is always regenerated from HEADER below.
         * Therefore every detected header row is skipped here.
         */
        return;
      }


      /* ========================================================
         CORRECT FIELD COUNT
      ======================================================== */

      if (
        fields.length ===
        EXPECTED_COLUMNS
      ) {

        const normalizedFields =
          validateMonetaryFields(
            fields,
            lineNumber,
            errors
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
        EXPECTED_COLUMNS
      ) {

        errors.push(
          `Row ${lineNumber}: expected ${EXPECTED_COLUMNS} fields, ` +
          `got ${fields.length}. Possible dropped blank field / column drift.`
        );


        if (padShortRows) {

          const padded =
            [...fields];


          while (
            padded.length <
            EXPECTED_COLUMNS
          ) {
            padded.push("");
          }


          const normalizedFields =
            validateMonetaryFields(
              padded,
              lineNumber,
              errors
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
        `Row ${lineNumber}: expected ${EXPECTED_COLUMNS} fields, ` +
        `got ${fields.length}. Possible malformed or unescaped field.`
      );

      /*
       * Do NOT attempt to guess how extra fields should be merged.
       *
       * A guessed merge could silently move financial values into
       * incorrect columns.
       */
    }
  );


  /* ============================================================
     BUILD CLEAN CSV
  ============================================================ */

  const cleanedCsv =
    [
      HEADER,
      ...rows,
    ]
      .map(toCsvLine)
      .join("\n");


  /* ============================================================
     RESULT
  ============================================================ */

  return {
    valid:
      errors.length === 0,

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
  validateCsv,
  parseCsvLine,
  parseCsvRows,
  toCsvLine,
  EXPECTED_COLUMNS,
  HEADER,
  MONETARY_COLUMNS,
  isValidMonetaryValue,
  normalizeMonetaryValue,
};
