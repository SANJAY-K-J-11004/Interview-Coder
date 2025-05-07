const express = require("express");
const cors = require("cors");
const { createWorker } = require("tesseract.js");
const dotenv = require("dotenv");
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Increase payload size for image data
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, "temp");
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

//const apiKey = "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"; // Use environment variable for API key
//console.log(`Using Anthropic API key: ${apiKey ? apiKey.substring(0, 10) + "..." : "NOT SET"}`);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });



// Initialize Groq SDK instance with your API key
//const apikey = "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"//"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"//"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"//"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"//"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";
//console.log(`Using Groq API key: ${apikey.substring(0, 10)}...`);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY});

// Supported Tesseract languages
const SUPPORTED_LANGUAGES = ["eng", "fra", "deu", "spa", "ita", "por", "chi_sim", "chi_tra", "jpn", "kor", "ara", "hin", "rus"];

// Function to save base64 image to a temporary file
const saveBase64ImageToTemp = (base64Data) => {
  // Generate a random filename
  const filename = path.join(tempDir, `image-${crypto.randomBytes(8).toString("hex")}.png`);
  
  // Remove the data URL prefix if present (e.g., "data:image/png;base64,")
  let imageData = base64Data;
  if (base64Data.includes(';base64,')) {
    imageData = base64Data.split(';base64,').pop();
  }
  
  // Write the file
  fs.writeFileSync(filename, Buffer.from(imageData, 'base64'));
  return filename;
};

