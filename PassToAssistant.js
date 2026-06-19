'use strict';

const ASSISTANT_LABELS = ["FirstName LastName Assistant"];
const PROCESSED_LABEL = "Processed";
const SEARCH_PAGE_SIZE = 100;
const RUNNER_FUNCTION = "processAssistantLabel";
const SEEDER_FUNCTION = "seedExistingAssistantThreads";
const NEXT_RUN_DELAY_MS = 60000;
const LOCK_TIMEOUT_MS = 30000;
const RUNTIME_BUDGET_MS = 5 * 60 * 1000;
const MAX_PAGES_PER_RUN = 50;
const SEED_COMPLETE_PROP = "seed_complete";

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

  PropertiesService.getScriptProperties().deleteProperty(SEED_COMPLETE_PROP);

  deleteTriggersFor(SEEDER_FUNCTION);
  deleteTriggersFor(RUNNER_FUNCTION);

  ScriptApp.newTrigger(SEEDER_FUNCTION)
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
    try {
      scheduleNextRun(RUNNER_FUNCTION);
    } catch (err) {
      console.error(`Failed to schedule next run: ${err.stack}. Run setup() manually.`);
    } finally {
      lock.releaseLock();
    }
  }
}

function processLabel(labelName, processedLabel, startTime) {
  const label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    console.warn(`Label not found, skipping: ${labelName}`);
    return;
  }

  const query = `label:${quoteLabel(labelName)} -label:${quoteLabel(PROCESSED_LABEL)} in:inbox`;
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

    const inboxPage = page.filter((t) => t.isInInbox());
    if (inboxPage.length === 0) continue;

    GmailApp.markThreadsUnread(inboxPage);
    if (isOverBudget(startTime)) {
      console.log(
        `Runtime budget reached mid-label "${labelName}" after marking unread; will resume next run.`,
      );
      return;
    }
    processedLabel.addToThreads(inboxPage);
    pagesThisRun++;
    if (pagesThisRun >= MAX_PAGES_PER_RUN) {
      console.log(
        `Reached max pages (${MAX_PAGES_PER_RUN}) for label "${labelName}"; deferring.`,
      );
      return;
    }
  } while (page.length === SEARCH_PAGE_SIZE);
}

function seedExistingAssistantThreads() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    console.warn("Could not acquire lock for seeder; another run is in progress. Exiting without reschedule.");
    return;
  }

  let didHandOff = false;

  try {
    const processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL);
    if (!processedLabel) {
      console.error(`Missing label "${PROCESSED_LABEL}" — seeder cannot proceed. Run setup() manually; not rescheduling to avoid an error loop.`);
      didHandOff = true;
      return;
    }

    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(SEED_COMPLETE_PROP) === "true") {
      deleteTriggersFor(SEEDER_FUNCTION);
      console.log("Seed already complete; exiting.");
      didHandOff = true;
      return;
    }

    const startTime = Date.now();
    // Threads arriving mid-pass after a label returned empty will be treated as runner work (mark unread) — by design.
    let sawEmptyAllLabels = true;

    for (const labelName of ASSISTANT_LABELS) {
      if (isOverBudget(startTime)) {
        console.log("Budget reached during seed; will resume next run.");
        return;
      }

      const label = GmailApp.getUserLabelByName(labelName);
      if (!label) {
        console.warn(`Label not found during seed, skipping: ${labelName}`);
        continue;
      }

      let page;
      let pagesThisRun = 0;
      do {
        if (isOverBudget(startTime)) {
          console.log(`Budget reached mid-seed of "${labelName}"; will resume.`);
          return;
        }

        try {
          const query = `label:${quoteLabel(labelName)} -label:${quoteLabel(PROCESSED_LABEL)}`;
          page = GmailApp.search(query, 0, SEARCH_PAGE_SIZE);
          if (page.length === 0) break;

          sawEmptyAllLabels = false;
          processedLabel.addToThreads(page);
        } catch (err) {
          console.error(`Error seeding page for label "${labelName}": ${err.stack}; breaking to next label.`);
          break;
        }

        pagesThisRun++;
        if (pagesThisRun >= MAX_PAGES_PER_RUN) {
          console.log(`Reached max pages (${MAX_PAGES_PER_RUN}) for label "${labelName}" during seed; deferring remaining pages to next seeder run.`);
          break;
        }
      } while (page.length === SEARCH_PAGE_SIZE);
    }

    if (sawEmptyAllLabels) {
      props.setProperty(SEED_COMPLETE_PROP, "true");
      deleteTriggersFor(SEEDER_FUNCTION);
      didHandOff = true;
      console.log("Seeding complete; starting runner.");
      try {
        scheduleNextRun(RUNNER_FUNCTION);
      } catch (err) {
        console.error(`Failed to schedule runner after seed: ${err.stack}. Run setup() manually.`);
      }
      return;
    }

    // Not complete; finally will reschedule seeder while still holding the lock.
  } finally {
    try {
      if (!didHandOff) {
        scheduleNextRun(SEEDER_FUNCTION);
      }
    } catch (err) {
      console.error(`Failed to schedule next seeder run: ${err.stack}. Run setup() manually.`);
    } finally {
      lock.releaseLock();
    }
  }
}

function scheduleNextRun(functionName) {
  deleteTriggersFor(functionName);
  ScriptApp.newTrigger(functionName)
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
