// Fixed public explanations only. These descriptions neither establish effects nor grant retries.
export const additionalFailureExplanations: Readonly<Record<string, string>> = {
  invalid_ask_user_arguments:
    'The question arguments are invalid. Supply one to three questions, each with two to three labeled and described options and at most one recommended option.',
  invalid_ask_user_answer:
    'The received answer does not match the offered options. Check the original question and answer; do not invent a selection.',
  cancel_requested:
    'The request was cancelled. Check its original response before deciding how to continue; do not automatically repeat it.',
  execution_cancel_requested:
    'The request was cancelled. Check its original response before deciding how to continue; do not automatically repeat it.',
  superseded_by_user_input:
    'New user input made the earlier decision out of date. Review the current task before choosing the next operation; do not automatically repeat the earlier request.',
  skill_text_limit:
    'The skill text is not an accepted regular text file or exceeded its supported reading limit. Check the original file and configured limit.',
  skill_text_invalid:
    'The skill text is not valid supported UTF-8 text. Preserve the original bytes; do not use a partial or guessed decoding.',
  skill_metadata_limit:
    'The skill metadata exceeds the supported name or required-capability limits. Check its declared metadata.',
  skill_resource_limit:
    'The skill declares more resources than the configured limit permits. Check the declared resource list and host limit.',
  web_input_invalid:
    'The web request arguments are invalid. Check the URL and declared positive integer timeout and content limits.',
  web_timeout:
    'The web request exceeded its time limit. Inspect the original result before deciding how to continue.',
  web_response_too_large:
    'The web response exceeds the supported reading limit. Do not present a partial response as complete content.',
  web_encoding_unsupported:
    'The web response uses an unsupported content encoding. Do not invent decoded page contents.',
  web_redirect_loop:
    'The web response redirected to an address already visited by this request. Inspect the redirect result without changing targets to bypass restrictions.',
  web_robots_denied:
    'The website robots policy does not permit this fetch. Respect that restriction rather than bypassing it.',
  web_parser_unavailable:
    'The web content parser is unavailable. The original page has not been accepted as parsed content.',
  web_content_unavailable:
    'Readable page content could not be extracted from the web response. Do not invent a page summary.',
  web_artifact_unavailable:
    'The response storage required for the complete web result is unavailable. Do not substitute a truncated result for the full response.',
  web_cancelled:
    'The web request was cancelled. Check its original response before deciding how to continue; do not repeat it automatically.',
  planning_invalid_record:
    'The saved plan data has an invalid structure. Inspect the current plan and preserve the original data.',
  planning_invalid_input:
    'The plan request has invalid arguments. Check the declared fields and required nonempty text.',
  planning_record_version_unavailable:
    'The saved plan data uses an unsupported format version. Preserve it and report the incompatibility.',
  planning_identity_conflict:
    'The same plan record identity already refers to different data. Inspect the original record rather than rebinding its identity.',
  planning_information_proof_unavailable:
    'The required question or plan-review confirmation cannot be verified with the available interface. Report the unavailable confirmation.',
  planning_information_proof_invalid:
    'The recorded answer or plan-review confirmation does not match the current request. Check the original confirmation; do not treat a stale answer as approval.',
  planning_run_mismatch:
    'The plan request does not match the current task context. Check the current plan and its accepted requirements.',
  planning_review_body_invalid:
    'The supplied plan-review body does not match the exact current plan or its saved content. Check the original review body and current plan.',
  planning_review_body_unavailable:
    'The complete plan-review content cannot be read or stored with the available interface. Report the unavailable review content.',
  plan_version_conflict:
    'The supplied plan version no longer matches the expected version. Read the current plan before deciding on another authorized update.',
  plan_file_changed:
    'The plan file changed from its expected contents or identity. Inspect the current file and original update before further plan changes.',
  plan_file_missing:
    'The expected plan file is missing. Inspect the original plan reference and saved plan state.',
  plan_file_invalid:
    'The plan file path, contents or baseline do not satisfy the plan-file contract. Check the exact current plan file.',
  plan_file_recovery_required:
    'The plan file and saved plan state require reconciliation. Check the original update before further plan changes.',
  file_baseline_conflict:
    'The supplied complete-file baseline or create-only condition does not match the target. Check the original result and authorized current file before another separately authorized change.',
  plan_steps_invalid:
    'The proposed plan steps do not satisfy the declared plan structure. Check the step identifiers and required fields.',
  plan_identity_mismatch:
    'The supplied plan identity, version or digest does not match the current plan. Read the current plan before deciding how to continue.',
  plan_missing:
    'The requested saved plan is unavailable. Check the original plan reference and current plan state.',
  plan_step_missing:
    'The requested step does not exist in the current plan. Check the current step identifiers.',
  plan_progress_conflict:
    'The saved plan progress changed since the supplied revision. Read the current progress before deciding on another authorized update.',
  plan_terminal_rollback:
    'A completed plan step cannot be moved back to an unfinished status. Preserve its confirmed completion evidence.',
  plan_compensation_evidence_required:
    'Marking a completed step as compensated requires distinct evidence of the compensating action. Preserve the original completion evidence.',
  plan_execution_evidence_required:
    'The proposed completed step lacks a suitable verified successful tool result. Check the original result and its connection to the plan.',
  plan_execution_scope_mismatch:
    'The supplied tool result does not belong to the required plan scope. Check its original source rather than substituting an unrelated success.',
  plan_steps_incomplete:
    'Required plan steps are not all completed. Check the current progress before claiming the plan is complete.',
  plan_requirement_missing:
    'A required plan obligation cannot be found in the current saved state. Inspect the current plan requirements.',
  plan_completion_evidence_required:
    'Required plan-completion evidence is not satisfied. Check the remaining requirements and verified progress before claiming completion.',
  record_revision_conflict:
    'The saved record changed since the supplied revision. Read its current revision before deciding on another authorized update.',
  extension_record_format_unavailable:
    'The saved data format is not supported by the current tool. Preserve the original data and report the incompatibility.',
};
