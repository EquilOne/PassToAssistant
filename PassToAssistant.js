'use strict';

const ASSISTANT_LABELS = ["FirstName LastName Assistant"];
const PROCESSED_LABEL = "Processed";
const SEARCH_PAGE_SIZE = 100;
const RUNNER_FUNCTION = "processAssistantLabel";
const NEXT_RUN_DELAY_MS = 60000;
const LOCK_TIMEOUT_MS = 30000;
const RUNTIME_BUDGET_MS = 5 * 60 * 1000;
const MAX_PAGES_PER_RUN = 50;

function quoteLabel(name) {
  return '"' + name.replace(/[\\"]/g, '\\$&') + '"';
}

function isOverBudget(startTime) {
  return Date.now() - startTime > RUNTIME_BUDGET_MS;
}

function setup() {
  if (ASSISTANT_LABELS.includes(PROCESSED_LABEL)) {
    throw new Error(
      `PROCESSED_LABEL ("${PROCESSED_LABEL}") must not appear in ASSISTANT_LABELS.`,
    );
  }

  const processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!processedLabel) {
    GmailApp.createLabel(PROCESSED_LABEL);
  }

  for (const label of ASSISTANT_LABELS) {
    if (!GmailApp.getUserLabelByName(label)) {
      console.warn(`Label not found, skipping: ${label}`);
    }
  }

  deleteTriggersFor(RUNNER_FUNCTION);
  ScriptApp.newTrigger(RUNNER_FUNCTION)
    .timeBased()
    .after(NEXT_RUN_DELAY_MS)
    .create();
}

function processAssistantLabel() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    console.log("Could not acquire lock; another run is in progress. Exiting.");
    return;
  }

  try {
    const processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL);
    if (!processedLabel) {
      console.error(`Missing label: ${PROCESSED_LABEL}. Run setup() first.`);
      return;
    }

    const startTime = Date.now();

    for (const labelName of ASSISTANT_LABELS) {
      if (isOverBudget(startTime)) {
        console.log(
          "Runtime budget reached; deferring remaining labels to next run.",
        );
        break;
      }

      try {
        processLabel(labelName, processedLabel, startTime);
      } catch (err) {
        console.error(`Error processing label "${labelName}": ${err.stack}`);
      }
    }
  } finally {
    lock.releaseLock();
    try {
      scheduleNextRun();
    } catch (err) {
      console.error(`Failed to schedule next run: ${err.stack}. Run setup() manually.`);
    }
  }
}

function processLabel(labelName, processedLabel, startTime) {
  const label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    console.warn(`Label not found, skipping: ${labelName}`);
    return;
  }

  const query = `label:${quoteLabel(labelName)} -label:${quoteLabel(PROCESSED_LABEL)}`;
  let page;
  let pagesThisRun = 0;

  do {
    if (isOverBudget(startTime)) {
      console.log(
        `Runtime budget reached mid-label "${labelName}"; will resume next run.`,
      );
      return;
    }

    page = GmailApp.search(query, 0, SEARCH_PAGE_SIZE);
    if (page.length === 0) break;
    GmailApp.markThreadsUnread(page);
    if (isOverBudget(startTime)) {
      console.log(
        `Runtime budget reached mid-label "${labelName}" after marking unread; will resume next run.`,
      );
      return;
    }
    processedLabel.addToThreads(page);
    pagesThisRun++;
    if (pagesThisRun >= MAX_PAGES_PER_RUN) {
      console.log(
        `Reached max pages (${MAX_PAGES_PER_RUN}) for label "${labelName}"; deferring.`,
      );
      return;
    }
  } while (page.length === SEARCH_PAGE_SIZE);
}

function scheduleNextRun() {
  deleteTriggersFor(RUNNER_FUNCTION);
  ScriptApp.newTrigger(RUNNER_FUNCTION)
    .timeBased()
    .after(NEXT_RUN_DELAY_MS)
    .create();
}

function deleteTriggersFor(functionName) {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}
