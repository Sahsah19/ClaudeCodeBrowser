/**
 * ClaudeCodeBrowser - Background Script
 * Handles native messaging, tab management, and coordination with content scripts
 *
 * MIT License
 * Copyright (c) 2025 Andre Watson (nanogenomic), Ligandal Inc.
 * Author: dre@ligandal.com
 */

const NATIVE_HOST_NAME = "claudecodebrowser";
let nativePort = null;
let isConnected = false;
let pendingRequests = new Map();
let requestCounter = 0;

// Reconnection settings
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
const INITIAL_RECONNECT_DELAY = 1000;  // 1 second
const MAX_RECONNECT_DELAY = 30000;     // 30 seconds

// Calculate exponential backoff delay
function getReconnectDelay() {
  const delay = Math.min(
    INITIAL_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  return delay;
}

// Connect to native messaging host
function connectNativeHost() {
  if (isConnected && nativePort) {
    console.log("[ClaudeCodeBrowser] Already connected");
    return;
  }

  try {
    console.log(`[ClaudeCodeBrowser] Connecting to native host (attempt ${reconnectAttempts + 1})...`);
    nativePort = browser.runtime.connectNative(NATIVE_HOST_NAME);
    isConnected = true;
    reconnectAttempts = 0;  // Reset on successful connection
    console.log("[ClaudeCodeBrowser] Connected to native host");

    nativePort.onMessage.addListener(handleNativeMessage);
    nativePort.onDisconnect.addListener(handleDisconnect);
  } catch (error) {
    console.error("[ClaudeCodeBrowser] Failed to connect to native host:", error);
    isConnected = false;
    nativePort = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[ClaudeCodeBrowser] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    // Reset after a long delay to try again eventually
    setTimeout(() => {
      reconnectAttempts = 0;
      connectNativeHost();
    }, 60000);  // Try again after 1 minute
    return;
  }

  const delay = getReconnectDelay();
  reconnectAttempts++;
  console.log(`[ClaudeCodeBrowser] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  setTimeout(connectNativeHost, delay);
}

function handleDisconnect(port) {
  console.log("[ClaudeCodeBrowser] Disconnected from native host");
  if (port.error) {
    console.error("[ClaudeCodeBrowser] Disconnect error:", port.error);
  }
  isConnected = false;
  nativePort = null;

  // Reject all pending requests with a descriptive error
  for (const [id, { reject }] of pendingRequests) {
    reject(new Error("Native host disconnected - reconnecting..."));
  }
  pendingRequests.clear();

  // Schedule reconnection with exponential backoff
  scheduleReconnect();
}

function handleNativeMessage(message) {
  console.log("[ClaudeCodeBrowser] Received from native host:", message);

  if (message.requestId && pendingRequests.has(message.requestId)) {
    const { resolve, reject } = pendingRequests.get(message.requestId);
    pendingRequests.delete(message.requestId);

    if (message.error) {
      reject(new Error(message.error));
    } else {
      resolve(message);
    }
  } else if (message.action) {
    // Handle incoming commands from native host (i.e. from the MCP server)
    handleCommand(message, { fromAgent: true });
  }
}

function sendToNativeHost(message, retryCount = 0) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  return new Promise((resolve, reject) => {
    // Try to connect if not connected
    if (!isConnected || !nativePort) {
      connectNativeHost();

      // Wait a bit for connection to establish
      setTimeout(() => {
        if (!isConnected || !nativePort) {
          if (retryCount < MAX_RETRIES) {
            console.log(`[ClaudeCodeBrowser] Not connected, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
            setTimeout(() => {
              sendToNativeHost(message, retryCount + 1)
                .then(resolve)
                .catch(reject);
            }, RETRY_DELAY);
          } else {
            reject(new Error("Not connected to native host after retries"));
          }
          return;
        }

        // Now connected, send the message
        doSend();
      }, 500);
      return;
    }

    doSend();

    function doSend() {
      const requestId = ++requestCounter;
      message.requestId = requestId;
      pendingRequests.set(requestId, { resolve, reject });

      // Timeout after 30 seconds
      const timeoutId = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject(new Error("Request timeout"));
        }
      }, 30000);

      // Store timeout for potential cleanup
      pendingRequests.get(requestId).timeoutId = timeoutId;

      try {
        nativePort.postMessage(message);
      } catch (error) {
        pendingRequests.delete(requestId);
        clearTimeout(timeoutId);

        // Connection might have died, try to reconnect and retry
        if (retryCount < MAX_RETRIES) {
          console.log(`[ClaudeCodeBrowser] Send failed, reconnecting and retrying...`);
          isConnected = false;
          nativePort = null;
          setTimeout(() => {
            sendToNativeHost(message, retryCount + 1)
              .then(resolve)
              .catch(reject);
          }, RETRY_DELAY);
        } else {
          reject(error);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Agent workspace
//
// Like Claude in Chrome's tab group: the agent works in its own "Claude" tab
// group (or, on Firefox without tab-group support, its own window). Commands
// from the MCP server that don't name a tab act on the workspace's current
// tab, never on whatever tab the user happens to be looking at. New agent tabs
// open in the workspace in the background.
// ---------------------------------------------------------------------------

const WORKSPACE_TITLE = "Claude";
const WORKSPACE_COLOR = "orange";

const workspace = {
  mode: null,          // "group" | "window" | null when there is no workspace
  groupId: null,       // group mode
  windowId: null,      // window mode: the dedicated window
  tabIds: new Set(),
  activeTabId: null    // the tab agent commands default to
};

// Actions that don't operate on a single page, so no default tab is filled in.
const NON_TAB_ACTIONS = new Set([
  "getTabs", "findTabs", "createTab", "closeTab", "focusTab", "getTabInfo",
  "reloadAll", "reloadByUrl", "screenshotAllTabs",
  "createWorkspace", "closeWorkspace", "status", "ping"
]);

function supportsTabGroups() {
  return typeof browser.tabs.group === "function";
}

function resetWorkspace() {
  workspace.mode = null;
  workspace.groupId = null;
  workspace.windowId = null;
  workspace.tabIds.clear();
  workspace.activeTabId = null;
}

function workspaceInfo() {
  return {
    exists: workspace.mode !== null,
    mode: workspace.mode,
    groupId: workspace.groupId,
    windowId: workspace.windowId,
    tabIds: [...workspace.tabIds],
    activeTabId: workspace.activeTabId
  };
}

// Drop tabs that no longer exist; returns true if a workspace is still usable.
async function pruneWorkspace() {
  if (workspace.mode === null) return false;
  for (const id of [...workspace.tabIds]) {
    try {
      await browser.tabs.get(id);
    } catch (e) {
      workspace.tabIds.delete(id);
    }
  }
  if (workspace.tabIds.size === 0) {
    resetWorkspace();
    return false;
  }
  if (!workspace.tabIds.has(workspace.activeTabId)) {
    workspace.activeTabId = [...workspace.tabIds].pop();
  }
  return true;
}

async function lastFocusedNormalWindow() {
  try {
    return await browser.windows.getLastFocused({ windowTypes: ["normal"] });
  } catch (e) {
    return null;
  }
}

async function labelGroup(groupId) {
  // tabGroups.update needs Firefox 139+ and the "tabGroups" permission; the
  // group works without a title, so failures are ignored.
  try {
    if (browser.tabGroups && browser.tabGroups.update) {
      await browser.tabGroups.update(groupId, { title: WORKSPACE_TITLE, color: WORKSPACE_COLOR });
    }
  } catch (e) {
    console.warn("[ClaudeCodeBrowser] Could not label workspace group:", e);
  }
}

async function createWorkspaceWindow(url, previousWindow) {
  const win = await browser.windows.create({ url, focused: false });
  // Some Firefox versions focus new windows regardless; hand focus back.
  if (previousWindow && previousWindow.focused) {
    try {
      await browser.windows.update(previousWindow.id, { focused: true });
    } catch (e) { /* window may be gone */ }
  }
  workspace.mode = "window";
  workspace.windowId = win.id;
  workspace.groupId = null;
  const tabs = win.tabs || await browser.tabs.query({ windowId: win.id });
  tabs.forEach(t => workspace.tabIds.add(t.id));
  workspace.activeTabId = tabs[0].id;
  return tabs[0];
}

async function createWorkspace(data = {}) {
  if (await pruneWorkspace()) {
    return { success: true, created: false, workspace: workspaceInfo() };
  }
  const url = data.url || "about:blank";
  const wantMode = data.mode || "auto";
  const previousWindow = await lastFocusedNormalWindow();
  let tab;
  let note;

  if (wantMode !== "window" && supportsTabGroups()) {
    const createOpts = { url, active: false };
    if (previousWindow) createOpts.windowId = previousWindow.id;
    tab = await browser.tabs.create(createOpts);
    try {
      const groupId = await browser.tabs.group({ tabIds: [tab.id] });
      await labelGroup(groupId);
      workspace.mode = "group";
      workspace.groupId = groupId;
      workspace.windowId = null;
      workspace.tabIds.add(tab.id);
      workspace.activeTabId = tab.id;
    } catch (e) {
      // Grouping failed (e.g. private window restrictions): use a window.
      note = `Tab groups unavailable (${e.message}); using a separate window.`;
      await browser.tabs.remove(tab.id).catch(() => {});
      tab = await createWorkspaceWindow(url, previousWindow);
    }
  } else {
    if (wantMode === "group") {
      note = "This Firefox has no tab group support (needs Firefox 138+); using a separate window.";
    }
    tab = await createWorkspaceWindow(url, previousWindow);
  }

  const result = {
    success: true,
    created: true,
    workspace: workspaceInfo(),
    tab: { id: tab.id, url: tab.url, title: tab.title }
  };
  if (note) result.note = note;
  return result;
}

async function ensureWorkspace() {
  if (await pruneWorkspace()) return;
  await createWorkspace({});
}

// Open a new background tab inside the workspace (creating it if needed).
async function openWorkspaceTab(url = "about:blank") {
  if (!(await pruneWorkspace())) {
    const created = await createWorkspace({ url });
    return browser.tabs.get(created.tab.id);
  }

  let tab;
  if (workspace.mode === "group") {
    const anchor = await browser.tabs.get(workspace.activeTabId);
    tab = await browser.tabs.create({ url, active: false, windowId: anchor.windowId });
    try {
      await browser.tabs.group({ groupId: workspace.groupId, tabIds: [tab.id] });
    } catch (e) {
      // The group vanished (e.g. the user ungrouped it): start a new one.
      workspace.groupId = await browser.tabs.group({ tabIds: [tab.id, ...workspace.tabIds] });
      await labelGroup(workspace.groupId);
    }
  } else {
    tab = await browser.tabs.create({ url, active: false, windowId: workspace.windowId });
  }
  workspace.tabIds.add(tab.id);
  workspace.activeTabId = tab.id;
  return tab;
}

async function closeWorkspace(data = {}) {
  if (!(await pruneWorkspace())) {
    return { success: true, closed: false, note: "No workspace was open." };
  }
  const ids = [...workspace.tabIds];
  const info = workspaceInfo();
  if (data.keepTabs) {
    if (workspace.mode === "group" && browser.tabs.ungroup) {
      await browser.tabs.ungroup(ids).catch(() => {});
    }
    resetWorkspace();
    return { success: true, closed: false, keptTabIds: ids, workspace: info };
  }
  if (workspace.mode === "window") {
    await browser.windows.remove(workspace.windowId).catch(() => {});
  } else {
    await browser.tabs.remove(ids).catch(() => {});
  }
  resetWorkspace();
  return { success: true, closed: true, closedTabIds: ids, workspace: info };
}

// Fill in the tab an agent command acts on. An explicit tabId always wins;
// otherwise the workspace's current tab is used (created on first use).
async function resolveAgentTabId(action, tabId, data = {}) {
  if (tabId) {
    if (workspace.tabIds.has(tabId)) workspace.activeTabId = tabId;
    return tabId;
  }
  if (NON_TAB_ACTIONS.has(action)) return tabId;
  // navigate(new_tab) opens its own workspace tab; don't create a blank one first.
  if (action === "navigate" && data && data.newTab) return tabId;
  await ensureWorkspace();
  return workspace.activeTabId;
}

// Tabs that multi-tab tools may touch: the workspace's, unless the caller
// explicitly opts into the user's tabs.
async function scopedTabs(options = {}) {
  const tabs = await browser.tabs.query({});
  if (options.includeUserTabs) return tabs;
  await pruneWorkspace();
  return tabs.filter(t => workspace.tabIds.has(t.id));
}

// Keep membership in sync with what happens in the browser.
browser.tabs.onRemoved.addListener((tabId) => {
  if (!workspace.tabIds.delete(tabId)) return;
  if (workspace.tabIds.size === 0) {
    resetWorkspace();
  } else if (workspace.activeTabId === tabId) {
    workspace.activeTabId = [...workspace.tabIds].pop();
  }
});

browser.windows.onRemoved.addListener((windowId) => {
  if (workspace.mode === "window" && workspace.windowId === windowId) {
    resetWorkspace();
  }
});

// Group mode: dragging a tab into the Claude group shares it with the agent;
// dragging one out takes it back.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (workspace.mode !== "group" || changeInfo.groupId === undefined) return;
  if (changeInfo.groupId === workspace.groupId) {
    workspace.tabIds.add(tabId);
  } else if (workspace.tabIds.has(tabId)) {
    workspace.tabIds.delete(tabId);
    if (workspace.tabIds.size === 0) {
      resetWorkspace();
    } else if (workspace.activeTabId === tabId) {
      workspace.activeTabId = [...workspace.tabIds].pop();
    }
  }
});

