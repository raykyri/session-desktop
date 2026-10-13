# Session agent onboarding and maintenance review

Session should keep its research application and selectively adopt T3 Code's provider setup and maintenance patterns. The priorities are accurate readiness states, a clear transition from setup to research, and repair actions that let users retry failed research. A full fork would add provider infrastructure but require integrating or rebuilding Session's research domain and hosted API runtime.

This review covers onboarding, agent setup, and maintaining long-running research. It does not recommend expanding Session into a general agent orchestrator. Git worktrees, pull requests, terminal tabs, a marketplace of providers, and fleet administration are outside the proposed scope.

## Scope and evidence

Reviewed on October 11, 2026:

- Session at `5d888278a2ce9ffce0e7ef81d9ae583789cd89ec`.
- [T3 Code source](https://github.com/pingdotgg/t3code/tree/8d199b4f7b918079161d5f43e0146c099301be08) at `8d199b4f7b918079161d5f43e0146c099301be08`.
- T3's public site and repository, followed by implementation inspection. Features below describe that source snapshot; they are not guarantees about every released build.

The comparison is a source review, not a clean-machine usability test. No provider accounts were connected, credentials changed, or applications installed. Runtime behavior, installation success, and migration feasibility remain validation work. Local source references are relative to this document and refer to the Session revision above.

Session has two materially different execution models. [Desktop](../README.md) uses existing Claude Code, Codex, and Grok CLIs and their credentials. [Hosted web](../web/packages/server/src/runs/providers.ts) constructs API clients using deployment credentials and runs Session's own agent loop. A web user signs into Session; that does not install or authenticate a provider CLI. These flows should share terminology, but require different setup actions and maintenance owners.

## Round one findings

The initial review found that desktop setup already provides install, sign-in, and refresh steps; copyable commands; links to provider setup guides; research launch checks; and retained prompts after failure. T3 adds a first-run sequence, integrated setup/authentication paths, provider account details, and installer-aware maintenance.

The first candidate gaps were completion of onboarding, uncertainty hidden by readiness labels, incorrect repair instructions, installation-channel mismatch, maintenance diagnostics, and separation of desktop from hosted provider readiness. The fork investigation added questions about credential ownership, runtime changes during active research, capability policy, and research-data migration.

## Round two validation with subagents

Three independent subagents examined desktop setup, hosted lifecycle, and fork feasibility. Their findings were checked against the source.

| Review | Confirmed or added | Correction to the initial interpretation |
| --- | --- | --- |
| Desktop setup and maintenance | Unknown authentication can satisfy setup completion; the intended success hint is hidden; Codex install/update channels differ; legacy terminal instructions remain. | Session already has Retry, launch checks, and automatic status refresh. The gap is a connected repair flow, not their absence. |
| Hosted onboarding and lifecycle | Submit readiness is weaker than picker readiness; credential presence substitutes for health; search degradation and context maintenance are poorly surfaced. | Session already has usage totals, quota enforcement, rate-limit retries, compaction, and restart recovery. Improve their visibility and user controls. |
| Full-fork feasibility | Provider setup infrastructure is reusable, but research state, hosted identity/admission, and distribution need explicit ownership. | Managed ChatGPT uses dynamic registration, not a fixed T3 OAuth client ID. Own-brand authorization is unverified, not proven impossible. |

Keep the existing [readiness refresh](../src/App.tsx) on startup, when opening agent setup, after five minutes of focus/visibility, and on new research submission; the backend's [30-second probe cache](../src-tauri/src/adapters/mod.rs); [Retry](../src/components/research/ResearchTurn.tsx); durable research history; and the hosted runtime's [retries and recovery](../web/docs/05-run-lifecycle-and-streaming.md). Session also exposes research capability flags; the proposed work makes their use consistent and visible.

## Consolidated gap list

P1 means address in the next onboarding/reliability work. P2 means valuable subsequent work. A proposed product option is distinguished from a confirmed defect. Fork-derived requirements apply before adopting that architecture; they do not imply Session must implement a full provider platform.

### G1 Complete onboarding with a useful research action

**P1 for the hidden success state; P2 for broader orientation. Desktop defect and shared workflow gap.**

[agentSetup.ts](../src/lib/agentSetup.ts) creates a “ready for research” instruction, but [AgentSetupGuide](../src/components/AgentSetupGuide.tsx) displays hints only for the active incomplete step. When all steps are complete, `activeIndex` becomes `-1`, so that instruction disappears. The footer offers Next agent and refresh. Home also removes its setup guide once a research provider is ready. On web, [login](../web/packages/client/src/routes/login.tsx) leads into the [Home composer](../web/packages/client/src/routes/home.tsx) without a research-specific orientation.

T3's [WelcomeWizard](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/web/src/components/onboarding/WelcomeWizard.tsx) steps through connection, agents, and project import, with later stages skippable. Session should use the sequence workspace/audience → working research capability → first question, without requiring repository import.

**Done when:** successful desktop setup visibly offers “Start research with [provider]” and returns to the retained question; one usable provider is sufficient. First-time hosted users understand the question's audience and can ask a useful question without configuring a machine or provider account. Existing users can skip orientation.

### G2 Distinguish verified readiness from an attempted check

**P1. Desktop correctness gap.**

[Provider probing](../src-tauri/src/adapters/mod.rs) initializes an installed CLI as generally ready. Unrecognized authentication output produces `Unknown`; an auth-probe error is ignored. [Setup completion](../src/lib/agentSetup.ts) requires a check timestamp and general readiness, rather than authenticated evidence. It can therefore mark Sign in complete without verifying sign-in.

A second mismatch, remote probing reporting general readiness with research readiness set to Error, no longer applies: remote targets were removed, and every probed adapter is local.

**Done when:** installed, authentication verified, authentication unverified, and research-compatible are distinct states. A failed or unsupported auth probe cannot claim verified sign-in. Preserve an explicit attempt path for valid configurations that cannot be probed. Only research-capable targets count toward research setup completion; remote limitations are stated accurately.

### G3 Connect failures to repair and return to the investigation

**P1. Desktop defect and recovery gap.**

[research_runtime.rs](../src-tauri/src/research_runtime.rs) and [claude_sdk.rs](../src-tauri/src/claude_sdk.rs) now tell users to run the provider's login command in Terminal, the macOS application, rather than a terminal tab. Failed turns already expose [Retry](../src/components/research/ResearchTurn.tsx), but the error is not a structured route through provider repair and verification.

**Done when:** authentication and version failures offer the relevant provider's setup action, retain the question and failed research node, refresh its status, then offer Retry. Instructions name the correct login command and external application when needed. No terminal renderer or general shell surface is restored.

### G4 Update the installation that Session uses

**P1. Desktop maintenance defect and missing lifecycle coordination.**

[Installation metadata](../src-tauri/src/adapters/mod.rs) recommends the standalone Codex installer but supplies `npm install -g @openai/codex@latest` for updating. That can update a different executable or require npm unnecessarily. Version-floor enforcement is also narrower than an ongoing compatibility policy.

T3's [maintenance resolver](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/packages/provider-core/src/server/maintenanceResolver.ts) identifies installer ownership, while its [runner](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/server/src/provider/providerMaintenanceRunner.ts) rechecks ownership and verifies the resulting version. This is a useful pattern even if Session continues to provide manual commands.

**Done when:** update advice targets the resolved installation, unknown ownership gets an accurate manual route, and success requires checking the binary Session will launch. Distinguish app updates, provider CLI updates, and capability metadata changes. State the effect on active investigations; do not assume every external updater can preserve running processes.

### G5 Expose compact diagnostics and execution ownership

**P1. Workflow gap confirmed by the fork investigation.**

Session [metadata](../src/types.ts) already includes configured/resolved binary, version, auth state, check time, and local/remote target. [AgentSetupGuide](../src/components/AgentSetupGuide.tsx) does not display most of them. T3's [provider card](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/web/src/components/settings/ProviderInstanceCard.tsx) displays status, account, version, and maintenance details.

**Done when:** a details view explains where research runs, which installation/account supplies it where known, when it was checked, and who can fix it. Desktop offers sanitized diagnostic copying. Hosted users see service availability and an administrator repair route; deployment credentials and account secrets remain administrative. If managed installation is later added, clearly distinguish it from an existing external CLI.

### G6 Make model and research capability compatibility explicit

**P2; prerequisite for broadening supported runtimes. Desktop maintenance gap and fork-derived requirement.**

Desktop [model presets](../src/lib/launcherModels.ts) and [effort options](../src/adapters/codex.tsx) are code-defined, with an option to enter a custom model. Research capability flags exist, but installation/authentication alone do not prove the selected model supports every research operation or effort setting.

T3 separates provider capability policy and maintains a [model manifest](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/server/src/provider/ModelManifest.ts). Its default remote metadata comes from upstream `main`, with cached/bundled fallbacks. A fork must maintain its own policy or pin the upstream version.

**Done when:** Session defines supported research functions per runtime/version and explains unsupported choices before launch where evidence exists. Retired models and stale metadata have a recoverable path. Custom models remain possible with clearly stated uncertainty. A capability refresh cannot silently change the identity or context of an existing investigation.

### G7 Report hosted launch readiness accurately

**P1. Hosted correctness and service-maintenance gap.**

The [web composer](../web/packages/client/src/features/composer/ResearchQueryComposer.tsx) disables unavailable model choices but its `canSubmit` check only requires a selected model, not `selected.available`. Missing runtime config falls back to models marked available. The server safely rejects unavailable execution, but users can be invited to submit a request that cannot run.

Separately, [runtime model availability](../web/packages/server/src/trpc/routers/system.ts) is based on credential presence, not successful authentication or model access. Its public `system.health` response is not a provider health check; deployment `/healthz` is a different mechanism.

**Done when:** checking, ready, unavailable, and failed-to-check states are explicit; known-unavailable research cannot submit; bare-URL bookmarking still works. Administrators have an explicit bounded provider/model test, timestamp, and sanitized diagnosis. Ordinary users have a status retry or administrator-contact action. Avoid making paid inference an invisible background-health side effect.

### G8 Explain degraded research capabilities before submission

**P1 for missing web search visibility. Hosted workflow gap.**

[Runtime configuration](../web/packages/server/src/trpc/routers/system.ts) exposes `webSearch`, and the [search tool](../web/packages/server/src/runs/tools/webSearch.ts) is absent without a vendor key. The composer does not explain this degradation. A working model can therefore look like a fully functioning web-research agent.

**Done when:** the composer states when web search is unavailable and what still works, with an administrative repair route. Explain consequential differences in document/image handling and available research tools without showing implementation trivia. Successful model access must not imply every research capability is available.

### G9 Make quota recovery predictable

**P2. Hosted and desktop lifecycle improvement.**

Hosted [Settings](../web/packages/client/src/routes/settings.tsx) already shows usage, costs, and daily limits; [admission](../web/packages/server/src/research/admission.ts) explains daily reset, and [provider throttling](../web/packages/server/src/runs/errors.ts) retries with backoff. T3's [usage recovery banner](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx) provides additional reset/resume controls.

**Done when:** users can distinguish a Session daily cap from provider throttling, see known reset times in local time, and retain their question after rejection. Display the remaining allowance near launch when it is reliably known. Explicit cancellable deferred retry is optional; never invent a provider allowance or promise a reset time the provider did not supply.

### G10 Show how context maintenance affects continuing research

**P2. Hosted workflow gap; applicable to desktop where the provider exposes context events.**

Session already [elides old tool results and summarizes older exchanges](../web/packages/server/src/runs/messages.ts). Relevant assembly information is [debug-logged](../web/packages/server/src/runs/loop.ts), rather than presented as a research event. T3 exposes a [context meter](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/web/src/components/chat/ContextWindowMeter.tsx).

**Done when:** users can see that earlier research was summarized, which portion it covers, and how to inspect the retained evidence or create a linked continuation. Approximate budgets are labeled approximate. Preserve citations and source provenance; do not equate a visible transcript with the model's current context.

### G11 Define the effect of account and runtime changes on active research

**P1 before adding managed accounts or account switching; P2 for current external-account detection. Fork-derived lifecycle requirement.**

Session currently relies on external CLI credentials, so account changes occur outside the application. T3's [auth service](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/server/src/provider/ProviderAuthService.ts) releases native sessions based on their credential bindings when authentication changes, rather than relying only on the currently selected model.

**Done when:** any Session-managed sign-out, account replacement, or destructive runtime maintenance identifies affected investigations and defines whether they stop, resume, or require a fresh continuation. Retain historical provider/account provenance where available. Do not silently continue using a different account. This does not require adding multiple-account management now.

### G12 Consider one recoverable managed installation path

**P2. Optional product investment, not a defect in the current external-CLI contract.**

Manual installation, authentication, and returning to refresh remain work for the desktop user. T3 has a [managed Codex installer](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/server/src/provider/CodexInstallation.ts) with a pinned version, integrity checks, progress/cancellation, and leases guarding removal.

**Done when, if chosen:** a fresh Mac can install one supported runtime with progress, cancellation, repair, and post-install verification, while existing users can keep their own CLI. Establish precedence between managed and external binaries. A limited setup operation can provide this benefit without reintroducing terminal tabs. Managed credentials are a separate decision from managed binaries.

### G13 Treat migration and continuation as research contracts

**P1 gate for a full fork; P2 for broader portability work. Fork-derived requirement.**

Session's [research records](../src-tauri/src/research.rs) include tree relationships and research semantics beyond a coding conversation. Importing T3 threads is not evidence that Session research can migrate faithfully.

**Done when:** a migration exercise preserves representative branches, authored material, highlights, snapshots, archived results, citations, selected provider/model, and actual native continuation identity. Validate both history viewing and subsequent follow-ups. Maintain a recoverable original copy and report unsupported continuation explicitly. This is a migration acceptance requirement, not a claim that Session currently lacks all export or recovery facilities.

## What a T3 Code fork would change

| Flow | Infrastructure a full fork could inherit | Session work still required |
| --- | --- | --- |
| First use | Environment connection, first-run gating, provider setup, project/history import UI. | Replace the coding-project sequence with first research, audience, and evidence. Do not force repository selection. |
| Install and authenticate | Managed Codex installation/authentication, existing-CLI paths, provider authentication controllers, instance configuration. | Choose installation/credential ownership, remove upstream product identity, verify external authorization, and supply a terminal-free Session flow where needed. |
| Maintain providers | Installer-aware updates, status/account display, capability metadata, diagnostics. | Own compatibility policy and endpoints; define effects on active research. Provider-specific process protections are not a universal updater guarantee. |
| Continue investigations | Thread/runtime primitives and durable provider lifecycle machinery. | Map Session nodes, branches, artifacts, provenance, recaps, and native continuation handles; satisfy G11 and G13. |
| Desktop delivery | Electron desktop with Node/Effect server architecture. | Replace or bridge Tauri/Rust, keep Session identities, and preserve AppKit/WebKit support and research process infrastructure. TypeScript provider packages are not drop-in Rust adapters. |
| Hosted delivery | Client/environment communication and some reusable presentation patterns. | Preserve Session's GitHub identities, invitations, user isolation, per-user admission/quotas, API agent loop, and deployment-credential operations. T3 environment pairing is a different access model. |

These architectural differences are visible in T3's [overview](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/docs/internals/overview.md), [project contract](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/packages/contracts/src/orchestrationProject.ts), and Session's [hosted provider runtime](../web/packages/server/src/runs/providers.ts). A server-only fork behind Session's existing UI would reduce shell replacement, but introduce another runtime/service boundary and still need research-event, permissions, authentication, and persistence mappings.

### External services and distribution

Managed ChatGPT sign-in is not automatically proven portable by cloning the code. T3's [implementation](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/server/src/provider/CodexChatGptAuth.ts) uses `dynamic_agent_client`, identifies its agent as T3 Code, requests `chatgpt.tokens.use.direct`, and stores issued registrations. An independent Session build must verify that its own registration and scopes are accepted. The source does not justify either promising success or declaring the flow categorically unavailable. Retain an existing-CLI authentication alternative while evaluating it.

A fork also needs an inventory of metadata and update endpoints, signing/release ownership, authentication configuration, and diagnostics. T3's [model manifest source](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/apps/server/src/provider/ModelManifest.ts) is one concrete upstream dependency. Its root [MIT license](https://github.com/pingdotgg/t3code/blob/8d199b4f7b918079161d5f43e0146c099301be08/LICENSE) permits source reuse with notice retention; that does not establish access to external services or transfer distribution infrastructure.

### Recommendation and decision gates

Prefer selective adoption: implement G1–G5 and G7–G8 in Session, then evaluate G6 and the longer-running research improvements. This retains the existing research domain without requiring a platform migration for setup changes. Evaluate managed installation separately.

Before choosing a full or server-only fork, require these concrete demonstrations:

1. A Session-branded clean-machine install → sign-in → first research → restart → successful follow-up, with accurate readiness and no unintended upstream service dependence.
2. Independent verification of managed ChatGPT authorization, plus a working supported alternative.
3. Account change and runtime update during an investigation, with explicit user impact and preserved provenance.
4. Migration of a representative research tree, followed by history inspection and correct continuation.
5. A working hosted path preserving Session identities, access boundaries, quotas, and API-provider behavior.
6. An owned release/compatibility plan and an engineering comparison with adding one managed-provider flow to the existing application.

No effort estimate is asserted from source inspection alone. These demonstrations would provide the evidence needed to decide whether inherited maintenance infrastructure outweighs the integration and ongoing upstream-merge cost.
