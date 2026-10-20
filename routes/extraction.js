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

const archiver = require("archiver");

const { getAuth } = require("firebase-admin/auth");


/* ============================================================
   FIREBASE AUTHENTICATION MIDDLEWARE
============================================================ */

async function requireFirebaseAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Authentication required."
      });
    }

    const idToken = authHeader.substring(7).trim();

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: "Missing authentication token."
      });
    }

    const decodedToken = await getAuth().verifyIdToken(idToken, true);

    if (!decodedToken.email_verified) {
      return res.status(403).json({
        success: false,
        error: "Please verify your email before continuing."
      });
    }

    req.firebaseUser = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified
    };

    next();

  } catch (error) {
    console.error(
      "Firebase authentication error:",
      error.code || error.message
    );

    return res.status(401).json({
      success: false,
      error: "Invalid or expired authentication token."
    });
  }
}


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
============================================================ */

const FINANCIAL_OUTPUT_MODES =
  new Set([
    "pdf_csv",
    "pdf_excel",
    "pdf_sheets",
    "ai_bank",
    "ai_medical",
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
    case "ai_bank":
    case "ai_medical":
    case "pdf_csv":
    default:
      return "csv";
  }
}


/* ============================================================
   BUILD FALLBACK OUTPUT FILE NAME
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
   BUILD FRIENDLY OUTPUT FILE NAME
============================================================ */

function buildFriendlyOutputFileName(
  documentType,
  processingMode,
  index
) {
  const normalized =
    String(
      documentType || ""
    )
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");

  let baseName =
    "extracted_data";

  if (
    normalized.includes("bank") &&
    normalized.includes("statement")
  ) {
    baseName =
      "bank_statement";

  } else if (
    normalized.includes("credit") &&
    normalized.includes("card")
  ) {
    baseName =
      "credit_card_statement";

  } else if (
    normalized.includes("invoice")
  ) {
    baseName =
      "invoice";

  } else if (
    normalized.includes("receipt")
  ) {
    baseName =
      "receipt";

  } else if (
    normalized.includes("eob") ||
    normalized.includes(
      "explanation_of_benefits"
    )
  ) {
    baseName =
      "medical_eob";

  } else if (
    normalized.includes("medical_bill")
  ) {
    baseName =
      "medical_bill";

  } else if (
    normalized.includes("medical")
  ) {
    baseName =
      "medical_document";

  } else if (
    normalized.includes("contract")
  ) {
    baseName =
      "contract";

  } else if (
    normalized.includes("resume") ||
    normalized.includes("cv")
  ) {
    baseName =
      "resume";

  } else if (
    normalized.includes("table")
  ) {
    baseName =
      "table_extraction";

  } else if (
    normalized &&
    normalized !== "unknown"
  ) {
    baseName =
      normalized.replace(
        /[^a-z0-9_]+/g,
        "_"
      );
  }

  const extension =
    getOutputExtension(
      processingMode
    );

  const suffix =
    index > 0
      ? `_${index + 1}`
      : "";

  return `${baseName}${suffix}.${extension}`;
}


