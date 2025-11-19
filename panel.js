// panel.js - Logic for the DevTools panel

// --- Helper functions for page context ---
function getPageContextEval(callback) {
  const code = `
    (() => {
      const title = document.title;
      const url = window.location.href;
      const text = document.body.innerText || document.body.textContent || '';
      return { title, url, text };
    })();
  `;
  chrome.devtools.inspectedWindow.eval(code, (result, isException) => {
    if (isException) {
      console.error("Error getting page context:", isException);
      callback(null);
    } else {
      callback(result);
    }
  });
}

function getPageHTMLEval(callback) {
  const code = `document.documentElement.outerHTML`;
  chrome.devtools.inspectedWindow.eval(code, (result, isException) => {
    if (isException) {
      console.error("Error getting page HTML:", isException);
      callback(null);
    } else {
      callback(result);
    }
  });
}

// Get the tab ID for the inspected window once.
const INSPECTED_TAB_ID = chrome.devtools.inspectedWindow.tabId;

// --- UI Elements (will be assigned in DOMContentLoaded) ---
let usePageBtn,
  promptEl,
  askBtn,
  askWithScreenshotBtn,
  resultDiv,
  modelSel,
  streamChk,
  refreshModelsBtn,
  debugToggleBtn,
  screenshotContainer,
  screenshotImage,
  apiKeyEl,
  saveApiKeyBtn;

// --- State ---
let conversationHistory = [];
let isAutomationRunning = false;
let originalUserPrompt = "";

// --- Function to load models ---
function loadModels() {
  refreshModelsBtn.textContent = "⏳";
  refreshModelsBtn.disabled = true;
  modelSel.innerHTML = '<option value="">Loading...</option>';
  askBtn.disabled = true;
  askWithScreenshotBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "LIST_MODELS" }, (resp) => {
    if (resp && resp.status === "ok" && resp.models && resp.models.models) {
      modelSel.innerHTML = ""; // Clear existing options
      if (resp.models.models.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No models found";
        modelSel.appendChild(option);
        askBtn.disabled = true;
        askWithScreenshotBtn.disabled = true;
      } else {
        resp.models.models.forEach((model) => {
          const option = document.createElement("option");
          option.value = model.name;
          option.textContent = model.name;
          modelSel.appendChild(option);
        });
        askBtn.disabled = false;
        askWithScreenshotBtn.disabled = false;
      }
    } else {
      console.log("Error response:", resp);
      const errorMessage =
        resp?.message || "Unknown error. Is the Ollama server running?";
      modelSel.innerHTML = `<option value="">Error: ${errorMessage}</option>`;
      askBtn.disabled = true;
      askWithScreenshotBtn.disabled = true;
      console.error("Failed to load models:", resp);
    }
    refreshModelsBtn.textContent = "🔄";
    refreshModelsBtn.disabled = false;
  });
}

// --- Debug helpers (omitted for brevity, assume they are present) ---
let DEBUG = false;

function logToUI(message, ...args) {
  if (DEBUG) {
    const logEntry = document.createElement("div");
    logEntry.className = "debug-log";
    const content = args.length > 0 ? JSON.stringify(args, null, 2) : "";
    logEntry.textContent = `[DEBUG] ${message} ${content}`;
    resultDiv.appendChild(logEntry);
    resultDiv.scrollTop = resultDiv.scrollHeight;
    console.log(`[Ollama Assistant Panel] ${message}`, ...args);
  }
}

function debugPing() {
  if (DEBUG) {
    logToUI("Sending ping to background script");
  }
  chrome.runtime.sendMessage({ type: "DEBUG_PING" }, (resp) => {
    if (DEBUG) {
      console.log(
        "[Ollama Assistant Panel]",
        "Background script ping response:",
        resp
      );
    }
  });
}

function setDebug(enabled) {
  DEBUG = !!enabled;
  // Use a try-catch block to prevent "context invalidated" errors if panel is closed
  try {
    chrome.runtime.sendMessage(
      { type: "SET_DEBUG", enabled: DEBUG },
      (resp) => {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError.message);
        } else if (DEBUG) {
          logToUI("SET_DEBUG response", resp);
        }
      }
    );
  } catch (e) {
    console.error("Failed to send SET_DEBUG message:", e.message);
  }
  // Update button text immediately
  debugToggleBtn.textContent = DEBUG ? "Debug ON" : "Debug OFF";
  debugToggleBtn.style.backgroundColor = DEBUG ? "#4CAF50" : "";
  debugToggleBtn.style.color = DEBUG ? "white" : "black";
}

