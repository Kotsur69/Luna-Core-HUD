# ARCHITECTURAL SPECIFICATION & DEVELOPMENT PLAN
## Module: Luna-Core Multi-Model Orchestration Engine & Harness Tree (`luna-orchestrator`)

**Document Version:** 2.0.0  
**Target Environment:** macOS / Linux / WSL2  
**Core Ecosystem:** Go 1.22+, Charm Stack (`bubbletea`, `lipgloss`), Process Isolation, IPC Locks  
**Primary Integration:** Luna-Core-HUD + Multi-Agent Pipeline (Claude Code, Kimi API, Codex, LM Studio)

---

## 1. Executive Summary & Vision

The **Luna-Core Multi-Model Harness Tree** transforms `Luna-Core-HUD` into a high-throughput, multi-agent orchestration deck. Instead of relying on a single LLM to perform every task sequentially, Luna-Core dynamically routes work to specialized models running in parallel:

* **Claude Code (Main Architect & Core Logic):** Oversees application architecture, backend logic, complex refactoring, and overall project coordination.
* **Kimi API / Agent (Frontend & TUI Specialist):** Generates UI component boilerplate, CSS/Tailwind rules, Lip Gloss styles, and complex layout code.
* **Codex / Automated Reviewer (Quality & Diff Checker):** Performs fast asynchronous code reviews on file diffs before changes are committed to the codebase.
* **LM Studio / Local LLM (Low-Cost Utility Worker):** Handles off-grid, low-priority tasks (docstrings, AST formatting, small refactors, token summarization) with zero API overhead.

---

## 2. System Architecture & Component Diagram

```
                               ┌─────────────────────────────────────────┐
                               │       Luna-Core Task Router / HUD       │
                               └────────────────────┬────────────────────┘
                                                    │
                 ┌──────────────────────────────────┼──────────────────────────────────┐
                 │                                  │                                  │
                 ▼                                  ▼                                  ▼
   ┌──────────────────────────┐       ┌──────────────────────────┐       ┌──────────────────────────┐
   │       Claude Code        │       │        Kimi API          │       │      Codex Reviewer      │
   │ (Main Architect / Logic) │       │ (Frontend & UI Specialist│       │  (Automated QA / Review) │
   └─────────────┬────────────┘       └─────────────┬────────────┘       └─────────────┬────────────┘
                 │                                  │                                  │
                 └──────────────────────────────────┼──────────────────────────────────┘
                                                    │
                                                    ▼
                                      ┌──────────────────────────┐
                                      │   LM Studio / Local LLM  │
                                      │  (Formatting & Utilities)│
                                      └──────────────────────────┘
```

---

## 3. Dynamic Task Delegation Matrix

| Model / Agent | Primary Specialty | Trigger Conditions / Scope | Output Handling |
| :--- | :--- | :--- | :--- |
| **Claude Code** | Backend, Core Logic, Refactoring | Complex architectural edits, multi-file features | Writes directly to source tree |
| **Kimi** | Frontend & TUI Layouts | Styles, UI widgets, component design | Generates code in sandbox / staging |
| **Codex** | Diff Inspection, Code Review | Triggers post-save or pre-commit | Output rendered in HUD review modal |
| **LM Studio** | Utilities, Docs, AST Format | Formatting, inline docs, token reduction | Writes directly to target files |

---

## 4. Cross-Agent Message Bus & Mutex File Locks

To prevent concurrent writes and race conditions (e.g., Claude and Kimi modifying the same file simultaneously), Luna-Core uses an IPC file-backed state and locking engine (`.luna/orchestration/`):

```
.luna/orchestration/
├── state.json                 # Global status of all active worker nodes
├── queue/                     # Incoming task queue payloads
│   ├── task_001_frontend.json
│   └── task_002_review.json
└── locks/                     # File-level mutex locks
    ├── main.go.lock
    └── view.go.lock
```

### Mutex Rules
1. Before any sub-agent (Kimi, LM Studio) receives a write task, the orchestrator checks `.luna/orchestration/locks/`.
2. If a file is locked by **Claude Code**, external sub-agent writes are queued until the lock expires or is explicitly released.
3. Once file operations complete, the lock is freed and a notification event is dispatched to the HUD.

---

## 5. TUI Harness Matrix View Specification