/* ============================================================
   CLEAN JSON RESPONSE
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


  /* ==========================================================
     DOCUMENT TYPE DIAGNOSTICS
  ========================================================== */

  console.log(
    "RAW parsed.documentType:",
    parsed.documentType
  );

  console.log(
    "RAW parsed top-level keys:",
    Object.keys(
      parsed
    )
  );


  const documentType =
    normalizeDocumentType(
      parsed.documentType
    );


  console.log(
    "NORMALIZED documentType:",
    documentType
  );


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

  // Reject headers-only or entirely empty extracted rows.
  const meaningfulRows = extraction.rows.filter((row) =>
    row && typeof row === "object" && !Array.isArray(row) &&
    Object.values(row).some((value) =>
      value !== null && value !== undefined &&
      String(value).trim().length > 0
    )
  );

  if (meaningfulRows.length === 0) {
    throw new Error(
      "No extractable data rows were found in this document."
    );
  }

  const csv =
    structuredRowsToCsv(
      meaningfulRows,
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
  documentType,
  status,
  content,
}) {
  const {
    data,
    error,
  } = await supabase
    .from("conversion_history")
    .insert({
      firebase_uid:
        firebaseUid,

      timestamp:
        new Date().toISOString(),

      input_file_name:
        inputFileName,

      output_file_name:
        outputFileName,

      processing_mode:
        processingMode,

      document_type:
        documentType || "",

      status:
        status,

      content:
        content || "",
    })
    .select("id")
    .single();


  if (error) {
    console.error(
      "Conversion history insert error:",
      error
    );

    throw error;
  }


  console.log(
    "Conversion history saved:",
    {
      id:
        data?.id || null,

      inputFileName,

      outputFileName,

      processingMode,

      documentType,

      status,

      contentLength:
        String(
          content || ""
        ).length,
    }
  );


  return (
    data?.id?.toString() ??
    null
  );
}
/* ============================================================
   POST /extract
   MAIN DOCUMENT EXTRACTION ROUTE
============================================================ */

