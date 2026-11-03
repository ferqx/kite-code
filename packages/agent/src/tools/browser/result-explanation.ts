import type { Json, ToolResult } from '../../extensions';

const explanations: Readonly<Record<string, string>> = {
  browser_page_already_open:
    'Another page is already bound in this task. This attempt did not acquire the requested candidate; the rejection does not show that either page closed or disappeared. Continue only on the currently bound page. When finished, call page.close() to release automation while keeping the page, then give a normal final answer. A later user message can bind the intended retained page in a new task; do not replace, refresh or navigate another page to work around this limit.',
  browser_page_capacity:
    'The browser reported its limit of open or reserved pages. Another page cannot be opened under this limit. Report the limit while preserving the existing pages; do not silently reuse or navigate a different page to work around it.',
  browser_tab_limit:
    'The browser reported its open-tab limit. Another page cannot be opened under this limit. Report the limit while preserving the existing pages; do not silently reuse or navigate a different page to work around it.',
  browser_page_grant_create_failed:
    'The browser could not prepare the requested new tab or establish a usable target binding. The underlying cause and whether a partial page was created are not confirmed. This failure does not authorize overwriting or navigating an existing page as a substitute.',
  browser_page_existing_missing:
    'The target of the selected retained-page candidate is closed or unavailable. Its old handle is invalid, so this attempt cannot continue on that page. This result concerns only that candidate; it does not establish that other retained pages are missing.',
  browser_existing_page_unavailable:
    'The previous target page is closed or unavailable. Its old handle is invalid, so this attempt cannot continue on that page.',
  browser_page_existing_mismatch:
    'The target page address, identity or navigation state changed. The old page binding no longer matches the target.',
  browser_page_existing_ambiguous:
    'Multiple existing pages match this address. A unique intended page could not be identified, so this attempt did not bind, create or navigate a page.',
  browser_page_stale:
    'The page handle is no longer valid for this task or control generation. The page may have changed, closed or lost its control connection.',
  browser_stale_element:
    'The element reference is no longer valid for the current page observation. The page or its control generation changed; the old reference cannot be used.',
  browser_page_lease_stale:
    'The page control lease is no longer valid. The target may have closed, been replaced or become unavailable; this result does not identify who caused it.',
  browser_page_closed:
    'The original target page was closed. Its previous handle can no longer read or control it. This result does not identify who closed the page or undo earlier completed actions. Do not create, refresh or navigate a replacement as a continuation of that original page.',
  browser_stale_or_foreign_target:
    'This page target no longer matches the current task or control generation. The old handle cannot be used.',
  browser_control_not_owned:
    'Browser control is no longer owned by this operation. The page or its control connection may have ended or changed.',
  browser_control_not_agent:
    'Agent control of the browser page is unavailable. The page or its control connection may have ended or changed.',
  browser_control_released:
    'Automation control was already released for this task. Its old page handles cannot take control back within the same task.',
  browser_page_binding_required:
    'This handle is only a pending existing-page candidate. It has not been bound and freshly observed, so it cannot send page input.',
  browser_page_recovery_required:
    'The original page is retained after its first navigation lost confirmation. Its old navigation result remains unknown. This request did not bind, create, refresh or navigate a page. List browser.pages(), identify the original observationRequired candidate by its current URL, and take a fresh snapshot before opening another page or sending input. Do not retry the earlier navigation or use another URL to bypass this observation.',
  browser_page_observation_required:
    'The retained original page has a new control binding but no successful current snapshot. Take page.snapshot() before input, navigation or a screenshot. Old element references and screenshot coordinates are invalid. The earlier navigation result remains unknown; do not replay it.',
  browser_native_action_failed:
    'The browser returned an unsuccessful operation. A current page read or control result could not be obtained; the page or its connection may be unavailable.',
  browser_page_request_failed:
    'The browser page request failed. The target page or its control connection may be unavailable; the exact reason is not confirmed.',
  browser_page_response_limit:
    'The browser returned more data than this operation can receive. This request could not return its result within the response size limit; this error does not establish that the page closed or the control connection ended. Earlier actions keep their recorded outcomes.',
  browser_page_document_not_ready:
    'The target document did not become ready for this observation. It may still be loading or its navigation may have failed; no current page observation was returned. This does not undo earlier completed input or navigation.',
  browser_page_read_stale:
    'The target page or its control generation changed while this read was waiting or running. No current observation was returned, and old references cannot be used.',
  browser_page_preflight_failed:
    'The browser could not prepare the target page before sending a Runtime command. That command was not sent, and no current observation was returned. Earlier operations keep their recorded outcomes. If control is still valid, obtain a fresh page observation before deciding the remaining work; do not repeat earlier navigation or input based on this failure.',
  browser_page_state_invalid:
    'The browser could not verify the current address and title against the original page and control binding. No usable current page state was returned. This does not prove that the page closed. Preserve earlier results, release control and explain the limitation; do not open or refresh a replacement to bypass the unverified binding.',
  desktop_browser_page_state_invalid:
    'The browser returned an incomplete or mismatched original-page receipt. Its current page state cannot be trusted, and the control connection is being closed. Earlier action results remain unchanged; do not retry them or choose another page to bypass this integrity failure.',
  browser_page_navigation_unavailable:
    'The current browser host cannot provide its required navigation capability. This attempt did not send a navigation. Report the unavailable capability and preserve existing pages; do not substitute a different control path.',
  browser_page_navigation_denied:
    'The requested page address is not allowed for this navigation. This attempt did not send it. Use an allowed HTTP or HTTPS address within the current user task; do not replace or navigate an unrelated page.',
  browser_page_navigation_stale:
    'The original page or control binding changed before this navigation could start. No navigation was sent by this attempt. Obtain a fresh observation only if the current control state permits it; preserve earlier results and old-reference failures.',
  browser_page_navigation_busy:
    'The original page still has a navigation being settled. This attempt did not send another navigation. Do not repeat the earlier action or start a replacement page; use its original result and report any unresolved state.',
  browser_page_navigation_outcome_unknown:
    'The browser did not confirm completion of the original navigation. The page may already have loaded or redirected, and stopping the waiter does not undo that effect. Preserve the unknown result and inspect the accurate original page through the normal recovery path; do not replay the navigation.',
  browser_snapshot_failed:
    'The browser page could not be read. The target may be unavailable or its browser connection may have been interrupted.',
  desktop_browser_read_stale:
    'The browser page changed or became unavailable during the read. No current observation could be returned.',
  browser_observation_stale:
    'Browser control or page state changed during the read. The resulting observation is stale and cannot be used.',
  browser_process_outcome_unknown:
    'The browser control connection ended without a confirmed lifetime result. The target may have closed or become unavailable.',
  browser_startup_outcome_unknown:
    'The browser lost confirmation while binding the target page or starting its navigation. The target page may have closed or its control connection may have been interrupted.',
  browser_ended_before_ready:
    'The browser session ended before the page binding was ready. No current page handle or observation is available from that session.',
  browser_startup_failed:
    'A usable browser page binding could not be established. The page or its browser connection may be unavailable; no confirmed current page handle was returned.',
  browser_page_control_unknown:
    'The browser page control state is unknown. The page or browser connection may have ended or become unavailable.',
  browser_page_dialog_cleanup_unknown:
    'The page may already have received the dialog decision, but closing the native dialog interface was not confirmed. Do not use the old dialog reference to act on a newer dialog.',
  browser_page_dialog_outcome_unknown:
    'The browser did not confirm the final dialog state. The page may already have received the decision while the native dialog interface may remain open. Do not use the old dialog reference to act on a newer dialog.',
  browser_action_outcome_unknown:
    'The browser lost confirmation while handling a page action. The target page or its control connection may have ended.',
  browser_native_connection_failed:
    'The browser connection failed. The target page or browser process may be closed or unavailable.',
  browser_native_response_lost:
    'The browser connection ended before the operation response was received. The target page or browser process may be closed or unavailable.',
  desktop_browser_closed:
    'The browser control connection has ended. The target page may be closed or unavailable, so this operation cannot continue on its old handle.',
  browser_stop_unconfirmed:
    'The browser did not confirm that automation stopped and its control was released. The current page and control state cannot be confirmed.',
  browser_executor_cleanup_unknown:
    'The browser code environment did not confirm cleanup. Its control and resource state cannot be safely assumed to be released.',
  browser_previous_cleanup_unconfirmed:
    'The previous browser action or cleanup state remains unresolved. This attempt cannot establish a safe current page binding from that prior state.',
  browser_owner_run_unverifiable:
    'The browser page could not be verified against its original owning task. Current control cannot be established from that prior state.',
  browser_executor_timeout:
    'The browser code exceeded its time or CPU budget and that code environment stopped. This timeout does not show that the page closed or that earlier completed input was undone.',
  browser_execution_stopped:
    'The browser code environment stopped before this batch completed. The target page or its control connection may have ended or become unavailable.',
};
const record = (value: Json | undefined): Record<string, Json> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const known = (value: Json | undefined): string | undefined =>
  typeof value === 'string' && Object.hasOwn(explanations, value) ? value : undefined;

