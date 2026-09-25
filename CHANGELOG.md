# Changelog

## 0.1.3 — 2026-09-25

- Publish explicit proactive contact and confirmed main-task endings through the existing durable outbox; preserve legacy custom-connector compatibility.
- Keep stable task identity, task type and progress distinct; correlate changing heartbeat IDs without manufacturing more tasks.
- Preserve terminal outcomes and native retry semantics; no SDK, model, permission, concurrency or signing changes.
- Deploy the compatible gateway before this release. Offline tests do not constitute real push or model acceptance.

## 0.1.2 — 2026-09-25

- Publish structured Skill, child-task and tool-progress records with stable input-scoped identities; update existing messages rather than appending each heartbeat.
- Surface native API/subagent retries, HTTP 429 evidence, quota warnings and terminal errors without replaying work or changing concurrency.
- Preserve task outcomes, redact known credentials, omit prompts/thinking/tool arguments, and mark missing terminal evidence unknown after stream termination or bridge restart.
- Bound new progress identities per turn with an explicit omission notice; native task execution is not capped by presentation.
- Keep SDK 0.3.281, native permissions and independent release signing unchanged. Do not enable additional model-generated progress summaries. Deploy the compatible activity-aware gateway first.

Validation: reducer/offline bridge tests and gateway simulated-SDK integration; real-model concurrency/limit reproduction is not included in this release validation.

## 0.1.1 — 2026-09-25

- Add opt-in native full trust (`bypassPermissions` with `allowDangerouslySkipPermissions`) and an instance-bound capability report. Other permission modes keep the bypass opt-in disabled; host and OS restrictions still apply.
- Preserve separate draft, topic and future-default configuration scopes. Freeze initial model/provider/effort/permission selections once; preserve native sessions across subsequent turns and restarts.
- Report explicit approval outcomes (approved, rejected, timed out or cancelled) rather than treating request closure as a decision. Outcomes do not certify tool execution success.
- Strengthen configuration admission, idle/maintenance guards and operation-instance binding. No automatic retry of uncertain model work.
- Keep Agent SDK 0.3.281 and the existing independent release-signing identity. Deploy a compatible gateway before starting this version. No automatic permission changes or self-update are introduced.

Validation: gateway integration tests use a simulated SDK runner and isolated HTTP fixtures; release CI checks all three packaged platforms. These are not production model or tool-execution acceptance.