router.post(
  "/",

  requireFirebaseAuth,

  /* ============================================================
     REQUEST LOGGING
  ============================================================ */

  (req, res, next) => {

    console.log(
      "========================================"
    );

    console.log(
      "=== EXTRACTION ROUTE HIT ==="
    );

    console.log(
      "Time:",
      new Date().toISOString()
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
      req.headers["content-type"] || "unknown"
    );

    next();
  },


  /* ============================================================
     MULTER FILE UPLOAD
  ============================================================ */

  upload.array(
    "files",
    MAX_FILES_PER_BATCH
  ),


  /* ============================================================
     UPLOAD DIAGNOSTICS
  ============================================================ */

  (req, res, next) => {

    console.log(
      "=== MULTER FINISHED ==="
    );

    console.log(
      "Files after multer:",
      Array.isArray(req.files)
        ? req.files.length
        : 0
    );

    console.log(
      "Body keys:",
      Object.keys(req.body || {})
    );

    if (Array.isArray(req.files)) {

      console.log(
        "Parsed filenames:",
        req.files.map(
          (file) => file.originalname
        )
      );

    }

    next();
  },


  /* ============================================================
     USAGE LIMIT DIAGNOSTICS
  ============================================================ */

  (req, res, next) => {

    console.log(
      "=== ABOUT TO CHECK USAGE LIMIT ==="
    );

    console.log(
      "firebase_uid present:",
      Boolean(req.body?.firebase_uid)
    );

    console.log(
      "processingMode present:",
      Boolean(req.body?.processingMode)
    );

    next();
  },


  /* ============================================================
     CHECK SUBSCRIPTION USAGE LIMIT
  ============================================================ */

  checkUsageLimit,


  (req, res, next) => {

    console.log(
      "=== USAGE LIMIT PASSED ==="
    );

    next();
  },


  /* ============================================================
     MAIN EXTRACTION HANDLER
  ============================================================ */

  async (req, res) => {

    try {

      console.log(
        "=== UPLOAD PARSED ==="
      );

      console.log(
        "Processing mode received:",
        req.body?.processingMode ||
        "(not supplied)"
      );

      console.log(
        "Firebase UID supplied:",
        Boolean(req.body?.firebase_uid)
      );

      console.log(
        "Files received:",
        Array.isArray(req.files)
          ? req.files.length
          : 0
      );


      /* ========================================================
         VALIDATE UPLOADED FILES
      ======================================================== */

      if (
        !Array.isArray(req.files) ||
        req.files.length === 0
      ) {

        console.warn(
          "Extraction stopped: no uploaded files."
        );

        return res.status(400).json({
          success: false,
          error: "No files uploaded."
        });

      }


      /* ========================================================
         VALIDATE FIREBASE USER
      ======================================================== */

      const firebaseUid =
        req.firebaseUser.uid;

      const suppliedUid =
        String(
          req.body?.firebase_uid || ""
        ).trim();

      if (
        suppliedUid &&
        suppliedUid !== firebaseUid
      ) {

        return res.status(403).json({
          success: false,
          error:
            "The supplied user ID does not match the authenticated user."
        });

      }


      /* ========================================================
         PROCESSING MODE
      ======================================================== */

      const processingMode =
        req.body?.processingMode ||
        DEFAULT_PROCESSING_MODE;

      console.log(
        "Resolved processing mode:",
        processingMode
      );

      if (
        !SUPPORTED_PROCESSING_MODES.has(
          processingMode
        )
      ) {

        console.warn(
          "Unsupported processing mode:",
          processingMode
        );

        return res.status(400).json({
          success: false,
          error:
            `Unsupported processing mode: ${processingMode}`
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
        let fileIndex = 0;
        fileIndex < req.files.length;
        fileIndex++
      ) {

        const file =
          req.files[fileIndex];

        const inputFileName =
          file.originalname ||
          "document.pdf";

        let outputFileName =
          buildOutputFileName(
            inputFileName,
            processingMode
          );

        // Declared outside the try block so that
        // failed-history handling can access it.

        let documentType = null;

        let schemaHeader = null;

        let validation = null;


        /* ====================================================
           INDIVIDUAL FILE PROCESSING
        ==================================================== */

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
            file.mimetype || "unknown"
          );

          console.log(
            "Input size:",
            file.size ||
            file.buffer?.length ||
            0
          );


          /* ====================================================
             VALIDATE FILE CONTENT
          ==================================================== */

          if (
            !file.buffer ||
            file.buffer.length === 0
          ) {

            throw new Error(
              "Uploaded file is empty."
            );

          }


          /* ====================================================
             OPENAI EXTRACTION
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
              rawContent || ""
            ).length
          );


          /* ====================================================
             INITIALIZE OUTPUT
          ==================================================== */

          let finalContent =
            rawContent;


          /* ====================================================
             ADAPTIVE FINANCIAL PROCESSING
          ==================================================== */

          if (
            FINANCIAL_OUTPUT_MODES.has(
              processingMode
            )
          ) {

            console.log(
              "=== PARSING ADAPTIVE FINANCIAL JSON ==="
            );


            /* ==================================================
               CONVERT STRUCTURED JSON TO CSV
            ================================================== */

            const adaptiveOutput =
              financialJsonToCsv(
                rawContent
              );


            documentType =
              adaptiveOutput.documentType;

            schemaHeader =
              adaptiveOutput.schema.header;


            console.log(
              "Document classified as:",
              documentType
            );

            console.log(
              "Schema column count:",
              schemaHeader.length
            );


            /* ==================================================
               BUILD OUTPUT FILENAME
            ================================================== */

            outputFileName =
              buildFriendlyOutputFileName(
                documentType,
                processingMode,
                fileIndex
              );


            console.log(
              "Detected document type:",
              documentType
            );

            console.log(
              "Friendly output filename:",
              outputFileName
            );


            /* ==================================================
               VALIDATE ADAPTIVE CSV
            ================================================== */

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
              Array.isArray(
                validation.errors
              )
                ? validation.errors.length
                : 0
            );


            console.log(
              "CSV validated rows:",
              Array.isArray(
                validation.rows
              )
                ? validation.rows.length
                : 0
            );


            console.log(
              "Cleaned CSV length:",
              String(
                validation.cleanedCsv || ""
              ).length
            );


            /* ==================================================
               VALIDATION FAILURE
            ================================================== */

            if (!validation.valid) {

              console.error(
                `CSV validation failed for "${inputFileName}":`,
                validation.errors
              );

              throw new Error(
                `CSV validation failed: ${
                  Array.isArray(
                    validation.errors
                  )
                    ? validation.errors.join("; ")
                    : "Invalid extraction result."
                }`
              );

            }


            /* ==================================================
               REJECT CSV WITHOUT DATA ROWS
            ================================================== */

            if (
              !Array.isArray(validation.rows) ||
              validation.rows.length === 0
            ) {

              throw new Error(
                "Extraction produced no CSV data rows."
              );

            }


            /* ==================================================
               SET VALIDATED CONTENT
            ================================================== */

            finalContent =
              validation.cleanedCsv;


          } // END ADAPTIVE FINANCIAL PROCESSING


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
              finalContent || ""
            ).length
          );


          if (
            !finalContent ||
            String(finalContent)
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

          let historyId = null;

          try {

            historyId =
              await recordConversionHistory({

                firebaseUid,

                inputFileName,

                outputFileName,

                processingMode,

                documentType,

                status:
                  "completed",

                content:
                  finalContent,

              });


          } catch (historyError) {

            console.error(
              `Failed to record conversion history for "${inputFileName}":`,
              historyError
            );

          }


          /* ====================================================
             SUCCESS RESULT
          ==================================================== */

          results.push({

            id:
              historyId,

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
                      validation.valid,

                    errors:
                      validation.errors,

                    flaggedRows:
                      validation.flaggedRows,

                    expectedColumns:
                      validation.expectedColumns,

                    documentType:
                      validation.documentType,

                    header:
                      validation.header,

                  }
                : null,

          });


          console.log(
            `=== FILE COMPLETED: ${inputFileName} ===`
          );


        } catch (fileError) {


          /* ====================================================
             FILE EXTRACTION ERROR HANDLER
          ==================================================== */

          console.error(
            `Extraction failed for "${inputFileName}":`,
            fileError?.message || fileError
          );


          /* ====================================================
             RECORD FAILED HISTORY
          ==================================================== */

          let failedHistoryId = null;

          try {

            failedHistoryId =
              await recordConversionHistory({

                firebaseUid,

                inputFileName,

                outputFileName,

                processingMode,

                documentType,

                status:
                  "failed",

                content:
                  "",

              });


          } catch (historyError) {

            console.error(
              `Failed to record failed conversion history for "${inputFileName}":`,
              historyError
            );

          }


          /* ====================================================
             FAILED RESULT
          ==================================================== */

          errors.push({

            id:
              failedHistoryId,

            filename:
              inputFileName,

            outputFileName,

            processingMode,

            documentType,

            success:
              false,

            status:
              "failed",

            error:
              fileError?.message ||
              "Document extraction failed.",

          });


        } // END INDIVIDUAL FILE TRY/CATCH


      } // END FILE PROCESSING LOOP


      /* ========================================================
         RECORD SUCCESSFUL USAGE
      ======================================================== */

      try {

        await recordSuccessfulUsage(
          firebaseUid,
          results.length
        );

      } catch (usageError) {

        console.error(
          "Failed to record usage:",
          usageError
        );

      }


      /* ========================================================
         RESPONSE DIAGNOSTICS
      ======================================================== */

      console.log(
        "=== EXTRACTION RESPONSE READY ==="
      );


      console.log(
        "Total files:",
        req.files.length
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
              result.outputFileName,

            documentType:
              result.documentType,

            columns:
              Array.isArray(
                result.schemaHeader
              )
                ? result.schemaHeader.length
                : null,

            contentLength:
              String(
                result.content || ""
              ).length,

          })
        )
      );


      console.log(
        "========================================"
      );


      /* ========================================================
         FINAL API RESPONSE
      ======================================================== */

      return res.status(200).json({

        success:
          results.length > 0,

        processingMode,

        totalFiles:
          req.files.length,

        successfulFiles:
          results.length,

        failedFiles:
          errors.length,

        partialSuccess:
          results.length > 0 &&
          errors.length > 0,

        results,

        errors,

      });


    } catch (error) {


      /* ========================================================
         MAIN EXTRACTION ROUTE ERROR
      ======================================================== */

      console.error(
        "Extraction route error:",
        error
      );


      return res.status(500).json({

        success:
          false,

        error:
          error?.message ||
          "Document extraction failed.",

      });


    } // END MAIN TRY/CATCH


  } // END MAIN EXTRACTION HANDLER


); // END POST /extract ROUTE