A dedicated panel inside `Luna-Core-HUD` renders real-time status cards for each active worker in the harness tree:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        LUNA-CORE HARNESS MATRIX                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [CLAUDE CODE]   ● ACTIVE  │ Editing: internal/app/model.go            │
│  [KIMI API]      ● ACTIVE  │ Generating Lip Gloss component layout  │
│  [CODEX REVIEW]  ○ STANDBY │ Waiting for file diff stream...            │
│  [LM STUDIO]     ○ IDLE    │ Local vLLM instance ready                  │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  [RECENT LOG STREAM]                                                    │
│  10:14:02 [Kimi]   Generated 'styles/themes.go' (142 lines)             │
│  10:14:05 [Claude] Applied state mutation in 'internal/app/update.go'   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Implementation Roadmap & Milestones

### Phase 1: Task Router & Orchestrator Engine (`internal/orchestration/`)
* **Step 1.1:** Implement the `AgentNode` Go interface to unify execution triggers for Claude Code, Kimi, and LM Studio.
* **Step 1.2:** Build task queue reader (`.luna/orchestration/queue/`) to handle task dispatching.

### Phase 2: File Locking & Mutex Engine
* **Step 2.1:** Build file-locking manager (`internal/orchestration/locks.go`) using `fsnotify` and atomic file creation.
* **Step 2.2:** Add task conflict checks so parallel agents execute cleanly without file corruption.

### Phase 3: TUI Harness Matrix Panel
* **Step 3.1:** Create `internal/ui/widgets/harness_matrix.go` using Bubble Tea to render live status indicators and log streams for every sub-agent.
* **Step 3.2:** Hook worker state updates into background tick updates (`200ms` refresh rate).

### Phase 4: Expansion & Integrations (Future)
* **Step 4.1 (Voice Event Triggers):** Add voice notifications for harness events (e.g., *"Kimi completed UI component generation"*).

---

## 7. Additional System Ideas for Luna-Core-HUD

### Idea 1: Local API Sandbox & Mock Server Engine
* **Standalone Mock Harness:** An embedded Go HTTP server inside the HUD that spins up instant mock endpoints based on OpenAPI/Swagger specs, letting Kimi or Claude test API integrations locally without touching production servers.

### Idea 2: Automated "Dead Code & Unused Imports" Reaper
* **Background AST Cleaner:** A background worker (powered by LM Studio or Go AST tools) that continuously scans modified files and cleans up unused imports, dead variables, or unformatted code right after saving.

### Idea 3: Interactive CLI Macro Recorder
* **Macro Deck (`Ctrl+M`):** Allows recording a sequence of terminal inputs and agent commands, saving them as reusable HUD hotkeys or voice commands (e.g., `Save -> Run Tests -> Trigger Codex Review -> Git Push`).

---

## 8. Reference Implementation Code (`internal/orchestration/router.go`)

```go
package orchestration

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type AgentRole string

const (
	RoleClaude AgentRole = "CLAUDE_ARCHITECT"
	RoleKimi   AgentRole = "KIMI_FRONTEND"
	RoleCodex  AgentRole = "CODEX_REVIEWER"
	RoleLM     AgentRole = "LM_STUDIO_UTILITY"
)

type Task struct {
	ID        string
	Role      AgentRole
	Payload   string
	TargetFile string
}

type AgentNode struct {
	Role   AgentRole
	Status string // "IDLE", "ACTIVE", "ERROR"
	mu     sync.Mutex
}

type Orchestrator struct {
	nodes map[AgentRole]*AgentNode
}

func NewOrchestrator() *Orchestrator {
	return &Orchestrator{
		nodes: map[AgentRole]*AgentNode{
			RoleClaude: {Role: RoleClaude, Status: "IDLE"},
			RoleKimi:   {Role: RoleKimi, Status: "IDLE"},
			RoleCodex:  {Role: RoleCodex, Status: "IDLE"},
			RoleLM:     {Role: RoleLM, Status: "IDLE"},
		},
	}
}

func (o *Orchestrator) DispatchTask(ctx context.Context, task Task) error {
	node, exists := o.nodes[task.Role]
	if !exists {
		return fmt.Errorf("unknown agent role: %s", task.Role)
	}

	node.mu.Lock()
	node.Status = "ACTIVE"
	node.mu.Unlock()

	go func() {
		defer func() {
			node.mu.Lock()
			node.Status = "IDLE"
			node.mu.Unlock()
		}()

		// Simulate async agent execution pipeline
		time.Sleep(2 * time.Second)
	}()

	return nil
}
```