// --- Main Automation Loop ---
function runAutomationLoop() {
  if (!isAutomationRunning) {
    console.log("Automation stopped.");
    askBtn.disabled = false;
    askWithScreenshotBtn.disabled = false;
    askWithScreenshotBtn.textContent = "Ask with Screenshot";
    return;
  }

  resultDiv.textContent = "Capturing screen and page state...";

  getPageHTMLEval((html) => {
    if (!html) {
      resultDiv.textContent =
        "Error: Failed to get page HTML. Stopping automation.";
      isAutomationRunning = false;
      return;
    }

    chrome.tabs.get(INSPECTED_TAB_ID, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resultDiv.textContent = `Error getting tab details: ${
          chrome.runtime.lastError?.message || "Unknown error"
        }. Stopping automation.`;
        isAutomationRunning = false;
        return;
      }

      chrome.tabs.captureVisibleTab(
        tab.windowId,
        { format: "jpeg" },
        (dataUrl) => {
          if (chrome.runtime.lastError || !dataUrl) {
            resultDiv.textContent = `Error capturing screen: ${
              chrome.runtime.lastError?.message || "Unknown error"
            }. Stopping automation.`;
            isAutomationRunning = false;
            return;
          }

          resultDiv.textContent =
            "Analyzing screenshot and deciding next action...";
          const base64Image = dataUrl.split(",")[1];
          const model = Array.from(modelSel.options).find(
            (opt) =>
              opt.value.includes("llava") || opt.value.includes("bakllava")
          )?.value;

          const fullPrompt = `You are an expert web automation assistant. Your goal is to complete the user's request by converting it into a series of structured JSON actions.

Analyze the user's overall goal, the history of your previous actions, the latest observation, the current screenshot, and the HTML content to determine the single next action to take.

You have the following actions available:
- "click": Clicks on an element. Requires a "selector".
- "type": Types text into an input field. Requires a "selector" and a "value".
- "scroll": Scrolls the main window. Can take a "value" for the vertical position.
- "scroll_to_element": Scrolls a specific element into view. Requires a "selector".
- "wait": Pauses execution. Requires a "value" in milliseconds.
- "submit": Submits the form containing a given element. Requires a "selector".
- "navigate": Navigates to a new URL. Requires a "value" for the URL.
- "get_text": Gets the text content of an element. Requires a "selector".
- "get_value": Gets the value of a form element. Requires a "selector".
- "done": Signals that the user's request is complete. Use this when you believe the task is fully finished.
- "answer": Respond with a text answer if the user asks a question you can answer from the context. Requires a "value".

Your response MUST be a single JSON object with the format:
{"action": "action_name", "selector": "css_selector", "value": "text_or_number"}

- The "selector" must be a valid and specific CSS selector.
- If the user's request cannot be fulfilled, respond with: {"action": "error", "message": "I cannot fulfill that request."}

User's Goal: ${originalUserPrompt}

History of previous actions and observations:
${conversationHistory.map((h) => `${h.role}: ${h.content}`).join("\n")}

HTML Content of the current page:
\`\`\`html
${html}
\`\`\``;

          logToUI("Sending request to background script for AI action.");
          chrome.runtime.sendMessage(
            {
              type: "ASK_OLLAMA",
              model,
              prompt: fullPrompt,
              stream: false,
              tabId: INSPECTED_TAB_ID,
              image: base64Image,
              history: conversationHistory, // Send full history for context
            },
            (resp) => {
              if (!resp || resp.status === "error") {
                resultDiv.textContent = `Error from AI: ${
                  resp?.message || "No response"
                }. Stopping automation.`;
                isAutomationRunning = false;
                return;
              }

              const text =
                resp.result?.response ||
                resp.result?.message ||
                JSON.stringify(resp.result);

              // The background script will now handle the action and send a status update,
              // which will trigger the next loop iteration via the message listener.
              // We just display the intended action here.
              resultDiv.textContent = `AI decided action: ${text}`;
              // The 'AUTOMATION_STATUS' message listener will call runAutomationLoop() again.
            }
          );
        }
      );
    });
  });
}

