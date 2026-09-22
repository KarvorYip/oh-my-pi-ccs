---
name: mem-search
description: Search claude-mem's persistent cross-session history. Use when the user asks whether prior work already solved something, how something was done previously, what happened during a past period, or needs exact evidence from an earlier session.
---

# Memory Search

Use the narrowest layer that answers the question:

1. `memory_search` → compact index with IDs.
2. `timeline` → surrounding chronological context.
3. `get_observations` → full summaries for selected IDs.
4. `get_tool_uses` → raw tool input/output only when summaries omit required evidence.

## Search

Start with `memory_search`. Supply `project` when the question belongs to one codebase.

```text
memory_search(query="authentication", limit=20, project="my-project")
```

Useful filters:

- `type`: `observations`, `sessions`, or `prompts`.
- `obs_type`: comma-separated observation types such as `bugfix,decision`.
- `dateStart` / `dateEnd`: ISO dates.
- `orderBy`: `date_desc`, `date_asc`, or `relevance`.
- `offset`: pagination offset.
- `platformSource`: restrict results to one agent source.

A date-only browse MAY omit `query`.

## Timeline

After selecting a result, read nearby context by ID:

```text
timeline(anchor=11131, depth_before=3, depth_after=3, project="my-project")
```

No ID yet? Let the worker locate one:

```text
timeline(query="authentication", depth_before=3, depth_after=3, project="my-project")
```

Provide exactly one of `anchor` or `query`.

## Observation Details

Fetch only IDs selected from the index or timeline. Batch multiple IDs in one call.

```text
get_observations(ids=[11131, 10942], project="my-project")
```

These are full generated summaries; they usually answer the question.

## Raw Tool I/O

Use `get_tool_uses` only when an observation points to tool-use IDs and the exact command output, API response, or diff is required.

```text
get_tool_uses(ids=["toolu_01ABC"], project="my-project")
```

Raw payloads are unsummarized and may be large. Search and read observations first.

## Completion

Answer from the smallest sufficient layer. Cite observation IDs when they support the conclusion; state when no matching history exists.
