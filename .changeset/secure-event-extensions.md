---
"@serhiitroinin/fold-harness": minor
---

Add a deny-by-default runtime persistence projection for adapter extension
events and tool extension maps. Adapters explicitly select safe data before
the runtime detaches and bounds it; unapproved, invalid, or oversized values
retain no raw payload and produce only sanitized diagnostics.
