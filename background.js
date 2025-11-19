// background.js

let DEBUG = false;
const OLLAMA_BASE = "http://localhost:11434";

// Store history per tab
const tabHistories = {};

async function callOllamaGenerate(
  model,
  prompt,
  stream,
  tabId,
  image = null,
  history = []
) {
  if (DEBUG) {
    console.log("[Ollama Assistant BG]", "Calling Ollama...", {
      model,
      stream,
      promptLength: prompt.length,
      hasImage: !!image,
      historyLength: history.length,
    });
  }

  const body = { model, prompt, stream };
  if (image) {
    body.images = [image]; // Expects raw Base64 string
  }
  // The new Ollama API format uses a `messages` array for history
  if (history.length > 0) {
    body.messages = [
      ...history,
      { role: "user", content: prompt, images: image ? [image] : undefined },
    ];
    delete body.prompt; // Remove top-level prompt when using messages
    delete body.images; // Images are now inside the message
  }

  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    console.error(
      "[Ollama Assistant BG] Ollama API error:",
      resp.status,
      errorText
    );
    throw new Error(
      `Ollama API error: ${resp.status} ${resp.statusText}. Check server logs for details.`
    );
  }

  if (!stream) {
    const result = await resp.json();
    if (DEBUG) {
      console.log(
        "[Ollama Assistant BG]",
        "Ollama non-stream response",
        result
      );
    }
    return result;
  } else {
    // Handle streaming response
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    // IIFE to handle the stream reading asynchronously
    (async () => {
      try {
        let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            if (DEBUG) {
              console.log("[Ollama Assistant BG]", "Stream finished.");
            }
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop(); // Keep the last, possibly incomplete, line

          for (const line of lines) {
            if (line.trim() === "") continue;
            try {
              const chunkObj = JSON.parse(line);
              // The panel is associated with the inspected tabId.
              // It will receive messages sent to that tabId.
              chrome.runtime.sendMessage({
                type: "OLLAMA_CHUNK",
                chunk: chunkObj.response || "",
                tabId: tabId,
              });
            } catch (e) {
              console.error("Error parsing stream chunk:", e, "Line:", line);
            }
          }
        }
      } catch (e) {
        console.error("Error in background stream reader:", e);
      }
    })();

    // For streaming, we don't have a single result to return,
    // so we return a placeholder or confirmation. The actual data is sent via messages.
    return { response: "Streaming response started...", done: false };
  }
}

