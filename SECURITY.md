# Security Policy

## Supported Use

This project is intended for local, authorized workflow assistance.

Allowed use:

- Managing appointment-related tasks for yourself or customers who explicitly authorized you.
- Storing structured task metadata locally.
- Pausing for manual verification when a third-party service requires it.
- Debugging failed workflows with local logs and screenshots.

Disallowed use:

- CAPTCHA solving or bypassing.
- SMS, OTP, queue, rate-limit, or anti-abuse bypass.
- Proxy pools, anti-detection, account evasion, or aggressive concurrency.
- Unauthorized access to third-party services.
- Publishing customer records, screenshots, trace files, or confirmation text.

## Sensitive Local Files

The following paths are intentionally ignored by git:

- `data/`
- `debug/`
- `records/`
- `.env`
- local request configs under `config/*.request.json`

These files may contain personal data, screenshots, reference numbers, tokens, operational logs, or third-party page content.

## Reporting Issues

If you find a security or privacy issue, do not post personal data or screenshots publicly. Open a minimal issue with:

- The affected module.
- Steps to reproduce using mock data.
- Expected behavior.
- Actual behavior.

## Maintainer Checklist

Before creating a public release:

- Confirm `.gitignore` excludes runtime data.
- Remove all private deployment notes.
- Run a secret scan.
- Use mock data in all examples.
- Verify that CAPTCHA and verification steps remain manual.
