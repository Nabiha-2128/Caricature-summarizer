
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { performance } = require('perf_hooks');

const app = express();
const PORT = process.env.PORT || 5000;

// ========================================
// 1. CONFIGURATION
// ========================================

const MODEL_NAME = 'gemini-2.5-flash';

const INPUT_PRICE_PER_MILLION = 0.30;
const OUTPUT_PRICE_PER_MILLION = 2.50;

const NOT_A_CARICATURE = 'NOT_A_CARICATURE';

const MAX_GEMINI_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp'
];

if (!process.env.GEMINI_API_KEY) {
  console.error('[ERROR] GEMINI_API_KEY is missing from .env');
  process.exit(1);
}

if (!process.env.MORSE_API_KEY) {
  console.error('[ERROR] MORSE_API_KEY is missing from .env');
  process.exit(1);
}

// ========================================
// 2. EXPRESS CONFIGURATION
// ========================================

app.use(cors());
app.use(express.json());

// ========================================
// 3. IMAGE UPLOAD CONFIGURATION
// ========================================

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: 10 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {

    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {

      const error = new Error(
        'Only JPEG, PNG and WEBP images are supported.'
      );

      error.code = 'UNSUPPORTED_FILE_TYPE';

      return cb(error);
    }

    cb(null, true);
  }
});

// ========================================
// 4. VERIFY ACTUAL IMAGE FILE SIGNATURE
// ========================================

function hasValidImageSignature(buffer, mimetype) {

  if (mimetype === 'image/jpeg') {
    return (
      buffer[0] === 0xFF &&
      buffer[1] === 0xD8 &&
      buffer[2] === 0xFF
    );
  }

  if (mimetype === 'image/png') {
    return buffer.subarray(0, 8).equals(
      Buffer.from([
        0x89, 0x50, 0x4E, 0x47,
        0x0D, 0x0A, 0x1A, 0x0A
      ])
    );
  }

  if (mimetype === 'image/webp') {
    return (
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    );
  }

  return false;
}

// ========================================
// 5. INITIALIZE GEMINI
// ========================================

const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY
);

const model = genAI.getGenerativeModel({
  model: MODEL_NAME
});

// ========================================
// 6. INITIALIZE MORSEAI
// ========================================

let morse;

async function initializeMorse() {

  const morseModule = await import('@morsehq-dev/sdk');

  morse = morseModule;

  morse.init({
    apiKey: process.env.MORSE_API_KEY
  });

  console.log('[MORSE] MorseAI initialized successfully');
}

// ========================================
// 7. EXTRACT GEMINI HTTP STATUS
// ========================================

function getHttpStatus(error) {

  if (error.status) {
    return Number(error.status);
  }

  if (error.statusCode) {
    return Number(error.statusCode);
  }

  const message = String(error.message || '');

  const match = message.match(
    /\b(429|500|502|503|504)\b/
  );

  return match ? Number(match[1]) : null;
}

// ========================================
// 8. DETECT DAILY QUOTA EXHAUSTION
// ========================================

function isDailyQuotaExceeded(error) {

  const message = String(
    error.message || ''
  ).toLowerCase();

  return (
    message.includes('generate_content_free_tier_requests') ||

    message.includes(
      'generaterequestsperdayperprojectpermodel-freetier'
    ) ||

    message.includes('requests per day limit exceeded') ||

    message.includes('per day limit exceeded')
  );
}

// ========================================
// 9. DETECT TEMPORARY ERRORS
// ========================================

