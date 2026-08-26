const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const {
  extractDocument,
} = require("../services/openaiService");

const {
  getExtractionPrompt,
} = require("../prompts/extractionPrompt");

const checkUsageLimit =
  require("../middleware/checkUsageLimit");

const {
  validateCsv,
  structuredRowsToCsv,
  normalizeDocumentType,
  getFinancialSchema,
} = require("../utils/validateCsvOutput");

const {
  MAX_FILES_PER_BATCH,
  MAX_FILE_SIZE_BYTES,
  SUPPORTED_PROCESSING_MODES,
  DEFAULT_PROCESSING_MODE,
} = require("../config/constants");


const router = express.Router();


/* ============================================================
   SUPABASE
============================================================ */

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


/* ============================================================
   UPLOAD CONFIG
============================================================ */

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_BATCH,
  },
});


/* ============================================================
   ADAPTIVE FINANCIAL OUTPUT MODES

   These modes use:

   OpenAI JSON
        ↓
   documentType
        ↓
   adaptive financial schema
        ↓
   CSV
============================================================ */

const FINANCIAL_OUTPUT_MODES =
  new Set([
    "pdf_csv",
    "pdf_excel",
    "pdf_sheets",
  ]);


/* ============================================================
   OUTPUT FILE EXTENSIONS
============================================================ */

function getOutputExtension(
  processingMode
) {
  switch (processingMode) {

    case "pdf_excel":
      return "xlsx";

    case "pdf_json":
    case "clean_data":
      return "json";

    case "ocr_pdf":
      return "txt";

    case "pdf_sheets":
      return "csv";

    case "ai_table":
      return "csv";

    case "pdf_csv":
    default:
      return "csv";
  }
}


/* ============================================================
   BUILD OUTPUT FILE NAME
============================================================ */

function buildOutputFileName(
  inputFileName,
  processingMode
) {
  const originalName =
    inputFileName ||
    "document.pdf";

  const baseName =
    originalName.replace(
      /\.[^/.]+$/,
      ""
    ) || "document";

  const extension =
    getOutputExtension(
      processingMode
    );

  return `${baseName}.${extension}`;
}


/* ============================================================
   CLEAN JSON RESPONSE

   Models should return raw JSON, but this safely removes
   accidental Markdown fences without changing JSON content.
============================================================ */

function cleanJsonResponse(
  rawContent
) {
  let content =
    String(
      rawContent || ""
    ).trim();


  if (
    content.startsWith("```")
  ) {
    content =
      content.replace(
        /^```(?:json)?\s*/i,
        ""
      );

    content =
      content.replace(
        /\s*```$/,
        ""
      );
  }


  return content.trim();
}


/* ============================================================
   PARSE ADAPTIVE FINANCIAL JSON
============================================================ */

function parseFinancialExtraction(
  rawContent
) {
  const cleaned =
    cleanJsonResponse(
      rawContent
    );


  let parsed;


  try {

    parsed =
      JSON.parse(
        cleaned
      );

  } catch (error) {

    console.error(
      "Financial JSON parse failed."
    );

    console.error(
      "OpenAI response length:",
      String(
        rawContent || ""
      ).length
    );

    console.error(
      "OpenAI response preview:",
      String(
        rawContent || ""
      ).slice(
        0,
        500
      )
    );


    throw new Error(
      "Financial extraction returned invalid JSON."
    );
  }


  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {

    throw new Error(
      "Financial extraction must return a JSON object."
    );
  }


  /* ============================================================
     DOCUMENT TYPE
  ============================================================ */

  const documentType =
    normalizeDocumentType(
      parsed.documentType
    );


  /* ============================================================
     ROWS
  ============================================================ */

  if (
    !Array.isArray(
      parsed.rows
    )
  ) {

    console.error(
      "Financial extraction JSON did not contain a rows array."
    );

    console.error(
      "Top-level JSON keys:",
      Object.keys(
        parsed
      )
    );


    throw new Error(
      "Financial extraction JSON is missing a rows array."
    );
  }


  /* ============================================================
     SCHEMA
  ============================================================ */

  const schema =
    getFinancialSchema(
      documentType
    );


  console.log(
    "Detected document type:",
    documentType
  );

  console.log(
    "Adaptive schema columns:",
    schema.header.length
  );

  console.log(
    "Adaptive schema header:",
    schema.header
  );

  console.log(
    "Financial JSON rows received:",
    parsed.rows.length
  );


  if (
    parsed.rows.length > 0 &&
    parsed.rows[0] &&
    typeof parsed.rows[0] ===
      "object"
  ) {

    console.log(
      "First financial row keys:",
      Object.keys(
        parsed.rows[0]
      )
    );
  }


  return {
    documentType,
    rows:
      parsed.rows,
    schema,
  };
}


