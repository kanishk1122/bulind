// contentScript.js - Content script to execute automation commands

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // --- HANDLE VISUAL CLICK ---
  if (message.type === "EXECUTE_COORDINATE_ACTION") {
    // 1. Translate relative (0.5, 0.5) to pixels (960px, 540px)
    const screenX = Math.floor(message.x * window.innerWidth);
    const screenY = Math.floor(message.y * window.innerHeight);

    console.log(`[AI Robot] Clicking at ${screenX}, ${screenY}`);

    // 2. Identify the element at that specific point
    const target = document.elementFromPoint(screenX, screenY);

    if (target) {
      // 3. Highlight it briefly for debugging (Optional)
      const originalBorder = target.style.border;
      target.style.border = "3px solid red";
      setTimeout(() => (target.style.border = originalBorder), 1000);

      // 4. Perform Action
      if (message.action === "click") {
        target.click();
        target.focus();
        sendResponse({
          status: "success",
          message: `Clicked <${target.tagName}>`,
        });
      } else if (message.action === "type") {
        target.focus();
        target.value = message.value;
        // Dispatch input events so React/Vue sites react
        target.dispatchEvent(new Event("input", { bubbles: true }));
        sendResponse({
          status: "success",
          message: `Typed into <${target.tagName}>`,
        });
      }
    } else {
      sendResponse({
        status: "error",
        message: "No element found at coordinates",
      });
    }
    return true; // Keep channel open
  }

  // Optional: Keep GET_PAGE_CONTEXT listener for compatibility, though DevTools panel might use eval()
  if (message && message.type === "GET_PAGE_CONTEXT") {
    const title = document.title;
    const url = window.location.href;
    const text = document.body.innerText || document.body.textContent || "";
    sendResponse({ title, url, text });
    return true; // Keep channel open for async response
  }

  // --- AUTOMATION ACTION HANDLER ---
  else if (message && message.type === "AUTOMATE_ACTION") {
    const { action, selector, value } = message.command;
    let status = "error";
    let responseMessage = `Action '${action}' failed.`;

    try {
      // Some actions don't need a selector, handle them first.
      if (action === "wait") {
        const waitTime = parseInt(value, 10) || 1000;
        setTimeout(() => {
          sendResponse({
            status: "ok",
            message: `Successfully waited for ${waitTime}ms`,
          });
        }, waitTime);
        return true; // Return true for async response
      } else if (action === "done") {
        status = "ok";
        responseMessage = "Task marked as complete.";
      } else if (action === "answer") {
        status = "ok";
        responseMessage = `AI answered: ${value}`;
      } else if (action === "navigate") {
        if (!value) {
          responseMessage = `Navigate action missing value parameter for URL.`;
        } else {
          window.location.href = value;
          status = "ok";
          responseMessage = `Successfully navigated to ${value}`;
        }
      } else if (action === "scroll") {
        window.scrollTo({
          top: value || 500, // Scroll to a position or default to 500px down
          behavior: "smooth",
        });
        status = "ok";
        responseMessage = `Successfully scrolled window to position: ${
          value || 500
        }`;
        // Fall through to sendResponse at the end
      } else {
        // Actions that require a selector.
        const element = document.querySelector(selector);
        if (!element) {
          responseMessage = `Element not found for selector: ${selector}`;
        } else {
          switch (action) {
            case "click":
              element.click();
              status = "ok";
              responseMessage = `Successfully clicked element using selector: ${selector}`;
              break;

            case "type":
              if (value === undefined || value === null) {
                responseMessage = `Type action missing value parameter for selector: ${selector}`;
                break;
              }
              // Set the value and dispatch events to ensure web apps recognize the change
              element.value = value;
              element.dispatchEvent(new Event("input", { bubbles: true }));
              element.dispatchEvent(new Event("change", { bubbles: true }));
              status = "ok";
              responseMessage = `Successfully typed "${value.substring(
                0,
                20
              )}..." into: ${selector}`;
              break;

            case "scroll_to_element":
              element.scrollIntoView({ behavior: "smooth", block: "center" });
              status = "ok";
              responseMessage = `Successfully scrolled element into view: ${selector}`;
              break;

            case "get_text":
              status = "ok";
              // Return the element's text content as the message
              responseMessage = element.innerText || element.textContent;
              break;

            case "get_value":
              status = "ok";
              // Return the element's value property
              responseMessage = element.value;
              break;

            case "submit":
              if (element.form) {
                element.form.submit();
                status = "ok";
                responseMessage = `Successfully submitted form containing element: ${selector}`;
              } else {
                responseMessage = `Element is not in a form to submit: ${selector}`;
              }
              break;

            default:
              responseMessage = `Unknown automation action: ${action}`;
          }
        }
      }
    } catch (e) {
      responseMessage = `Execution error for action '${action}': ${e.message}`;
      console.error(responseMessage, e);
    }

    // Send the result of the action execution back to the background script
    sendResponse({
      status: status,
      message: responseMessage,
    });
    return true; // Keep channel open for async response
  }
});
