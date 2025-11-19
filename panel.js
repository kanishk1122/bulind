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

// These functions are no longer needed for the visual automation loop.
// function getCleanedPageHTML(callback) { ... }
// function getInteractiveMap(tabId, callback) { ... }
// function getTargetedHTML(tabId, selector, callback) { ... }

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
  if (!chrome.runtime?.id) return; // Safety check
  refreshModelsBtn.textContent = "⏳";
  refreshModelsBtn.disabled = true;
  modelSel.innerHTML = '<option value="">Loading...</option>';
  askBtn.disabled = true;
  askWithScreenshotBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "LIST_MODELS" }, (resp) => {
    if (!chrome.runtime?.id) return; // Safety check inside callback
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

function logStatus(message, isError = false) {
  const entry = document.createElement("div");
  entry.textContent = message;
  if (isError) {
    entry.style.color = "red";
    entry.style.fontWeight = "bold";
  }
  resultDiv.appendChild(entry);
  resultDiv.scrollTop = resultDiv.scrollHeight;
}

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
  if (!chrome.runtime?.id) return;
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
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage(
      { type: "SET_DEBUG", enabled: DEBUG },
      (resp) => {
        if (!chrome.runtime?.id) return;
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

// --- Helper to safely send messages to tab (with retry/injection) ---
function sendMessageToTab(tabId, message, retries = 3) {
  if (!chrome.runtime?.id) {
    console.error(
      "Extension context invalidated. Please close and reopen DevTools."
    );
    return;
  }

  try {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (!chrome.runtime?.id) return; // Context died during request

      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message;
        console.warn(`[Msg Fail] Attempt remaining ${retries}: ${err}`);

        if (retries > 0 && err.includes("Receiving end does not exist")) {
          // Inject the content script again if it's missing
          logStatus("Re-injecting content script...", true);

          if (chrome.tabs.executeScript) {
            chrome.tabs.executeScript(tabId, { file: "content.js" }, () => {
              if (!chrome.runtime?.id) return;
              if (chrome.runtime.lastError) {
                logStatus(
                  "Injection failed: " + chrome.runtime.lastError.message,
                  true
                );
              } else {
                setTimeout(
                  () => sendMessageToTab(tabId, message, retries - 1),
                  500
                );
              }
            });
          } else {
            logStatus(
              "Cannot inject content script: API unavailable. Please reload page.",
              true
            );
          }
        } else {
          logStatus("Error executing action on page: " + err, true);
        }
      } else {
        logStatus(`Action successful: ${response?.message || "OK"}`);
        // Optional: Trigger next loop here if needed
      }
    });
  } catch (e) {
    console.error("Error sending message:", e);
    logStatus("Extension error: " + e.message, true);
  }
}