/* ============================================================
   ADAPTIVE FINANCIAL JSON -> CSV
============================================================ */

function financialJsonToCsv(
  rawContent
) {
  const extraction =
    parseFinancialExtraction(
      rawContent
    );


  const csv =
    structuredRowsToCsv(
      extraction.rows,
      extraction.documentType
    );


  console.log(
    "Generated adaptive CSV length:",
    csv.length
  );

  console.log(
    "Generated adaptive CSV data rows:",
    extraction.rows.length
  );


  return {
    documentType:
      extraction.documentType,

    schema:
      extraction.schema,

    csv,
  };
}


/* ============================================================
   USAGE TRACKING
============================================================ */

async function recordSuccessfulUsage(
  firebaseUid,
  successfulConversions
) {
  if (
    !firebaseUid ||
    successfulConversions <= 0
  ) {
    return;
  }


  const currentMonth =
    new Date()
      .toISOString()
      .slice(
        0,
        7
      );


  const {
    data: existingUsage,
    error: readError,
  } = await supabase
    .from("usage")
    .select(
      "month, conversions"
    )
    .eq(
      "firebase_uid",
      firebaseUid
    )
    .maybeSingle();


  if (readError) {
    throw readError;
  }


  let conversions =
    successfulConversions;


  if (
    existingUsage &&
    existingUsage.month ===
      currentMonth
  ) {

    conversions =
      Number(
        existingUsage.conversions ||
        0
      ) +
      successfulConversions;
  }


  const {
    error: upsertError,
  } = await supabase
    .from("usage")
    .upsert(
      {
        firebase_uid:
          firebaseUid,

        month:
          currentMonth,

        conversions,
      },
      {
        onConflict:
          "firebase_uid",
      }
    );


  if (upsertError) {
    throw upsertError;
  }
}


/* ============================================================
   CONVERSION HISTORY
============================================================ */

async function recordConversionHistory({
  firebaseUid,
  inputFileName,
  outputFileName,
  processingMode,
  status,
}) {

  const {
    error,
  } = await supabase
    .from(
      "conversion_history"
    )
    .insert({
      firebase_uid:
        firebaseUid,

      timestamp:
        new Date()
          .toISOString(),

      input_file_name:
        inputFileName,

      output_file_name:
        outputFileName,

      processing_mode:
        processingMode,

      status,
    });


  if (error) {
    throw error;
  }
}


/* ============================================================
   POST /extract
============================================================ */