// --- Event Listeners ---
function setupEventListeners() {
  usePageBtn.addEventListener("click", async () => {
    getPageContextEval((context) => {
      if (!context) {
        promptEl.value = "";
        resultDiv.textContent = "Failed to get page context.";
        return;
      }
      const pre = `Page title: ${context.title}\nURL: ${context.url}\n\n${context.text}\n\nQuestion: `;
      promptEl.value = pre;
      resultDiv.textContent = "Page context loaded.";
    });
  });

  refreshModelsBtn.addEventListener("click", loadModels);

  saveApiKeyBtn.addEventListener("click", () => {
    const key = apiKeyEl.value; // Don't trim, key might have spaces
    chrome.storage.local.set({ ollamaApiKey: key }, () => {
      if (chrome.runtime.lastError) {
        resultDiv.textContent = `Error saving API key: ${chrome.runtime.lastError.message}`;
      } else {
        resultDiv.textContent = "API key saved successfully.";
        // Reload models to verify the key
        loadModels();
      }
    });
  });

  askBtn.addEventListener("click", async () => {
    const prompt = promptEl.value.trim();
    if (!prompt) {
      resultDiv.textContent = "Write a prompt first.";
      return;
    }
    resultDiv.textContent = "Waiting for response...";
    const model = modelSel.value;
    const stream = streamChk.checked;

    chrome.runtime.sendMessage(
      {
        type: "ASK_OLLAMA",
        model,
        prompt,
        stream,
        tabId: INSPECTED_TAB_ID,
        history: conversationHistory,
      },
      (resp) => {
        if (!resp) {
          resultDiv.textContent =
            "No response from background. (Service worker may have crashed)";
          return;
        }
        if (resp.status === "error") {
          resultDiv.textContent = "Error: " + resp.message;
          return;
        }
        if (stream) {
          resultDiv.textContent = "";
          // streaming chunks will arrive via chrome.runtime.onMessage
        } else {
          // non-stream response (might be action initiated message)
          const text =
            resp.result?.response ||
            resp.result?.message ||
            JSON.stringify(resp.result);
          resultDiv.textContent = text;
          // Add to history
          conversationHistory.push({ role: "user", content: prompt });
          conversationHistory.push({ role: "assistant", content: text });
        }
      }
    );
  });

  askWithScreenshotBtn.addEventListener("click", async () => {
    if (isAutomationRunning) {
      isAutomationRunning = false;
      askBtn.disabled = false;
      askWithScreenshotBtn.textContent = "Ask with Screenshot";
      resultDiv.textContent = "Automation stopped by user.";
      return;
    }

    originalUserPrompt = promptEl.value.trim();
    if (!originalUserPrompt) {
      resultDiv.textContent = "Write a goal or prompt first.";
      return;
    }

    const multimodalModel = Array.from(modelSel.options).find(
      (opt) => opt.value.includes("llava") || opt.value.includes("bakllava")
    );

    if (!multimodalModel) {
      resultDiv.textContent =
        "Error: No multimodal model (like 'llava' or 'bakllava') found. Please pull one first.";
      return;
    }

    // Start the automation loop
    isAutomationRunning = true;
    conversationHistory = []; // Reset history for a new task
    askBtn.disabled = true;
    askWithScreenshotBtn.textContent = "Stop Automation";
    resultDiv.textContent = "Starting automation...";
    runAutomationLoop();
  });

  debugToggleBtn.addEventListener("click", () => {
    // Toggle the current state
    setDebug(!DEBUG);
  });
}

// --- Message Listeners (OLLAMA_CHUNK, DEBUG_MSG, AUTOMATION_STATUS) ---
chrome.runtime.onMessage.addListener((msg, sender) => {
  // Ignore messages not intended for this panel's tab
  if (msg.tabId && msg.tabId !== INSPECTED_TAB_ID) {
    return;
  }

  if (msg.type === "OLLAMA_CHUNK") {
    resultDiv.textContent += msg.chunk;
    resultDiv.scrollTop = resultDiv.scrollHeight;
  } else if (msg.type === "DEBUG_LOG") {
    // New listener for debug messages from background
    logToUI(msg.message, msg.data);
  } else if (msg.type === "AUTOMATION_STATUS") {
    const statusDiv = document.createElement("div");
    statusDiv.style.fontWeight = "bold";
    statusDiv.textContent = `ACTION STATUS: ${msg.status.toUpperCase()} - ${
      msg.message
    }`;
    statusDiv.style.color = msg.status === "error" ? "red" : "green";
    resultDiv.appendChild(statusDiv);
    resultDiv.scrollTop = resultDiv.scrollHeight;

    // Add action status to history as an observation for the next step
    conversationHistory.push({
      role: "assistant",
      content: `Observation: ${msg.message}`,
    });

    // If the last action was 'done' or an error occurred, stop the loop.
    if (
      msg.action === "done" ||
      msg.action === "error" ||
      msg.status === "error"
    ) {
      isAutomationRunning = false;
      resultDiv.appendChild(document.createTextNode("\nAutomation finished."));
    }

    // Trigger the next step of the loop after a short delay
    setTimeout(() => {
      runAutomationLoop();
    }, 1000);
  }
  // ... debug message handling
});

// --- Initial setup ---
// Assign UI elements
usePageBtn = document.getElementById("usePage");
promptEl = document.getElementById("prompt");
askBtn = document.getElementById("ask");
askWithScreenshotBtn = document.getElementById("askWithScreenshot");
resultDiv = document.getElementById("result");
modelSel = document.getElementById("model");
streamChk = document.getElementById("stream");
refreshModelsBtn = document.getElementById("refreshModels");
debugToggleBtn = document.getElementById("debugToggle");
screenshotContainer = document.getElementById("screenshotContainer");
screenshotImage = document.getElementById("screenshotImage");
apiKeyEl = document.getElementById("apiKey");
saveApiKeyBtn = document.getElementById("saveApiKey");

// Setup event listeners
setupEventListeners();

// Initial data load
chrome.storage.local.get("ollamaApiKey", (data) => {
  if (data.ollamaApiKey) {
    apiKeyEl.value = data.ollamaApiKey;
  }
  loadModels();
});

// Set initial button state
setDebug(false);
