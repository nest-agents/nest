---
id: req/csv-format
kind: requirement
version: 1
owner: person
title: CSV format
---
Exports are RFC 4180 CSV with a header row.
Fields containing commas, double quotes or line breaks are wrapped in double quotes.
A double quote inside a field is written as two double quotes.
Records are separated by CRLF.
