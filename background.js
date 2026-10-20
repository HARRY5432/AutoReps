chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});
chrome.runtime.onInstalled.addListener(() => console.log('[AutoRep] installed'));