/* ============================================================
   POST /extract/download-all-zip
   DOWNLOAD MULTIPLE EXTRACTED FILES
============================================================ */

router.post(
  "/download-all-zip",

  requireFirebaseAuth,

  express.json({
    limit: "50mb",
  }),

  async (req, res) => {

    try {

      console.log(
        "========================================"
      );

      console.log(
        "=== DOWNLOAD ALL ZIP ROUTE HIT ==="
      );


      /* ======================================================
         READ RESULTS FROM FLUTTERFLOW
      ====================================================== */

      const files =
        req.body?.results;


      console.log(
        "ZIP files received:",
        Array.isArray(files)
          ? files.length
          : 0
      );


      /* ======================================================
         VALIDATE FILES
      ====================================================== */

      if (
        !Array.isArray(files) ||
        files.length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "No files supplied for ZIP download.",

        });

      }


      /* ======================================================
         KEEP ONLY SUCCESSFUL FILES WITH CONTENT
      ====================================================== */

      const validFiles =
        files.filter(
          (file) =>

            file &&

            file.success !== false &&

            file.status !== "failed" &&

            typeof file.content === "string" &&

            file.content.trim().length > 0

        );


      if (
        validFiles.length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "No valid extracted files supplied for ZIP download.",

        });

      }


      console.log(
        "Valid ZIP files:",
        validFiles.length
      );


      /* ======================================================
         ZIP RESPONSE HEADERS
      ====================================================== */

      const zipFileName =
        `dataextract_${Date.now()}.zip`;


      res.setHeader(
        "Content-Type",
        "application/zip"
      );


      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${zipFileName}"`
      );


      /* ======================================================
         CREATE ZIP ARCHIVE
      ====================================================== */

      const archive =
        archiver(
          "zip",
          {
            zlib: {
              level: 9,
            },
          }
        );


      archive.on(
        "warning",
        (warning) => {

          console.warn(
            "ZIP warning:",
            warning
          );

        }
      );


      archive.on(
        "error",
        (error) => {

          console.error(
            "ZIP archive error:",
            error
          );


          if (
            !res.headersSent
          ) {

            res.status(500).json({

              success: false,

              error:
                "Unable to create ZIP file.",

            });

          } else {

            res.destroy(error);

          }

        }
      );


      archive.pipe(res);


      /* ======================================================
         ADD FILES TO ZIP
      ====================================================== */

      validFiles.forEach(
        (file, index) => {

          const filename =
            String(
              file.outputFileName ||
              file.filename ||
              `extracted_file_${index + 1}.csv`
            ).replace(
              /[\/\\]/g,
              "_"
            );


          console.log(
            "Adding to ZIP:",
            filename
          );


          archive.append(
            file.content,
            {
              name: filename,
            }
          );

        }
      );


      /* ======================================================
         FINALIZE ZIP
      ====================================================== */

      await archive.finalize();


      console.log(
        "=== ZIP FINALIZED ==="
      );


      console.log(
        "========================================"
      );


    } catch (error) {

      console.error(
        "Download All ZIP route error:",
        error
      );


      if (
        !res.headersSent
      ) {

        return res.status(500).json({

          success: false,

          error:
            error?.message ||
            "Unable to create ZIP download.",

        });

      }


      res.end();

    }

  }
);


