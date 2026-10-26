# gantt.mrover.org

A shared Gantt chart for MRover. Tasks nest as deep as you need, for example:

```
Rolling Rover → RA → Joint D → BMC → Schematic / Schematic review / Layout / Layout review / Parts ordered …
```

It's a static site (plain HTML/JS, no build step) hosted on GitHub Pages. The schedule itself is
[`data/schedule.json`](data/schedule.json) in this repo. Every save from the website is a commit,
so you get full history and blame for free.

## Using it

- **Anyone with the link can view.** Click a task to edit it. Drag a bar to move it, or drag its edges to change start/end.
- **Breaking things down:** hover a row and click **+** to add a subtask, or open a task and use
  **Break down → Add steps** to stamp a standard sequence under it, already linked (see *Dependencies*):
  - *PCB / electronics board*: Schematic → Schematic review → Layout → Layout review → Board fab ordered → Assembly → Bring-up & test,
    with *Parts ordered* starting right after the schematic review, in parallel with layout. Assembly waits for both parts and boards.
  - *Mechanical part*: CAD → Design review → Drawings → Manufacturing → Assembly → Testing, with stock ordered after the design review
  - *Software feature*: Design → Implementation → Code review → Sim testing → On-rover testing
- **Duplicate** copies a task with all its subtasks (e.g. make Joint E's BMC from Joint D's).
- **Dependencies:** in a task's editor, **Waits for** lists the tasks that must finish first. Arrows show these links on the chart.
  When something slips (e.g. you drag *Layout* a week later), everything waiting on it moves later automatically,
  keeping each task's length. Nothing is ever pulled earlier on its own. A task can wait for a whole group
  (e.g. *Joint D integration* waits for *BMC* and *Gearbox*). **Chain subtasks in order** links each subtask to the one above it in one click.
  Links that would make a task wait on itself, its parent, or its own subtasks aren't offered.
- Parent rows roll up automatically: their dates span their subtasks, the dark fill shows the fraction
  of steps done, and the status becomes blocked or in progress if any child is.
- Overdue tasks get a dashed red outline. Filter by text, owner or status from the toolbar.
- Undo/redo: `Ctrl+Z` / `Ctrl+Shift+Z`. Save: `Ctrl+S`.

### Saving (each team member, once)

Saving writes to `data/schedule.json` through the GitHub API, so each editor needs a token:

1. Make sure you have write access to this repo (ask a lead to add you as a collaborator).
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - **Resource owner:** the account/org that owns this repo
   - **Repository access:** *Only select repositories* → `gantt.mrover.org`
   - **Permissions → Repository → Contents:** *Read and write*
3. On the site, open **⚙ Settings**, paste the token, and optionally add your name for commit messages.

The token stays in your browser's local storage and is only sent to `api.github.com`. Don't set it up on shared computers.

### Several people editing at once

Edits are kept locally (they survive a refresh) until you click **Save to GitHub**. When you save, the
site fetches the latest version and does a task-by-task merge, so if you changed one task and a
teammate changed another, both changes are kept. If you both changed *the same field of the same task*,
your value wins and the site tells you. If you're idle, the page picks up teammates' saves when you come back to the tab.

## Hosting setup (one-time, repo admin)

1. **Settings → Pages →** *Source:* Deploy from a branch → `main` / `/ (root)`.
2. The [`CNAME`](CNAME) file already sets the custom domain to `gantt.mrover.org`. In mrover.org's DNS, add:
   `gantt  CNAME  b100dev.github.io.`
3. Once DNS resolves, tick **Enforce HTTPS** in the Pages settings.
4. (Optional) Protect `main` so the CI check below must pass for PRs. Saves from the site commit directly,
   so a branch protection rule that blocks direct pushes would block the site too.

If the repo moves (e.g. into an MRover org), update `CONFIG` at the top of [`app.js`](app.js) and the DNS target.

## Editing the data by hand

`data/schedule.json` has one task per line:

```json
{"id":"bmc-layout-rev","parent":"ra-jd-bmc","name":"Layout review","owner":"","status":"todo","start":"2026-10-22","end":"2026-10-24","milestone":false,"link":"","notes":"","deps":["bmc-layout"]}
```

`status` is one of `todo`, `in-progress`, `blocked`, `done`. Dates are `YYYY-MM-DD`, with the end date included.
`deps` lists the ids of tasks that must finish first. Hand edits aren't rescheduled until someone next
edits in the site, and a task that starts too early shows a red dashed arrow. The order of lines sets the order of siblings. A parent's own dates/status are ignored once it has children.

CI ([`.github/workflows/validate.yml`](.github/workflows/validate.yml)) checks the file on every push.

## Development

```sh
npm start          # serves on http://localhost:8000
npm test           # unit tests for merge/validation logic (lib.js)
npm run validate   # check data/schedule.json
```

`lib.js` is the pure logic (dates, normalisation, dependency scheduling, 3-way merge, validation) shared by the browser and Node.
`app.js` is the UI and GitHub sync. `style.css` follows the system light/dark theme.