/** Pure display only. Never changes outcome, dispatch facts, original results or recovery authority. */
export function explainBrowserExecutionResult(result: ToolResult): ToolResult {
  if (result.outcome === 'succeeded') return result;
  const details = record(result.details);
  let code = known(result.content) ?? known(details?.code);
  let originalUnknown = false;
  let current = details;
  // Only the fixed owner envelopes are inspected. Page text and arbitrary nested
  // objects cannot supply an explanation or manufacture dispatch evidence.
  for (let depth = 0; current && depth < 4; depth++) {
    code = known(current.cause) ?? known(current.code) ?? code;
    const originalJob = record(current.originalJob);
    const originalResult = record(originalJob?.result);
    if (originalResult) {
      originalUnknown ||= originalResult.outcome === 'outcome_unknown';
      code =
        known(record(originalResult.details)?.cause) ??
        known(record(originalResult.details)?.code) ??
        known(originalResult.content) ??
        code;
      const ref = record(originalJob?.ref);
      if (
        originalJob?.definitionId === 'browser.session' &&
        originalJob.definitionVersion === '1' &&
        typeof originalJob.executionId === 'string' &&
        originalJob.executionId.length > 0 &&
        ref?.extensionId === 'builtin.browser' &&
        ref.executionId === originalJob.executionId &&
        originalResult.outcome === 'outcome_unknown' &&
        originalResult.content === 'job_stop_unconfirmed'
      ) {
        // Core's exact Job supervision wrapper, not arbitrary nested page data.
        const actual = record(record(originalResult.details)?.actualResult);
        if (
          actual?.outcome === 'outcome_unknown' &&
          (known(record(actual.details)?.code) ?? known(actual.content)) ===
            'browser_stop_unconfirmed'
        )
          code = 'browser_stop_unconfirmed';
      }
    }
    current = record(current.original);
  }
  if (!code && result.content === 'The operation was aborted.' && details?.executorStopped === true)
    code = 'browser_execution_stopped';
  if (!code) return result;
  const unknown = result.outcome === 'outcome_unknown' || originalUnknown;
  let content = explanations[code]!;
  if (
    !unknown &&
    result.outcome === 'failed' &&
    [
      'browser_page_existing_missing',
      'browser_existing_page_unavailable',
      'browser_page_existing_mismatch',
    ].includes(code)
  )
    content +=
      ' This existing-only binding did not create or refresh a replacement page or navigate back to the old address.';
  if (unknown)
    content +=
      ' The last dispatched action may or may not have completed; its result remains unknown. Do not replay it, retry it under another key, or automatically create or refresh a replacement page.';
  else if (result.outcome === 'failed' && code === 'browser_page_existing_missing')
    content +=
      ' The old candidate is invalid. List browser.pages() once more to inspect the remaining candidates. If another candidate uniquely matches the page intended by the current user task, construct a fresh browser.page(candidate.id) handle and take a new snapshot. If no unique candidate matches, explain that limitation. Do not choose by list order, recency or visibility, guess between same-URL pages, navigate another page or replay earlier actions. If the current user task clearly requests opening a known URL and does not depend on the original page state, use a separate browser.open(theActualUrl) call and take a fresh snapshot of the new page. Do not replay earlier input or unknown actions. A connection failure or identity mismatch does not permit this recovery, and this result does not clear an unknown result or unconfirmed cleanup.';
  else if (result.outcome === 'cancelled')
    content += ' This step was cancelled; that does not undo any earlier completed actions.';
  const rawCode =
    result.content === 'job_stop_unconfirmed' ||
    /^(?:browser_|desktop_browser_)[a-z0-9_]+$/.test(result.content)
      ? result.content
      : (known(details?.code) ?? code);
  content += `\nDiagnostic code: ${rawCode}${rawCode === code ? '' : `; cause: ${code}`}.`;
  return {
    ...result,
    content,
    details: {
      ...(details ?? (result.details === undefined ? {} : { originalDetails: result.details })),
      ...(details?.code === undefined ? { code: rawCode } : {}),
      diagnostic: { code, originalContent: result.content },
    },
  };
}