/* ============================================================
   GET /extract/conversion-history
   LOAD USER EXTRACTION HISTORY
============================================================ */

router.get(
  "/conversion-history",

  requireFirebaseAuth,

  async (req, res) => {

    try {

      const firebaseUid =
        req.firebaseUser.uid;


      /* ========================================================
         LOAD USER'S CONVERSION HISTORY
      ======================================================== */

      const {
        data,
        error,
      } = await supabase
        .from("conversion_history")
        .select(
          "id, firebase_uid, timestamp, input_file_name, output_file_name, processing_mode, document_type, status, is_favorite, content"
        )
        .eq(
          "firebase_uid",
          firebaseUid
        )
        .order(
          "timestamp",
          {
            ascending: false,
          }
        )
        .limit(50);


      if (error) {

        console.error(
          "Conversion history query error:",
          error
        );


        return res.status(500).json({

          success: false,

          error:
            "Unable to load conversion history.",

        });

      }


      /* ========================================================
         SUCCESS RESPONSE
      ======================================================== */

      return res.status(200).json({

        success: true,

        count:
          data?.length || 0,

        history:
          data || [],

      });


    } catch (error) {

      console.error(
        "Conversion history route error:",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Unable to load conversion history.",

      });

    }

  }
);


/* ============================================================
   PATCH /extract/conversion-history/:id/favorite
   UPDATE FAVORITE STATUS
============================================================ */

