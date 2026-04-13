# Digest Guide

## What is a digest

A digest is a summarized briefing of recent social media activity, organized by topic (not by person or source). It includes a feedback step where the user indicates what's interesting and what's not, which updates their preferences in Memory.

## When to trigger

- User asks: "what's hot", "any updates", "today's summary", "briefing"
- Or via `/loop` for recurring digests

## Flow

### Step 1: Collect fresh data

```bash
site-use twitter feed --count 50 --tab following --stdout
```

Adjust `--tab` and `--count` based on user preferences in Memory. If the user prefers specific Lists (once multi-feed is supported), collect from those too.

### Step 2: Read user preferences from Memory

Before summarizing, check Memory for:
- **Interests** — topics to highlight
- **Not interested** — topics to suppress or de-prioritize
- **Digest preferences** — how many signals, what depth

### Step 3: Generate summary

Summarize by **topic/signal**, not by person:

```
3 signals worth noting today:

1. [Topic A] — Brief summary. (Sources: @author1, @author2)
2. [Topic B] — Brief summary. (Source: @author3)
3. [Topic C] — Brief summary. (Source: @author4)

Filtered out: 12 posts about [topics the user marked as not interested]
```

Rules:
- Lead with the most relevant signals based on user preferences
- Always attribute sources (who said it)
- Mention what was filtered out so the user knows coverage
- Include links to original tweets for deep-dive
- Deduplicate against the previous digest. Only report new signals — if a topic was already covered in the last cycle, skip it unless there's a meaningful update.

### Step 4: Ask for feedback

After presenting the digest, ask:

- "Any of these worth digging into?"
- "Anything here you'd rather not see next time?"
- "Any topics missing that you expected to see?"

### Step 5: Update Memory

Based on the user's feedback:
- Add new interests or ignored topics
- Adjust signal priority
- Note any specific requests ("more about X", "less about Y")

This creates the learning loop:

```
Collect → Filter by Memory → Summarize → Feedback → Update Memory → Next digest is better
```

## Recurring digest via /loop

If the user wants automatic digests:

```
/loop 2h Run a digest: fetch latest tweets (following tab, 50 items), filter by my preferences in Memory, summarize top signals with tweet URLs, skip anything already reported in the previous digest.
```

The loop prompt must be self-contained — each trigger starts a fresh context with no memory of the previous cycle's conversation. Write the full workflow into the prompt so the AI knows exactly what to do.

The user can adjust frequency. Note: `/loop` is session-scoped — it stops when Claude Code exits. Remind the user of this when setting it up.

## Important

- A digest is NOT just "fetch and dump." The value is in filtering, prioritizing, and asking for feedback.
- If Memory has no preferences yet, trigger onboard first.
- Keep digests concise. 3-5 signals is better than 20. The user can always ask to expand.
