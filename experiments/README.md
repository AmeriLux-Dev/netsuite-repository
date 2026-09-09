# Experiments: what N/query can do for the library

These probe scripts run in the SuiteScript Debugger (API 2.1) and record what the N/query object model resolves,
renders, and accepts. Their results are the evidence behind the 1.0.0 design: the library hands every join to
N/query and carries no NetSuite schema of its own.

| Script | Question | Result |
|---|---|---|
| `n-query-join-probe.js` | Does `autoJoin` accept subrecord, sublist, and select fields? Does `Component.target` name the table? | `n-query-join-probe.results-run1.json`. Every join was accepted; `target` is null; a formula column does not make the join render. |
| `n-query-join-probe-2.js` | Does a real field on the joined side render the join, and what does the predicate look like? | `n-query-join-probe.results-run2.json`. Yes: `"TRANSACTION".shippingaddress = transactionShippingAddress.nkey(+)`; sublist joins render inner without a main-line filter; `autoJoin` on select fields such as `entity` fails at render. |
| `n-query-object-model-probe-3.js` | Everything the 1.0.0 runtime assumes: the record type as query type, `joinFrom` for sublists, `joinTo` for references, DISPLAY columns, text conditions, operators per field type, paging and key casing, and/or/not, root types, aggregates, `ANY_OF` list sizes, sorts, datetime operators. | Pending. Fill in the ids at the top, run it, and save the returned JSON as `n-query-object-model-probe-3.results.json`. |

| `smoke-test-1.0.0.js` | Do the three query shapes the consumer's generated configs compile to run in an account: the order header with `joinFrom` lines, `autoJoin` addresses, `joinTo` items, DISPLAY columns, and text conditions; the separate load of a reference matched on a code column; a datetime condition on a custom record. | Pending. Fill in the ids at the top, run, and compare row counts and keys with the previous build. |

The probes contain no account data; the results files record field ids and rendered SQL only.

## What the results decided

- **Joins come from N/query.** A subrecord is `autoJoin(fieldId)`, a sublist is `joinFrom(parentField, lineType)`, a reference is `joinTo(selectField, targetType)`. The build step emits those three facts from the model and nothing else.
- **NetSuite picks inner or outer.** There is no join-type option in N/query. `load: 'separate'` on a relation decorator runs a second query keyed by the parent ids when parents must come back regardless.
- **A joined component renders only when a column or condition references it.** The runtime only joins the components its selected fields, conditions, and sorts touch.
- **`createColumn` does not validate field ids; `toSuiteQL` and `run` do.** Errors surface at execution, which is why the probes run their queries.

## Open items probe 3 settles

Probe 3 is the last check before the runtime's assumptions are confirmed in an account: whether a query rooted at
`salesorder` exposes custom body fields, whether `joinFrom` renders the line join and whether the header row needs
the `mainline` filter, whether references join through `joinTo`, whether DISPLAY-context columns and `#DISPLAY`
formula conditions work, how mapped-result keys are cased, and the operators each field type accepts.
