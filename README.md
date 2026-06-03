# Appointment Workflow Assistant

A compliance-first, semi-automated appointment workflow assistant for small operators who manage authorized customer bookings.

The project focuses on reducing repetitive form-entry work while keeping human verification, site terms, and operational safety at the center of the workflow.

## What It Does

- Provides a local dashboard for managing appointment-related tasks.
- Accepts customer intake through a separate public-facing form.
- Extracts structured fields from pasted customer conversations.
- Tracks task status, revenue, completion rate, elapsed time, and result records.
- Runs a scheduling layer with active hours, reminder windows, focus windows, and low-frequency checks.
- Keeps detailed debug logs, screenshots, and trace files for troubleshooting.
- Archives successful results with reference numbers, result JSON, and optional confirmation screenshots.

## Compliance Boundaries

This project is designed as an assistive workflow tool, not a bypass tool.

It intentionally does not:

- Solve, bypass, or automate CAPTCHA or human verification.
- Bypass SMS, OTP, queueing, rate limits, access controls, or anti-abuse systems.
- Use proxy pools, anti-detection techniques, aggressive concurrency, or abnormal request rates.
- Attack, scrape, or stress-test third-party services.

When a verification or manual review step appears, the workflow pauses and waits for the user.

Use this software only for yourself or for customers who have clearly authorized you to help with their appointment workflow. You are responsible for complying with the terms of any third-party service you interact with.

## Why This Project Exists

Small operators often manage repetitive, time-sensitive appointment work with scattered conversations, manual forms, screenshots, and ad hoc spreadsheets. This project turns that process into a safer, auditable workflow:

- Customer intake is separated from the private dashboard.
- Manual verification remains manual.
- Logs make failures explainable.
- Results are archived in a structured format.
- Scheduling avoids constant refreshing outside important windows.

## Features

### Task Dashboard

- Create and edit tasks.
- Track status, attempts, elapsed time, and income.
- Show required fields clearly.
- Display final reference number and result paths.
- Keep recent logs folded inside each task card.

### Customer Intake

- Public intake page for customers.
- Private dashboard remains separate.
- Intake token support for simple shared-link flows.

### Scheduling

- Active hours and sleeping hours.
- Normal low-frequency checks.
- Reminder windows before key time points.
- Focus windows for user-prepared workflows.
- Target-date phase and priority helpers.

### Debugging

- `debug/run.log` for system and step logs.
- Step and failure screenshots.
- Playwright trace archives when the workflow runner is used.
- Page text and diagnosis files when the flow cannot classify a state.

### Result Archiving

- Manual or automated successful result recording.
- `records/task-[taskId]/result.json`.
- Optional success screenshot path.
- Dashboard display for reference number, date, time, location, completion time, and result path.

## Installation

```bash
npm install
npx playwright install chromium
```

## Run Locally

Development dashboard:

```bash
npm run dashboard
```

Build and run compiled server:

```bash
npm run build
npm run start:dashboard
```

Open:

```text
http://127.0.0.1:4173/
```

Customer intake:

```text
http://127.0.0.1:4173/intake
```

## Configuration

Copy the example request and edit it locally:

```bash
cp config/example.request.json config/local.request.json
```

Local request files are ignored by git.

Environment variables:

```bash
cp .env.example .env
```

## Runtime Data

The following directories are runtime-only and are excluded from git:

- `data/`
- `debug/`
- `records/`

They may contain customer data, screenshots, trace archives, confirmation text, reference numbers, or local operational details.

Before publishing a fork or repository, run through `OPEN_SOURCE_CHECKLIST.md`.

## Scripts

```bash
npm run check
npm run build
npm run dashboard
npm run dashboard:debug
npm run start:dashboard
```

## Project Structure

```text
src/server/          Local dashboard and API server
src/tasks/           Task store and runner boundary logic
src/scheduler.ts     Pure scheduling and date-priority helpers
src/debug/           Debug logger utilities
src/xianyu/          Conversation parsing utilities
src/bochk/           Optional site adapter used by the local workflow runner
public/              Dashboard and customer intake UI
config/              Example request configuration
```

The site-specific adapter is intentionally isolated so that the reusable value of the project remains the workflow shell: scheduling, intake, logging, task state, and result archiving.

## Security And Privacy

See `SECURITY.md`.

## OpenAI Codex For OSS Application Draft

See `CODEX_OSS_APPLICATION.md`.

## License

MIT