// --- Main Automation Loop ---
function runAutomationLoop() {
  if (!isAutomationRunning) return;
  if (!chrome.runtime?.id) {
    logStatus("Extension context invalidated. Stopping.", true);
    isAutomationRunning = false;
    return;
  }

  logStatus("Capturing screen for visual analysis...");

  // 1. Capture Screenshot
  chrome.tabs.get(INSPECTED_TAB_ID, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      logStatus(
        `Error getting tab details: ${
          chrome.runtime.lastError?.message || "Unknown error"
        }. Stopping.`,
        true
      );
      isAutomationRunning = false;
      return;
    }
    chrome.tabs.captureVisibleTab(
      tab.windowId,
      { format: "jpeg" },
      (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          logStatus(
            `Error capturing screen: ${
              chrome.runtime.lastError?.message || "Unknown error"
            }. Stopping.`,
            true
          );
          isAutomationRunning = false;
          return;
        }

        const base64Image = dataUrl.split(",")[1];

        // 2. Send Image to LLaVA
        const visionPrompt = `
You are a web automation agent. You are looking at a screenshot of a web page.

User's Goal: "${originalUserPrompt}"

Task: Identify the specific UI element (button, link, input) that the user needs to interact with to achieve their goal.

Output Format:
Return a JSON object containing the coordinates of the element.
Use a 1000x1000 coordinate system (where 0,0 is top-left and 1000,1000 is bottom-right).

Response Schema:
{
  "action": "click" | "type",
  "box_2d": [ymin, xmin, ymax, xmax], 
  "reason": "Brief explanation of why you chose this element"
}

Example:
{"action": "click", "box_2d": [10, 10, 50, 200], "reason": "This is the search bar"}

🚫 STRICT CONSTRAINTS:
- Do NOT return CSS selectors.
- Return ONLY the JSON object.
`;

        if (!chrome.runtime?.id) return;
        chrome.runtime.sendMessage(
          {
            type: "ASK_OLLAMA",
            model: modelSel.value,
            prompt: visionPrompt,
            image: base64Image,
            stream: false,
            tabId: INSPECTED_TAB_ID,
            history: conversationHistory,
          },
          (resp) => {
            if (!resp || resp.status === "error") {
              logStatus(
                `AI failed: ${resp?.message || "No response"}. Stopping.`,
                true
              );
              isAutomationRunning = false;
              return;
            }

            // 3. Handle Response & Execute
            try {
              // 1. Parse the JSON from LLaVA
              const rawText = resp.result?.response ?? "";
              const cleanText = rawText.replace(/```json|```/g, "").trim();

              // Add a check to ensure we aren't parsing a status message
              if (cleanText.startsWith("Action initiated")) {
                // ignore self-generated status messages
                return;
              }

              let aiData;
              try {
                aiData = JSON.parse(cleanText);
              } catch (e) {
                // include the raw cleaned text to make debugging clear
                logStatus(
                  "Failed to parse AI response: " +
                    e.message +
                    " | Raw: " +
                    cleanText,
                  true
                );
                return;
              }

              console.log("[DEBUG] Parsed AI Data:", aiData);

              // 2. Check if we have Coordinates (Vision Approach)
              if (aiData.box_2d && aiData.box_2d.length === 4) {
                const [ymin, xmin, ymax, xmax] = aiData.box_2d;

                // Calculate the center point (normalized 0-1000 scale)
                const centerX = (xmin + xmax) / 2;
                const centerY = (ymin + ymax) / 2;

                // Convert to 0.0 - 1.0 float for the content script
                const normalizedX = centerX / 1000;
                const normalizedY = centerY / 1000;

                logStatus(
                  `AI targeted coordinates: X=${normalizedX.toFixed(
                    2
                  )}, Y=${normalizedY.toFixed(2)}`
                );

                // Use background helper to send to tab reliably
                chrome.runtime.sendMessage(
                  {
                    type: "SEND_TO_TAB",
                    tabId: INSPECTED_TAB_ID,
                    payload: {
                      type: "EXECUTE_COORDINATE_ACTION",
                      action: aiData.action || "click",
                      x: normalizedX,
                      y: normalizedY,
                      value: originalUserPrompt,
                    },
                  },
                  (sendResp) => {
                    if (chrome.runtime.lastError) {
                      logStatus(
                        "Error sending to background: " +
                          chrome.runtime.lastError.message,
                        true
                      );
                    } else if (!sendResp || sendResp.status === "error") {
                      logStatus(
                        "Failed to deliver coordinate action: " +
                          (sendResp?.message || "unknown"),
                        true
                      );
                    } else {
                      logStatus(
                        "Coordinate action forwarded to page: " +
                          (sendResp.message || "OK")
                      );
                    }
                  }
                );
              }
              // 3. Fallback: Check if we have a Selector (HTML Approach)
              else if (aiData.selector) {
                // ... your old selector logic here ...
                logStatus(
                  "AI returned a selector, but this mode is not supported yet.",
                  true
                );
              } else {
                logStatus(
                  "Error: AI did not return valid coordinates or selector.",
                  true
                );
              }
            } catch (e) {
              logStatus("Failed to parse AI response: " + e.message, true);
            }
          }
        );
      }
    );
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

    if (!chrome.runtime?.id) return;
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
        if (!chrome.runtime?.id) return;
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
      logStatus("Automation stopped by user.");
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
    resultDiv.innerHTML = ""; // Clear the log only when starting a new automation task
    askBtn.disabled = true;
    askWithScreenshotBtn.textContent = "Stop Automation";
    logStatus("Starting automation...");
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
      logStatus("Automation finished.");
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
