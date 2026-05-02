# Extension Patterns

## Content script (content.js)
- Floating button injected on text selection - check if already injected before adding
- Overlay UI: always remove existing before creating new
- Guard all DOM queries: `const el = document.querySelector(x); if (!el) return;`
- Listen for messages from popup/background via `chrome.runtime.onMessage.addListener`

## Messaging between extension parts
```js
// content -> background
chrome.runtime.sendMessage({ type: 'ANALYZE', data: text });

// background -> content (needs tabId)
chrome.tabs.sendMessage(tabId, { type: 'RESULT', data: result });

// popup reads cached result
chrome.storage.local.get(['lastResult'], ({ lastResult }) => { ... });
```

## chrome.storage patterns
```js
// write
await chrome.storage.local.set({ lastResult: data });

// read
const { lastResult } = await chrome.storage.local.get(['lastResult']);
```

## i18n usage
```js
// Always use i18n helper, never hardcode
const label = i18n.t('explain_button_label');
```

## Hotkeys (background.js)
- Defined in manifest.json commands block
- Handled in background.js via `chrome.commands.onCommand.addListener`
- Background can be killed - do not assume state persists between hotkey events

## Popup (popup.js)
- Reads lastResult from chrome.storage on load
- Does NOT inject content script - background handles that
- Close popup programmatically: `window.close()`