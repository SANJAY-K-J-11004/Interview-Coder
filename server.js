// === EXPRESS SERVER === //

const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { z } = require("zod");
const Anthropic = require("@anthropic-ai/sdk");
const { Groq } = require("groq-sdk");
const fs = require("fs");
const { createWorker } = require("tesseract.js");
const { text } = require("stream/consumers");


// === SETUP === //

dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Request Logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});


// === CONFIG === //
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "mistral-saba-24b"

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const ANTHROPIC_MODEL = "claude-3-7-sonnet-20250219"


// === AI SETUP === //

console.log(`Using Groq API key: ${GROQ_API_KEY.substring(0, 10)}...`);
const groq = new Groq({ GROQ_API_KEY });

console.log(`Using Groq API key: ${ANTHROPIC_API_KEY.substring(0, 10)}...`);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });


// === PROMPTS === //

// Claude Prompts
const CLAUDE_EXTRACT_PROMPT = `You are an image extractor. Extract every single thing that are available in the images that is sent to you:
Make sure that nothing is left out
The images that are sent to you usually will be either a coding problem with constrains, input format, output format, sample test cases
Or an multiple choice question with options or just a question
Even if you cannot find the things that are mentioned above, you must extract everything that is available in the image
Make sure to extract all the information that is available in the image`;

const CLAUDE_CODE_PROMPT = `You are a coding assistant that generates solutions and analyzes them. For each field in your response:
- thoughts: Provide thoughts about your solution approach, as if explaining to a teacher. Explain your thought process progressively, as if arriving at the solution step by step. Focus on the code and logic only.
- code: Write the complete [LANGUAGE] solution. Make it optimal, legible, and include **inline comments after every line explaining what that line of code does**.
- time_complexity: Start with big-O notation (e.g., O(n)) followed by a brief explanation of why
- space_complexity: Start with big-O notation (e.g., O(n)) followed by a brief explanation of why

Your response must be in the following JSON format:
Respond only with the JSON object, do not include any other text or explanation
Make sure the code is single line with no new lines, and use \\n for line breaks
Make sure to **inline comments after every line explaining what that line of code does do not miss it**:
{
  "thoughts": ["thought1", "thought2", "thought3", "thought..."],
  "code": "your complete code solution",
  "time_complexity": "O(X) followed by explanation",
  "space_complexity": "O(X) followed by explanation"
}`;

const CLAUDE_MCQ_PROMPT = `You are an AI assistant that helps solve MCQs. Given a problem statement with multiple-choice options, your task is to:
1. Identify the correct answer.
2. Explain why the selected option is correct.
3. If helpful, rule out the other options briefly.

Your response must be in the following JSON format:
{
  "thoughts": ["complete step by step explanation of how that option is correct line by line"],
  "code": "Correct option with the answer -> ex: A -> 800",
  "time_complexity": "NA",
  "space_complexity": "NA"
}`


// Groq Prompts
const GROQ_CODE_PROMPT = `You are a coding assistant that generates solutions and analyzes them. For each field in your response:
- thoughts: Provide thoughts about your solution approach, as if explaining to a teacher. Explain your thought process progressively, as if arriving at the solution step by step. Focus on the code and logic only.
- code: Write the complete [LANGUAGE] solution. Make it optimal, legible, and include **inline comments after every line explaining what that line of code does**.
- time_complexity: Start with big-O notation (e.g., O(n)) followed by a brief explanation of why
- space_complexity: Start with big-O notation (e.g., O(n)) followed by a brief explanation of why

Your response must be in the following JSON format:
Respond only with the JSON object, do not include any other text or explanation
Make sure the code is single line with no new lines, and use \\n for line breaks
Make sure to **inline comments after every line explaining what that line of code does do not miss it**:
{
  "code": "solution code",
  "thoughts": ["thought 1", "thought 2", "thought 3", "thought..."],
  "time_complexity": "O(X) followed by explanation",
  "space_complexity": "O(X) followed by explanation"
}`;

const GROQ_MCQ_PROMPT = `You are an AI assistant that helps solve MCQs. Given a problem statement with multiple-choice options, your task is to:
1. Identify the correct answer.
2. Explain why the selected option is correct.
3. If helpful, rule out the other options briefly.

Your response must be in the following JSON format:
{
  "thoughts": ["complete step by step explanation of how that option is correct line by line"],
  "code": "Correct option with the answer -> ex: A -> 800",
  "time_complexity": "NA",
  "space_complexity": "NA"
}`

// === HELPERS === //
const SolutionResponse = z.object({
  thoughts: z.array(z.string()).optional(),
  code: z.string().optional(),
  time_complexity: z.string().optional(),
  space_complexity: z.string().optional(),
});

function detectImageType(base64Data) {
  const prefix = base64Data.substring(0, 30).toLowerCase();
  if (prefix.startsWith("/9j/")) return "image/jpeg";
  if (prefix.includes("png")) return "image/png";
  if (prefix.includes("gif")) return "image/gif";
  if (prefix.includes("webp")) return "image/webp";
  return "image/png";
}

function saveBase64ImageToTemp(base64Data) {
  const filename = path.join(tempDir, `image-${crypto.randomBytes(8).toString("hex")}.png`);
  let imageData = base64Data;
  if (base64Data.includes(';base64,')) {
    imageData = base64Data.split(';base64,').pop();
  }
  fs.writeFileSync(filename, Buffer.from(imageData, 'base64'));
  return filename;
};

// === MAIN === //

