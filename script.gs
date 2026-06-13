const ASSISTANT_LABEL = 'My Assistant';
const PROCESSED_LABEL = 'Processed';
const BATCH_SIZE = 50;
const HANDLER_FUNCTION = 'processAssistantLabel';

function setup() {
  const assistantLabel = GmailApp.getUserLabelByName(ASSISTANT_LABEL);
  if (!assistantLabel) {
    throw new Error(`Create this Gmail label first: ${ASSISTANT_LABEL}`);
  }

  let processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
  }

  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === HANDLER_FUNCTION) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(HANDLER_FUNCTION)
    .timeBased()
    .everyMinutes(1)
    .create();
}

function processAssistantLabel() {
  const assistantLabel = GmailApp.getUserLabelByName(ASSISTANT_LABEL);
  if (!assistantLabel) {
    throw new Error(`Label not found: ${ASSISTANT_LABEL}`);
  }

  let processedLabel = GmailApp.getUserLabelByName(PROCESSED_LABEL);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
  }

  const threads = assistantLabel.getThreads(0, BATCH_SIZE);

  threads.forEach(thread => {
    const alreadyProcessed = thread
      .getLabels()
      .some(label => label.getName() === PROCESSED_LABEL);

    if (!alreadyProcessed) {
      thread.markUnread();
      thread.addLabel(processedLabel);
    }
  });
}
