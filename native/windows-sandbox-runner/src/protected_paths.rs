use crate::protocol::InvocationRequest;

/// Sensitive external paths are governed by Tool Policy and mode-aware
/// authorization. The native runner must not install a second, unbypassable
/// deny.
pub fn protected_deny_paths(_request: &InvocationRequest) -> Vec<String> {
    Vec::new()
}
