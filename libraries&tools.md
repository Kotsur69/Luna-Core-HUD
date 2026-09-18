I want to add a "Recommended Libraries \& Tools" view/modal to the application interface.



\### Requirements



1\. Data \& Categorization

Render a structured, clean directory using the following exact categories and items:



\*\*UI Components \& Design Systems\*\*

\- daisyUI (https://daisyui.com) – Pure-CSS component plugin for Tailwind CSS with multi-theme support.

\- Kokonut UI (https://kokonutui.com) – Modern, agent-friendly React + Tailwind + Motion components.

\- OriginKit (https://www.originkit.dev) – Clean React UI blocks and layout components.



\*\*Animation \& Visual Effects\*\*

\- Motion (https://motion.dev) – Production-grade animation library for React and JavaScript.

\- Particles (Casberry) (https://particles.casberry.in) – Interactive WebGL/Canvas particle effect backgrounds.



\*\*Data Visualization \& Metrics\*\*

\- Bklit UI (https://bklit.com) – Modern chart components and live telemetry visuals.



\*\*AI Tools \& Automation\*\*

\- Manus (https://manus.im) – Autonomous AI agent for browser automation and workflow execution.



2\. UX \& Interactivity

\- Render as a sleek modal/panel matching our overall dark HUD theme.

\- Keyboard shortcut to trigger/toggle: `Ctrl + B` (or `Alt + L`). Include an accessible close button (and `Esc` to close).

\- Allow clicking any item to open the URL in a new browser tab (`target="\_blank" rel="noopener noreferrer"`).

\- Add a quick filter/search input at the top to narrow down libraries by keyword or category.

\- Add a "Copy Link" or "Quick Insert" action button next to each entry.



3\. Code Integration

\- Create a modular, reusable React component (e.g., `LibraryDirectoryModal` or similar) with typed data structures.

\- Register the global shortcut handler cleanly without breaking existing keybinding listeners. ctrl b for example

Repository Categorization & Descriptions
1. Agent Skills, Frameworks & Infrastructure
cloudflare/computer

Description: Provides a persistent, Linux-like virtual filesystem inside Cloudflare Durable Objects. It gives AI agents their own sandbox environment to run code, mount drives, and persist workspace state between sessions.

usestrix/strix

Description: An autonomous, agentic penetration testing tool. It uses AI agents operating inside sandboxed Docker environments to scan apps for vulnerabilities, validate flaws, and generate actual Proof-of-Concept (PoC) exploits or security patches.

mvanhorn/last30days-skill

Description: A search and research skill for AI agents (Claude Code, Cursor, Codex). It aggregates real-time trends, discussions, and engagement signals from the past 30 days across X, Reddit, YouTube, Hacker News, and Polymarket into a grounded summary.

2. Visuals, Design & Diagramming Tools
cathrynlavery/diagram-design

Description: An agent skill offering 38+ static HTML/SVG editorial diagram templates (flywheels, systems, sequences). Designed to eliminate generic "Mermaid slop" by producing clean, brand-matched technical diagrams.

tt-a1i/archify

Description: An interactive architecture diagram generator for coding agents. It parses codebases or system prompts into typed JSON IR, compiling it into self-contained HTML/SVG system maps with interactive tracing and commit-backed source evidence.

3. Web Scraping, Search & Automation
unclecode/crawl4ai

Description: An open-source, LLM-friendly web crawler and scraper engine. It extracts clean Markdown, structural data, screenshots, and raw HTML optimized for LLM context windows and RAG pipelines.

Panniantong/Agent-Reach

Description: A zero-API-fee web scraping and search CLI for AI agents. It allows agents to search and parse platforms like Twitter, Reddit, YouTube, GitHub, Bilibili, and XiaoHongShu directly.

browser-use/browser-use

Description: A web automation tool that allows AI agents to interact with websites, handle complex UI workflows, fill out forms, click elements, and navigate web applications using vision and DOM trees.

4. Full-Stack Web App & AI Generators
AKCodez/seo-god

Description: An autonomous SEO agent skill and runner. It conducts site audits, tracks keyword rankings, analyzes AI visibility, and schedules automated daily maintenance/fix loops.

JCodesMore/ai-website-cloner-template

Description: A Next.js/Tailwind starter template paired with an AI skill that reverse-engineers and clones existing websites. It analyzes computed CSS, assets, and layouts to recreate a modern codebase automatically.

diegosouzapw/OmniRoute

Description: An LLM routing engine/proxy that unifies multi-model provider endpoints (OpenAI, Anthropic, local models), handling fallback routing, rate limiting, and prompt delivery across different LLM backends.

5. Media, Audio & AI Utility Tools
jamiepine/voicebox

Description: A local-first, open-source AI voice synthesis and cloning studio powered by local TTS engines (like Qwen3-TTS/Kokoro). Features multi-track timeline editing, dictation, and MCP agent voice I/O.

guillaumemeyer/watermarks-remover

Description: A privacy-focused tool and agent skill designed to identify and strip AI provenance marks, C2PA metadata, and synthetic watermarks from text and media files.

6. System & Developer Utilities
pranshuparmar/witr

Description: A Linux CLI tool that answers "Why is this running?" It traces PID ancestry, systemd/Docker/PM2 supervisors, and network ports to reveal the exact causal chain behind running processes.

public-apis/public-apis

Description: A massive, community-curated list of free public APIs organized by categories for developers to use in software and AI projects.

Shortcut Recommendation: Keep Ctrl+B or Create New Shortcuts?
If you are managing this list in an editor/IDE workspace (like VS Code, Obsidian, or an AI CLI environment):

Keep Ctrl+B for Navigation / Toggling:

Standard behavior across tools uses Ctrl+B for toggling the sidebar or building/running tasks. If you use it purely for quick bookmarking, sidebar navigation, or opening a central workspace file, leave it as Ctrl+B.

Create New Shortcuts for Workflows:

Agents & Automation (Ctrl+Shift+A or similar): Tools like last30days-skill, browser-use, strix, and archify are heavy, interactive agent tools. Map specific agent runs to dedicated keybindings rather than burying them under Ctrl+B.

Quick Diagnostics (Ctrl+Alt+W or similar): Utilities like witr (process tracing) or watermarks-remover benefit from an instant hotkey when inspecting a file or process in a active terminal.

Verdict: Keep Ctrl+B for generic navigation or building, but assign new, dedicated shortcuts for triggering high-frequency agent actions (last30days, archify, witr) to prevent hotkey conflicts and maintain clean terminal focus.

1. AI & Autonomous Agents (Orchestration & Voice)
livekit/agents: Open-source framework for building real-time, multi-modal, programmable voice AI participants (STT, LLM, TTS) over WebRTC.

langflow-ai/langflow: Visual builder for orchestrating AI agents and workflows, featuring an interactive playground, Python custom nodes, and native MCP/API deployment.

langgenius/dify: Production-ready LLMOps platform for designing AI workflows, RAG pipelines, agent orchestrations, and visual prompt engineering.

2. Software Development, Code RAG & CLI Skills
vitali87/code-graph-rag: Tree-sitter & Memgraph parser that converts multi-language codebases into a unified knowledge graph for natural-language querying, architectural analysis, and AST refactoring.

cathrynlavery/diagram-design: Specialized AI agent skill designed for terminal coding assistants (Claude Code, Codex CLI) to auto-generate architectural and system design diagrams.

3. Autonomous Content Creation, Media & Writing
xiamuceer-j/MuMuAINovel: AI-powered novel drafting platform with character management, plot timeline visualization, multi-LLM backend support, and relationship graphs.

GVCLab/PersonaLive: Real-time, streamable diffusion framework for generating infinite-length portrait/avatar animations designed for live streaming on a single 12GB GPU.

aiming-lab/AutoResearchClaw: 23-stage autonomous academic research pipeline that handles literature search, experimental execution, self-healing code, peer review, and LaTeX generation.

4. Business Automation, Productivity & DevOps
Zackriya-Solutions/meetily: Privacy-first, local-only AI meeting assistant (Rust/Tauri) with real-time transcription, speaker diarization, and Ollama-powered summaries.

coollabsio/coolify: Open-source, self-hosted PaaS alternative to Vercel and Heroku for deploying full-stack apps, databases, and Docker services on any VPS.

CoreBunch/Instatic: Self-hosted visual CMS built on Git and Bun, combining content modeling, layout canvas editing, and static site generation without SaaS dependencies.

Stirling-Tools/Stirling-PDF: Web-based PDF manipulation suite for editing, merging, splitting, converting, and OCR processing documents locally.