// ─── thread-view webview script ─────────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.thread-view.json and loaded
// with <script src>. It used to be returned as a string from a function in
// ui/execution-detail-panel.ts, which is a template literal by another name —
// the compiler never parsed it either way.

/** Provided by the VS Code webview runtime. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- declaration merging
interface Document {
  getElementById(elementId: string): any;
  querySelector(selectors: string): any;
  querySelectorAll(selectors: string): any;
}
(function() {
      const vscode = acquireVsCodeApi();
      const chatArea = document.getElementById('chatArea');
      const replyInput = document.getElementById('replyInput');
      const btnSend = document.getElementById('btnSend');
      const btnBack = document.getElementById('btnBack');
      const streamingRow = document.getElementById('streamingRow');
      const streamingBubble = document.getElementById('streamingBubble');
      const streamingLabel = document.getElementById('streamingLabel');
      let isStreaming = false;
      let streamedText = '';

      function scrollToBottom() {
        const threshold = 50;
        const nearBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < threshold;
        if (nearBottom || !isStreaming) {
          chatArea.scrollTop = chatArea.scrollHeight;
        }
      }
      scrollToBottom();

      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      const btnDelete = document.getElementById('btnDelete');

      btnBack.addEventListener('click', () => {
        vscode.postMessage({ type: 'navigate-back' });
      });

      if (btnDelete) {
        btnDelete.addEventListener('click', () => {
          const threadId = btnDelete.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'delete-thread', threadId });
          }
        });
      }

      function sendReply() {
        const text = replyInput.value.trim();
        if (!text || isStreaming) return;
        replyInput.value = '';
        vscode.postMessage({ type: 'send-reply', text });
      }

      btnSend.addEventListener('click', sendReply);
      replyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendReply();
        }
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
          case 'user-message': {
            const row = document.createElement('div');
            row.className = 'bubble-row user';
            row.innerHTML = '<div><div class="bubble-label">You</div><div class="bubble">' + escapeHtml(msg.text) + '</div></div>';
            chatArea.insertBefore(row, streamingRow);
            scrollToBottom();
            break;
          }
          case 'stream-start': {
            isStreaming = true;
            streamedText = '';
            btnSend.disabled = true;
            replyInput.disabled = true;
            streamingLabel.textContent = msg.engine || '...';
            streamingBubble.innerHTML = '<span class="typing-indicator">Thinking...</span>';
            streamingRow.style.display = '';
            scrollToBottom();
            break;
          }
          case 'stream-chunk': {
            if (streamedText === '') {
              streamingBubble.textContent = '';
            }
            streamedText += msg.text;
            streamingBubble.textContent = streamedText;
            scrollToBottom();
            break;
          }
          case 'stream-end': {
            isStreaming = false;
            btnSend.disabled = false;
            replyInput.disabled = false;
            streamingRow.style.display = 'none';

            const row = document.createElement('div');
            row.className = 'bubble-row assistant';
            const stdout = (msg.entry && msg.entry.result && msg.entry.result.stdout) || streamedText || '(no output)';
            row.innerHTML = '<div><div class="bubble-label">' + escapeHtml(streamingLabel.textContent) + '</div><div class="bubble">' + escapeHtml(stdout) + '</div></div>';
            chatArea.insertBefore(row, streamingRow);
            scrollToBottom();
            replyInput.focus();
            break;
          }
          case 'stream-error': {
            isStreaming = false;
            btnSend.disabled = false;
            replyInput.disabled = false;
            streamingRow.style.display = 'none';

            const row = document.createElement('div');
            row.className = 'bubble-row assistant';
            row.innerHTML = '<div><div class="bubble-label">Error</div><div class="bubble stderr">' + escapeHtml(msg.error || 'Unknown error') + '</div></div>';
            chatArea.insertBefore(row, streamingRow);
            scrollToBottom();
            break;
          }
        }
      });
    })();