function sendPanelMessage(message, tabId) {
  // This is a generic helper to broadcast messages.
  // The panel.js is responsible for filtering messages by tabId.
  chrome.runtime.sendMessage({ ...message, tabId });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      // Debug Control Messages (SET_DEBUG, GET_DEBUG, DEBUG_PING)
      if (message.type === "SET_DEBUG") {
        DEBUG = !!message.enabled;
        if (DEBUG)
          console.log("[Ollama Assistant BG]", "Debug mode set to", DEBUG);
        sendResponse({ status: "ok", debug: DEBUG });
        return;
      } else if (message.type === "GET_DEBUG") {
        sendResponse({ status: "ok", debug: DEBUG });
        return;
      } else if (message.type === "DEBUG_PING") {
        if (DEBUG)
          console.log("[Ollama Assistant BG]", "Ping from panel received");
        sendResponse({ status: "ok", message: "pong" });
        return;
      }

      if (message.type === "ASK_OLLAMA") {
        // FIX: Retrieve tabId directly from the message payload
        const {
          model,
          prompt = "",
          stream = false,
          tabId,
          image = null,
        } = message;

        if (!model) {
          throw new Error(
            "Model not specified. Please select a model from the dropdown."
          );
        }

        // Get history for the current tab
        const history = tabHistories[tabId] || [];

        if (DEBUG) {
          console.log("[Ollama Assistant BG]", "Received ASK_OLLAMA message:", {
            model,
            promptLength: prompt.length,
            stream,
            tabId, // Log the received tabId
            hasImage: !!image,
            historyLength: history.length,
          });
        }

        if (!tabId) {
          throw new Error(
            "Missing tabId in message payload. Cannot perform automation."
          );
        }

        const result = await callOllamaGenerate(
          model,
          prompt,
          stream,
          tabId,
          image,
          history
        );

        if (!stream) {
          // Add user prompt and AI response to history
          if (!tabHistories[tabId]) {
            tabHistories[tabId] = [];
          }
          tabHistories[tabId].push({
            role: "user",
            content: prompt,
            images: image ? [image] : undefined,
          });
          tabHistories[tabId].push({
            role: "assistant",
            content: result.response,
          });

          // Non-streaming path: Check if the result is a structured action command
          let actionCommand = null;
          let responseText = result.response;

          // Sanitize: Extract JSON from markdown code blocks (```json ... ```
          const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch && jsonMatch[1]) {
            responseText = jsonMatch[1];
          }

          try {
            actionCommand = JSON.parse(responseText);
            if (DEBUG) {
              console.log(
                "[Ollama Assistant BG]",
                "Parsed action command:",
                actionCommand
              );
            }
          } catch (e) {
            if (DEBUG) {
              console.log(
                "[Ollama Assistant BG]",
                "AI response was not a structured action JSON."
              );
            }
          }

          if (actionCommand && actionCommand.action) {
            if (actionCommand.action === "error") {
              // AI explicitly returned an error message
              result.response =
                actionCommand.message ||
                "The AI returned an unspecified error.";
              sendResponse({ status: "ok", result });
              return;
            }

            // --- AUTOMATION PATH ---
            if (DEBUG) {
              console.log(
                "[Ollama Assistant BG]",
                `Relaying action '${actionCommand.action}' to Content Script in tab ${tabId}`
              );
            } // Use the passed tabId for sending the message

            chrome.tabs.sendMessage(
              tabId,
              { type: "AUTOMATE_ACTION", command: actionCommand },
              (contentResp) => {
                // Use the original sender.tab.id (if available) or rely on the DevTools panel listener
                const recipientId = tabId; // sender.tab is undefined from devtools, so this is always the inspected tabId

                if (chrome.runtime.lastError) {
                  if (DEBUG) {
                    console.error(
                      "[Ollama Assistant BG] Error sending action to content script:",
                      chrome.runtime.lastError.message
                    );
                  }
                  // Send failure status back to the panel
                  sendPanelMessage(
                    {
                      type: "AUTOMATION_STATUS",
                      status: "error",
                      message: `Failed to communicate with content script: ${chrome.runtime.lastError.message}`,
                    },
                    recipientId
                  );
                } else {
                  if (DEBUG) {
                    console.log(
                      "[Ollama Assistant BG] Content script response:",
                      contentResp
                    );
                  }
                  // Send the Content Script's execution status back to the panel
                  sendPanelMessage(
                    {
                      type: "AUTOMATION_STATUS",
                      status: contentResp.status,
                      message: contentResp.message,
                    },
                    recipientId
                  );
                }
              }
            ); // Send an immediate "Action Initiated" status back to the original DevTools panel call
            sendResponse({
              status: "ok",
              result: {
                response: `Action initiated: ${actionCommand.action}. Awaiting execution status...`,
              },
            });
            return;
          } else {
            // --- STANDARD TEXT RESPONSE PATH ---
            sendResponse({ status: "ok", result });
          }
        } else {
          // Streaming path: already handled in callOllamaGenerate, return confirmation
          sendResponse({ status: "ok", result });
        }
      } else if (message.type === "LIST_MODELS") {
        const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
        if (!resp.ok) {
          throw new Error(
            `Ollama API error: ${resp.status} ${resp.statusText}`
          );
        }
        const models = await resp.json();
        sendResponse({ status: "ok", models });
      } else {
        sendResponse({ status: "error", message: "unknown type" });
      }
    } catch (err) {
      console.error("[Ollama Assistant BG] handler error", err && err.message);
      sendResponse({ status: "error", message: err.message });
    }
  })();
  return true; // Keep channel open for asynchronous sendResponse
});
