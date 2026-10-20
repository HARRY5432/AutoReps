chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id !== undefined) await chrome.sidePanel.open({ tabId: tab.id });
});
chrome.runtime.onInstalled.addListener(() => console.log('[AutoRep] installed'));
