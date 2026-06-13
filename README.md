# PassToAssistant

A small Gmail script that automatically marks emails as unread when you label them for an assistant. No more manually marking unread after every email you pass along.

---

## What This Does

You read an email, decide an assistant needs to see it, and apply their label. The script runs about a minute later and:

1. Finds every thread under that label that hasn't been processed yet
2. Marks those threads **unread** (so they rise to the top of the label view)
3. Adds a `Processed` label so it never re-processes the same thread

The assistant just opens their label in Gmail — unread threads are at the top. No fuss.

**Supports multiple assistants.** Each assistant gets their own label processed independently.
> [!TIP]
> **Not just for assistants.**
> You can use this with any Gmail label. Set it up for a team member, a shared mailbox, a project label — anything where you want newly-labeled threads to auto-surface as unread.

---

## Before You Start — Create Your Labels

These steps happen in Gmail, not in the script.

### 1. Create an assistant label

1. Open [Gmail](https://mail.google.com)
2. On the left sidebar, click **More** then **Create new label**
3. Type a name for your assistant's label — for example, `Alex Rivera Assistant`
4. Click **Create**

Repeat for each assistant you want to use this with.

### 2. Optionally create the "Processed" label

The script can create it automatically, but you can also make it now if you like:

1. **More → Create new label**
2. Name it `Processed`
3. Click **Create**

---

## Setup

Each person who wants to use this must set up their own copy. These steps are one-time only.

### Step 1: Open Google Apps Script

1. Go to [script.google.com](https://script.google.com)
2. Sign in with the Google account that has your Gmail
3. Click the **+ New project** button (top-left)

### Step 2: Name your project

1. At the top-left, click **Untitled project**
2. Type `Pass To Assistant`
3. Press Enter to save

### Step 3: Delete the placeholder code

The editor window shows a default function:

```javascript
function myFunction() {

}
```

Select all of it and delete it so the editor is blank.

### Step 4: Copy the script from GitHub

1. Open the repo file [`PassToAssistant.js`](./PassToAssistant.js) in a new browser tab
2. Select the entire contents of the file (Ctrl+A or Cmd+A)
3. Copy it (Ctrl+C or Cmd+C)

### Step 5: Paste into the editor

1. Go back to the Apps Script tab
2. Click in the blank editor window
3. Paste (Ctrl+V or Cmd+V)

### Step 6: Edit the assistant labels

Find the line near the top that looks like this:

```javascript
const ASSISTANT_LABELS = ["FirstName LastName Assistant"];
```

Replace `FirstName LastName Assistant` with the label name you created in Gmail. If you have multiple assistants, add them as comma-separated items:

```javascript
// Example with two assistants:
const ASSISTANT_LABELS = ["Alex Rivera Assistant", "Sam Patel Assistant"];
```

Make sure the names match your Gmail labels **exactly** — including spaces and capitalization.

### Step 7: Save the project

Click the **Save** icon (floppy disk) in the toolbar, or press Ctrl+S (Cmd+S on Mac).

### Step 8: Run the setup function

1. In the toolbar, find the function dropdown — it probably says `myFunction` or `processAssistantLabel`
2. Click the dropdown and select **`setup`**
3. Click the **Run** button (play icon)

### Step 9: Authorize the script

A pop-up will ask for permissions:

1. Click **Review permissions**
2. Choose your Google account
3. A warning appears: *"Google hasn't verified this app"* — this is normal because you wrote it yourself
4. Click **Advanced** (bottom-left of the warning)
5. Click **Go to Pass To Assistant (unsafe)**
6. Click **Allow**

The script is now authorized and will start running automatically.

### Step 10: Verify it worked

After a minute or so, try it out (see "How to Use It" below). If it doesn't work, check the **Triggers** section:

1. In the Apps Script editor, click the clock icon in the left sidebar (Triggers)
2. You should see one trigger listed for `processAssistantLabel`
3. If not, go back to the editor, select `setup` from the function dropdown, and click Run again

---

## How to Use It

1. Open an email thread in Gmail
2. Using the label button (or by dragging), apply one of your assistant labels — for example `Alex Rivera Assistant`
3. That's it

Within about a minute, the thread will be marked unread and tagged as `Processed`. When the assistant opens that label in Gmail, unread emails appear at the top.

> **Tip:** You do not need to manually mark the email unread. The script does that for you.

---

## If Something Goes Wrong

| Symptom | Likely Cause | Fix |
|---|---|---|
| Nothing happens after labeling an email | Label name in script doesn't match Gmail | Open the script, check `ASSISTANT_LABELS` against your actual Gmail labels — they must match exactly |
| Script stopped running after a week | Triggers can sometimes be removed by Google | Open the project, select `setup` from the function dropdown, click Run |
| "Label not found" warning in logs | A label in the `ASSISTANT_LABELS` array doesn't exist yet | Create the missing label in Gmail, or remove it from the array if no longer needed |
| Can't remember if it's running | Check the Triggers panel (clock icon in Apps Script editor sidebar) | — |

---

## Customization

All settings are at the top of `PassToAssistant.js`. Edit them before running `setup()`.

| Constant | Default | What It Does |
|---|---|---|
| `ASSISTANT_LABELS` | `["FirstName LastName Assistant"]` | List of assistant label names to watch |
| `PROCESSED_LABEL` | `"Processed"` | Label added to threads once handled |
| `SEARCH_PAGE_SIZE` | `100` | How many threads to check per search batch |
| `NEXT_RUN_DELAY_MS` | `60000` | Milliseconds between runs (60000 = 1 minute) |
| `RUNTIME_BUDGET_MS` | `300000` | Max ms per run before stopping (300000 = 5 minutes) |

After changing any of these, re-run the `setup()` function to apply the changes.

---

## Hiding the "Processed" Label

The `Processed` label is just for tracking — you probably don't want to see it. To hide it:

1. Open Gmail and click the **Settings** gear icon (top-right)
2. Click **See all settings**
3. Go to the **Labels** tab
4. Find `Processed` in the list
5. Under **Show in label list**, click **hide**
6. Under **Show in message list**, click **hide**
7. Scroll down and click **Save Changes**

The label still works. It just won't clutter your sidebar or message view.

---

## Notes

- **Each person needs their own copy.** Installable triggers in Google Apps Script run under the person who created them and cannot be shared.
- **Free quota limits.** Google Apps Script has daily quotas: roughly 90 minutes of execution time and 20,000 Gmail read/write operations per day. This script uses 2-3 calls per run and runs about once per minute, which is well within free limits for normal use.
