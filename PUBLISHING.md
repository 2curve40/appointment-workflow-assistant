# Publishing Guide

This directory currently contains local runtime data. Do not upload the whole folder to GitHub manually.

Use git so `.gitignore` can protect private files.

## 1. Verify Local Files

```bash
npm run check
npm run build
```

## 2. Initialize Git

```bash
git init
git add .gitignore README.md LICENSE SECURITY.md OPEN_SOURCE_CHECKLIST.md CODEX_OSS_APPLICATION.md PUBLISHING.md .env.example package.json package-lock.json tsconfig.json config public src
git add data/.gitkeep debug/.gitkeep records/.gitkeep
git status
```

Before committing, confirm that these paths do not appear in `git status`:

```text
data/tasks.json
debug/
records/task-*/
VPS_DEPLOYMENT.md
open-bochk-dashboard.command
stop-bochk-dashboard-tunnel.command
.env
node_modules/
dist/
```

## 3. Commit

```bash
git commit -m "Prepare compliance-first appointment workflow assistant for open source"
```

## 4. Create GitHub Repository

Create a public repository, then connect it:

```bash
git remote add origin git@github.com:YOUR_NAME/appointment-workflow-assistant.git
git branch -M main
git push -u origin main
```

## 5. Apply To OpenAI Codex For OSS

Use `CODEX_OSS_APPLICATION.md` as the application draft.

Official form:

```text
https://openai.com/form/codex-for-oss/
```

Open source fund:

```text
https://openai.com/form/codex-open-source-fund/
```
