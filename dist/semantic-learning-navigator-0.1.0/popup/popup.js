const DEFAULT_SETTINGS = {
  enabled: true,
  stage: "beginner",
  domain: "auto",
  collapseC: true,
  showSidebar: true
};

const controls = {
  enabled: document.querySelector("#enabled"),
  stage: document.querySelector("#stage"),
  domain: document.querySelector("#domain"),
  collapseC: document.querySelector("#collapseC"),
  showSidebar: document.querySelector("#showSidebar"),
  reanalyze: document.querySelector("#reanalyze")
};

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  controls.enabled.checked = settings.enabled;
  controls.stage.value = settings.stage;
  controls.domain.value = settings.domain;
  controls.collapseC.checked = settings.collapseC;
  controls.showSidebar.checked = settings.showSidebar;
});

["enabled", "stage", "domain", "collapseC", "showSidebar"].forEach((key) => {
  controls[key].addEventListener("change", saveAndNotify);
});

controls.reanalyze.addEventListener("click", () => saveAndNotify({ forceRefresh: true }));

function saveAndNotify(options = {}) {
  const settings = {
    enabled: controls.enabled.checked,
    stage: controls.stage.value,
    domain: controls.domain.value,
    collapseC: controls.collapseC.checked,
    showSidebar: controls.showSidebar.checked
  };

  chrome.storage.sync.set(settings, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, {
        type: "SLN_SETTINGS_UPDATED",
        settings,
        forceRefresh: Boolean(options.forceRefresh)
      });
    });
  });
}
