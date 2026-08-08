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
  toCsvLine,
  HEADER,
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
   CSV OUTPUT MODES

   NOTE:
   ai_table is intentionally NOT included here because
   validateCsvOutput.js expects the fixed 13-column financial
   schema. AI table detection may return arbitrary columns.
============================================================ */

const CSV_OUTPUT_MODES = new Set([
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


function financialJsonToCsv(rawContent) {
  let parsed;

  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(
      "Financial extraction returned invalid JSON."
    );
  }

  if (
    !parsed ||
    !Array.isArray(parsed.rows)
  ) {
    throw new Error(
      "Financial extraction JSON is missing a rows array."
    );
  }

  const csvRows = parsed.rows.map((item) => {
    const fields = HEADER.map((column) => {
      const value = item?.[column];

      return value == null
        ? ""
        : String(value);
    });

    return toCsvLine(fields);
  });

  return [
    toCsvLine(HEADER),
    ...csvRows,
  ].join("\n");
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
      .slice(0, 7);

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

      status,
    });

  if (error) {
    throw error;
  }
}


/* ============================================================
   POST /extract

   Supports:
   - One file
   - Multiple files
   - Usage-limit middleware
   - Mode-aware prompts
   - Mode-aware validation
   - Partial batch success
   - Usage recording
   - Conversion history recording
============================================================ */

router.post(
  "/",

  upload.array(
    "files",
    MAX_FILES_PER_BATCH
  ),

  checkUsageLimit,

  async (req, res) => {
    try {

      /* ========================================================
         VALIDATE FILES
      ======================================================== */

      if (
        !Array.isArray(req.files) ||
        req.files.length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "No files uploaded.",
          });
      }


      /* ========================================================
         READ FIREBASE UID
      ======================================================== */

      const firebaseUid =
        req.body.firebase_uid;


      if (
        !firebaseUid ||
        firebaseUid
          .trim()
          .length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Missing firebase_uid.",
          });
      }


      /* ========================================================
         READ PROCESSING MODE
      ======================================================== */

      const processingMode =
        req.body.processingMode ||
        DEFAULT_PROCESSING_MODE;


      if (
        !SUPPORTED_PROCESSING_MODES.has(
          processingMode
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,

            error:
              `Unsupported processing mode: ${processingMode}`,
          });
      }


      /* ========================================================
         GET MODE PROMPT
      ======================================================== */

      const prompt =
        getExtractionPrompt(
          processingMode
        );


      /* ========================================================
         PROCESS FILES
      ======================================================== */

      const results = [];
      const errors = [];


      for (
        const file of req.files
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


          /* ====================================================
             MODE-AWARE VALIDATION
          ==================================================== */

          let finalContent =
            rawContent;

          let validation =
            null;
			
			
		  if (
			CSV_OUTPUT_MODES.has(
			 processingMode
			)
		   ) {

		const generatedCsv =
		 financialJsonToCsv(
		  rawContent
		);

		validation =
		 validateCsv(
		   generatedCsv
		 );

		finalContent =
		  validation.cleanedCsv;

   
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
             RECORD COMPLETED HISTORY
          ==================================================== */

          try {

            await recordConversionHistory({
              firebaseUid:
                firebaseUid.trim(),

              inputFileName,

              outputFileName,

              processingMode,

              status:
                "completed",
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
            filename:
              inputFileName,

            outputFileName,

            mimeType:
              file.mimetype,

            processingMode,

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
                  }
                : null,
          });


        } catch (fileError) {

          console.error(
            `Extraction failed for "${inputFileName}":`,
            fileError
          );


          /* ====================================================
             RECORD FAILED HISTORY
          ==================================================== */

          try {

            await recordConversionHistory({
              firebaseUid:
                firebaseUid.trim(),

              inputFileName,

              outputFileName,

              processingMode,

              status:
                "failed",
            });

          } catch (historyError) {

            console.error(
              `Failed to record failed conversion history for "${inputFileName}":`,
              historyError
            );
          }


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
              fileError.message ||
              "Document extraction failed.",
          });
        }
      }


      /* ========================================================
         HANDLE TOTAL FAILURE
      ======================================================== */

      if (
        results.length === 0
      ) {

        return res
          .status(500)
          .json({
            success:
              false,

            processingMode,

            totalFiles:
              req.files.length,

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

         Only successful files count toward usage.
      ======================================================== */

      try {

        await recordSuccessfulUsage(
          firebaseUid.trim(),
          results.length
        );

      } catch (usageError) {

        console.error(
          "Failed to record usage:",
          usageError
        );

        /*
         * Do not destroy an otherwise successful extraction
         * because usage bookkeeping failed.
         */
      }


      /* ========================================================
         RETURN BATCH RESPONSE
      ======================================================== */

      return res
        .status(200)
        .json({
          success:
            true,

          processingMode,

          totalFiles:
            req.files.length,

          successfulFiles:
            results.length,

          failedFiles:
            errors.length,

          partialSuccess:
            errors.length > 0,

          results,

          errors,
        });


    } catch (error) {

      console.error(
        "Extraction route error:",
        error
      );


      return res
        .status(500)
        .json({
          success:
            false,

          error:
            error.message ||
            "Internal extraction error.",
        });
    }
  }
);


module.exports =
  router;