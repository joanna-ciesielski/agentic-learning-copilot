# ADR 0001 — Orchestrate agents with LangGraph.js

**Status:** accepted · **Date:** 2026-07

## Context

The system needs a supervisor that routes a query to one of several vertical agents,
with room to add agents, share typed state, and (later) persist state across turns for
a self-improvement loop. The target platform's stack is Node/TypeScript with
LangChain.js already in use.

## Decision

Use **LangGraph.js** (`StateGraph`) for orchestration: a supervisor node with
conditional edges to vertical-agent nodes, a typed state channel, and a checkpointer for
cross-turn memory in later phases. Keep the orchestration behind a thin internal wrapper
so the rest of the code is not coupled to a specific framework version.

## Consequences

- **+** Matches the target stack; supervisor + sub-agent pattern is first-class.
- **+** Typed state + checkpointing give a clean home for the Zone-4 profile loop.
- **−** LangGraph.js API is still evolving — mitigated by pinning versions and the wrapper.
- **Alternative considered:** a hand-rolled router. Rejected: it re-implements graph
  state, edges, and checkpointing that LangGraph already provides, and it wouldn't
  demonstrate the framework the role uses.
