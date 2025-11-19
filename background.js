// background.js

let DEBUG = false;
const OLLAMA_BASE = "http://localhost:11434";

// Store history per tab
const tabHistories = {};

function logDebug(message, data, tabId) {
  if (DEBUG) {
    console.log(`[Ollama Assistant BG] ${message}`, data || "");
    // Send log to the panel UI if a tabId is provided
    if (tabId) {
      sendPanelMessage(
        { type: "DEBUG_LOG", message, data: data || null },
        tabId
      );
    }
  }
}

async function getHeaders() {
  return new Promise((resolve) => {
    chrome.storage.local.get("ollamaApiKey", (data) => {
      const headers = { "Content-Type": "application/json" };
      if (data.ollamaApiKey) {
        headers["Authorization"] = `Bearer ${data.ollamaApiKey}`;
      }
      resolve(headers);
    });
  });
}

async function callOllamaGenerate(
  model,
  prompt,
  stream,
  tabId,
  image = null,
  history = []
) {
  logDebug("Calling Ollama...", { model, stream, hasImage: !!image }, tabId);

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

  const headers = await getHeaders();
  const resp = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    logDebug("Ollama API error", { status: resp.status, errorText }, tabId);
    throw new Error(
      `Ollama API error: ${resp.status} ${resp.statusText}. Check server logs for details.`
    );
  }

  if (!stream) {
    let result = await resp.json();
    delete result.context;
    logDebug("Ollama non-stream response", result, tabId);
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
          history = [], // Receive history from panel
        } = message;

        if (!model) {
          throw new Error(
            "Model not specified. Please select a model from the dropdown."
          );
        }

        logDebug("Received ASK_OLLAMA message", message, tabId);

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
          // The panel now manages history based on action outcomes.
          // We only add the AI's direct response here.
          const assistantResponse = {
            role: "assistant",
            content: result.response,
          };
          if (!tabHistories[tabId]) tabHistories[tabId] = [];
          tabHistories[tabId].push(assistantResponse);

          // Non-streaming path: Check if the result is a structured action command
          let actionCommand = null;
          let responseText = result.response;

          // --- ROBUST JSON EXTRACTION START ---

          // 1. Try to extract from Markdown code blocks (ignoring the language label like 'css' or 'json')
          // Regex: Matches ``` followed by optional word (language), captures content, ends with ```
          const codeBlockMatch = responseText.match(
            /```(?:\w+)?\s*([\s\S]*?)\s*```/
          );

          if (codeBlockMatch && codeBlockMatch[1]) {
            // If we found a code block, use its content
            responseText = codeBlockMatch[1];
          }

          // 2. Attempt to parse
          try {
            actionCommand = JSON.parse(responseText);
            logDebug(
              "Parsed action command successfully",
              actionCommand,
              tabId
            );
          } catch (e) {
            // 3. Fallback: If direct parsing failed (maybe no backticks, or extra text outside backticks),
            // try to find the first '{' and the last '}' and parse that substring.
            logDebug(
              "Direct parse failed, attempting heuristic JSON extraction...",
              null,
              tabId
            );

            const firstOpen = responseText.indexOf("{");
            const lastClose = responseText.lastIndexOf("}");

            if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
              const potentialJson = responseText.substring(
                firstOpen,
                lastClose + 1
              );
              try {
                actionCommand = JSON.parse(potentialJson);
                logDebug(
                  "Heuristic extraction successful",
                  actionCommand,
                  tabId
                );
              } catch (e2) {
                // If this fails, the JSON is truly malformed
                logDebug("Heuristic extraction failed", e2.message, tabId);
              }
            }
          }

          // --- ROBUST JSON EXTRACTION END ---

          if (!actionCommand) {
            logDebug(
              "AI response was not a structured action JSON.",
              result.response, // log original response
              tabId
            );
            // Self-correction: If the AI responds with text, treat it as an observation and continue the loop.
            sendPanelMessage(
              {
                type: "AUTOMATION_STATUS",
                status: "error",
                message: `AI did not return a valid JSON action. It said: "${result.response.substring(
                  0,
                  100
                )}..."`,
                action: "none", // Special action type to indicate a non-action
              },
              tabId
            );
            sendResponse({
              status: "ok",
              result: {
                response: "AI response was not a valid action. Retrying...",
              },
            });
            return; // Stop further processing for this invalid response
          }

          // CHECK IF JSON IS VALID BUT MISSING THE 'ACTION' KEY
          if (actionCommand && !actionCommand.action) {
            logDebug(
              "AI returned JSON, but it was missing the 'action' key.",
              actionCommand,
              tabId
            );

            // Force a retry or treat as error specifically
            sendPanelMessage(
              {
                type: "AUTOMATION_STATUS",
                status: "error",
                message:
                  "AI returned invalid JSON structure (missing 'action' field).",
                action: "error",
              },
              tabId
            );

            sendResponse({
              status: "ok",
              result: { response: "Invalid JSON structure." },
            });
            return;
          }

          // NOW proceed with your existing check
          if (actionCommand && actionCommand.action) {
            if (
              actionCommand.action === "error" ||
              actionCommand.action === "done" ||
              actionCommand.action === "answer"
            ) {
              // AI explicitly returned a terminal or informational action.
              // Forward this status directly to the panel.
              sendPanelMessage(
                {
                  type: "AUTOMATION_STATUS",
                  status: "ok",
                  message:
                    actionCommand.message ||
                    `Task marked as ${actionCommand.action}.`,
                  action: actionCommand.action, // Pass the action type
                },
                tabId
              );
              // Send a simple response back to the original caller in the panel
              sendResponse({
                status: "ok",
                result: { response: `Action: ${actionCommand.action}` },
              });
              return;
            }

            // --- AUTOMATION PATH ---
            logDebug(
              `Relaying action '${actionCommand.action}' to Content Script`,
              actionCommand,
              tabId
            );

            chrome.tabs.sendMessage(
              tabId,
              { type: "AUTOMATE_ACTION", command: actionCommand },
              (contentResp) => {
                // Use the original sender.tab.id (if available) or rely on the DevTools panel listener
                const recipientId = tabId; // sender.tab is undefined from devtools, so this is always the inspected tabId

                if (chrome.runtime.lastError) {
                  logDebug(
                    "Error sending action to content script",
                    chrome.runtime.lastError.message,
                    recipientId
                  );
                  // Send failure status back to the panel
                  sendPanelMessage(
                    {
                      type: "AUTOMATION_STATUS",
                      status: "error",
                      message: `Failed to communicate with content script: ${chrome.runtime.lastError.message}`,
                      action: actionCommand.action,
                    },
                    recipientId
                  );
                } else {
                  logDebug("Content script response", contentResp, recipientId);
                  // Send the Content Script's execution status back to the panel
                  sendPanelMessage(
                    {
                      type: "AUTOMATION_STATUS",
                      status: contentResp.status,
                      message: contentResp.message,
                      action: actionCommand.action, // Pass the action type
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
            // This path should ideally not be taken in automation mode.
            // We can treat this as a failure to produce an action.
            logDebug(
              "AI returned a standard text response instead of an action.",
              result,
              tabId
            );
            sendPanelMessage(
              {
                type: "AUTOMATION_STATUS",
                status: "error",
                message: `AI did not return a valid JSON action. It said: "${result.response.substring(
                  0,
                  100
                )}..."`,
                action: "none",
              },
              tabId
            );
            sendResponse({ status: "ok", result });
          }
        } else {
          // Streaming path: already handled in callOllamaGenerate, return confirmation
          sendResponse({ status: "ok", result });
        }
      } else if (message.type === "LIST_MODELS") {
        const headers = await getHeaders();
        const resp = await fetch(`${OLLAMA_BASE}/api/tags`, {
          method: "GET",
          headers: headers,
        });
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
      console.error("[Ollama Assistant BG] handler error", err);
      let detailedMessage = err.message;
      if (err.message.includes("Failed to fetch")) {
        detailedMessage = `Failed to connect to Ollama at ${OLLAMA_BASE}. Please ensure the Ollama server is running and accessible.`;
      }
      sendResponse({ status: "error", message: detailedMessage });
    }
  })();
  return true; // Keep channel open for asynchronous sendResponse
});