router.patch(
  "/conversion-history/:id/favorite",

  requireFirebaseAuth,

  async (req, res) => {

    try {

      const recordId =
        req.params.id;

      const firebaseUid =
        req.firebaseUser.uid;

      const isFavorite =
        req.body?.is_favorite;


      /* ========================================================
         VALIDATE RECORD ID
      ======================================================== */

      if (
        !recordId ||
        String(recordId).trim().length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Missing conversion history record id.",

        });

      }


      /* ========================================================
         VALIDATE FAVORITE VALUE
      ======================================================== */

      if (
        typeof isFavorite !== "boolean"
      ) {

        return res.status(400).json({

          success: false,

          error:
            "is_favorite must be a boolean.",

        });

      }


      /* ========================================================
         UPDATE ONLY AUTHENTICATED USER'S RECORD
      ======================================================== */

      const {
        data,
        error,
      } = await supabase
        .from("conversion_history")
        .update({

          is_favorite:
            isFavorite,

        })
        .eq(
          "id",
          String(recordId).trim()
        )
        .eq(
          "firebase_uid",
          firebaseUid
        )
        .select(
          "id, firebase_uid, timestamp, input_file_name, output_file_name, processing_mode, document_type, status, is_favorite, content"
        );


      if (error) {

        console.error(
          "Favorite update error:",
          error
        );


        return res.status(500).json({

          success: false,

          error:
            "Unable to update favorite status.",

        });

      }


      /* ========================================================
         RECORD NOT FOUND
      ======================================================== */

      if (
        !Array.isArray(data) ||
        data.length === 0
      ) {

        return res.status(404).json({

          success: false,

          error:
            "Conversion history record not found or does not belong to this user.",

        });

      }


      console.log(
        "Favorite status updated:",
        {
          recordId:
            String(recordId).trim(),

          firebaseUid,

          isFavorite,
        }
      );


      /* ========================================================
         SUCCESS RESPONSE
      ======================================================== */

      return res.status(200).json({

        success: true,

        record:
          data[0],

      });


    } catch (error) {

      console.error(
        "Favorite update route error:",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Unable to update favorite status.",

      });

    }

  }
);


/* ============================================================
   DELETE /extract/conversion-history/:id
   DELETE INDIVIDUAL HISTORY RECORD
============================================================ */

