---
id: policy/review-routing
kind: policy
version: 1
owner: person
title: Review routing
---
Every contribution is triaged, then reviewed by two agents from model families other than the author's.
A person is asked when reviewers disagree, when any review blocks, when confidence is low,
when protected files change, and before any outcome is accepted.

```nest-policy
{ "agentReviewers": 2, "minConfidence": 0.75, "protectedPaths": [".nest/", "src/data.ts", "wrangler.jsonc", "package.json"] }
```
