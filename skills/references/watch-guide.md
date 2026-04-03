# Watch Guide

## What is a watch

A watch is a long-term monitoring task for a specific topic, project, or person. It runs periodically, checks for relevant new activity, and only alerts the user when something meaningful happens. Silent otherwise.

## When to trigger

- User says: "track this", "monitor X for me", "keep an eye on", "alert me if", "watch this topic for two weeks"

## Flow

### Step 1: Define the watch

Clarify with the user:
- **What to watch**: topic, keyword, project name, specific person
- **Where to look**: Twitter search, specific tab, specific list
- **Conditions**: what counts as "worth alerting" (any mention? only high-engagement? only negative sentiment?)
- **Duration**: how long to monitor (default: 1 week)
- **On completion**: what to do when the watch period ends (summary report? just stop?)

Example conversation:
```
User: "Keep an eye on the Devin drama for the next week"
AI: "Got it. I'll search Twitter for 'Devin' daily. I'll alert you if:
     - Major new developments (high engagement posts)
     - Sentiment shifts (backlash or vindication)
     Otherwise I'll stay quiet. After a week I'll give you a summary. Sound good?"
```

### Step 2: Create the loop

Use `/loop` to set up periodic checks:

```
/loop 4h Search Twitter for "Devin", check for major new developments or sentiment shifts, alert me if found
```

`/loop` takes a natural language prompt, not a CLI command. The AI reads the prompt each cycle, runs the appropriate site-use commands, and decides whether to alert.

### Step 3: Periodic check (each cycle)

On each loop iteration:
1. Run the search/collect command
2. Compare results against previous cycle (are there new, significant posts?)
3. Apply the user's alert conditions
4. **If conditions met** → present findings to user, ask if they want to act
5. **If conditions not met** → stay silent, log the check

### Step 4: Completion

When the watch period ends:
1. Generate a summary: key events, timeline, overall trajectory
2. Present to user
3. Ask: "Want to keep watching, or is this enough?"
4. Clean up the loop if done

## Storing watch state

Use Memory to track active watches:

```markdown
---
name: active_watches
type: project
description: Currently active topic watches with conditions and expiry
---

## Devin controversy
- Query: "Devin" on Twitter search
- Conditions: high engagement (>100 likes) or sentiment shift
- Started: 2026-04-02
- Expires: 2026-04-09
- Status: active
```

Update this Memory entry as watches are created, completed, or cancelled.

## Important

- A watch is NOT a repeated fetch-and-dump. The value is in **silence** — only interrupting when it matters.
- Keep the check interval reasonable (2-4 hours). More frequent wastes resources and risks rate limits.
- Always confirm the watch parameters with the user before starting.
- When a watch expires, always deliver the final summary — don't just silently stop.
