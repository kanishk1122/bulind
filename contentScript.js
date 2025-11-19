// popup.js
const usePageBtn = document.getElementById('usePage');
const promptEl = document.getElementById('prompt');
const askBtn = document.getElementById('ask');
const resultDiv = document.getElementById('result');
const modelSel = document.getElementById('model');
const streamChk = document.getElementById('stream');

usePageBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, 'GET_PAGE_CONTEXT', resp => {
    if (!resp) return promptEl.value = '';
    const pre = `Page title: ${resp.title}\nURL: ${resp.url}\n\n${resp.text}\n\nQuestion: `;
    promptEl.value = pre;
  });
});

askBtn.addEventListener('click', async () => {
  const prompt = promptEl.value.trim();
  if (!prompt) {
    resultDiv.textContent = 'Write a prompt first.';
    return;
  }
  resultDiv.textContent = 'Waiting for response...';
  const model = modelSel.value;
  const stream = streamChk.checked;

  chrome.runtime.sendMessage({ type: 'ASK_OLLAMA', model, prompt, stream }, resp => {
    if (!resp) {
      resultDiv.textContent = 'No response from background. (Service worker may have crashed)';
      return;
    }
    if (resp.status === 'error') {
      resultDiv.textContent = 'Error: ' + resp.message;
      return;
    }
    if (stream) {
      resultDiv.textContent = '';
      // streaming chunks will arrive via chrome.runtime.onMessage
    } else {
      // non-stream response
      const text = resp.result?.response || JSON.stringify(resp.result);
      resultDiv.textContent = text;
    }
  });
});

// Receive streaming chunks
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'OLLAMA_CHUNK') {
    resultDiv.textContent += msg.chunk;
    // Auto-scroll
    resultDiv.scrollTop = resultDiv.scrollHeight;
  }
});
