# AI Coding Methodology Suite (Six-Plugin)

Turn AI pair development from ad-hoc edits into an engineering method with **process, evidence, and gates**. Six independently installable plugins cover the full loop: idea assessment → requirement clarification → planning → review → execution → debugging → verification/review → closing and learnings, plus a research-methodology tier for coding-adjacent domains.

This is an **AI Coding and Research Methodology** project (domain anchor: algorithm research, computer science, software engineering). The same assets and discipline run on ZCode, DeepSeek Harness, MiniMax Code, and Kimi Code. The repository is also the development home of the methodology; its design specs (`specs/`) and development-process records (`docs/`) are not published with the source code.

## What it solves

- **No skipped steps**: every development task first hits the single routing table in the workflow meta skill, then enters idea review, planning, execution, debugging, review, or closing.
- **Evidence before completion**: verification commands must actually run; spec validation, tests, reviews, and gates leave reviewable evidence.
- **Host portability**: the same six-plugin assets attach to different hosts through adapter layers; project-level skills live in the cross-host discovery root `项目级技能`.

## The six plugins

| Plugin | Role |
|---|---|
| **workflow** | Conversational development-process engine: workflow's 20 skills form the single routing system, with dangerous-command guards, task leases, edit freeze, completion gate, and three read-only agents |
| **spec-gate** | Spec-asset governance and machine validation: spec/plan validators, aggregate completion gate, task ledger, evidence capture |
| **scout** | Project-level low-discipline mode for exploratory work and one-shot deliverables: mode declaration, expiry checkpoints, graduation handoff |
| **team-governance** | Optional: AI Run Manifest, model policy, collaboration leases, content-bound approvals, replay evaluation, governance reports |
| **algo-loop** | Optional: metric contracts, experiment ledger, bad-case library, baseline registry (`.algo/` five-file state) |
| **research-loop** | Optional: rival explanations, preregistration cards, CS experiment-design decision tree; zero hooks/state, explicit research intent |

Installation tiers: `workflow` is the core and is required; `spec-gate` needs the project to opt into `.sdd/`; the other four are installed per project need and do not affect the rest when absent.

## Choose a host

| Host | Installation | Details |
|---|---|---|
| ZCode | Install the six plugins from a marketplace; `node zcode-adapter/cli.mjs install --bootstrap` for a new machine | `zcode-adapter/README.md` |
| DeepSeek Harness (DSH) | `dsh plugin --profile <profile> add link:<repo checkout path>` (pin a compatible CLI version) | `ai-coding-methodology/README.md` |
| MiniMax Code (MCode) | `node mcode-adapter/cli.mjs install` materializes local packages into the host data directory | `mcode-adapter/README.md` |
| Kimi Code | `node kimi-code-adapter/cli.mjs install` writes `plugins/managed/` directly | `kimi-code-adapter/README.md` |

Capability differences (native surfaces, fallbacks, pending real-host evidence) are documented in each adapter README's capability summary or known-limitations section. Passing package-mapping tests is not the same as a verified host UI/session.

## Quick start

1. **Pick a host and install**: follow the adapter README in the table above.
2. **Start with the minimum**: `workflow` alone is enough; add `spec-gate` and run `/spec-gate:init` when you need spec gates.
3. **Run the first task**: open a new session and describe the task (or `/feature-dev <task>`); the routing table is injected at session start and picks the single entry skill for the scenario.
4. **Verify injection**: open a new session and check SessionStart injection, guard firing, routing hit and command reachability against the adapter README's smoke checklist; record observations.
5. **Recover/reinstall**: hooks default to fail-open (silent on error, never block the session); the only exception is check-freeze's DENY on unreadable payloads. If you suspect drift, run the adapter's `verify` first for ZCode/MCode/Kimi, then re-run `install` (idempotent, write-then-verify, rollback on failure); for DSH, re-link with `dsh plugin --profile <profile> add link:<path>`. Do **not** manually delete old ZCode cache directories.

## Development and maintenance notes

The repository's spec system (`specs/`), development-process records (`docs/`), project-level skills (`.agents/`), and internal validation toolchain (repository-level `scripts/`, `tests/`) are **not published** with the open-source release; the public surface contains product source and the repository-root facade files only. Contributors can start from each plugin README's environment/verification sections; maintainer release/install entry points follow below.

## Maintainer entry points

- **Release** (six plugins share one version): `node zcode-adapter/cli.mjs publish --marketplace <marketplace source>` — runs the full validation set, then syncs the marketplace source and manifest.
- **Install**: `node zcode-adapter/cli.mjs install`; version fold: `node zcode-adapter/cli.mjs bump --version <X.Y.Z> --note "<summary>"`; six-face read-only check: `node zcode-adapter/cli.mjs verify`.
- Each plugin and adapter README documents its own verification commands; the repository's internal validation toolchain, specs and process records are not published.

## Documentation map

| Document | Audience | Purpose |
|---|---|---|
| `README.md` / `README.en.md` | Human users and contributors | Suite positioning, host selection, onboarding and maintainer entry points |
| `<plugin>/README.md` | Users and contributors | Plugin capabilities, installation, requirements and verification commands |
| `<adapter>/README.md` | Users of each host | Installation, capability differences and known limitations |

## Requirements

One supported host (event-hook support is documented in the `## 环境要求` section of each plugin README) + Node.js ≥ 21 (the only hard requirement; bash is optional and only affects the shell semantics of verify-gate declared commands, with four-level detection fallback).

## License

MIT. Third-party attribution is recorded in the root `LICENSE` supplement and each plugin's `LICENSE`/`NOTICE`.
