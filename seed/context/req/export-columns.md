---
id: req/export-columns
kind: requirement
version: 1
owner: person
title: Export columns
---
An export contains one row per issue the viewer can see, with these columns in this order:
id, title, status, internal_notes.

```nest-policy
{ "columns": ["id", "title", "status", "internal_notes"] }
```
