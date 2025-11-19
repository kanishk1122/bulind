// devtools.js

chrome.devtools.panels.create(
  "Ollama AI", // Tab Title
  "icons/icon16.png", // Icon Path (Ensure you have a 16x16 icon here)
  "panel.html", // Path to the panel's user interface
  function(panel) {
    console.log("Ollama AI DevTools panel created successfully.");
    // No further actions needed here for basic panel creation
  }
);