// Handle commands from native host. Commands from the MCP server (fromAgent)
// are scoped to the agent workspace; popup/content-script messages are not.
async function handleCommand(message, { fromAgent = false } = {}) {
  const { action, data } = message;
  let { tabId } = message;
  let result = { success: false };

  try {
    if (fromAgent) {
      tabId = await resolveAgentTabId(action, tabId, data);
    }
    switch (action) {
      case "createWorkspace":
        result = await createWorkspace(data);
        break;
      case "closeWorkspace":
        result = await closeWorkspace(data);
        break;
      case "screenshot":
        result = await takeScreenshot(tabId, data);
        break;
      case "click":
        result = await performClick(tabId, data);
        break;
      case "type":
        result = await performType(tabId, data);
        break;
      case "scroll":
        result = await performScroll(tabId, data);
        break;
      case "navigate":
        result = await navigateTo(tabId, data);
        break;
      case "getPageInfo":
        result = await getPageInfo(tabId);
        break;
      case "getElements":
        result = await getElements(tabId, data);
        break;
      case "executeScript":
        result = await executeScript(tabId, data);
        break;
      case "highlight":
        result = await highlightElement(tabId, data);
        break;
      case "waitForElement":
        result = await waitForElement(tabId, data);
        break;
      case "getTabs":
        result = await getAllTabs(data);
        break;
      case "createTab":
        result = await createNewTab(data);
        break;
      case "closeTab":
        result = await closeTab(tabId);
        break;
      case "focusTab":
        result = await focusTab(tabId);
        break;
      case "getTabInfo":
        result = await getTabInfo(tabId);
        break;
      case "findTabs":
        result = await findTabs(data);
        break;
      case "screenshotAllTabs":
        result = await screenshotAllTabs(data);
        break;
      case "refresh":
      case "reload":
        result = await refreshTab(tabId, data);
        break;
      case "hardRefresh":
        result = await hardRefreshTab(tabId);
        break;
      case "reloadAll":
        result = await reloadAllTabs(data);
        break;
      case "reloadByUrl":
        result = await reloadTabsByUrl(data);
        break;
      case "goBack":
        result = await navigateHistory(tabId, "back");
        break;
      case "goForward":
        result = await navigateHistory(tabId, "forward");
        break;
      case "requestApproval":
        result = await requestApproval(tabId, data);
        break;
      case "solveCaptcha":
        result = await solveCaptcha(tabId, data);
        break;
      // Element interaction and dynamic-content commands implemented by the
      // content script — forwarded as-is
      case "getValue":
      case "setValue":
      case "selectOption":
      case "hover":
      case "getAttribute":
      case "focus":
      case "getComputedStyles":
      case "getBoundingRect":
      case "waitForChange":
      case "waitForNetworkIdle":
      case "observeElement":
      case "stopObserving":
      case "scrollAndCapture":
      case "clickAndWait":
      case "pressKey":
      case "getText":
        result = await sendToContentScript(tabId, { action, ...data });
        break;
      // Console and network logging commands
      case "startLogging":
        result = await sendToContentScript(tabId, { action: "startLogging", ...data });
        break;
      case "stopLogging":
        result = await sendToContentScript(tabId, { action: "stopLogging" });
        break;
      case "getConsoleLogs":
        result = await sendToContentScript(tabId, { action: "getConsoleLogs", ...data });
        break;
      case "getNetworkLogs":
        result = await sendToContentScript(tabId, { action: "getNetworkLogs", ...data });
        break;
      case "clearLogs":
        result = await sendToContentScript(tabId, { action: "clearLogs", ...data });
        break;
      default:
        result = { success: false, error: `Unknown action: ${action}` };
    }
  } catch (error) {
    result = { success: false, error: error.message };
  }

  // Send result back to native host
  if (nativePort && message.requestId) {
    nativePort.postMessage({
      requestId: message.requestId,
      ...result
    });
  }

  return result;
}

