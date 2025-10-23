import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { GoogleAuth } from "google-auth-library";

const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API;
const GOOGLE_VERTEX_AI_API_KEY = process.env.GOOGLE_VERTEX_AI_API;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Initialize Google Auth for service account
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  // For Railway deployment - use JSON from environment variable
  credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    ? JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON)
    : undefined
});

const app = new Elysia()
  .use(cors())
  .get("/", async () => {
    const file = Bun.file("public/index.html");
    return new Response(file.stream(), {
      headers: {
        "Content-Type": "text/html",
      },
    });
  })
  .post("/api/tts", async ({ body, set }) => {
    try {
      const {
        text,
        apiMode = "standard",
        languageCode = "id-ID",
        modelName,
        voiceName,
        audioEncoding = "MP3",
        pitch = 0,
        speakingRate = 1
      } = body as {
        text: string;
        apiMode?: string;
        languageCode?: string;
        modelName?: string;
        voiceName?: string;
        audioEncoding?: string;
        pitch?: number;
        speakingRate?: number;
      };

      if (!text) {
        set.status = 400;
        return { error: "Text is required" };
      }

      let requestBody: any;
      let apiUrl: string = '';
      let headers: any = { "Content-Type": "application/json" };

      if (apiMode === "vertex") {
        // Use service account authentication for Vertex AI
        try {
          const client = await auth.getClient();
          const accessToken = await client.getAccessToken();

          if (!accessToken.token) {
            set.status = 500;
            return { error: "Failed to get service account access token" };
          }

          headers["Authorization"] = `Bearer ${accessToken.token}`;

          // Google Cloud Gemini TTS API format
          requestBody = {
            input: {
              text: text
            },
            voice: {
              languageCode,
              modelName: 'gemini-2.5-flash-tts',
              name: voiceName
            },
            audioConfig: {
              audioEncoding: "LINEAR16"
            }
          };
          apiUrl = `https://texttospeech.googleapis.com/v1/text:synthesize`;
        } catch (error) {
          console.error("Service account authentication failed:", error);
          const errorMessage = error instanceof Error ? error.message : "Service account authentication failed";

          // Check for quota limit errors in Gemini/Vertex AI
          if (errorMessage.includes("quota") || errorMessage.includes("Quota") ||
              errorMessage.includes("requests_per_minute") || errorMessage.includes("rate limit")) {
            set.status = 429;
            return { error: "Limit exceeded per project per minute" };
          }

          set.status = 500;
          return { error: "Service account authentication failed" };
        }
      } else if (apiMode === "standard") {
        // Standard TTS API format
        const voice: any = { languageCode };
        if (voiceName) voice.name = voiceName;
        if (modelName) voice.modelName = modelName;

        // Some voices (like Chirp3) don't support pitch/speakingRate
        const audioConfig: any = { audioEncoding };

        // Only add pitch and speakingRate if they're not default values
        // This helps avoid errors with voices that don't support these parameters
        if (pitch !== 0) audioConfig.pitch = pitch;
        if (speakingRate !== 1) audioConfig.speakingRate = speakingRate;

        requestBody = {
          input: { text },
          voice,
          audioConfig,
        };

        if (!GOOGLE_TTS_API_KEY) {
          set.status = 500;
          return { error: "TTS API key not configured" };
        }

        apiUrl = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`;
      } else if (apiMode === "openai") {
        // OpenAI TTS API format
        if (!OPENAI_API_KEY) {
          set.status = 500;
          return { error: "OpenAI API key not configured" };
        }

        headers["Authorization"] = `Bearer ${OPENAI_API_KEY}`;

        // Add Indonesian voice instructions
        const indonesianInstructions = `
            Speak in Bahasa Indonesia.
            Voice Affect: Calm, composed, and reassuring; project quiet authority and confidence.
            Tone: Announcer, sincere, empathetic, and gently authoritative—express genuine apology while conveying competence.
            Pacing: Steady and moderate; unhurried enough to communicate care, yet efficient enough to demonstrate professionalism.
            Emotion: Genuine empathy and understanding; speak with warmth
            Pronunciation: Clear and precise
            Pauses: Brief after commas, longer after period.
            `;

        requestBody = {
          model: "gpt-4o-mini-tts",
          instructions: indonesianInstructions,
          input: text,
          voice: voiceName,
          response_format: audioEncoding === "LINEAR16" ? "wav" : "mp3",
          speed: speakingRate
        };

        apiUrl = `https://api.openai.com/v1/audio/speech`;
      }

      const response = await fetch(apiUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorData = await response.json();
        const errorMessage = errorData.error?.message || "TTS API request failed";

        // Check for quota limit errors
        if (errorMessage.includes("quota") || errorMessage.includes("Quota") ||
            errorMessage.includes("requests_per_minute") || errorMessage.includes("rate limit")) {
          throw new Error("Limit exceeded per project per minute");
        }

        throw new Error(errorMessage);
      }

      if (apiMode === "openai") {
        // OpenAI returns audio directly, not JSON
        if (!response.ok) {
          const errorData = await response.json();
          const errorMessage = errorData.error?.message || "OpenAI TTS API request failed";

          // Check for quota limit errors
          if (errorMessage.includes("quota") || errorMessage.includes("rate limit")) {
            throw new Error("Limit exceeded per project per minute");
          }

          throw new Error(errorMessage);
        }

        const audioBuffer = await response.arrayBuffer();
        const contentType = audioEncoding === "LINEAR16" ? "audio/wav" : "audio/mpeg";

        set.headers["Content-Type"] = contentType;
        set.headers["Content-Length"] = audioBuffer.byteLength.toString();

        return new Response(audioBuffer, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": audioBuffer.byteLength.toString(),
          },
        });
      } else {
        // Google APIs return JSON with base64 audio
        const data = await response.json();

        if (!data.audioContent) {
          set.status = 500;
          return { error: "Failed to generate audio" };
        }

        // Convert base64 to buffer
        const audioBuffer = Buffer.from(data.audioContent, "base64");

        // Set content type based on audio encoding
        const contentType = audioEncoding === "LINEAR16" ? "audio/wav" : "audio/mpeg";

        set.headers["Content-Type"] = contentType;
        set.headers["Content-Length"] = audioBuffer.length.toString();

        return new Response(audioBuffer, {
          headers: {
            "Content-Type": contentType,
            "Content-Length": audioBuffer.length.toString(),
          },
        });
      }
    } catch (error) {
      console.error("TTS Error:", error);
      set.status = 500;
      return { error: "Internal server error" };
    }
  })
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`
);