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

  if (
    !fileBuffer ||
    !Buffer.isBuffer(fileBuffer)
  ) {
    throw new Error(
      "A valid document buffer is required."
    );
  }


  if (
    !prompt ||
    typeof prompt !== "string"
  ) {
    throw new Error(
      "A valid extraction prompt is required."
    );
  }


  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not configured."
    );
  }


  /* ============================================================
     PREPARE FILE
  ============================================================ */

  const base64File =
    fileBuffer.toString("base64");


  const instructions = `
${prompt}

Additional Processing Instructions:

Processing Mode: ${processingMode}
Original Filename: ${filename}
MIME Type: ${mimeType}

Follow the requested processing mode while preserving the
document's original data accurately.

Do not invent values that are not supported by the document.
`;


  try {

    /* ============================================================
       OPENAI REQUEST
    ============================================================ */

    const response =
      await openai.responses.create({

        model: "gpt-4.1",

        input: [
          {
            role: "user",

            content: [
              {
                type: "input_text",

                text:
                  instructions,
              },

              {
                type: "input_file",

                filename:
                  filename,

                file_data:
                  `data:${mimeType};base64,${base64File}`,
              },
            ],
          },
        ],
      });


    /* ============================================================
       RESPONSE VALIDATION
    ============================================================ */

    const content =
      response?.output_text;


    if (
      !content ||
      !content.trim()
    ) {
      throw new Error(
        `OpenAI returned an empty response for "${filename}".`
      );
    }


    return content.trim();


  } catch (error) {

    console.error(
      `OpenAI extraction failed for "${filename}":`,
      error?.message ||
      error
    );


    throw error;
  }
}


module.exports = {
  extractDocument,
};