// --- OCR Extraction Endpoint ---
app.post("/api/extract", async (req, res) => {
  const tempFiles = [];
  
  try {
    const { imageDataList, language } = req.body;
    if (!imageDataList || !Array.isArray(imageDataList)) {
      return res.status(400).json({ error: "Invalid imageDataList" });
    }

    // Ensure the language is supported by Tesseract
    // Default to English if not specified or not supported
    const ocrLang = SUPPORTED_LANGUAGES.includes(language) ? language : "eng";
    console.log(`Using OCR language: ${ocrLang}`);
    
    const ocrResults = [];

    // Process each image
    for (const imageData of imageDataList) {
      // Save base64 image to a temporary file
      const imagePath = saveBase64ImageToTemp(imageData);
      tempFiles.push(imagePath);
      console.log(`Saved temporary image to: ${imagePath}`);
      
      // Create a new worker for each image
      const worker = await createWorker(ocrLang);
      
      // Recognize text from the image file
      const { data } = await worker.recognize(imagePath);
      ocrResults.push(data.text);
      
      // Terminate the worker after use
      await worker.terminate();
    }
   
    const problemText = ocrResults.join("\n");

//new here
    // const finalPrompt = `
    //   ${problemText}

    // ---

    //   Please analyze the above problem and provide:
    //   1. The time complexity.
    //   2. The space complexity.
    //   `;

    
    console.log("OCR extraction successful. Extracted text:", problemText.substring(0, 100) + (problemText.length > 100 ? "..." : ""));
    
    res.json({ problemText });
    // res.json({ problemText: finalPrompt });

    
  } catch (error) {
    console.error("OCR extraction error:", error);
    res.status(500).json({ error: "OCR extraction failed", details: error.message });
  } finally {
    // Clean up temporary files
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





app.post("/api/generate", async (req, res) => {
  try {
    const { problemText, language } = req.body;
    console.log("Generate endpoint called with:", {
      languageRequested: language,
      problemTextLength: problemText ? problemText.length : 0,
      problemTextPreview: problemText ? problemText.substring(0, 100) + (problemText.length > 100 ? "..." : "") : "none"
    });
    
    if (!problemText) {
      return res.status(400).json({ error: "No problem text provided" });
    }
    
    const lang = language || "cpp";
    console.log(`Generating solution in ${lang}`);
    
    // Construct the message for Claude with specific formatting instructions
    const message = `Solve the following problem in ${lang}:\n${problemText}\n
    Provide your solution in the following JSON format:
    {
      "code": "your complete code solution here",
      "thoughts": ["thought 1", "thought 2", "thought 3"], 
      "time_complexity": "O(n) explanation here",
      "space_complexity": "O(n) explanation here"
    }
    
    The response MUST be valid JSON. Make sure to escape any special characters in strings properly.`;

    console.log("Calling Claude API...");
    
    // Create a completion using Claude model
    const completion = await anthropic.messages.create({
      model: "claude-3-7-sonnet-20250219", // Latest Claude model (as of May 2025)
      max_tokens: 4096,
      temperature: 0.6,
      top_p: 0.95,
      messages: [
        { role: "user", content: message }
      ]
    });

    console.log("Claude API call successful");
    
    // Get the full response
    const fullResponse = completion.content[0].text;
    
    // Extract JSON from the response (handling potential text before/after JSON)
    let jsonResponse;
    try {
      // Find JSON in the response text (looking for opening and closing braces)
      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonResponse = JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: parse the entire response as JSON
        jsonResponse = JSON.parse(fullResponse);
      }
      
      // Ensure required fields exist
      jsonResponse = {
        code: jsonResponse.code || "",
        thoughts: Array.isArray(jsonResponse.thoughts) ? jsonResponse.thoughts : ["No specific thoughts provided"],
        time_complexity: jsonResponse.time_complexity || "Not specified",
        space_complexity: jsonResponse.space_complexity || "Not specified"
      };
      
      res.json(jsonResponse);
    } catch (error) {
      console.error("Error parsing JSON from model response:", error);
      
      // Fallback: If JSON parsing fails, create a structured response from text
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







// --- Generation Endpoint using Groq for Chat Completions ---
// Modify the /api/generate endpoint in your server (paste-2.txt)
// app.post("/api/generate", async (req, res) => {
//   try {
//     const { problemText, language } = req.body;
//     console.log("Generate endpoint called with:", {
//       languageRequested: language,
//       problemTextLength: problemText ? problemText.length : 0,
//       problemTextPreview: problemText ? problemText.substring(0, 100) + (problemText.length > 100 ? "..." : "") : "none"
//     });
    
//     if (!problemText) {
//       return res.status(400).json({ error: "No problem text provided" });
//     }
    
//     const lang = language || "cpp";
//     console.log(`Generating solution in ${lang}`);
    
//     // Construct the message for the chat completion with specific formatting instructions
//     const messages = [
//       {
//         role: "user",
//         content: `Solve the following problem in ${lang}:\n${problemText}\n
//         Provide your solution in the following JSON format:
//         {
//           "code": "your complete code solution here",
//           "thoughts": ["thought 1", "thought 2", "thought 3"], 
//           "time_complexity": "O(n) explanation here",
//           "space_complexity": "O(n) explanation here"
//         }
        
//         The response MUST be valid JSON. Make sure to escape any special characters in strings properly.`,
//       },
//     ];

//     console.log("Calling Groq API...");
    
//     // Create a chat completion with streaming disabled to get full response
//     const chatCompletion = await groq.chat.completions.create({
//       messages,
//       model: "mistral-saba-24b",
//       temperature: 0.6,
//       max_completion_tokens: 4096,
//       top_p: 0.95,
//       stream: false, // Change to non-streaming
//       stop: null,
//     });

//     console.log("Groq API call successful");
    
//     // Get the full response
//     const fullResponse = chatCompletion.choices[0].message.content;
    
//     // Extract JSON from the response (handling potential text before/after JSON)
//     let jsonResponse;
//     try {
//       // Find JSON in the response text (looking for opening and closing braces)
//       const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
//       if (jsonMatch) {
//         jsonResponse = JSON.parse(jsonMatch[0]);
//       } else {
//         // Fallback: parse the entire response as JSON
//         jsonResponse = JSON.parse(fullResponse);
//       }
      
//       // Ensure required fields exist
//       jsonResponse = {
//         code: jsonResponse.code || "",
//         thoughts: Array.isArray(jsonResponse.thoughts) ? jsonResponse.thoughts : ["No specific thoughts provided"],
//         time_complexity: jsonResponse.time_complexity || "Not specified",
//         space_complexity: jsonResponse.space_complexity || "Not specified"
//       };
      
//       res.json(jsonResponse);
//     } catch (error) {
//       console.error("Error parsing JSON from model response:", error);
      
//       // Fallback: If JSON parsing fails, create a structured response from text
//       const fallbackResponse = {
//         code: fullResponse.replace(/```[\w]*\n([\s\S]*?)```/g, "$1").trim() || fullResponse,
//         thoughts: ["Automatically extracted from unstructured response"],
//         time_complexity: "Could not determine from response",
//         space_complexity: "Could not determine from response"
//       };
      
//       res.json(fallbackResponse);
//     }
//   } catch (error) {
//     console.error("Generation error:", error);
//     res.status(500).json({ error: "Generation failed", details: error.message });
//   }
// });

// --- NEW MCQ Answer Generation Endpoint ---
app.post("/api/answer-mcq", async (req, res) => {
  try {
    const { problemInfo } = req.body;
    console.log("Here is the data from body:", { problemInfo });
    
    if (!problemInfo) {
      return res.status(400).json({ error: "No question text provided" });
    }
   
    console.log(`Generating MCQ answer`);
   
    const messages = [
      {
        role: "user",
        content: `Analyze this multiple choice question and provide the correct answer:
${problemInfo}
Provide your response in the following JSON format:
{
  "correctOption": "A", // The letter of the correct option (A, B, C, D, etc.)
  "thoughts": ["reasoning step 1", "reasoning step 2", "reasoning step 3","Final correct answer"],
  "explanation": "Detailed explanation of why this is the correct answer"
}
The response MUST be valid JSON. Make sure to escape any special characters in strings properly.Also provide the final correct answer from the options(Final correct answer should be the last element in the thoughts array).`,
      }
    ];
    
    console.log("Calling Groq API for MCQ answer...");
   
    const chatCompletion = await groq.chat.completions.create({
      messages,
      model: "mistral-saba-24b",
      temperature: 0.2,
      max_completion_tokens: 2048,
      top_p: 0.95,
      stream: false,
      stop: null,
    });
    
    console.log("Groq API MCQ answer call successful");
   
    const fullResponse = chatCompletion.choices[0].message.content;
    console.log("Raw response from model:", fullResponse);
    
    // Process the response to extract valid JSON
    try {
      // First try: Remove markdown formatting and fix potential issues
      const cleanedJson = fullResponse
        .replace(/```json\s*|\s*```/g, '') // Remove markdown code blocks
        .trim();
      
      // Manual parsing to handle unescaped quotes
      let manuallyFixedJson;
      
      // Extract the three main components separately
      const correctOptionMatch = cleanedJson.match(/"correctOption"\s*:\s*"([^"]+)"/);
      const correctOption = correctOptionMatch ? correctOptionMatch[1] : "Not specified";
      
      // Extract thoughts array
      const thoughtsMatch = cleanedJson.match(/"thoughts"\s*:\s*\[([\s\S]*?)\]/);
      let thoughts = ["No specific reasoning provided"];
      if (thoughtsMatch) {
        // Split by commas between array items but be careful with commas inside quotes
        thoughts = thoughtsMatch[1]
          .split(/,(?=\s*")/g) // Split only on commas followed by whitespace and quotes
          .map(item => {
            // Extract just the content inside the quotes
            const contentMatch = item.match(/"([\s\S]*?)"/);
            return contentMatch ? contentMatch[1] : item.trim();
          })
          .filter(item => item.length > 0); // Remove empty items
      }
      
      // Extract explanation by finding the bounds
      const explanationStartIdx = cleanedJson.indexOf('"explanation"');
      let explanation = "No explanation provided";
      
      if (explanationStartIdx !== -1) {
        // Find the start of the actual content (after the colon and opening quote)
        const contentStartIdx = cleanedJson.indexOf(':', explanationStartIdx) + 1;
        const contentStartQuoteIdx = cleanedJson.indexOf('"', contentStartIdx) + 1;
        
        // Find the end quote of the explanation (the last quote before the closing brace)
        const remainingText = cleanedJson.substring(contentStartQuoteIdx);
        let contentEndQuoteIdx = -1;
        
        // Find the last unescaped quote before the end of the JSON
        for (let i = 0; i < remainingText.length; i++) {
          if (remainingText[i] === '"' && 
              (i === 0 || remainingText[i-1] !== '\\') && 
              remainingText.substring(i+1).trim().startsWith('}')) {
            contentEndQuoteIdx = i;
            break;
          }
        }
        
        if (contentEndQuoteIdx !== -1) {
          explanation = remainingText.substring(0, contentEndQuoteIdx)
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"');
        }
      }
      
      // Construct the fixed JSON
      const jsonResponse = {
        correctOption,
        thoughts,
        explanation
      };
      
      console.log("Parsed JSON response:", jsonResponse);
      return res.json(jsonResponse);
    } catch (parseError) {
      console.error("Error parsing JSON from model response:", parseError);
      console.error("Failed response content:", fullResponse);
      
      // Fallback response when all parsing fails
      const fallbackResponse = {
        correctOption: "Could not determine",
        thoughts: ["Failed to parse structured response from model"],
        explanation: fullResponse.replace(/```json\s*|\s*```/g, '').substring(0, 500)
      };
      
      return res.json(fallbackResponse);
    }
  } catch (error) {
    console.error("MCQ answer generation error:", error);
    return res.status(500).json({ 
      error: "MCQ answer generation failed", 
      details: error.message 
    });
  }
});







// --- Debug Endpoint using Groq for Chat Completions ---
// Modify the /api/debug endpoint similarly
app.post("/api/debug", async (req, res) => {
  try {
    const { problemText, language } = req.body;
    console.log("Debug endpoint called with:", {
      languageRequested: language,
      problemTextLength: problemText ? problemText.length : 0,
      problemTextPreview: problemText ? problemText.substring(0, 100) + (problemText.length > 100 ? "..." : "") : "none"
    });
    
    if (!problemText) {
      return res.status(400).json({ error: "No problem text provided" });
    }
    
    const lang = language || "cpp";
    console.log(`Debugging problem in ${lang}`);
    
    const messages = [
      {
        role: "user",
        content: `Debug the following problem in ${lang}:\n${problemText}\n
        Provide your debug solution in the following JSON format:
        {
          "code": "your complete fixed code solution here",
          "thoughts": ["debug observation 1", "debug observation 2", "debug observation 3"], 
          "time_complexity": "O(n) explanation here",
          "space_complexity": "O(n) explanation here"
        }
        
        The response MUST be valid JSON. Make sure to escape any special characters in strings properly.`,
      },
    ];

    console.log("Calling Groq API for debugging...");
    
    // Use non-streaming response
    const chatCompletion = await groq.chat.completions.create({
      messages,
      model: "mistral-saba-24b",
      temperature: 0.6,
      max_completion_tokens: 4096,
      top_p: 0.95,
      stream: false,
      stop: null,
    });

    console.log("Groq API debug call successful");
    
    // Get the full response
    const fullResponse = chatCompletion.choices[0].message.content;
    
    // Extract JSON from the response (handling potential text before/after JSON)
    let jsonResponse;
    try {
      // Find JSON in the response text
      const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonResponse = JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: parse the entire response as JSON
        jsonResponse = JSON.parse(fullResponse);
      }
      
      // Ensure required fields exist
      jsonResponse = {
        code: jsonResponse.code || "",
        thoughts: Array.isArray(jsonResponse.thoughts) ? jsonResponse.thoughts : ["No specific debug observations provided"],
        time_complexity: jsonResponse.time_complexity || "Not specified",
        space_complexity: jsonResponse.space_complexity || "Not specified"
      };
      
      res.json(jsonResponse);
    } catch (error) {
      console.error("Error parsing JSON from model response:", error);
      
      // Fallback: If JSON parsing fails, create a structured response from text
      const fallbackResponse = {
        code: fullResponse.replace(/```[\w]*\n([\s\S]*?)```/g, "$1").trim() || fullResponse,
        thoughts: ["Automatically extracted from unstructured debug response"],
        time_complexity: "Could not determine from response",
        space_complexity: "Could not determine from response"
      };
      
      res.json(fallbackResponse);
    }
  } catch (error) {
    console.error("Debug error:", error);
    res.status(500).json({ error: "Debug generation failed", details: error.message });
  }
});

// Add a test endpoint to verify Groq API connectivity
app.get("/api/test-groq", async (req, res) => {
  try {
    console.log("Testing Groq API connection...");
    const completion = await groq.chat.completions.create({
      messages: [{ role: "user", content: "Hello, can you respond with just the text 'Groq API is working'?" }],
      model: "mistral-saba-24b",
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

app.listen(port, () => {
  console.log(`Server listening on port ${port} at ${new Date().toISOString()}`);
  console.log(`API endpoints available:
  - POST /api/extract - Extract text from images
  - POST /api/generate - Generate solutions from problem text
  - POST /api/debug - Debug code problems
  - GET /api/test-groq - Test Groq API connectivity`);
});

app.get("/cron", (req, res) => {
  console.log(`${new Date().toISOString()} - Cron endpoint called`);
  res.send("happy");
});
