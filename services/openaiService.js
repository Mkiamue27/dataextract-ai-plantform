const { OpenAI } = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Process one uploaded document with OpenAI.
 *
 * IMPORTANT:
 * - This service handles ONE file at a time.
 * - Batch / multiple-file processing is handled in routes/extraction.js.
 *
 * @param {Object} options
 * @param {Buffer} options.fileBuffer
 * @param {string} options.filename
 * @param {string} options.mimeType
 * @param {string} options.processingMode
 * @param {string} options.prompt
 *
 * @returns {Promise<string>}
 */
async function extractDocument({
  fileBuffer,
  filename = "document.pdf",
  mimeType = "application/pdf",
  processingMode = "pdf_csv",
  prompt,
}) {
  /* ============================================================
     VALIDATION
  ============================================================ */

  if (!fileBuffer || !Buffer.isBuffer(fileBuffer)) {
    throw new Error("A valid document buffer is required.");
  }

  if (!prompt || typeof prompt !== "string") {
    throw new Error("A valid extraction prompt is required.");
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  /* ============================================================
     PREPARE FILE
  ============================================================ */

  const base64File = fileBuffer.toString("base64");

  /**
   * Normalize MIME type.
   * FlutterFlow sometimes uploads files as application/octet-stream.
   * OpenAI requires the real MIME type.
   */
  let normalizedMimeType = mimeType;

  if (
    !normalizedMimeType ||
    normalizedMimeType === "application/octet-stream"
  ) {
    const lowerFilename = (filename || "").toLowerCase();

    if (lowerFilename.endsWith(".pdf")) {
      normalizedMimeType = "application/pdf";
    } else if (lowerFilename.endsWith(".csv")) {
      normalizedMimeType = "text/csv";
    } else if (lowerFilename.endsWith(".json")) {
      normalizedMimeType = "application/json";
    } else if (lowerFilename.endsWith(".xlsx")) {
      normalizedMimeType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (lowerFilename.endsWith(".xls")) {
      normalizedMimeType =
        "application/vnd.ms-excel";
    } else {
      // Default to PDF since this endpoint currently processes PDFs.
      normalizedMimeType = "application/pdf";
    }
  }

  const instructions = `
${prompt}

Additional Processing Instructions:

Processing Mode: ${processingMode}
Original Filename: ${filename}
MIME Type: ${normalizedMimeType}

Follow the requested processing mode while preserving the
document's original data accurately.

Do not invent values that are not supported by the document.
`;

  try {

  console.log("========== OpenAI Upload ==========");
  console.log("Filename:", filename);
  console.log("Original MIME:", mimeType);
  console.log("Normalized MIME:", normalizedMimeType);
  console.log("==================================");
  
    /* ============================================================
       OPENAI REQUEST
    ============================================================ */

    const response = await openai.responses.create({
      model: "gpt-4.1",

      input: [
        {
          role: "user",

          content: [
            {
              type: "input_text",
              text: instructions,
            },

            {
              type: "input_file",
              filename: filename,
              file_data: `data:${normalizedMimeType};base64,${base64File}`,
            },
          ],
        },
      ],
    });

    /* ============================================================
       RESPONSE VALIDATION
    ============================================================ */

    const content = response?.output_text;

    if (!content || !content.trim()) {
      throw new Error(
        `OpenAI returned an empty response for "${filename}".`
      );
    }

    return content.trim();
  } catch (error) {
    console.error(
      `OpenAI extraction failed for "${filename}":`,
      error?.message || error
    );

    throw error;
  }
}

module.exports = {
  extractDocument,
};