# Archive

Historical engineering records, kept for reference. Nothing in this directory is
maintained, and nothing here describes the current implementation.

Each document records the state of the codebase at the time it was written, and
records git state, test counts and file inventories that are now out of date.
Where an archived document contradicts current behaviour, current behaviour is in
`src/`.

| Document | What it records |
|---|---|
| `ROLE_SEPARATION_PLAN.md` | An analysis of the flat administrator role and a proposal to split it into privilege tiers. The proposed tiering is **not implemented**; the application still has exactly one `admin` role. See [../authentication.md](../authentication.md) |
| `phase16-batch4-forensic-report.md` | A forensic analysis of a frontend extraction that did not match the repository as it stood |
| `phase16-batch4-structural-extraction-repair-report.md` | The repair pass that followed, with the resulting file and test inventory |
| `batch4-summary-raw.txt` | The build and test log from before the repair pass — the baseline the repair report cites when comparing before and after. Retained because the repair report references it as its own evidence |

These are superseded by the current documentation in `docs/`.
