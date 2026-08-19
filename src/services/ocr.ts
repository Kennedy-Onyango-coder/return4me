import { GoogleGenAI, Type } from '@google/genai';

export interface OcrResult {
  documentType: string;
  documentNumber: string | null;
  fullName: string | null;
  confidence: number;
  flaggedForReview: boolean;
}

export const OcrService = {
  /**
   * Analyze found item photo and extract text fields
   */
  async extractDocumentDetails(base64Image: string): Promise<OcrResult> {
    // Check if the API key is set
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      console.warn('[OCR SERVICE] WARNING: No valid GEMINI_API_KEY configured. Falling back to sandbox heuristic parsing.');
      return unavailableOcrResult('API key missing or placeholder');
    }

    // Save ambient GCP / ADC environment variables to prevent the Google Auth Library
    // from fetching metadata server tokens and attaching an unsupported OAuth Bearer header.
    const savedEnv: Record<string, string | undefined> = {};
    const envsToClear = [
      'GOOGLE_APPLICATION_CREDENTIALS',
      'GOOGLE_GCLOUD_PROJECT',
      'GOOGLE_CLOUD_PROJECT',
      'GCP_PROJECT',
      'GCLOUD_PROJECT',
      'GCE_METADATA_HOST',
      'GCP_METADATA_HOST'
    ];

    for (const key of envsToClear) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    process.env.GCE_METADATA_HOST = 'none';
    process.env.GCP_METADATA_HOST = 'none';

    try {
      console.log('[OCR SERVICE] Attempting primary OCR provider: Gemini...');
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'return4me-ocr-service/1.0',
          },
        },
      });

      // Format image part for Gemini API
      // Trim mime-type prefix from base64 if present
      const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

      const imagePart = {
        inlineData: {
          mimeType: 'image/jpeg',
          data: cleanBase64,
        },
      };

      const promptPart = {
        text: `You are an expert OCR vision agent for the Return4me platform in Kenya. 
        Your task is to analyze the uploaded photo of a lost and found Kenyan document or item. 
        Extract the document type, the unique identification/serial number, the full name of the owner shown, and check the plausibility of the item.
        Valid document types: national-id, alien-id, passport, driving-licence, birth-certificate, kra-pin, nhif-card, nssf-card, vehicle-logbook, number-plate, academic-cert, title-deed, atm-card, wallet, phone, keys, laptop.
        Return structured JSON. If a detail cannot be read, output null for that field and set a low confidence score.`,
      };

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [imagePart, promptPart],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              documentType: {
                type: Type.STRING,
                description: 'The classified Return4me category key (e.g. national-id, passport, driving-licence, etc.)',
              },
              documentNumber: {
                type: Type.STRING,
                description: 'Unique registration number, plate number, serial, ID number, or account number on document.',
              },
              fullName: {
                type: Type.STRING,
                description: 'Name of the holder/owner printed on the document in uppercase.',
              },
              confidence: {
                type: Type.NUMBER,
                description: 'Model confidence score between 0.0 and 1.0 based on image legibility.',
              },
              isPlausibleGenuineItem: {
                type: Type.STRING,
                description: 'Whether the photo plausibly shows a genuine lost item or document of value worth reporting. Choose strictly from: "true", "false", "uncertain". Set to "false" if blank, spam, gibberish, or of zero value.',
              },
            },
            required: ['documentType', 'documentNumber', 'fullName', 'confidence', 'isPlausibleGenuineItem'],
          },
        },
      });

      const responseText = response.text;
      if (!responseText) {
        throw new Error('Empty response from Gemini OCR engine.');
      }

      const data = JSON.parse(responseText.trim());
      
      console.log('[OCR SERVICE] Gemini extraction successful:', data);

      const isNotPlausibleOrUncertain = data.isPlausibleGenuineItem === 'false' || data.isPlausibleGenuineItem === 'uncertain';

      return {
        documentType: data.documentType || 'national-id',
        documentNumber: data.documentNumber,
        fullName: data.fullName ? data.fullName.toUpperCase() : null,
        confidence: data.confidence,
        flaggedForReview: data.confidence < 0.7 || !data.documentNumber || !data.fullName || isNotPlausibleOrUncertain,
      };

    } catch (e: any) {
      const originalMsg = String(e?.message || e || '');
      const isPermissionDenied = originalMsg.includes('PERMISSION_DENIED') || originalMsg.includes('403');
      const hasRealLookingKey = /^(AQ\.[A-Za-z0-9_-]+|AIzaSy[A-Za-z0-9_-]+)$/.test(process.env.GEMINI_API_KEY || '');

      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.warn('[OCR SERVICE] NOTE: Gemini API request completed or returned an error.');
      console.warn(`Details: ${originalMsg}`);

      if (isPermissionDenied && hasRealLookingKey) {
        // A real-looking key (correct format) still got PERMISSION_DENIED — this is
        // NOT the "still using the default sandbox key" case. It means the Google
        // Cloud project this specific key belongs to doesn't actually have access
        // to the Gemini API yet (API not enabled, billing not set up, or the key
        // has restrictions that exclude the Generative Language API).
        console.warn('Your GEMINI_API_KEY has the correct format of a real key, so this is NOT');
        console.warn('the "still using a placeholder key" issue. Instead, "PERMISSION_DENIED" here');
        console.warn('means the Google Cloud project this key belongs to does not have access to');
        console.warn('the Gemini API. To fix, in Google Cloud Console (console.cloud.google.com):');
        console.warn('  1. Select the project this API key belongs to');
        console.warn('  2. Go to "APIs & Services" -> "Enabled APIs" and confirm "Generative Language API"');
        console.warn('     (or "Vertex AI API") is enabled — if not, enable it');
        console.warn('  3. Go to "Billing" and confirm this project has an active billing account linked');
        console.warn('  4. If using a restricted key, go to "Credentials" -> this key -> "API restrictions"');
        console.warn('     and confirm the Generative Language API is allowed');
      } else {
        console.warn('If you see authentication (401/403) issues and your GEMINI_API_KEY is still');
        console.warn('a placeholder/default value, this is expected — go to "Settings > Secrets" and');
        console.warn('enter your own real Gemini API Key.');
      }
      console.warn('Using graceful OCR fallback (Groq Vision or local simulation)...');
      console.warn('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');

      // Attempt secondary provider: Groq's free-tier vision-capable models
      // (Llama 4 Scout/Maverick as of writing). Chosen over the previous
      // OCR.space fallback because OCR.space only does raw text extraction —
      // it can't classify document type at all, so every fallback item was
      // silently hardcoded to 'national-id' regardless of what it actually
      // was (passport, driving licence, laptop, etc.). Groq's vision models
      // can follow the same structured-JSON extraction contract as Gemini,
      // so a fallback item gets a real category guess instead of a wrong
      // guaranteed one. Groq's free tier (as of writing) has no cost and a
      // generous per-minute request limit — check https://console.groq.com
      // for current limits before relying on this at meaningful scale.
      const groqKey = process.env.GROQ_API_KEY;
      if (groqKey && groqKey !== 'MY_GROQ_API_KEY') {
        try {
          console.log('[OCR SERVICE] Attempting secondary OCR provider: Groq Vision...');

          let formattedBase64 = base64Image;
          if (!formattedBase64.startsWith('data:')) {
            formattedBase64 = `data:image/jpeg;base64,${formattedBase64}`;
          }

          const groqPrompt = `You are an expert OCR vision agent for the Return4me platform in Kenya. Analyze this photo of a lost and found Kenyan document or item. Extract the document type, the unique identification/serial number, the full name of the owner shown, and check the plausibility of the item.
Valid document types: national-id, alien-id, passport, driving-licence, birth-certificate, kra-pin, nhif-card, nssf-card, vehicle-logbook, number-plate, academic-cert, title-deed, atm-card, wallet, phone, keys, laptop.
Respond with ONLY a raw JSON object (no markdown fences, no prose) with exactly these keys: documentType (string), documentNumber (string or null), fullName (string or null, uppercase), confidence (number 0.0-1.0), isPlausibleGenuineItem (string: "true", "false", or "uncertain"). If a detail cannot be read, use null for that field and a low confidence score.`;

          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${groqKey}`,
            },
            body: JSON.stringify({
              model: 'meta-llama/llama-4-scout-17b-16e-instruct',
              messages: [
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: groqPrompt },
                    { type: 'image_url', image_url: { url: formattedBase64 } },
                  ],
                },
              ],
              temperature: 0.1,
              response_format: { type: 'json_object' },
            }),
          });

          if (!groqRes.ok) {
            const errBody = await groqRes.text().catch(() => '');
            throw new Error(`Groq Vision API HTTP error! Status: ${groqRes.status}. ${errBody}`);
          }

          const groqData = await groqRes.json() as any;
          const groqContent = groqData?.choices?.[0]?.message?.content;
          if (!groqContent) {
            throw new Error('Empty response from Groq Vision engine.');
          }

          const parsed = JSON.parse(groqContent.trim());
          console.log('[OCR SERVICE] Groq Vision extraction successful:', parsed);

          const isNotPlausibleOrUncertainGroq = parsed.isPlausibleGenuineItem === 'false' || parsed.isPlausibleGenuineItem === 'uncertain';

          return {
            documentType: parsed.documentType || 'national-id',
            documentNumber: parsed.documentNumber || null,
            fullName: parsed.fullName ? String(parsed.fullName).toUpperCase() : null,
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
            flaggedForReview: (typeof parsed.confidence === 'number' ? parsed.confidence : 0) < 0.7 || !parsed.documentNumber || !parsed.fullName || isNotPlausibleOrUncertainGroq,
          };

        } catch (groqErr: any) {
          console.error('[OCR SERVICE] Groq Vision API call failed!');
          console.error(`Error Details: ${groqErr?.message || groqErr}`);
        }
      } else {
        console.log('[OCR SERVICE] Groq Vision secondary provider not configured (GROQ_API_KEY is missing).');
      }

      console.warn('[OCR SERVICE] All configured OCR providers failed or were unavailable. Falling back to local heuristic mock OCR.');
      return unavailableOcrResult(e?.message || String(e));
    } finally {
      // Restore original environment variables to preserve the state of other subsystems
      for (const key of envsToClear) {
        if (savedEnv[key] !== undefined) {
          process.env[key] = savedEnv[key];
        } else {
          delete process.env[key];
        }
      }
    }
  },
};

// Graceful fallback parser in case Gemini is offline or unconfigured
function unavailableOcrResult(errorMsg?: string): OcrResult {
  // When every OCR provider is unavailable or unconfigured, the honest thing
  // to do is ask the person to fill the details in themselves — not silently
  // hand back a fabricated, realistic-looking Kenyan name and ID number as if
  // it were genuinely read from their photo. A finder who doesn't scrutinize
  // every field before submitting could otherwise attach a fictional
  // stranger's identity to a real found-item report.
  console.log('[OCR SERVICE] No OCR provider available. Returning empty fields for manual entry.', errorMsg ? `(${errorMsg})` : '');

  return {
    documentType: 'national-id',
    documentNumber: null,
    fullName: null,
    confidence: 0,
    flaggedForReview: true, // Prompts manual edit in frontend
  };
}