// Screenshot functionality
async function takeScreenshot(tabId, options = {}) {
  try {
    const targetTab = tabId
      ? await browser.tabs.get(tabId)
      : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    const shot = await captureTabImage(targetTab, options);
    return {
      success: true,
      data: shot.dataUrl,
      type: shot.type,
      method: shot.method,
      ...(shot.note ? { note: shot.note } : {}),
      tab: { id: targetTab.id, url: targetTab.url, title: targetTab.title },
      wasFocused: shot.method === "focus-switch"
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Largest full-page capture we attempt, in CSS pixels (Firefox canvas limits).
const MAX_FULL_PAGE_HEIGHT = 16000;

// Capture a tab while disturbing the user as little as possible:
//   1. tabs.captureTab (Firefox 59+) renders any tab, active or not, with no
//      focus change. It also supports a rect, which gives real full-page shots.
//   2. If the tab is already the visible tab of its window (e.g. in the
//      workspace window), captureVisibleTab on that window.
//   3. Last resort: briefly activate the tab, capture, then restore the
//      window's previous tab and the previously focused window.
async function captureTabImage(tab, options = {}) {
  const imageOpts = { format: options.format || "png", quality: options.quality || 90 };

  if (typeof browser.tabs.captureTab === "function") {
    if (options.fullPage) {
      try {
        const dims = await browser.tabs.sendMessage(tab.id, { action: "captureFullPage" });
        const height = Math.min(dims.scrollHeight, MAX_FULL_PAGE_HEIGHT);
        const dataUrl = await browser.tabs.captureTab(tab.id, {
          ...imageOpts,
          rect: { x: 0, y: 0, width: dims.scrollWidth, height }
        });
        const note = dims.scrollHeight > height
          ? `Page is ${dims.scrollHeight}px tall; capture truncated at ${height}px.` : undefined;
        return { dataUrl, type: "fullPage", method: "captureTab", note };
      } catch (e) {
        // Fall through to a visible-area capture.
        console.warn("[ClaudeCodeBrowser] Full-page capture failed:", e);
      }
    }
    try {
      const dataUrl = await browser.tabs.captureTab(tab.id, imageOpts);
      return {
        dataUrl, type: "visible", method: "captureTab",
        note: options.fullPage ? "Full-page capture failed; returned the visible area." : undefined
      };
    } catch (e) {
      console.warn("[ClaudeCodeBrowser] captureTab failed, falling back:", e);
    }
  }

  const note = options.fullPage ? "Full-page capture unsupported here; returned the visible area." : undefined;

  if (tab.active) {
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, imageOpts);
    return { dataUrl, type: "visible", method: "captureVisibleTab", note };
  }

  // Temporarily switch tabs, then put everything back the way the user had it.
  const [previousTab] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  const focusedWindow = await lastFocusedNormalWindow();
  try {
    await browser.tabs.update(tab.id, { active: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, imageOpts);
    return { dataUrl, type: "visible", method: "focus-switch", note };
  } finally {
    if (previousTab && previousTab.id !== tab.id) {
      await browser.tabs.update(previousTab.id, { active: true }).catch(() => {});
    }
    const nowFocused = await lastFocusedNormalWindow();
    if (focusedWindow && focusedWindow.focused && nowFocused && nowFocused.id !== focusedWindow.id) {
      await browser.windows.update(focusedWindow.id, { focused: true }).catch(() => {});
    }
  }
}

// Screenshot several tabs. Defaults to the workspace's tabs; the user's own
// tabs are included only with includeUserTabs.
async function screenshotAllTabs(options = {}) {
  try {
    let targetTabs = (await scopedTabs(options))
      .filter(t => !t.url.startsWith('about:') && !t.url.startsWith('moz-extension:'));

    if (options.urlPattern) {
      const regex = new RegExp(options.urlPattern);
      targetTabs = targetTabs.filter(t => regex.test(t.url));
    }

    const results = [];
    for (const tab of targetTabs) {
      try {
        const shot = await captureTabImage(tab, options);
        results.push({
          success: true,
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          method: shot.method,
          data: options.includeData ? shot.dataUrl : undefined,
          timestamp: Date.now()
        });
      } catch (e) {
        results.push({ success: false, tabId: tab.id, url: tab.url, error: e.message });
      }
    }

    return {
      success: true,
      scope: options.includeUserTabs ? "all_tabs" : "workspace",
      screenshots: results,
      count: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Human approval: OS notification to catch the user's attention, plus an
// in-page Approve/Deny banner (content script) that carries the decision
async function requestApproval(tabId, data = {}) {
  try {
    if (browser.notifications) {
      await browser.notifications.create({
        type: "basic",
        title: "Claude requests approval",
        message: (data.message || "Claude wants to perform an action").slice(0, 200),
        iconUrl: browser.runtime.getURL("icons/icon-48.png")
      });
    }
  } catch (e) {
    // Notifications unavailable — the in-page banner still works
  }
  return sendToContentScript(tabId, { action: "requestApproval", ...data });
}

// Captcha handoff: notify the human (unless it's a detect-only probe), then
// let the content script show the solve banner and wait for completion
async function solveCaptcha(tabId, data = {}) {
  if (!data.detectOnly) {
    try {
      if (browser.notifications) {
        await browser.notifications.create({
          type: "basic",
          title: "Captcha needs solving",
          message: "Claude paused on a captcha and needs you to solve it.",
          iconUrl: browser.runtime.getURL("icons/icon-48.png")
        });
      }
    } catch (e) {
      // Notifications unavailable — the in-page banner still works
    }
  }
  return sendToContentScript(tabId, { action: "solveCaptcha", ...data });
}

// History navigation (Back/Forward buttons)
async function navigateHistory(tabId, direction) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (direction === "back") {
      await browser.tabs.goBack(tab.id);
    } else {
      await browser.tabs.goForward(tab.id);
    }
    // Give the navigation a moment to commit before reporting the new URL
    await new Promise(resolve => setTimeout(resolve, 300));
    const updated = await browser.tabs.get(tab.id);
    return { success: true, url: updated.url, title: updated.title };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Generic helper to send message to content script
async function sendToContentScript(tabId, message) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    const result = await browser.tabs.sendMessage(tab.id, message);
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Click functionality
async function performClick(tabId, data) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.sendMessage(tab.id, {
      action: "click",
      ...data
    });

    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Type functionality
async function performType(tabId, data) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.sendMessage(tab.id, {
      action: "type",
      ...data
    });

    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Scroll functionality
async function performScroll(tabId, data) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.sendMessage(tab.id, {
      action: "scroll",
      ...data
    });

    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Navigation
async function navigateTo(tabId, data) {
  try {
    let tab;
    if (data.newTab) {
      // Open a fresh background tab in the agent workspace. Never reuse the
      // active tab: that is the bug new_tab used to have.
      tab = await openWorkspaceTab(data.url);
    } else {
      tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
      await browser.tabs.update(tab.id, { url: data.url });
    }

    const loaded = data.url === "about:blank" || await waitForTabLoad(tab.id, 30000);
    const result = { success: true, url: data.url, tabId: tab.id, newTab: !!data.newTab };
    if (!loaded) result.note = "Navigation initiated but completion not confirmed";
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Resolve true once the tab finishes loading a real page, false on timeout.
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(value);
    };
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete" && tab.url !== "about:blank") {
        finish(true);
      }
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// Get page information
async function getPageInfo(tabId) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.sendMessage(tab.id, {
      action: "getPageInfo"
    });

    return {
      success: true,
      tab: { id: tab.id, url: tab.url, title: tab.title },
      ...result
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get elements by selector
async function getElements(tabId, data) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.sendMessage(tab.id, {
      action: "getElements",
      ...data
    });

    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Execute arbitrary script
async function executeScript(tabId, data) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.executeScript(tab.id, {
      code: data.script
    });

    return { success: true, result: result[0] };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Highlight element
async function highlightElement(tabId, data) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.sendMessage(tab.id, {
      action: "highlight",
      ...data
    });

    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Wait for element
async function waitForElement(tabId, data) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    const result = await browser.tabs.sendMessage(tab.id, {
      action: "waitForElement",
      ...data
    });

    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Tab management
async function getAllTabs(options = {}) {
  try {
    // Default scope: the window Claude is actually driving, not every
    // window/tab in the user's browser. With dozens of tabs open, querying
    // {} and returning full metadata per tab blows past response size
    // limits. Opt into the wider view explicitly when needed.
    const currentWindowOnly = options.current_window_only !== false;
    const includeFavicon = options.include_favicon === true;
    const urlPattern = options.url_pattern ? new RegExp(options.url_pattern) : null;
    const limit = Number.isInteger(options.limit) ? options.limit : 50;

    await pruneWorkspace();
    let tabs = await browser.tabs.query({});
    if (currentWindowOnly) {
      // The current window plus the workspace (which may be its own window).
      const current = await browser.tabs.query({ currentWindow: true });
      const currentWindowId = current.length ? current[0].windowId : null;
      tabs = tabs.filter(t => t.windowId === currentWindowId || workspace.tabIds.has(t.id));
    }
    const windows = await browser.windows.getAll();
    const windowMap = new Map(windows.map(w => [w.id, w]));

    const totalMatched = urlPattern ? tabs.filter(t => urlPattern.test(t.url)).length : tabs.length;
    if (urlPattern) {
      tabs = tabs.filter(t => urlPattern.test(t.url));
    }

    const truncated = tabs.length > limit;
    const pageTabs = tabs.slice(0, limit);

    return {
      success: true,
      tabs: pageTabs.map(t => {
        const win = windowMap.get(t.windowId);
        const base = {
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          windowId: t.windowId,
          pinned: t.pinned,
          status: t.status,  // "loading" or "complete"
          audible: t.audible,  // playing audio
          inWorkspace: workspace.tabIds.has(t.id)
        };
        if (includeFavicon) {
          base.favIconUrl = t.favIconUrl;
        }
        if (!currentWindowOnly) {
          base.windowFocused = win?.focused || false;
        }
        return base;
      }),
      returnedTabs: pageTabs.length,
      truncated,
      scope: currentWindowOnly ? 'current_window' : 'all_windows',
      workspace: workspaceInfo(),
      windowCount: windows.length,
      totalTabs: totalMatched,
      summary: {
        active: tabs.filter(t => t.active).length,
        loading: tabs.filter(t => t.status === 'loading').length,
        discarded: tabs.filter(t => t.discarded).length,
        audible: tabs.filter(t => t.audible).length
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get detailed info about a specific tab
async function getTabInfo(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    const win = await browser.windows.get(tab.windowId);

    // Try to get page info from content script
    let pageInfo = null;
    try {
      pageInfo = await browser.tabs.sendMessage(tabId, { action: "getPageInfo" });
    } catch (e) {
      // Content script may not be loaded
      pageInfo = { error: "Content script not available" };
    }

    return {
      success: true,
      tab: {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
        status: tab.status,
        discarded: tab.discarded,
        audible: tab.audible,
        favIconUrl: tab.favIconUrl
      },
      window: {
        id: win.id,
        focused: win.focused,
        state: win.state,
        type: win.type
      },
      pageInfo: pageInfo
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Find tabs by URL pattern
async function findTabs(options) {
  try {
    const tabs = await browser.tabs.query({});
    let filtered = tabs;

    if (options.url) {
      filtered = filtered.filter(t => t.url.startsWith(options.url));
    }
    if (options.urlPattern) {
      const regex = new RegExp(options.urlPattern);
      filtered = filtered.filter(t => regex.test(t.url));
    }
    if (options.title) {
      const titleLower = options.title.toLowerCase();
      filtered = filtered.filter(t => t.title?.toLowerCase().includes(titleLower));
    }
    if (options.active !== undefined) {
      filtered = filtered.filter(t => t.active === options.active);
    }
    if (options.audible !== undefined) {
      filtered = filtered.filter(t => t.audible === options.audible);
    }

    return {
      success: true,
      tabs: filtered.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        windowId: t.windowId,
        status: t.status
      })),
      count: filtered.length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function createNewTab(data) {
  try {
    // Agent tabs live in the workspace and open in the background. Only an
    // explicit active:true brings the tab to the front.
    const tab = await openWorkspaceTab(data.url || "about:blank");
    if (data.active === true) {
      await browser.tabs.update(tab.id, { active: true });
    }
    return {
      success: true,
      tab: { id: tab.id, url: tab.url, title: tab.title },
      workspace: workspaceInfo()
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function closeTab(tabId) {
  try {
    await browser.tabs.remove(tabId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function focusTab(tabId) {
  try {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Refresh/Reload functionality
async function refreshTab(tabId, options = {}) {
  try {
    const tab = tabId ? await browser.tabs.get(tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];

    // bypassCache: true = hard refresh (Ctrl+Shift+R), false = normal refresh (F5)
    await browser.tabs.reload(tab.id, { bypassCache: options.bypassCache || false });

    // Wait for page to load if requested
    if (options.waitForLoad !== false) {
      return new Promise((resolve) => {
        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tab.id && changeInfo.status === "complete") {
            browser.tabs.onUpdated.removeListener(listener);
            resolve({
              success: true,
              refreshed: true,
              tab: { id: tab.id, url: tab.url, title: tab.title },
              bypassCache: options.bypassCache || false
            });
          }
        };
        browser.tabs.onUpdated.addListener(listener);

        // Timeout after 30 seconds
        setTimeout(() => {
          browser.tabs.onUpdated.removeListener(listener);
          resolve({ success: true, refreshed: true, note: "Refresh initiated but completion not confirmed" });
        }, 30000);
      });
    }

    return { success: true, refreshed: true, tab: { id: tab.id, url: tab.url } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Hard refresh - bypass cache (like Ctrl+Shift+R)
async function hardRefreshTab(tabId) {
  return refreshTab(tabId, { bypassCache: true });
}

// Reload all tabs (useful when restarting dev servers)
async function reloadAllTabs(options = {}) {
  try {
    const tabs = await scopedTabs(options);
    const results = [];

    for (const tab of tabs) {
      // Skip special browser pages
      if (tab.url.startsWith('about:') || tab.url.startsWith('moz-extension:')) {
        continue;
      }

      // Filter by URL pattern if provided
      if (options.urlPattern) {
        const regex = new RegExp(options.urlPattern);
        if (!regex.test(tab.url)) {
          continue;
        }
      }

      await browser.tabs.reload(tab.id, { bypassCache: options.bypassCache || false });
      results.push({ id: tab.id, url: tab.url, reloaded: true });
    }

    return {
      success: true,
      scope: options.includeUserTabs ? "all_tabs" : "workspace",
      reloadedCount: results.length,
      tabs: results,
      bypassCache: options.bypassCache || false
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Reload tabs matching a specific URL or pattern (great for dev servers)
async function reloadTabsByUrl(options) {
  try {
    if (!options.url && !options.urlPattern) {
      return { success: false, error: "Must provide url or urlPattern" };
    }

    const tabs = await scopedTabs(options);
    const results = [];

    for (const tab of tabs) {
      let matches = false;

      if (options.url) {
        // Exact URL match or starts with
        matches = tab.url === options.url || tab.url.startsWith(options.url);
      } else if (options.urlPattern) {
        // Regex pattern match
        const regex = new RegExp(options.urlPattern);
        matches = regex.test(tab.url);
      }

      if (matches) {
        await browser.tabs.reload(tab.id, { bypassCache: options.bypassCache !== false });
        results.push({ id: tab.id, url: tab.url, reloaded: true });
      }
    }

    return {
      success: true,
      scope: options.includeUserTabs ? "all_tabs" : "workspace",
      reloadedCount: results.length,
      tabs: results,
      bypassCache: options.bypassCache !== false
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Listen for messages from content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === "background") {
    handleCommand({ ...message, tabId: sender.tab?.id })
      .then(sendResponse);
    return true; // Keep channel open for async response
  }
});

// Refuse external messages. Nothing legitimate uses this path — the MCP
// server reaches the extension via native messaging and HTTP polling, never
// runtime.sendMessage — and an open forward here would let any co-installed
// extension run arbitrary commands (including executeScript on any tab),
// bypassing the API token and the localhost boundary entirely.
browser.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  console.warn("[ClaudeCodeBrowser] Refused external message from", sender?.id);
  sendResponse({ success: false, error: "External messages are not accepted" });
  return false;
});

// Context menu for quick actions
browser.contextMenus.create({
  id: "claude-screenshot",
  title: "Take Screenshot for Claude",
  contexts: ["page"]
});

browser.contextMenus.create({
  id: "claude-inspect",
  title: "Inspect Element for Claude",
  contexts: ["all"]
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "claude-screenshot") {
    takeScreenshot(tab.id).then(result => {
      if (result.success && nativePort) {
        nativePort.postMessage({
          action: "screenshotTaken",
          data: result.data,
          tab: { id: tab.id, url: tab.url, title: tab.title }
        });
      }
    });
  } else if (info.menuItemId === "claude-inspect") {
    browser.tabs.sendMessage(tab.id, {
      action: "inspectElement",
      x: info.pageX,
      y: info.pageY
    });
  }
});

// Initialize
connectNativeHost();
console.log("[ClaudeCodeBrowser] Background script initialized");