// === /claude/api/extract === //
app.post("/claude/api/extract", async (req, res) => {
  try {
    const { imageDataList } = req.body;
    if (!imageDataList || !Array.isArray(imageDataList)) return res.status(400).json({ error: "imageDataList must be an array" });
    const imageContents = imageDataList.map(imageData => ({
      type: "image",
      source: {
        type: "base64",
        media_type: detectImageType(imageData),
        data: imageData
      }
    }));
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: CLAUDE_EXTRACT_PROMPT,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Follow the system prompt and extract the problem statement from the images provided." },
          ...imageContents
        ]
      }]
    });

    const textBlock = response.content.find(block => block.type === "text");
    // const result = textBlock?.text.match(/\{[\s\S]*\}/);
    return res.json({ problem_statement: textBlock?.text || "No problem statement found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});


// === /claude/api/generate === //
app.post("/claude/api/generate", async (req, res) => {
  try {
    const { problem_statement, language } = req.body;
    const isMCQ = language?.toLowerCase() === "mcq";

    const system = isMCQ ? CLAUDE_MCQ_PROMPT : CLAUDE_CODE_PROMPT.replace("[LANGUAGE]", language || "cpp");
    const user = `Follow the system prompt and generate a solution for the problem statement provided below:\nProblem Statement: ${problem_statement}`;

    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user }]
    });

    const fullResponse = response.content[0].text;
    let jsonResponse;
    console.log("Claude API call successful");
    try {
      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonResponse = SolutionResponse.parse(JSON.parse(jsonMatch[0]));
      } else {
        jsonResponse = SolutionResponse.parse(JSON.parse(fullResponse));
      }
      res.json(jsonResponse);
    } catch (error) {
      console.error("Error parsing JSON from model response:", error);
      const fallbackResponse = {
        code: fullResponse.replace(/```[\w]*\n([\s\S]*?)```/g, "$1").trim() || fullResponse,
        thoughts: ["Automatically extracted from unstructured response"],
        time_complexity: "Could not determine from response",
        space_complexity: "Could not determine from response"
      };

      res.json(fallbackResponse);
    }
  } catch (error) {
    console.error("Generation error:", error);
    res.status(500).json({ error: "Generation failed", details: error.message });
  }
});


// === /mistral/api/extract === //
app.post("/mistral/api/extract", async (req, res) => {
  const tempFiles = [];
  try {
    const { imageDataList, language } = req.body;
    if (!imageDataList || !Array.isArray(imageDataList)) {
      return res.status(400).json({ error: "Invalid imageDataList" });
    }
    const ocrResults = [];
    for (const imageData of imageDataList) {
      const imagePath = saveBase64ImageToTemp(imageData);
      tempFiles.push(imagePath);
      console.log(`Saved temporary image to: ${imagePath}`);
      const worker = await createWorker("eng");
      const { data } = await worker.recognize(imagePath);
      ocrResults.push(data.text);
      await worker.terminate();
    }
    const result = ocrResults.join("\n");
    res.json({ problem_statement: result });
  } catch (err) {
    console.error("OCR extraction error:", err);
    res.status(500).json({ error: "OCR extraction failed", details: err.message });
  } finally {
    tempFiles.forEach(file => {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          console.log(`Deleted temporary file: ${file}`);
        }
      } catch (err) {
        console.error(`Error deleting temporary file ${file}:`, err);
      }
    });
  }
});

// === /mistral/api/generate === //
app.post("/mistral/api/generate", async (req, res) => {
  try {
    const { problem_statement, language } = req.body;
    console.log("Generate endpoint called with:", {
      languageRequested: language,
      problemStatementLength: problem_statement ? problem_statement.length : 0,
      problemStatementPreview: problem_statement ? problem_statement.substring(0, 100) + (problem_statement.length > 100 ? "..." : "") : "none"
    });
    const isMCQ = language?.toLowerCase() === "mcq";

    const system = isMCQ ? GROQ_MCQ_PROMPT : GROQ_CODE_PROMPT.replace("[LANGUAGE]", language || "cpp");
    const user = `Follow the system prompt and generate a solution for the problem statement provided below:\nProblem Statement: ${problem_statement}`;

    const result = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_completion_tokens: 4096,
      temperature: 0.2,
      top_p: 0.95,
      stream: false,
      stop: null
    });

    const fullResponse = result.choices[0].message.content;
    let jsonResponse;
    console.log("Groq API call successful");
    console.log("Full response from Groq:", fullResponse);
    try {
      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonResponse = SolutionResponse.parse(JSON.parse(jsonMatch[0]));
      } else {
        jsonResponse = SolutionResponse.parse(JSON.parse(fullResponse));
      }
      res.json(jsonResponse);
    } catch (error) {
      console.error("Error parsing JSON from model response:", error);
      const fallbackResponse = {
        code: fullResponse.replace(/```[\w]*\n([\s\S]*?)```/g, "$1").trim() || fullResponse,
        thoughts: ["Automatically extracted from unstructured response"],
        time_complexity: "Could not determine from response",
        space_complexity: "Could not determine from response"
      };

      res.json(fallbackResponse);
    }
  } catch (error) {
    console.error("Generation error:", error);
    res.status(500).json({ error: "Generation failed", details: error.message });
  }
});

app.get("/api/test-groq", async (req, res) => {
  try {
    console.log("Testing Groq API connection...");
    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: "Hello, can you respond with just the text 'Groq API is working'?" }],
      model: GROQ_MODEL,
      max_completion_tokens: 10,
      temperature: 0,
    });

    console.log("Groq API test response:", completion.choices[0].message.content);
    res.json({ status: "success", message: completion.choices[0].message.content });
  } catch (error) {
    console.error("Groq API test error:", error);
    res.status(500).json({ status: "error", error: error.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
