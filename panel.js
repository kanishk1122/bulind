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
  screenshotImage;

// --- State ---
let conversationHistory = [];

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
      modelSel.innerHTML = '<option value="">Error loading models</option>';
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

function debugPing() {
  if (DEBUG) {
    console.log(
      "[Ollama Assistant Panel]",
      "Sending ping to background script"
    );
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
  chrome.runtime.sendMessage({ type: "SET_DEBUG", enabled: DEBUG }, (resp) => {
    if (DEBUG) {
      console.log("[Ollama Assistant Panel]", "SET_DEBUG response", resp);
    }
  });
  // Update button text immediately
  debugToggleBtn.textContent = DEBUG ? "Debug ON" : "Debug OFF";
  debugToggleBtn.style.backgroundColor = DEBUG ? "#4CAF50" : "";
  debugToggleBtn.style.color = DEBUG ? "white" : "black";
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
    const prompt = promptEl.value.trim();
    if (!prompt) {
      resultDiv.textContent = "Write a prompt first.";
      return;
    }

    // Find a suitable multimodal model (e.g., llava, bakllava)
    const multimodalModel = Array.from(modelSel.options).find(
      (opt) => opt.value.includes("llava") || opt.value.includes("bakllava")
    );

    if (!multimodalModel) {
      resultDiv.textContent =
        "Error: No multimodal model (like 'llava' or 'bakllava') found. Please pull one first.";
      return;
    }

    resultDiv.textContent = "Capturing screen and page HTML...";
    screenshotContainer.style.display = "none";
    const model = multimodalModel.value;

    getPageHTMLEval((html) => {
      if (!html) {
        resultDiv.textContent = "Error: Failed to get page HTML.";
        return;
      }

      // Get the windowId for the inspected tab before capturing
      chrome.tabs.get(INSPECTED_TAB_ID, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          resultDiv.textContent = `Error getting tab details: ${
            chrome.runtime.lastError?.message || "Unknown error"
          }`;
          return;
        }

        chrome.tabs.captureVisibleTab(
          tab.windowId, // Use the correct windowId
          { format: "jpeg" },
          (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
              let errorMsg =
                chrome.runtime.lastError?.message || "Unknown error";
              if (errorMsg.toLowerCase().includes("permission")) {
                errorMsg +=
                  "\n\nPlease grant the extension permission to access this page. You might need to click the extension icon in the toolbar and allow access.";
              }
              resultDiv.textContent = `Error capturing screen: ${errorMsg}`;
              return;
            }

            // --- NEW: Show screenshot and wait for click ---
            resultDiv.textContent =
              "Capture complete. Please click on the target element in the screenshot below.";
            screenshotImage.src = dataUrl;
            screenshotContainer.style.display = "block";

            // One-time click listener
            const clickHandler = (event) => {
              screenshotImage.removeEventListener("click", clickHandler);
              screenshotContainer.style.display = "none";

              const rect = event.target.getBoundingClientRect();
              const scaleX = event.target.naturalWidth / rect.width;
              const scaleY = event.target.naturalHeight / rect.height;

              const clickX = Math.round((event.clientX - rect.left) * scaleX);
              const clickY = Math.round((event.clientY - rect.top) * scaleY);

              resultDiv.textContent = `Coordinates [${clickX}, ${clickY}] captured. Sending to Ollama...`;

              // Strip the data URL prefix to get the pure base64 string
              const base64Image = dataUrl.split(",")[1];
              const fullPrompt = `You are an expert web automation assistant. Your goal is to help users by converting their natural language commands into structured JSON actions that can be executed on a web page.

Analyze the user's request, the provided screenshot, the user's click location, and the HTML content to determine the correct action to take.

The user clicked on the screenshot at coordinates [${clickX}, ${clickY}]. This indicates the area of interest for their command. Use this location to identify the target element.

You have the following actions available:
- "click": Clicks on an element. Requires a "selector".
- "type": Types text into an input field. Requires a "selector" and a "value".
- "scroll": Scrolls the main window. Can take a "value" for the vertical position, otherwise defaults.
- "scroll_to_element": Scrolls a specific element into view. Requires a "selector".
- "wait": Pauses execution. Requires a "value" in milliseconds.
- "submit": Submits the form containing a given element. Requires a "selector".
- "navigate": Navigates to a new URL. Requires a "value" for the URL.
- "get_text": Gets the text content of an element. Requires a "selector".
- "get_value": Gets the value of a form element. Requires a "selector".
- "done": Signals that the task is complete. Does not require any other parameters.
- "answer": Respond with a text answer to the user's question. Requires a "value" containing the answer.

Your response MUST be a single JSON object with the following format:
{"action": "action_name", "selector": "css_selector", "value": "text_or_number"}

- The "selector" must be a valid and specific CSS selector.
- The "value" is only required for "type", "wait", "navigate", and "answer" actions.
- If the user's request cannot be fulfilled, respond with: {"action": "error", "message": "I cannot fulfill that request."}

History of previous actions and observations:
${conversationHistory.map((h) => `${h.role}: ${h.content}`).join("\n")}

User Question: ${prompt}

HTML Content:
\`\`\`html
${html}
\`\`\``;

              chrome.runtime.sendMessage(
                {
                  type: "ASK_OLLAMA",
                  model,
                  prompt: fullPrompt,
                  stream: false, // Streaming is not standard with image inputs yet
                  tabId: INSPECTED_TAB_ID,
                  image: base64Image,
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
                  const text =
                    resp.result?.response ||
                    resp.result?.message ||
                    JSON.stringify(resp.result);
                  resultDiv.textContent = text;
                  // Add to history
                  conversationHistory.push({ role: "user", content: prompt });
                  conversationHistory.push({
                    role: "assistant",
                    content: text,
                  });
                }
              );
            };
            screenshotImage.addEventListener("click", clickHandler);
          }
        );
      });
    });
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
  } else if (msg.type === "AUTOMATION_STATUS") {
    const statusDiv = document.createElement("div");
    statusDiv.style.fontWeight = "bold";
    statusDiv.textContent = `ACTION STATUS: ${msg.status.toUpperCase()} - ${
      msg.message
    }`;
    statusDiv.style.color = msg.status === "error" ? "red" : "green";
    resultDiv.appendChild(statusDiv);
    resultDiv.scrollTop = resultDiv.scrollHeight;

    // Add action status to history
    conversationHistory.push({
      role: "assistant",
      content: `Observation: ${msg.message}`,
    });
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

// Setup event listeners
setupEventListeners();

// Initial data load
loadModels();

// Set initial button state
setDebug(false);
