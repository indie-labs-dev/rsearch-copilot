# plan: example dev task

## Status: example
## Prerequisites: none

---

## Context
This is a public example of the plan format used by the `.claude` helper.

Use it as a template when you want to break a task into explicit implementation steps.

In THIS plan:
- make one focused change
- keep scope clear
- define done conditions

Do NOT:
- mix unrelated tasks into one plan
- leave file scope ambiguous
- skip verification notes

---

## PART 1: Define the target change

### Files
- `path/to/file.js`

### Required change
Describe the exact behavior or content change that should happen.

Rules:
- explain the intended outcome, not just the mechanism
- mention user-facing constraints when they matter

### Done when
- the intended behavior is clearly implemented

---

## PART 2: Update related docs or copy

### Files
- `README.md`

### Required change
If the task changes setup, behavior, or contributor expectations, update the related docs.

### Done when
- docs no longer contradict the implementation

---

## PART 3: Verify

### Required change
Run the smallest useful verification pass for the task.

Examples:
- manual smoke check
- targeted unit test
- grep/sanity pass for stale references

### Done when
- the change has at least one explicit verification step

---

## Files to touch
- `path/to/file.js`
- `README.md`

## Done when
- implementation matches the requested scope
- related docs are aligned
- verification is complete
