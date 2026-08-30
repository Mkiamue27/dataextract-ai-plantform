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
   BUILD FALLBACK OUTPUT FILE NAME

   Used before document classification is available and for
   modes where no document type is detected.
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

   Converts detected document types into readable filenames.

   Examples:
   bank_statement.csv
   medical_eob.csv
   invoice.csv
   receipt.csv

   The batch index guarantees that files remain unique.
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
    /*
     * If normalizeDocumentType returns another legitimate
     * document type, preserve it instead of throwing it away.
     */
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

  /*
   * index is zero-based.
   *
   * First file:
   * bank_statement.csv
   *
   * Additional files:
   * bank_statement_2.csv
   * bank_statement_3.csv
   */
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
        let fileIndex = 0;
        fileIndex < req.files.length;
        fileIndex++
      ) {

        const file =
          req.files[fileIndex];

        const inputFileName =
          file.originalname ||
          "document.pdf";


        /*
         * Initial fallback filename.
         *
         * Once OpenAI determines the document type,
         * this may be replaced with a friendly filename.
         */
        let outputFileName =
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


            /* ==================================================
               FRIENDLY OUTPUT FILENAME

               IMPORTANT:
               documentType is now available, so this is the
               correct point to rename the generated output.
            ================================================== */

            outputFileName =
              buildFriendlyOutputFileName(
                documentType,
                processingMode,
                fileIndex
              );


            console.log(
              "Friendly output filename:",
              outputFileName
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


/* ============================================================
   POST /extract/download-all-zip
============================================================ */

router.post(
  "/download-all-zip",

  async (req, res) => {
    try {
      const { results } =
        req.body || {};

      if (
        !Array.isArray(results) ||
        results.length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "No extraction results were provided.",
          });
      }


      const successfulResults =
        results.filter(
          (item) => {
            return (
              item &&
              item.success === true &&
              typeof item.content ===
                "string" &&
              item.content
                .trim()
                .length > 0
            );
          }
        );


      if (
        successfulResults.length ===
        0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "No successful files are available for ZIP download.",
          });
      }


      const zipFileName =
        `DataExtractAI_Results_${Date.now()}.zip`;


      res.setHeader(
        "Content-Type",
        "application/zip"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${zipFileName}"`
      );


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
        (error) => {
          console.warn(
            "ZIP warning:",
            error
          );
        }
      );


      archive.on(
        "error",
        (error) => {
          console.error(
            "ZIP creation error:",
            error
          );

          if (
            !res.headersSent
          ) {
            return res
              .status(500)
              .json({
                success:
                  false,

                error:
                  "Unable to create ZIP file.",
              });
          }

          res.destroy(
            error
          );
        }
      );


      archive.pipe(
        res
      );


      const usedNames =
        new Set();


      for (
        let index = 0;
        index <
          successfulResults.length;
        index++
      ) {

        const item =
          successfulResults[index];


        let outputFileName =
          typeof item.outputFileName ===
            "string" &&
          item.outputFileName
            .trim()
            .length > 0
            ? item.outputFileName
                .trim()
            : `extraction_${index + 1}.csv`;


        outputFileName =
          outputFileName.replace(
            /[\\/:*?"<>|]/g,
            "_"
          );


        let uniqueFileName =
          outputFileName;


        if (
          usedNames.has(
            uniqueFileName
          )
        ) {

          const dotIndex =
            uniqueFileName
              .lastIndexOf(".");


          if (
            dotIndex > 0
          ) {

            const base =
              uniqueFileName
                .substring(
                  0,
                  dotIndex
                );

            const extension =
              uniqueFileName
                .substring(
                  dotIndex
                );

            uniqueFileName =
              `${base}_${index + 1}${extension}`;

          } else {

            uniqueFileName =
              `${uniqueFileName}_${index + 1}`;
          }
        }


        usedNames.add(
          uniqueFileName
        );


        archive.append(
          item.content,
          {
            name:
              uniqueFileName,
          }
        );
      }


      console.log(
        `ZIP download prepared with ${successfulResults.length} file(s).`
      );


      await archive.finalize();

    } catch (
      error
    ) {

      console.error(
        "Download-all ZIP error:",
        error
      );


      if (
        !res.headersSent
      ) {

        return res
          .status(500)
          .json({
            success:
              false,

            error:
              error
                ?.message ||
              "Unable to create ZIP file.",
          });
      }


      res.end();
    }
  }
);

/* ============================================================
   GET /extract/conversion-history
============================================================ */

router.get(
  "/conversion-history",

  async (req, res) => {
    try {
      const firebaseUid =
        req.query.firebase_uid;

      if (
        !firebaseUid ||
        String(firebaseUid).trim().length === 0
      ) {
        return res.status(400).json({
          success: false,
          error: "Missing firebase_uid.",
        });
      }

      const {
        data,
        error,
      } = await supabase
        .from("conversion_history")
        .select(
          "id, firebase_uid, timestamp, input_file_name, output_file_name, processing_mode, status"
        )
        .eq(
          "firebase_uid",
          String(firebaseUid).trim()
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

      return res.status(200).json({
        success: true,
        count: data?.length || 0,
        history: data || [],
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
   DELETE /extract/conversion-history/:id
============================================================ */

router.delete(
  "/conversion-history/:id",

  async (req, res) => {
    try {
      const recordId =
        req.params.id;

      const firebaseUid =
        req.query.firebase_uid;

      /* ========================================================
         VALIDATE REQUEST
      ======================================================== */

      if (
        !recordId ||
        String(recordId).trim().length === 0
      ) {
        return res.status(400).json({
          success: false,
          error: "Missing conversion history record id.",
        });
      }

      if (
        !firebaseUid ||
        String(firebaseUid).trim().length === 0
      ) {
        return res.status(400).json({
          success: false,
          error: "Missing firebase_uid.",
        });
      }

      /* ========================================================
         DELETE ONLY THIS USER'S RECORD
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
          String(firebaseUid).trim()
        )
        .select("id");

      if (error) {
        console.error(
          "Conversion history delete error:",
          error
        );

        return res.status(500).json({
          success: false,
          error: "Unable to delete conversion history.",
        });
      }

      /* ========================================================
         RECORD NOT FOUND / DOES NOT BELONG TO USER
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
         SUCCESS
      ======================================================== */

      return res.status(200).json({
        success: true,
        deletedId: recordId,
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

module.exports =
  router;
