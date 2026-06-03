# Open Source Release Checklist

Use this checklist before pushing the repository to GitHub.

## Privacy

- [ ] Remove or ignore `data/tasks.json`.
- [ ] Remove or ignore all `debug/` screenshots, traces, logs, and page text files.
- [ ] Remove or ignore all `records/` result JSON and screenshots.
- [ ] Remove `.env` and local deployment tokens.
- [ ] Confirm no customer names, phone numbers, emails, reference numbers, or screenshots are committed.

## Repository Hygiene

- [ ] Run `npm run check`.
- [ ] Run `npm run build`.
- [ ] Confirm README uses compliance-first language.
- [ ] Confirm examples use mock data only.
- [ ] Confirm `config/example.request.json` does not contain real customer data.
- [ ] Confirm `VPS_DEPLOYMENT.md` is not committed.

## GitHub Setup

- [ ] Create a public GitHub repository.
- [ ] Add a short project description:
  `Compliance-first appointment workflow assistant with manual verification checkpoints, scheduling, diagnostics, and result archiving.`
- [ ] Add topics:
  `typescript`, `playwright`, `workflow-automation`, `task-dashboard`, `scheduler`, `debugging`, `open-source`.
- [ ] Add screenshots using mock data only.
- [ ] Open at least a few issues for roadmap items.

## OpenAI Codex For OSS Application

- [ ] Make your GitHub profile public.
- [ ] Make the repository public.
- [ ] Prepare your role statement.
- [ ] Prepare why the repository matters.
- [ ] Prepare how API credits would be used.
- [ ] Find your OpenAI organization ID.
- [ ] Submit the Codex for OSS form.
