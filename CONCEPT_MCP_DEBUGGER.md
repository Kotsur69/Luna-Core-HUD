# Concept: Interactive MCP Server Visual Debugger & Gateway

This concept outlines a visual control center and diagnostic logger for local Model Context Protocol (MCP) servers integrated with your Claude session.

## 1. Core Mechanics

Claude Code relies heavily on local Model Context Protocol (MCP) servers to read databases, pull Git history, run searches, or scrape the web. Setting up and debugging these servers is historically difficult. This widget provides a real-time visual logging and mocking gateway.

```
  ┌──────────────────┐       JSON-RPC Payload       ┌────────────────────┐
  │   CLAUDE TERMINAL│ ◄──────────────────────────► │  LOCAL MCP SERVERS │
  └──────────────────┘                              └────────────────────┘
           │                                                   ▲
           ▼                                                   │
  ┌────────────────────────────────────────────────────────────┴─────────┐
  │                      LUNACORE INTERACTIVE HUD DIAGNOSTICS            │
  │  - Visualizes active payloads (SQL queries, API responses, errors)   │
  │  - Lets you pause, restart, or inject mock failures into servers     │
  └──────────────────────────────────────────────────────────────────────┘
```

## 2. Key Elements

1.  **Live Connection Flow Mapping:**
    *   A card lists all active MCP servers registered in your local `.claude` configuration.
    *   When Claude makes an MCP call, a connection link in your HUD glows and animates a visual request bubble traveling from the terminal region to the server card, indicating active data-flow.
2.  **Structured JSON-RPC Inspector:**
    *   Clicking an active server card opens a sliding sidebar displaying a clean, syntax-highlighted history of calls (requests, responses, and errors).
    *   Instead of digging through log files, you can instantly see the exact SQL parameters Claude passed to your local Postgres MCP server, or the exact output returned by a local Puppeteer crawl.
3.  **Active Injection Control (The Sandbox Gateway):**
    *   **Failure Injector:** Toggle switches let you intentionally block or delay specific MCP responses (e.g., simulating a database timeout or internet disconnect). This lets you test and debug how Claude's code responds to API exceptions in real-time, completely locally.
    *   **Restart Button:** Directly terminate and restart hung local MCP processes without restarting your shell or your entire Electron session.

## 3. Technology & Integration

*   **Implementation:** Intercept the stdin/stdout streams of active MCP processes in LunaCore's main process (`src/main.js`). Since MCP relies on stdio-based JSON-RPC payloads, we can tap these streams, parse the JSON structures, and broadcast them over IPC to the renderer.
*   **Performance:** Non-blocking and lightweight—only parses active RPC message structures. Strictly zero-token.