function isRetryableGeminiError(error) {

  // A daily quota cannot be fixed by a short retry.

  if (isDailyQuotaExceeded(error)) {
    return false;
  }

  const status = getHttpStatus(error);

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

// ========================================
// 10. DELAY FUNCTION
// ========================================

function delay(ms) {

  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// ========================================
// 11. GEMINI REQUEST WITH RETRIES
// ========================================

async function generateContentWithRetry(
  targetModel,
  contents,
  operationName
) {

  let lastError;

  for (
    let attempt = 0;
    attempt <= MAX_GEMINI_RETRIES;
    attempt++
  ) {

    try {

      console.log(
        `[GEMINI] ${operationName}: attempt ${attempt + 1}`
      );

      const result = await targetModel.generateContent(
        contents
      );

      return {
        response: await result.response,
        attempts: attempt + 1
      };

    } catch (error) {

      lastError = error;

      const status = getHttpStatus(error);

      // Stop immediately if daily quota is exhausted.

      if (isDailyQuotaExceeded(error)) {

        console.error(
          '[GEMINI QUOTA] Daily request quota exceeded.'
        );

        console.error(
          '[GEMINI QUOTA] No retry will be attempted.'
        );

        throw error;
      }

      console.error(
        `[GEMINI] ${operationName} failed`,
        {
          attempt: attempt + 1,
          status,
          message: error.message
        }
      );

      if (
        attempt >= MAX_GEMINI_RETRIES ||
        !isRetryableGeminiError(error)
      ) {

        throw error;
      }

      const waitTime =
        RETRY_DELAY_MS * Math.pow(2, attempt);

      console.warn(
        `[GEMINI] Temporary error. Retrying in ${waitTime} ms`
      );

      await delay(waitTime);
    }
  }

  throw lastError;
}

// ========================================
// 12. GEMINI USAGE AND COST TRACKING
// ========================================

function trackGeminiUsage(
  usage,
  operationName = 'Gemini'
) {

  if (!usage) {

    console.warn(
      `[GEMINI USAGE] ${operationName}: Usage metadata unavailable`
    );

    return null;
  }

  const inputTokens =
    usage.promptTokenCount || 0;

  const outputTokens =
    usage.candidatesTokenCount || 0;

  const thinkingTokens =
    usage.thoughtsTokenCount || 0;

  const totalTokens =
    usage.totalTokenCount ||
    (inputTokens + outputTokens + thinkingTokens);

  const billableOutputTokens =
    outputTokens + thinkingTokens;

  const estimatedInputCost =
    (inputTokens / 1000000) *
    INPUT_PRICE_PER_MILLION;

  const estimatedOutputCost =
    (billableOutputTokens / 1000000) *
    OUTPUT_PRICE_PER_MILLION;

  const estimatedTotalCost =
    estimatedInputCost + estimatedOutputCost;

  console.log(
    `\n========== ${operationName.toUpperCase()} USAGE ==========`
  );

  console.log('Model:', MODEL_NAME);
  console.log('Input tokens:', inputTokens);
  console.log('Output tokens:', outputTokens);
  console.log('Thinking tokens:', thinkingTokens);
  console.log('Total tokens:', totalTokens);

  console.log(
    'Estimated cost: $' +
    estimatedTotalCost.toFixed(8)
  );

  console.log('==================================\n');

  return {
    model: MODEL_NAME,
    inputTokens,
    outputTokens,
    thinkingTokens,
    totalTokens,
    estimatedInputCostUsd: estimatedInputCost,
    estimatedOutputCostUsd: estimatedOutputCost,
    estimatedTotalCostUsd: estimatedTotalCost
  };
}

// ========================================
// 13. COMBINE BOTH GEMINI USAGE RECORDS
// ========================================

function combineUsage(first, second) {

  if (!first && !second) {
    return null;
  }

  const a = first || {};
  const b = second || {};

  return {
    model: MODEL_NAME,

    inputTokens:
      (a.inputTokens || 0) +
      (b.inputTokens || 0),

    outputTokens:
      (a.outputTokens || 0) +
      (b.outputTokens || 0),

    thinkingTokens:
      (a.thinkingTokens || 0) +
      (b.thinkingTokens || 0),

    totalTokens:
      (a.totalTokens || 0) +
      (b.totalTokens || 0),

    estimatedInputCostUsd:
      (a.estimatedInputCostUsd || 0) +
      (b.estimatedInputCostUsd || 0),

    estimatedOutputCostUsd:
      (a.estimatedOutputCostUsd || 0) +
      (b.estimatedOutputCostUsd || 0),

    estimatedTotalCostUsd:
      (a.estimatedTotalCostUsd || 0) +
      (b.estimatedTotalCostUsd || 0)
  };
}

// ========================================
// 14. CARICATURE ANALYSIS PROMPT
// ========================================

const prompt = `
You are a specialist AI caricature analyst.

Your task is to analyze ONLY genuine caricatures.

FIRST, determine whether the uploaded image is a caricature.

A caricature is an illustration or drawing that intentionally
exaggerates a person's facial features, physical characteristics,
or expressions for humorous, satirical, or artistic effect.

CLASSIFICATION RULES:

1. If the image is a normal photograph, landscape, ordinary
   illustration, screenshot, document, logo, or unrelated image,
   respond with exactly:
   ${NOT_A_CARICATURE}

2. If the image is unclear or you cannot confidently identify it
   as a caricature, respond with exactly:
   ${NOT_A_CARICATURE}

3. Do not generate a caricature description for unrelated images.

4. Do not mistake every cartoon or illustration for a caricature.
   Look for intentional exaggeration of recognizable features.

IF THE IMAGE IS A GENUINE CARICATURE:

Write an engaging, humorous and informative description.

Cover these four aspects:

1. Exaggerated facial features.
2. Facial expressions.
3. Artistic style.
4. What makes the caricature funny.

IMPORTANT:

- Describe only details visible in the image.
- Do not invent facial features.
- Do not guess the person's identity.
- Do not invent the artist, publication or historical context.
- Do not invent a political message.
- Keep the description interesting and easy to understand.

Return only the final description or the exact rejection marker.
`;

// ========================================
// 15. IMAGE-GROUNDED EVALUATION PROMPT
// ========================================

function buildEvaluationPrompt(description) {

  return `
You are an independent visual-grounding evaluator.

You will receive:
1. The ORIGINAL uploaded image.
2. A description generated by another AI model.

Your job is to verify whether the description is supported
by the actual visible image.

IMPORTANT:
You MUST inspect the image before judging the description.

Do not assume the description is correct.
Do not assume the description is incorrect.

EVALUATION RULES:

1. Check whether the described facial features are actually visible.
2. Check whether the described expression matches the image.
3. Check whether the described hair, glasses, clothing and other
   physical details are visually supported.
4. Check whether the artistic style is reasonably supported.
5. Identify specific invented or contradictory details.
6. Do not flag a detail merely because it is not mentioned in
   the image metadata.
7. Do not flag a reasonable interpretation as hallucination
   unless it is contradicted by the image.
8. Do not infer a person's identity.
9. Do not require every visible detail to be mentioned.

DESCRIPTION TO EVALUATE:

"""
${description}
"""

Return ONLY valid JSON in this exact structure:

{
  "grounded": true,
  "confidence": 0.95,
  "issues": [],
  "reason": "The description is supported by the visible image."
}

If the description contains unsupported or contradictory visual
claims, set grounded to false and list the specific issues.

Confidence must be a number between 0 and 1.

Do not use Markdown code fences.
`;
}

// ========================================
// 16. PARSE EVALUATION RESPONSE
// ========================================

function parseEvaluationResponse(text) {

  const cleaned = text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1) {

    throw new Error(
      'Visual evaluator returned invalid JSON'
    );
  }

  const parsed = JSON.parse(
    cleaned.substring(start, end + 1)
  );

  if (typeof parsed.grounded !== 'boolean') {

    throw new Error(
      'Visual evaluator returned an invalid grounded value'
    );
  }

  return {
    grounded: parsed.grounded,

    confidence:
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null,

    issues:
      Array.isArray(parsed.issues)
        ? parsed.issues
        : [],

    reason:
      typeof parsed.reason === 'string'
        ? parsed.reason
        : 'No explanation provided.'
  };
}

// ========================================
// 17. IMAGE-GROUNDED EVALUATION
// ========================================

async function evaluateVisualGrounding(
  imagePart,
  imageMetadata,
  description
) {

  const evaluationPrompt =
    buildEvaluationPrompt(description);

  const evaluationStart = performance.now();

  const evaluationModel = genAI.getGenerativeModel({
    model: MODEL_NAME
  });

  const result = await morse.spanAsync(
    {
      name: 'gemini-visual-grounding-evaluation',
      type: 'llm',

      metadata: {
        provider: 'google',
        operation: 'generateContent',
        task: 'image_grounded_description_evaluation'
      }
    },

    async (llmSpanHandle) => {

      const spanData = llmSpanHandle?.span;

      if (spanData) {

        spanData.model = MODEL_NAME;

        spanData.input_data = {
          task: 'image_grounded_description_evaluation',

          image_metadata: imageMetadata,

          description_to_evaluate: description,

          evaluation_prompt: evaluationPrompt
        };
      }

      const generated = await generateContentWithRetry(
        evaluationModel,

        [
          evaluationPrompt,
          imagePart
        ],

        'Visual grounding evaluation'
      );

      const response = generated.response;

      const evaluationText = response.text();

      const evaluation = parseEvaluationResponse(
        evaluationText
      );

      const usage = trackGeminiUsage(
        response.usageMetadata,
        'Visual evaluation'
      );

      if (spanData) {

        if (usage) {

          spanData.input_tokens =
            usage.inputTokens;

          spanData.output_tokens =
            usage.outputTokens;

          spanData.reasoning_tokens =
            usage.thinkingTokens;

          spanData.total_tokens =
            usage.totalTokens;

          spanData.cost_usd =
            usage.estimatedTotalCostUsd;
        }

        spanData.output_data = {
          task: 'image_grounded_description_evaluation',
          evaluation
        };
      }

      return {
        evaluation,
        usage,
        attempts: generated.attempts
      };
    }
  );

  return {
    ...result,

    latencyMs: Math.round(
      performance.now() - evaluationStart
    )
  };
}

// ========================================
// 18. IMAGE SUMMARIZATION ENDPOINT
// ========================================

app.post(
  '/api/summarize',
  upload.single('image'),

  async (req, res) => {

    console.log('\n================================');
    console.log('IMAGE UPLOAD REQUEST RECEIVED');
    console.log('================================');

    if (!morse) {

      console.error(
        '[MORSE] Monitoring service is not ready'
      );

      return res.status(503).json({
        error: 'Monitoring service is not ready'
      });
    }

    try {

      await morse.run(
        {
          agentName: 'caricature-summarizer'
        },

        async (handle) => {

          console.log('[MORSE] Agent trace started');

          try {

            // ========================================
            // 19. CHECK IMAGE UPLOAD
            // ========================================

            if (!req.file) {

              console.error('[VALIDATION] No image received');

              handle.setOutcome(false, 'image_missing');

              return res.status(400).json({
                error: 'No image uploaded'
              });
            }

            console.log('[UPLOAD] Image received successfully');

            console.log(
              '[UPLOAD] Image type:',
              req.file.mimetype
            );

            console.log(
              '[UPLOAD] Image size:',
              req.file.size,
              'bytes'
            );

            // ========================================
            // 20. VERIFY IMAGE CONTENT
            // ========================================

            if (
              !hasValidImageSignature(
                req.file.buffer,
                req.file.mimetype
              )
            ) {

              console.error(
                '[VALIDATION] Invalid image content'
              );

              handle.setOutcome(
                false,
                'invalid_image_content'
              );

              return res.status(400).json({
                error: 'Invalid image file. Please upload a valid JPEG, PNG or WEBP image.'
              });
            }

            console.log(
              '[VALIDATION] Image signature verified'
            );

            const imageMetadata = {
              mime_type: req.file.mimetype,
              size_bytes: req.file.size
            };

            const imagePart = {
              inlineData: {
                data: req.file.buffer.toString('base64'),
                mimeType: req.file.mimetype
              }
            };

            // ========================================
            // 21. FAILURE SIMULATION
            // ========================================

            if (
              process.env.NODE_ENV !== 'production' &&
              process.env.MORSE_TEST_FORCE_GEMINI_FAILURE === 'true'
            ) {

              console.warn(
                '[TEST] Simulating Gemini API failure'
              );

              throw new Error(
                'SIMULATED_GEMINI_FAILURE'
              );
            }

            // ========================================
            // 22. GEMINI IMAGE SUMMARIZATION
            // ========================================

            console.log(
              '[GEMINI] Sending image to Gemini...'
            );

            const geminiStartTime = performance.now();

            const geminiResult = await morse.spanAsync(
              {
                name: 'gemini-image-summarization',
                type: 'llm',

                metadata: {
                  provider: 'google',
                  operation: 'generateContent',
                  task: 'caricature_analysis'
                }
              },

              async (llmSpanHandle) => {

                const spanData = llmSpanHandle?.span;

                if (spanData) {

                  spanData.model = MODEL_NAME;

                  spanData.input_data = {
                    task: 'caricature_analysis',

                    user_request:
                      'Analyze and describe the uploaded caricature',

                    image_metadata: imageMetadata,

                    prompt
                  };
                }

                const generated = await generateContentWithRetry(
                  model,

                  [
                    prompt,
                    imagePart
                  ],

                  'Image summarization'
                );

                const response = generated.response;

                const description = response.text().trim();

                const usage = trackGeminiUsage(
                  response.usageMetadata,
                  'Image summarization'
                );

                if (spanData) {

                  if (usage) {

                    spanData.input_tokens =
                      usage.inputTokens;

                    spanData.output_tokens =
                      usage.outputTokens;

                    spanData.reasoning_tokens =
                      usage.thinkingTokens;

                    spanData.total_tokens =
                      usage.totalTokens;

                    spanData.cost_usd =
                      usage.estimatedTotalCostUsd;
                  }

                  spanData.output_data = {
                    task: 'caricature_description',
                    description
                  };
                }

                return {
                  description,
                  usage,
                  attempts: generated.attempts
                };
              }
            );

            const geminiLatency = Math.round(
              performance.now() - geminiStartTime
            );

            const description =
              geminiResult.description;

            const generationUsage =
              geminiResult.usage;

            console.log(
              '[GEMINI] Summarization completed in:',
              geminiLatency,
              'ms'
            );

            console.log(
              '[GEMINI] Generation attempts:',
              geminiResult.attempts
            );

            // ========================================
            // 23. REJECT NON-CARICATURE IMAGES
            // ========================================

            if (
              description.trim() === NOT_A_CARICATURE
            ) {

              console.log(
                '[VALIDATION] Image is not a recognizable caricature'
              );

              handle.setOutcome(
                false,
                'not_a_caricature'
              );

              return res.status(422).json({
                error: 'This image does not appear to be a caricature. Please upload a caricature image.'
              });
            }

            // ========================================
            // 24. VALIDATE GENERATED DESCRIPTION
            // ========================================

            if (
              typeof description !== 'string' ||
              description.trim().length === 0
            ) {

              console.error(
                '[GEMINI] Empty description received'
              );

              handle.setOutcome(
                false,
                'empty_description'
              );

              return res.status(502).json({
                error: 'Gemini returned an empty description'
              });
            }

            // ========================================
            // 25. IMAGE-GROUNDED EVALUATION
            // ========================================

            console.log(
              '[EVALUATION] Starting image-grounded evaluation...'
            );

            let visualEvaluation = null;
            let evaluationUsage = null;
            let evaluationLatencyMs = 0;
            let evaluationAttempts = 0;

            try {

              const evaluationResult =
                await evaluateVisualGrounding(
                  imagePart,
                  imageMetadata,
                  description
                );

              visualEvaluation =
                evaluationResult.evaluation;

              evaluationUsage =
                evaluationResult.usage;

              evaluationLatencyMs =
                evaluationResult.latencyMs;

              evaluationAttempts =
                evaluationResult.attempts;

              console.log(
                '[EVALUATION] Grounded:',
                visualEvaluation.grounded
              );

              console.log(
                '[EVALUATION] Confidence:',
                visualEvaluation.confidence
              );

              console.log(
                '[EVALUATION] Reason:',
                visualEvaluation.reason
              );

              console.log(
                '[EVALUATION] Duration:',
                evaluationLatencyMs,
                'ms'
              );

            } catch (evaluationError) {

              console.error(
                '[EVALUATION] Visual evaluation unavailable:',
                evaluationError.message
              );

              // If the evaluation call exhausted the daily
              // quota, report that the evaluation was skipped.
              // Keep the already-generated description.

              visualEvaluation = {
                grounded: null,
                confidence: null,
                issues: [],
                reason: isDailyQuotaExceeded(evaluationError)
                  ? 'Daily Gemini API quota exhausted. Visual evaluation could not be completed.'
                  : 'Visual evaluation could not be completed.'
              };
            }

            // ========================================
            // 26. COMBINE GEMINI USAGE
            // ========================================

            const combinedUsage = combineUsage(
              generationUsage,
              evaluationUsage
            );

            if (combinedUsage) {

              console.log(
                '\n========== TOTAL GEMINI USAGE =========='
              );

              console.log(
                'Total input tokens:',
                combinedUsage.inputTokens
              );

              console.log(
                'Total output tokens:',
                combinedUsage.outputTokens
              );

              console.log(
                'Total thinking tokens:',
                combinedUsage.thinkingTokens
              );

              console.log(
                'Total tokens:',
                combinedUsage.totalTokens
              );

              console.log(
                'Estimated total cost: $' +
                combinedUsage.estimatedTotalCostUsd.toFixed(8)
              );

              console.log(
                '========================================\n'
              );
            }

            // ========================================
            // 27. RECORD SUCCESS IN MORSEAI
            // ========================================

            handle.setOutcome(
              true,
              'description_generated'
            );

            console.log(
              '[MORSE] Successful outcome recorded'
            );

            console.log('================================\n');

            return res.status(200).json({

              description,

              usage: combinedUsage,

              geminiLatencyMs: geminiLatency,

              evaluationLatencyMs,

              visualEvaluation,

              retryAttempts: {
                generation: geminiResult.attempts,
                evaluation: evaluationAttempts
              }
            });

          } catch (error) {

            // ========================================
            // 28. RECORD FAILURE
            // ========================================

            console.error(
              '[ERROR] Summarization failed:',
              error.message
            );

            handle.setOutcome(
              false,
              isDailyQuotaExceeded(error)
                ? 'gemini_daily_quota_exceeded'
                : 'generation_failed'
            );

            console.log(
              '[MORSE] Failed outcome recorded'
            );

            console.log('================================\n');

            if (!res.headersSent) {

              const status = getHttpStatus(error);

              const dailyQuotaExceeded =
                isDailyQuotaExceeded(error);

              const responseStatus =
                dailyQuotaExceeded ? 429 :
                status === 429 ? 429 :
                status && status >= 500 ? 503 :
                500;

              let errorMessage;

              if (dailyQuotaExceeded) {

                errorMessage =
                  'Daily Gemini API quota exceeded. Please try again after your quota resets.';

              } else if (responseStatus === 503) {

                errorMessage =
                  'The AI service is temporarily unavailable. Please try again.';

              } else if (responseStatus === 429) {

                errorMessage =
                  'Gemini is temporarily rate-limited. Please try again shortly.';

              } else {

                errorMessage =
                  'Something went wrong. Please try again.';
              }

              return res.status(responseStatus).json({

                error: errorMessage,

                code: dailyQuotaExceeded
                  ? 'GEMINI_DAILY_QUOTA_EXCEEDED'
                  : error.message === 'SIMULATED_GEMINI_FAILURE'
                    ? 'SIMULATED_GEMINI_FAILURE'
                    : 'GENERATION_FAILED'
              });
            }
          }
        }
      );

    } catch (error) {

      console.error(
        '[MORSE] Trace execution failed:',
        error
      );

      if (!res.headersSent) {

        return res.status(500).json({
          error: 'Unable to complete the monitored request'
        });
      }
    }
  }
);

// ========================================
// 29. GLOBAL ERROR HANDLER
// ========================================

app.use((error, req, res, next) => {

  console.error(
    '[SERVER ERROR]',
    error.message
  );

  if (res.headersSent) {
    return next(error);
  }

  if (error.code === 'UNSUPPORTED_FILE_TYPE') {

    return res.status(415).json({
      error: error.message
    });
  }

  if (error instanceof multer.MulterError) {

    return res.status(400).json({
      error: 'Image upload failed: ' + error.message
    });
  }

  return res.status(500).json({
    error: 'Internal server error'
  });
});

// ========================================
// 30. START SERVER AFTER MORSEAI INIT
// ========================================

initializeMorse()

  .then(() => {

    app.listen(PORT, () => {

      console.log('\n================================');
      console.log('CARICATURE SUMMARIZER BACKEND');
      console.log('================================');

      console.log(
        `Backend running at http://localhost:${PORT}`
      );

      console.log('MorseAI monitoring: ACTIVE');
      console.log('Gemini usage tracking: ACTIVE');
      console.log('Gemini LLM span tracking: ACTIVE');
      console.log('Image-grounded evaluation: ACTIVE');
      console.log('Gemini temporary-error retries: ACTIVE');
      console.log('Daily quota detection: ACTIVE');

      console.log(
        'Accepted formats: JPEG, PNG, WEBP'
      );

      console.log(
        'Maximum Gemini retries:',
        MAX_GEMINI_RETRIES
      );

      console.log(
        'Failure simulation:',
        process.env.MORSE_TEST_FORCE_GEMINI_FAILURE === 'true'
          ? 'ENABLED'
          : 'DISABLED'
      );

      console.log(
        'Waiting for image uploads...'
      );

      console.log('================================\n');
    });
  })

  .catch((error) => {

    console.error(
      '[STARTUP ERROR] MorseAI initialization failed:',
      error
    );

    process.exit(1);
  });
