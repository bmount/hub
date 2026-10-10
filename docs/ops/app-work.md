# App errors and recorded work

Authorized `trace.read` / MCP `trace_read` calls and the Apps error inspector show work associated with an error group. Associations come from a recorded URL source, an explicit URL link, or the group's existing `work_item_id` pointer. They are evidence, not proof that logs authorized execution, that a fix worked, or that the viewer has access to another destination.

The URL match is exact: `https://<tenant>.<hub-domain>/apps?g=<encoded-group-id>`. Use that URL in the work inspector's **Add link** form with kind **URL**, or as `source_kind: url` and `source_ref` when filing through `work.create`. Other URLs, fragments and additional query parameters are not inferred to identify the group. Work inspectors open safe HTTPS source URLs without fetching or verifying the target; unsafe URLs remain non-navigable.

## Filing from an error

Members can choose **File a snag** on an error group to open `/new?trace=<id>`. The server reads the authorized group, not title/body/source values supplied in the URL. The File form defaults to the group's project and snag kind, supplies bounded details and an editable excerpt of at most 2,000 UTF-16 units, and records the canonical group URL as a `url` source. Shortened excerpts are identified. The title and details are also bounded to the existing filing limits without splitting Unicode pairs.

The group must belong to this tenant and a non-channel project. Its project must be active and its slug unambiguous among this tenant's non-channel projects; unknown, foreign, malformed, archived or ambiguous targets return 404 instead of a generic draft. Readers cannot open the filing form. Different source groups have different draft pane keys.

Opening the draft performs no write or model call. The member must review and submit the existing CSRF-protected, audited `work.create` form. The resulting URL source makes the item appear as **filed** in the error's recorded-work view. This neither updates the legacy group pointer nor prevents someone explicitly filing another item from the same group.

## Association coverage

A source URL association is labelled **filed**. Explicit links and the legacy group pointer are **linked**. An item with multiple associations appears once, with **filed** taking precedence. Related work must belong to the current tenant and have a matching non-channel project. The error group's project must also match its tenant and not be a channel.

At most 50 items are shown, ordered by creation time descending and item ID descending. Invalid rows are excluded before the limit. API/MCP return `relatedWork` and `relatedWorkCoverage` (`limit`, `shown`, `truncated`); one extra row detects truncation. The browser reports the same coverage. Error lists and app summaries require matching non-channel projects; legacy work references require a matching work/project tenant and a non-channel project. App counters stay with the reporting tenant; group counts and latest-deploy samples also match its mapped project. Error occurrences and deploys remain tenant-scoped, and deploys must match the group's project. Archived records remain readable under the existing tenant-reader rule.

Opening these views neither files work nor sends mail or invokes a model. Existing filing permissions and audit behavior are unchanged.