router.delete(
  "/conversion-history/:id",

  requireFirebaseAuth,

  async (req, res) => {

    try {

      const recordId =
        req.params.id;

      const firebaseUid =
        req.firebaseUser.uid;


      /* ========================================================
         VALIDATE RECORD ID
      ======================================================== */

      if (
        !recordId ||
        String(recordId).trim().length === 0
      ) {

        return res.status(400).json({

          success: false,

          error:
            "Missing conversion history record id.",

        });

      }


      /* ========================================================
         DELETE ONLY AUTHENTICATED USER'S RECORD
      ======================================================== */

      const {
        data,
        error,
      } = await supabase
        .from("conversion_history")
        .delete()
        .eq(
          "id",
          String(recordId).trim()
        )
        .eq(
          "firebase_uid",
          firebaseUid
        )
        .select("id");


      if (error) {

        console.error(
          "Conversion history delete error:",
          error
        );


        return res.status(500).json({

          success: false,

          error:
            "Unable to delete conversion history.",

        });

      }


      /* ========================================================
         RECORD NOT FOUND
      ======================================================== */

      if (
        !Array.isArray(data) ||
        data.length === 0
      ) {

        return res.status(404).json({

          success: false,

          error:
            "Conversion history record not found or does not belong to this user.",

        });

      }


      console.log(
        "Conversion history deleted:",
        recordId
      );


      /* ========================================================
         SUCCESS RESPONSE
      ======================================================== */

      return res.status(200).json({

        success: true,

        deletedId:
          data[0].id,

      });


    } catch (error) {

      console.error(
        "Conversion history delete route error:",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Unable to delete conversion history.",

      });

    }

  }
);


/* ============================================================
   DELETE DATAEXTRACT ACCOUNT DATA
   DELETE /extract/delete
============================================================ */

router.delete(
  "/delete",

  requireFirebaseAuth,

  async (req, res) => {

    try {

      const firebaseUid =
        req.firebaseUser.uid;


      console.log(
        "=== DATAEXTRACT ACCOUNT DELETE REQUEST ==="
      );


      /* ========================================================
         DELETE CONVERSION HISTORY
      ======================================================== */

      const {
        error: historyError,
      } = await supabase
        .from("conversion_history")
        .delete()
        .eq(
          "firebase_uid",
          firebaseUid
        );


      if (historyError) {

        console.error(
          "Account delete - conversion_history error:",
          historyError
        );


        return res.status(500).json({

          success: false,

          error:
            "Unable to delete conversion history.",

        });

      }


      /* ========================================================
         DELETE USAGE
      ======================================================== */

      const {
        error: usageError,
      } = await supabase
        .from("usage")
        .delete()
        .eq(
          "firebase_uid",
          firebaseUid
        );


      if (usageError) {

        console.error(
          "Account delete - usage error:",
          usageError
        );


        return res.status(500).json({

          success: false,

          error:
            "Unable to delete usage data.",

        });

      }


      /* ========================================================
         DELETE FEEDBACK
      ======================================================== */

      const {
        error: feedbackError,
      } = await supabase
        .from("feedback")
        .delete()
        .eq(
          "firebase_uid",
          firebaseUid
        );


      if (feedbackError) {

        console.error(
          "Account delete - feedback error:",
          feedbackError
        );


        return res.status(500).json({

          success: false,

          error:
            "Unable to delete feedback data.",

        });

      }


      /* ========================================================
         DELETE SUBSCRIPTION RECORD
      ======================================================== */

      const {
        error: subscriptionError,
      } = await supabase
        .from("subscriptions")
        .delete()
        .eq(
          "firebase_uid",
          firebaseUid
        );


      if (subscriptionError) {

        console.error(
          "Account delete - subscriptions error:",
          subscriptionError
        );


        return res.status(500).json({

          success: false,

          error:
            "Unable to delete subscription data.",

        });

      }


      /* ========================================================
         SUCCESS RESPONSE
      ======================================================== */

      console.log(
        "DataExtract account data deleted successfully."
      );


      return res.status(200).json({

        success: true,

        message:
          "DataExtract account data deleted successfully.",

      });


    } catch (error) {

      console.error(
        "Account delete route error:",
        error
      );


      return res.status(500).json({

        success: false,

        error:
          error?.message ||
          "Unable to delete account data.",

      });

    }

  }
);


/* ============================================================
   EXPORT ROUTER
============================================================ */

module.exports = router;