router.post(

  "/",

  /* ============================================================
     DEBUG CHECKPOINT 1
  ============================================================ */

  (
    req,
    res,
    next
  ) => {

    console.log(
      "========================================"
    );

    console.log(
      "=== EXTRACTION ROUTE HIT ==="
    );

    console.log(
      "Time:",
      new Date()
        .toISOString()
    );

    console.log(
      "Method:",
      req.method
    );

    console.log(
      "Path:",
      req.originalUrl
    );

    console.log(
      "Content-Type:",
      req.headers[
        "content-type"
      ] ||
      "unknown"
    );


    next();
  },


  /* ============================================================
     MULTER FILE PARSING
  ============================================================ */

  upload.array(
    "files",
    MAX_FILES_PER_BATCH
  ),


  /* ============================================================
     DEBUG CHECKPOINT 2
  ============================================================ */

  (
    req,
    res,
    next
  ) => {

    console.log(
      "=== MULTER FINISHED ==="
    );

    console.log(
      "Files after multer:",
      Array.isArray(
        req.files
      )
        ? req.files.length
        : 0
    );

    console.log(
      "Body keys:",
      Object.keys(
        req.body || {}
      )
    );


    if (
      Array.isArray(
        req.files
      )
    ) {

      console.log(
        "Parsed filenames:",
        req.files.map(
          (file) =>
            file.originalname
        )
      );
    }


    next();
  },


  /* ============================================================
     DEBUG CHECKPOINT 3
  ============================================================ */

  (
    req,
    res,
    next
  ) => {

    console.log(
      "=== ABOUT TO CHECK USAGE LIMIT ==="
    );

    console.log(
      "firebase_uid present:",
      Boolean(
        req.body
          ?.firebase_uid
      )
    );

    console.log(
      "processingMode present:",
      Boolean(
        req.body
          ?.processingMode
      )
    );


    next();
  },


  /* ============================================================
     USAGE LIMIT
  ============================================================ */

  checkUsageLimit,


  /* ============================================================
     DEBUG CHECKPOINT 4
  ============================================================ */

  (
    req,
    res,
    next
  ) => {

    console.log(
      "=== USAGE LIMIT PASSED ==="
    );

    next();
  },


  /* ============================================================
     EXTRACTION HANDLER
  ============================================================ */

  async (
    req,
    res
  ) => {

    try {

      console.log(
        "=== UPLOAD PARSED ==="
      );

      console.log(
        "Processing mode received:",
        req.body
          ?.processingMode ||
        "(not supplied)"
      );

      console.log(
        "Firebase UID supplied:",
        Boolean(
          req.body
            ?.firebase_uid
        )
      );

      console.log(
        "Files received:",
        Array.isArray(
          req.files
        )
          ? req.files.length
          : 0
      );


      /* ========================================================
         VALIDATE FILES
      ======================================================== */

      if (
        !Array.isArray(
          req.files
        ) ||
        req.files.length === 0
      ) {

        console.warn(
          "Extraction stopped: no uploaded files were received."
        );


        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "No files uploaded.",
          });
      }


      /* ========================================================
         FIREBASE UID
      ======================================================== */

      const firebaseUid =
        req.body
          .firebase_uid;


      if (
        !firebaseUid ||
        firebaseUid
          .trim()
          .length === 0
      ) {

        console.warn(
          "Extraction stopped: firebase_uid missing."
        );


        return res
          .status(400)
          .json({
            success:
              false,

            error:
              "Missing firebase_uid.",
          });
      }


      /* ========================================================
         PROCESSING MODE
      ======================================================== */

      const processingMode =
        req.body
          .processingMode ||
        DEFAULT_PROCESSING_MODE;


      console.log(
        "Resolved processing mode:",
        processingMode
      );


      if (
        !SUPPORTED_PROCESSING_MODES
          .has(
            processingMode
          )
      ) {

        console.warn(
          "Unsupported processing mode:",
          processingMode
        );


        return res
          .status(400)
          .json({
            success:
              false,

            error:
              `Unsupported processing mode: ${processingMode}`,
          });
      }


      /* ========================================================
         GET EXTRACTION PROMPT
      ======================================================== */

      const prompt =
        getExtractionPrompt(
          processingMode
        );


      console.log(
        "Extraction prompt loaded."
      );

      console.log(
        "Prompt length:",
        prompt.length
      );


      /* ========================================================
         PROCESS FILES
      ======================================================== */

      const results = [];

      const errors = [];


      for (
        const file
        of req.files
      ) {

        const inputFileName =
          file.originalname ||
          "document.pdf";


        const outputFileName =
          buildOutputFileName(
            inputFileName,
            processingMode
          );


        try {

          console.log(
            "----------------------------------------"
          );

          console.log(
            "Beginning file:",
            inputFileName
          );

          console.log(
            "Input MIME type:",
            file.mimetype ||
            "unknown"
          );

          console.log(
            "Input size:",
            file.size ||
            file.buffer
              ?.length ||
            0
          );


          /* ====================================================
             OPENAI CALL
          ==================================================== */

          console.log(
            "=== ABOUT TO CALL OPENAI ==="
          );


          const rawContent =
            await extractDocument({
              fileBuffer:
                file.buffer,

              filename:
                inputFileName,

              mimeType:
                file.mimetype ||
                "application/pdf",

              processingMode,

              prompt,
            });


          console.log(
            "=== OPENAI RESPONSE RECEIVED ==="
          );

          console.log(
            "OpenAI response length:",
            String(
              rawContent ||
              ""
            ).length
          );


          /* ====================================================
             MODE-AWARE OUTPUT PROCESSING
          ==================================================== */

          let finalContent =
            rawContent;

          let validation =
            null;

          let documentType =
            null;

          let schemaHeader =
            null;


          if (
            FINANCIAL_OUTPUT_MODES
              .has(
                processingMode
              )
          ) {

            console.log(
              "=== PARSING ADAPTIVE FINANCIAL JSON ==="
            );


            const adaptiveOutput =
              financialJsonToCsv(
                rawContent
              );


            documentType =
              adaptiveOutput
                .documentType;

            schemaHeader =
              adaptiveOutput
                .schema
                .header;


            console.log(
              "Document classified as:",
              documentType
            );

            console.log(
              "Schema column count:",
              schemaHeader.length
            );


            console.log(
              "=== VALIDATING ADAPTIVE CSV ==="
            );


            validation =
              validateCsv(
                adaptiveOutput.csv,
                {
                  documentType,
                }
              );


            console.log(
              "CSV validation valid:",
              validation.valid
            );

            console.log(
              "CSV validation errors:",
              validation
                .errors
                .length
            );

            console.log(
              "CSV validated rows:",
              validation
                .rows
                .length
            );

            console.log(
              "Cleaned CSV length:",
              String(
                validation
                  .cleanedCsv ||
                ""
              ).length
            );


            finalContent =
              validation
                .cleanedCsv;


            if (
              !validation.valid
            ) {

              console.warn(
                `CSV validation issues for "${inputFileName}":`,
                validation.errors
              );
            }
          }


          /* ====================================================
             FINAL OUTPUT CHECK
          ==================================================== */

          console.log(
            "Final output filename:",
            outputFileName
          );

          console.log(
            "Final document type:",
            documentType ||
            "not-applicable"
          );

          console.log(
            "Final content length:",
            String(
              finalContent ||
              ""
            ).length
          );


          if (
            !finalContent ||
            String(
              finalContent
            )
              .trim()
              .length === 0
          ) {

            console.error(
              "FINAL CONTENT IS EMPTY."
            );


            throw new Error(
              "Extraction produced empty final content."
            );
          }


          /* ====================================================
             RECORD COMPLETED HISTORY
          ==================================================== */

          try {

            await recordConversionHistory({
              firebaseUid:
                firebaseUid
                  .trim(),

              inputFileName,

              outputFileName,

              processingMode,

              status:
                "completed",
            });

          } catch (
            historyError
          ) {

            console.error(
              `Failed to record conversion history for "${inputFileName}":`,
              historyError
            );
          }


          /* ====================================================
             SUCCESS RESULT
          ==================================================== */

          results.push({
            filename:
              inputFileName,

            outputFileName,

            mimeType:
              file.mimetype,

            processingMode,

            documentType,

            schemaHeader,

            success:
              true,

            status:
              "completed",

            content:
              finalContent,

            validation:
              validation
                ? {
                    valid:
                      validation
                        .valid,

                    errors:
                      validation
                        .errors,

                    flaggedRows:
                      validation
                        .flaggedRows,

                    expectedColumns:
                      validation
                        .expectedColumns,

                    documentType:
                      validation
                        .documentType,

                    header:
                      validation
                        .header,
                  }
                : null,
          });


          console.log(
            `=== FILE COMPLETED: ${inputFileName} ===`
          );


        } catch (
          fileError
        ) {

          console.error(
            `Extraction failed for "${inputFileName}":`,
            fileError
              ?.message ||
            fileError
          );


          /* ====================================================
             RECORD FAILED HISTORY
          ==================================================== */

          try {

            await recordConversionHistory({
              firebaseUid:
                firebaseUid
                  .trim(),

              inputFileName,

              outputFileName,

              processingMode,

              status:
                "failed",
            });

          } catch (
            historyError
          ) {

            console.error(
              `Failed to record failed conversion history for "${inputFileName}":`,
              historyError
            );
          }


          /* ====================================================
             FAILED RESULT
          ==================================================== */

          errors.push({
            filename:
              inputFileName,

            outputFileName,

            processingMode,

            success:
              false,

            status:
              "failed",

            error:
              fileError
                ?.message ||
              "Document extraction failed.",
          });
        }
      }


      /* ========================================================
         TOTAL FAILURE
      ======================================================== */

      if (
        results.length ===
        0
      ) {

        console.error(
          "=== EXTRACTION BATCH FAILED ==="
        );

        console.error(
          "Failed files:",
          errors.length
        );


        return res
          .status(500)
          .json({
            success:
              false,

            processingMode,

            totalFiles:
              req.files
                .length,

            successfulFiles:
              0,

            failedFiles:
              errors.length,

            partialSuccess:
              false,

            results:
              [],

            errors,
          });
      }


      /* ========================================================
         RECORD SUCCESSFUL USAGE

         Each successfully processed PDF counts as one conversion.
      ======================================================== */

      try {

        await recordSuccessfulUsage(
          firebaseUid
            .trim(),

          results.length
        );

      } catch (
        usageError
      ) {

        console.error(
          "Failed to record usage:",
          usageError
        );
      }


      /* ========================================================
         RESPONSE
      ======================================================== */

      console.log(
        "=== EXTRACTION RESPONSE READY ==="
      );

      console.log(
        "Total files:",
        req.files
          .length
      );

      console.log(
        "Successful files:",
        results.length
      );

      console.log(
        "Failed files:",
        errors.length
      );

      console.log(
        "Response results:",
        results.map(
          (result) => ({
            file:
              result
                .outputFileName,

            documentType:
              result
                .documentType,

            columns:
              Array.isArray(
                result
                  .schemaHeader
              )
                ? result
                    .schemaHeader
                    .length
                : null,

            contentLength:
              String(
                result
                  .content ||
                ""
              ).length,
          })
        )
      );

      console.log(
        "========================================"
      );


      return res
        .status(200)
        .json({
          success:
            true,

          processingMode,

          totalFiles:
            req.files
              .length,

          successfulFiles:
            results.length,

          failedFiles:
            errors.length,

          partialSuccess:
            errors.length >
            0,

          results,

          errors,
        });


    } catch (
      error
    ) {

      console.error(
        "=== EXTRACTION ROUTE ERROR ==="
      );

      console.error(
        error
          ?.message ||
        error
      );


      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error
              ?.message ||
            "Internal extraction error.",
        });
    }
  }
);


module.exports =
  router;
