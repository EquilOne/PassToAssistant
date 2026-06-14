'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function fail(message) {
  failed++;
  process.stdout.write(`  FAIL: ${message}\n`);
}

function ok(message) {
  passed++;
  process.stdout.write(`  PASS: ${message}\n`);
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    ok(message);
  } else {
    fail(`${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value, message) {
  if (value === true) {
    ok(message);
  } else {
    fail(`${message}\n    expected true, got: ${JSON.stringify(value)}`);
  }
}

function assertFalse(value, message) {
  if (value === false) {
    ok(message);
  } else {
    fail(`${message}\n    expected false, got: ${JSON.stringify(value)}`);
  }
}

function assertThrows(fn, message) {
  try {
    fn();
    fail(`${message}\n    expected to throw, but did not`);
  } catch (err) {
    ok(`${message} (${err.message})`);
  }
}

function assertDoesNotThrow(fn, message) {
  try {
    fn();
    ok(message);
  } catch (err) {
    fail(`${message}\n    unexpected error: ${err.message}`);
  }
}

function assertIncludes(haystack, needle, message) {
  if (haystack.includes(needle)) {
    ok(message);
  } else {
    fail(`${message}\n    expected ${JSON.stringify(haystack)} to include ${JSON.stringify(needle)}`);
  }
}

function assertSomeMatch(haystack, predicate, message) {
  if (haystack.some(predicate)) {
    ok(message);
  } else {
    fail(`${message}\n    no item in ${JSON.stringify(haystack)} matched`);
  }
}

function assertArrayEquals(actual, expected, message) {
  if (actual.length !== expected.length) {
    fail(`${message}\n    length mismatch: expected ${expected.length}, got ${actual.length}`);
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      fail(`${message}\n    mismatch at index ${i}: expected ${JSON.stringify(expected[i])}, got ${JSON.stringify(actual[i])}`);
      return;
    }
  }
  ok(message);
}

// -----------------------------------------------------------------------------
// GAS global mocks
// -----------------------------------------------------------------------------
const originalDateNow = Date.now;

function makeLabel(name) {
  return {
    name,
    addedToThreads: [],
    addToThreads(threads) {
      this.addedToThreads.push(...threads);
      for (const thread of threads) {
        if (!thread.labels) thread.labels = [];
        thread.labels.push(name);
      }
    },
  };
}

function createTrigger(functionName) {
  return {
    functionName,
    getHandlerFunction() {
      return this.functionName;
    },
    timeBased() {
      return this;
    },
    after(ms) {
      this.afterMs = ms;
      return this;
    },
    create() {
      ScriptApp.triggers.push(this);
      return this;
    },
  };
}

global.Logger = {
  log() {},
  warn() {},
  error() {},
  info() {},
};

global.GmailApp = {
  labels: new Map(),
  searches: [],
  markedThreads: [],
  searchImpl() {
    return [];
  },

  reset() {
    this.labels = new Map();
    this.searches = [];
    this.markedThreads = [];
    this.searchImpl = () => [];
  },

  getUserLabelByName(name) {
    return this.labels.get(name) || null;
  },

  createLabel(name) {
    const label = makeLabel(name);
    this.labels.set(name, label);
    return label;
  },

  search(query, start, maxResults) {
    this.searches.push({ query, start, maxResults });
    return this.searchImpl(query, start, maxResults);
  },

  markThreadsUnread(threads) {
    this.markedThreads.push(...threads);
    for (const thread of threads) {
      thread.unread = true;
    }
  },
};

global.LockService = {
  acquireResult: true,
  released: false,
  lock: null,

  reset() {
    this.acquireResult = true;
    this.released = false;
    this.lock = {
      tryLock() {
        return LockService.acquireResult;
      },
      releaseLock() {
        LockService.released = true;
      },
    };
  },

  getScriptLock() {
    return this.lock;
  },
};

global.ScriptApp = {
  triggers: [],
  deletedTriggers: [],

  reset() {
    this.triggers = [];
    this.deletedTriggers = [];
    this.getProjectTriggers = () => this.triggers;
    this.deleteTrigger = (trigger) => {
      this.deletedTriggers.push(trigger);
      this.triggers = this.triggers.filter((t) => t !== trigger);
    };
    this.newTrigger = (functionName) => createTrigger(functionName);
  },
};

// Capture console calls made by the script under test.
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};

global.console = {
  logs: [],
  warns: [],
  errors: [],
  infos: [],

  log(...args) {
    this.logs.push(args.join(' '));
  },
  warn(...args) {
    this.warns.push(args.join(' '));
  },
  error(...args) {
    this.errors.push(args.join(' '));
  },
  info(...args) {
    this.infos.push(args.join(' '));
  },
};

function resetMocks() {
  GmailApp.reset();
  LockService.reset();
  ScriptApp.reset();
  console.logs = [];
  console.warns = [];
  console.errors = [];
  console.infos = [];
  Date.now = originalDateNow;
}

// -----------------------------------------------------------------------------
// Load the GAS source into a vm context (with mocks already supplied).
// runInNewContext keeps strict-mode source isolated while still exposing top-level
// function declarations and constants on the sandbox object.
// -----------------------------------------------------------------------------
const sourcePath = path.join(__dirname, 'PassToAssistant.js');
const originalSource = fs.readFileSync(sourcePath, 'utf8');

function createGasContext() {
  return {
    GmailApp,
    LockService,
    ScriptApp,
    Logger,
    console,
    Date,
  };
}

const gasContext = createGasContext();
vm.runInNewContext(originalSource, gasContext);

const {
  quoteLabel,
  isOverBudget,
  setup,
  processAssistantLabel,
  processLabel,
  scheduleNextRun,
  deleteTriggersFor,
} = gasContext;

// These mirror the constants in PassToAssistant.js. Lexical declarations (const/let)
// are not exported by the vm context, so we redeclare them here for assertions.
const PROCESSED_LABEL = 'Processed';
const RUNNER_FUNCTION = 'processAssistantLabel';
const NEXT_RUN_DELAY_MS = 60000;
const RUNTIME_BUDGET_MS = 300000;
const SEARCH_PAGE_SIZE = 100;
const MAX_PAGES_PER_RUN = 50;

// Helper for tests that need different constant values.
function loadWithOverrides(overrides) {
  let src = originalSource;
  if (overrides.ASSISTANT_LABELS !== undefined) {
    src = src.replace(
      /const ASSISTANT_LABELS = \[.*?\];/s,
      `const ASSISTANT_LABELS = ${JSON.stringify(overrides.ASSISTANT_LABELS)};`
    );
  }
  if (overrides.PROCESSED_LABEL !== undefined) {
    src = src.replace(
      /const PROCESSED_LABEL = ".*?";/,
      `const PROCESSED_LABEL = "${overrides.PROCESSED_LABEL.replace(/"/g, '\\"')}";`
    );
  }
  if (overrides.MAX_PAGES_PER_RUN !== undefined) {
    src = src.replace(
      /const MAX_PAGES_PER_RUN = \d+;/,
      `const MAX_PAGES_PER_RUN = ${overrides.MAX_PAGES_PER_RUN};`
    );
  }

  const ctx = createGasContext();
  vm.runInNewContext(src, ctx);

  return {
    quoteLabel: ctx.quoteLabel,
    isOverBudget: ctx.isOverBudget,
    setup: ctx.setup,
    processAssistantLabel: ctx.processAssistantLabel,
    processLabel: ctx.processLabel,
    scheduleNextRun: ctx.scheduleNextRun,
    deleteTriggersFor: ctx.deleteTriggersFor,
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
function runTests() {
  "describe: quoteLabel";

  "  it: normal label name -> returns wrapped in quotes";
  assertEqual(quoteLabel('FirstName LastName Assistant'), '"FirstName LastName Assistant"', 'quoteLabel wraps normal name');

  "  it: label with backslash -> backslash is escaped";
  assertEqual(quoteLabel('A\\B'), '"A\\\\B"', 'quoteLabel escapes backslash');

  "  it: label with double quote -> double quote is escaped";
  assertEqual(quoteLabel('A"B'), '"A\\"B"', 'quoteLabel escapes double quote');

  "  it: label with both backslash and double quote -> both escaped";
  assertEqual(quoteLabel('A\\"B'), '"A\\\\\\"B"', 'quoteLabel escapes backslash and double quote');

  // ---------------------------------------------------------------------------
  "describe: isOverBudget";

  "  it: recent startTime -> returns false";
  {
    const now = 1000000000;
    Date.now = () => now;
    assertFalse(isOverBudget(now), 'isOverBudget returns false for recent start time');
  }

  "  it: startTime far in the past -> returns true";
  {
    const now = 1000000000;
    Date.now = () => now;
    assertTrue(isOverBudget(now - RUNTIME_BUDGET_MS - 1000), 'isOverBudget returns true for old start time');
  }

  "  it: at budget boundary -> returns true";
  // Note: the source uses `> RUNTIME_BUDGET_MS`, so the first millisecond *past*
  // the budget boundary is the point where this becomes true.
  {
    const now = 1000000000;
    Date.now = () => now;
    assertTrue(isOverBudget(now - RUNTIME_BUDGET_MS - 1), 'isOverBudget returns true at budget boundary');
  }

  // ---------------------------------------------------------------------------
  "describe: setup";

  "  it: PROCESSED_LABEL in ASSISTANT_LABELS -> throws";
  {
    const broken = loadWithOverrides({
      ASSISTANT_LABELS: ['Processed'],
      PROCESSED_LABEL: 'Processed',
    });
    assertThrows(() => broken.setup(), 'setup throws when PROCESSED_LABEL is in ASSISTANT_LABELS');
  }

  "  it: normal setup -> creates missing Processed label, schedules trigger";
  {
    resetMocks();
    assertDoesNotThrow(() => setup(), 'setup does not throw in normal case');
    assertTrue(GmailApp.getUserLabelByName(PROCESSED_LABEL) !== null, 'setup creates missing Processed label');
    assertEqual(ScriptApp.triggers.length, 1, 'setup creates exactly one trigger');
    assertEqual(ScriptApp.triggers[0].functionName, RUNNER_FUNCTION, 'setup trigger targets runner function');
    assertEqual(ScriptApp.triggers[0].afterMs, NEXT_RUN_DELAY_MS, 'setup trigger uses correct delay');
  }

  "  it: existing triggers -> deletes matching ones before creating a new one";
  {
    resetMocks();
    const staleRunner = ScriptApp.newTrigger(RUNNER_FUNCTION).timeBased().after(1000).create();
    const otherTrigger = ScriptApp.newTrigger('otherHandler').timeBased().after(2000).create();
    setup();
    assertIncludes(ScriptApp.deletedTriggers, staleRunner, 'setup deletes existing runner trigger');
    assertEqual(ScriptApp.triggers.length, 2, 'setup keeps non-matching triggers plus the new one');
    assertIncludes(ScriptApp.triggers, otherTrigger, 'setup preserves non-matching trigger');
    const newTrigger = ScriptApp.triggers.find((t) => t !== otherTrigger);
    assertEqual(newTrigger.functionName, RUNNER_FUNCTION, 'setup new trigger is the runner');
    assertEqual(newTrigger.afterMs, NEXT_RUN_DELAY_MS, 'setup new trigger uses correct delay');
  }

  "  it: missing assistant labels -> warns about each missing label";
  {
    resetMocks();
    setup();
    assertSomeMatch(
      console.warns,
      (m) => m.includes('FirstName LastName Assistant'),
      'setup warns about missing assistant label'
    );
  }

  "  it: loadWithOverrides works with different PROCESSED_LABEL value";
  {
    resetMocks();
    const alt = loadWithOverrides({
      ASSISTANT_LABELS: ['My Assistant'],
      PROCESSED_LABEL: 'AlreadyDone',
    });
    const processedLabel = GmailApp.createLabel('AlreadyDone');
    GmailApp.createLabel('My Assistant');
    GmailApp.searchImpl = () => [];
    alt.processLabel('My Assistant', processedLabel, Date.now());
    const searchQuery = GmailApp.searches[0].query.replace(/"/g, '');
    assertEqual(GmailApp.searches.length, 1, 'overridden label triggers one search');
    assertIncludes(searchQuery, '-label:AlreadyDone', 'overridden PROCESSED_LABEL appears in query');
    assertEqual(GmailApp.searches[0].start, 0, 'search starts at offset 0');
    assertEqual(GmailApp.searches[0].maxResults, SEARCH_PAGE_SIZE, 'search uses PAGE_SIZE');
  }

  // ---------------------------------------------------------------------------
  "describe: deleteTriggersFor";

  "  it: deletes only triggers matching the given function name";
  {
    resetMocks();
    const foo1 = ScriptApp.newTrigger('foo').timeBased().after(1000).create();
    const bar = ScriptApp.newTrigger('bar').timeBased().after(2000).create();
    const foo2 = ScriptApp.newTrigger('foo').timeBased().after(3000).create();
    deleteTriggersFor('foo');
    assertEqual(ScriptApp.deletedTriggers.length, 2, 'deleteTriggersFor deletes matching triggers');
    assertIncludes(ScriptApp.deletedTriggers, foo1, 'deleteTriggersFor deletes first matching trigger');
    assertIncludes(ScriptApp.deletedTriggers, foo2, 'deleteTriggersFor deletes second matching trigger');
    assertEqual(ScriptApp.triggers.length, 1, 'deleteTriggersFor keeps non-matching triggers');
    assertIncludes(ScriptApp.triggers, bar, 'deleteTriggersFor preserves bar trigger');
  }

  // ---------------------------------------------------------------------------
  "describe: scheduleNextRun";

  "  it: deletes old triggers then creates a new .after() trigger";
  {
    resetMocks();
    ScriptApp.newTrigger(RUNNER_FUNCTION).timeBased().after(1000).create();
    const oldTrigger = ScriptApp.triggers[0];
    scheduleNextRun();
    assertIncludes(ScriptApp.deletedTriggers, oldTrigger, 'scheduleNextRun deletes old trigger');
    assertEqual(ScriptApp.triggers.length, 1, 'scheduleNextRun creates one new trigger');
    assertEqual(ScriptApp.triggers[0].functionName, RUNNER_FUNCTION, 'scheduleNextRun trigger targets runner');
    assertEqual(ScriptApp.triggers[0].afterMs, NEXT_RUN_DELAY_MS, 'scheduleNextRun trigger uses correct delay');
  }

  // ---------------------------------------------------------------------------
  "describe: processLabel";

  "  it: label does not exist -> warns and returns early";
  {
    resetMocks();
    const processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
    processLabel('MissingLabel', processedLabel, Date.now());
    assertEqual(GmailApp.searches.length, 0, 'processLabel skips search when label missing');
    assertEqual(processedLabel.addedToThreads.length, 0, 'processLabel adds nothing when label missing');
    assertSomeMatch(
      console.warns,
      (m) => m.includes('MissingLabel'),
      'processLabel warns about missing label'
    );
  }

  "  it: search returns empty -> no further operations";
  {
    resetMocks();
    GmailApp.createLabel('InboxAssistant');
    const processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
    GmailApp.searchImpl = () => [];
    processLabel('InboxAssistant', processedLabel, Date.now());
    const searchQuery = GmailApp.searches[0].query.replace(/"/g, '');
    assertEqual(GmailApp.searches.length, 1, 'processLabel performs one search');
    assertIncludes(searchQuery, '-label:Processed', 'search query excludes Processed label');
    assertEqual(GmailApp.searches[0].start, 0, 'search starts at offset 0');
    assertEqual(GmailApp.searches[0].maxResults, SEARCH_PAGE_SIZE, 'search uses PAGE_SIZE');
    assertEqual(GmailApp.markedThreads.length, 0, 'processLabel marks nothing unread on empty result');
    assertEqual(processedLabel.addedToThreads.length, 0, 'processLabel adds nothing on empty result');
  }

  "  it: page has threads -> marks unread then adds Processed label";
  {
    resetMocks();
    GmailApp.createLabel('InboxAssistant');
    const processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
    const threads = [{ id: 't1' }, { id: 't2' }];
    GmailApp.searchImpl = () => threads;
    processLabel('InboxAssistant', processedLabel, Date.now());
    const searchQuery = GmailApp.searches[0].query.replace(/"/g, '');
    assertEqual(GmailApp.markedThreads.length, 2, 'processLabel marks page threads unread');
    assertEqual(processedLabel.addedToThreads.length, 2, 'processLabel adds Processed label to page threads');
    assertEqual(GmailApp.searches.length, 1, 'processLabel searches once for single partial page');
    assertIncludes(searchQuery, '-label:Processed', 'search query excludes Processed label');
    assertEqual(GmailApp.searches[0].start, 0, 'search starts at offset 0');
    assertEqual(GmailApp.searches[0].maxResults, SEARCH_PAGE_SIZE, 'search uses PAGE_SIZE');
  }

  "  it: MAX_PAGES_PER_RUN reached -> returns after processing that page";
  {
    resetMocks();
    const alt = loadWithOverrides({ MAX_PAGES_PER_RUN: 2 });
    GmailApp.createLabel('LimitLabel');
    const processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
    const page = new Array(SEARCH_PAGE_SIZE).fill(0).map((_, i) => ({ id: `limit-${i}` }));
    GmailApp.searchImpl = () => page;
    alt.processLabel('LimitLabel', processedLabel, Date.now());
    const searchQuery = GmailApp.searches[0].query.replace(/"/g, '');
    assertEqual(GmailApp.searches.length, 2, 'processLabel processes exactly MAX_PAGES_PER_RUN pages');
    assertEqual(processedLabel.addedToThreads.length, SEARCH_PAGE_SIZE * 2, 'processLabel adds threads for all processed pages');
    assertIncludes(searchQuery, '-label:Processed', 'search query excludes Processed label');
    assertEqual(GmailApp.searches[0].start, 0, 'search starts at offset 0');
    assertEqual(GmailApp.searches[0].maxResults, SEARCH_PAGE_SIZE, 'search uses PAGE_SIZE');
    assertSomeMatch(
      console.logs,
      (m) => m.includes('Reached max pages (2)'),
      'processLabel logs max pages reached'
    );
  }

  "  it: over budget before search -> returns early";
  {
    resetMocks();
    GmailApp.createLabel('BudgetLabel');
    const processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
    const startTime = 2000000;
    Date.now = () => startTime + RUNTIME_BUDGET_MS + 1000;
    GmailApp.searchImpl = () => [{ id: 'x' }];
    processLabel('BudgetLabel', processedLabel, startTime);
    assertEqual(GmailApp.searches.length, 0, 'processLabel skips search when over budget');
    assertEqual(processedLabel.addedToThreads.length, 0, 'processLabel adds nothing when over budget');
    assertSomeMatch(
      console.logs,
      (m) => m.includes('Runtime budget reached mid-label'),
      'processLabel logs budget reached before search'
    );
  }

  "  it: mid-batch over budget -> markUnread happens, addToThreads is skipped";
  {
    resetMocks();
    GmailApp.createLabel('MidBatchLabel');
    const processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
    const startTime = 3000000;
    Date.now = () => startTime;
    const threads = [{ id: 't1' }];
    GmailApp.searchImpl = () => threads;

    const originalMarkUnread = GmailApp.markThreadsUnread;
    GmailApp.markThreadsUnread = function (page) {
      originalMarkUnread.call(this, page);
      // Push past the budget immediately after marking unread.
      Date.now = () => startTime + RUNTIME_BUDGET_MS + 1000;
    };

    processLabel('MidBatchLabel', processedLabel, startTime);

    const searchQuery = GmailApp.searches[0].query.replace(/"/g, '');
    assertEqual(GmailApp.searches.length, 1, 'processLabel performs one search');
    assertEqual(GmailApp.markedThreads.length, 1, 'processLabel still marks threads unread mid-batch');
    assertEqual(processedLabel.addedToThreads.length, 0, 'processLabel skips addToThreads when budget hits mid-batch');
    assertIncludes(searchQuery, '-label:Processed', 'search query excludes Processed label');
    assertEqual(GmailApp.searches[0].start, 0, 'search starts at offset 0');
    assertEqual(GmailApp.searches[0].maxResults, SEARCH_PAGE_SIZE, 'search uses PAGE_SIZE');
    assertSomeMatch(
      console.logs,
      (m) => m.includes('after marking unread'),
      'processLabel logs mid-batch budget after mark unread'
    );
  }

  "  it: pagination -> loops when page is full, stops when page is partial";
  {
    resetMocks();
    GmailApp.createLabel('PageLabel');
    const processedLabel = GmailApp.createLabel(PROCESSED_LABEL);
    const fullPage = new Array(SEARCH_PAGE_SIZE).fill(0).map((_, i) => ({ id: `full-${i}` }));
    const partialPage = [{ id: 'partial-1' }];
    let searchCount = 0;
    GmailApp.searchImpl = () => {
      searchCount++;
      return searchCount === 1 ? fullPage : partialPage;
    };
    processLabel('PageLabel', processedLabel, Date.now());
    const searchQuery = GmailApp.searches[0].query.replace(/"/g, '');
    assertEqual(GmailApp.searches.length, 2, 'processLabel searches again after a full page');
    assertEqual(processedLabel.addedToThreads.length, SEARCH_PAGE_SIZE + 1, 'processLabel labels threads from both pages');
    assertIncludes(searchQuery, '-label:Processed', 'search query excludes Processed label');
    assertEqual(GmailApp.searches[0].start, 0, 'search starts at offset 0');
    assertEqual(GmailApp.searches[0].maxResults, SEARCH_PAGE_SIZE, 'search uses PAGE_SIZE');
  }

  // ---------------------------------------------------------------------------
  "describe: processAssistantLabel";

  "  it: lock cannot be acquired -> logs and returns without scheduling";
  {
    resetMocks();
    LockService.acquireResult = false;
    processAssistantLabel();
    assertSomeMatch(
      console.logs,
      (m) => m.includes('Could not acquire lock'),
      'processAssistantLabel logs lock acquisition failure'
    );
    assertFalse(LockService.released, 'processAssistantLabel does not release lock it never acquired');
    assertEqual(ScriptApp.triggers.length, 0, 'processAssistantLabel does not schedule next run when locked out');
  }

  "  it: PROCESSED_LABEL missing -> logs error, but still releases lock and schedules";
  {
    resetMocks();
    // Do not create PROCESSED_LABEL in GmailApp.
    processAssistantLabel();
    assertSomeMatch(
      console.errors,
      (m) => m.includes('Missing label'),
      'processAssistantLabel logs missing Processed label'
    );
    assertTrue(LockService.released, 'processAssistantLabel releases lock even when label missing');
    assertEqual(ScriptApp.triggers.length, 1, 'processAssistantLabel still schedules next run when label missing');
  }

  "  it: normal flow -> iterates all assistant labels and calls processLabel";
  {
    resetMocks();
    GmailApp.createLabel('FirstName LastName Assistant');
    GmailApp.createLabel(PROCESSED_LABEL);
    GmailApp.searchImpl = () => [];
    processAssistantLabel();
    assertEqual(GmailApp.searches.length, 1, 'processAssistantLabel searches the assistant label');
    assertTrue(LockService.released, 'processAssistantLabel releases lock in normal flow');
    assertEqual(ScriptApp.triggers.length, 1, 'processAssistantLabel schedules next run');
    assertEqual(ScriptApp.triggers[0].functionName, RUNNER_FUNCTION, 'scheduled trigger targets runner');
  }

  "  it: over budget between labels -> breaks loop before next label";
  {
    resetMocks();
    const multi = loadWithOverrides({
      ASSISTANT_LABELS: ['Label1', 'Label2'],
    });
    GmailApp.createLabel('Label1');
    GmailApp.createLabel('Label2');
    GmailApp.createLabel(PROCESSED_LABEL);
    const startTime = 5000000;
    Date.now = () => startTime;
    let firstSearchDone = false;
    GmailApp.searchImpl = () => {
      if (!firstSearchDone) {
        firstSearchDone = true;
        // Move past the budget as soon as the first label's first search begins.
        Date.now = () => startTime + RUNTIME_BUDGET_MS + 1000;
      }
      return [];
    };
    multi.processAssistantLabel();
    assertEqual(GmailApp.searches.length, 1, 'processAssistantLabel stops after first label when budget is reached');
    assertSomeMatch(
      console.logs,
      (m) => m.includes('Runtime budget reached; deferring remaining labels'),
      'processAssistantLabel logs budget reached between labels'
    );
  }

  "  it: lock is always released in finally block";
  {
    resetMocks();
    GmailApp.createLabel('FirstName LastName Assistant');
    GmailApp.createLabel(PROCESSED_LABEL);
    GmailApp.searchImpl = () => [];
    processAssistantLabel();
    assertTrue(LockService.released, 'processAssistantLabel releases lock in finally block');
  }

  "  it: scheduleNextRun is called in finally block after lock release";
  {
    resetMocks();
    GmailApp.createLabel('FirstName LastName Assistant');
    GmailApp.createLabel(PROCESSED_LABEL);
    GmailApp.searchImpl = () => [];

    const order = [];
    const originalRelease = LockService.lock.releaseLock;
    LockService.lock.releaseLock = function () {
      order.push('release');
      originalRelease.call(this);
    };
    const originalNewTrigger = ScriptApp.newTrigger;
    ScriptApp.newTrigger = function (functionName) {
      order.push('newTrigger');
      return originalNewTrigger(functionName);
    };

    processAssistantLabel();
    assertArrayEquals(order, ['release', 'newTrigger'], 'lock is released before scheduling next run');
  }

  "  it: scheduleNextRun failure -> caught, logged, lock still released";
  {
    resetMocks();
    GmailApp.createLabel('FirstName LastName Assistant');
    GmailApp.createLabel(PROCESSED_LABEL);
    GmailApp.searchImpl = () => [];
    ScriptApp.newTrigger = function () {
      throw new Error('Trigger creation failed');
    };
    processAssistantLabel();
    assertTrue(LockService.released, 'processAssistantLabel releases lock even if scheduling fails');
    assertSomeMatch(
      console.errors,
      (m) => m.includes('Failed to schedule next run'),
      'processAssistantLabel logs scheduling failure'
    );
  }
}

resetMocks();
runTests();

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
process.stdout.write('\n');
if (failed === 0) {
  process.stdout.write(`All ${passed} tests passed.\n`);
} else {
  process.stdout.write(`${passed} passed, ${failed} failed.\n`);
  process.exitCode = 1;
}
