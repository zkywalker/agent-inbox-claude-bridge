# Changelog

## 0.1.1 — 2026-09-25

- Add opt-in native full trust (`bypassPermissions` with `allowDangerouslySkipPermissions`) and an instance-bound capability report. Other permission modes keep the bypass opt-in disabled; host and OS restrictions still apply.
- Preserve separate draft, topic and future-default configuration scopes. Freeze initial model/provider/effort/permission selections once; preserve native sessions across subsequent turns and restarts.
- Report explicit approval outcomes (approved, rejected, timed out or cancelled) rather than treating request closure as a decision. Outcomes do not certify tool execution success.
- Strengthen configuration admission, idle/maintenance guards and operation-instance binding. No automatic retry of uncertain model work.
- Keep Agent SDK 0.3.281 and the existing independent release-signing identity. Deploy a compatible gateway before starting this version. No automatic permission changes or self-update are introduced.

Validation: gateway integration tests use a simulated SDK runner and isolated HTTP fixtures; release CI checks all three packaged platforms. These are not production model or tool-execution acceptance.
