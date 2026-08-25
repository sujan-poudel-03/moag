// ─── session-list webview script ────────────────────────────────────
//
// Runs in the webview. Compiled by tsconfig.webview.session-list.json and loaded
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

      // Session card clicks
      document.querySelectorAll('.session-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.card-delete')) return;
          const runId = card.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'open-run', runId });
          }
        });
      });

      // Thread card clicks
      document.querySelectorAll('.thread-card').forEach(card => {
        card.addEventListener('click', (e) => {
          if (e.target.closest('.card-delete')) return;
          const threadId = card.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'open-thread', threadId });
          }
        });
      });

      // Active run view-details button
      document.querySelectorAll('.active-run-open').forEach(btn => {
        btn.addEventListener('click', () => {
          const runId = btn.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'open-run', runId });
          }
        });
      });

      // Delete buttons (sessions)
      document.querySelectorAll('.card-delete[data-run-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const runId = btn.getAttribute('data-run-id');
          if (runId) {
            vscode.postMessage({ type: 'delete-run', runId });
          }
        });
      });

      // Delete buttons (threads)
      document.querySelectorAll('.card-delete[data-thread-id]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const threadId = btn.getAttribute('data-thread-id');
          if (threadId) {
            vscode.postMessage({ type: 'delete-thread', threadId });
          }
        });
      });

      // Search filtering
      const searchInput = document.getElementById('searchInput');
      const searchEmptyState = document.getElementById('searchEmptyState');
      if (searchInput) {
        const applySearchFilter = () => {
          const query = searchInput.value.toLowerCase().trim();
          let visibleCount = 0;

          document.querySelectorAll('.active-run-card, .session-card, .thread-card').forEach(card => {
            const text = (card.getAttribute('data-search-text') || card.textContent || '').toLowerCase();
            const hidden = query.length > 0 && !text.includes(query);
            card.classList.toggle('search-hidden', hidden);
            if (!hidden) {
              visibleCount++;
            }
          });

          document.querySelectorAll('.section-header').forEach(header => {
            const list = header.nextElementSibling;
            if (!list) return;
            const hasVisibleCards = !!list.querySelector('.session-card:not(.search-hidden), .thread-card:not(.search-hidden)');
            header.classList.toggle('search-hidden', query.length > 0 && !hasVisibleCards);
            if (list.classList.contains('session-list') || list.classList.contains('thread-list')) {
              list.classList.toggle('search-hidden', query.length > 0 && !hasVisibleCards);
            }
          });
          if (searchEmptyState) {
            searchEmptyState.classList.toggle('search-hidden', query.length === 0 || visibleCount > 0);
          }
        };

        searchInput.addEventListener('input', applySearchFilter);
        applySearchFilter();
      }

      // New conversation from footer
      const newPromptInput = document.getElementById('newPromptInput');
      const btnNewConversation = document.getElementById('btnNewConversation');
      const enginePicker = document.getElementById('enginePicker');

      if (btnNewConversation && newPromptInput) {
        const startConversation = () => {
          const text = newPromptInput.value.trim();
          if (!text) return;
          const engine = enginePicker ? enginePicker.value : 'claude';
          vscode.postMessage({ type: 'new-conversation', text, engine });
          newPromptInput.value = '';
        };
        btnNewConversation.addEventListener('click', startConversation);
        newPromptInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            startConversation();
          }
        });
      }
    })();
