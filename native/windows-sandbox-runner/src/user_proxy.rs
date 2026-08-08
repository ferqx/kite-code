use std::collections::BTreeMap;
use std::ffi::c_void;
use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

const INTERNET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

pub fn current_user_loopback_proxy_env() -> BTreeMap<String, String> {
    let enabled = read_registry_dword("ProxyEnable") == Some(1);
    let proxy_server = read_registry_string("ProxyServer");
    project_loopback_proxy_env(enabled, proxy_server.as_deref())
}

fn project_loopback_proxy_env(
    enabled: bool,
    proxy_server: Option<&str>,
) -> BTreeMap<String, String> {
    if !enabled {
        return BTreeMap::new();
    }
    proxy_server
        .map(parse_loopback_proxy_server)
        .unwrap_or_default()
}

fn parse_loopback_proxy_server(value: &str) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    if value.contains('=') {
        for entry in value.split(';') {
            let Some((kind, endpoint)) = entry.split_once('=') else {
                continue;
            };
            match kind.trim().to_ascii_lowercase().as_str() {
                "http" => {
                    if let Some(proxy) = normalize_loopback_proxy(endpoint, "http") {
                        insert_proxy(&mut env, "HTTP_PROXY", "http_proxy", proxy);
                    }
                }
                "https" => {
                    if let Some(proxy) = normalize_loopback_proxy(endpoint, "http") {
                        insert_proxy(&mut env, "HTTPS_PROXY", "https_proxy", proxy);
                    }
                }
                "socks" => {
                    if let Some(proxy) = normalize_loopback_proxy(endpoint, "socks5") {
                        insert_proxy(&mut env, "ALL_PROXY", "all_proxy", proxy);
                    }
                }
                _ => {}
            }
        }
    } else if let Some(proxy) = normalize_loopback_proxy(value, "http") {
        insert_proxy(&mut env, "HTTP_PROXY", "http_proxy", proxy.clone());
        insert_proxy(&mut env, "HTTPS_PROXY", "https_proxy", proxy);
    }
    env
}

fn insert_proxy(
    env: &mut BTreeMap<String, String>,
    uppercase: &str,
    lowercase: &str,
    value: String,
) {
    env.insert(uppercase.to_string(), value.clone());
    env.insert(lowercase.to_string(), value);
}

fn normalize_loopback_proxy(value: &str, default_scheme: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.contains('@') || value.contains('/') && !value.contains("://") {
        return None;
    }
    let (scheme, authority) = match value.split_once("://") {
        Some((scheme, authority)) => (scheme.to_ascii_lowercase(), authority),
        None => (default_scheme.to_string(), value),
    };
    if !matches!(
        scheme.as_str(),
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return None;
    }
    if authority.contains('/') || authority.contains('?') || authority.contains('#') {
        return None;
    }
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        (format!("[{host}]"), port)
    } else {
        authority
            .rsplit_once(':')
            .map(|(host, port)| (host.to_string(), port))?
    };
    if !matches!(
        host.to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "[::1]"
    ) {
        return None;
    }
    let port = port.parse::<u16>().ok()?;
    if port == 0 {
        return None;
    }
    Some(format!("{scheme}://{host}:{port}"))
}

fn read_registry_dword(name: &str) -> Option<u32> {
    let subkey = wide(INTERNET_SETTINGS_KEY);
    let name = wide(name);
    let mut value = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut value as *mut u32).cast::<c_void>()),
            Some(&mut size),
        )
    };
    (status == ERROR_SUCCESS).then_some(value)
}

fn read_registry_string(name: &str) -> Option<String> {
    let subkey = wide(INTERNET_SETTINGS_KEY);
    let name = wide(name);
    let mut size = 0u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS || size < 2 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize / 2];
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            Some(&mut size),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let length = buffer
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(buffer.len());
    String::from_utf16(&buffer[..length]).ok()
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_loopback_proxy_applies_to_http_and_https() {
        let env = project_loopback_proxy_env(true, Some("127.0.0.1:7890"));
        expect_proxy(&env, "HTTP_PROXY", "http://127.0.0.1:7890");
        expect_proxy(&env, "HTTPS_PROXY", "http://127.0.0.1:7890");
    }

    #[test]
    fn disabled_or_missing_proxy_keeps_the_online_environment_direct() {
        assert!(project_loopback_proxy_env(false, Some("127.0.0.1:7890")).is_empty());
        assert!(project_loopback_proxy_env(true, None).is_empty());
        assert!(project_loopback_proxy_env(true, Some("")).is_empty());
    }

    #[test]
    fn protocol_specific_loopback_proxies_are_preserved_without_credentials() {
        let env = parse_loopback_proxy_server(
            "http=localhost:8080;https=http://127.0.0.1:8443;socks=[::1]:1080",
        );
        expect_proxy(&env, "HTTP_PROXY", "http://localhost:8080");
        expect_proxy(&env, "HTTPS_PROXY", "http://127.0.0.1:8443");
        expect_proxy(&env, "ALL_PROXY", "socks5://[::1]:1080");
    }

    #[test]
    fn remote_or_credentialed_proxies_are_rejected() {
        assert!(parse_loopback_proxy_server("proxy.example.com:8080").is_empty());
        assert!(parse_loopback_proxy_server("http://user:secret@127.0.0.1:7890").is_empty());
    }

    #[test]
    fn malformed_or_unsupported_proxy_values_are_rejected() {
        assert!(parse_loopback_proxy_server("file://127.0.0.1:7890").is_empty());
        assert!(parse_loopback_proxy_server("127.0.0.1:0").is_empty());
        assert!(parse_loopback_proxy_server("127.0.0.1:not-a-port").is_empty());
    }

    fn expect_proxy(env: &BTreeMap<String, String>, uppercase: &str, value: &str) {
        assert_eq!(env.get(uppercase).map(String::as_str), Some(value));
        assert_eq!(
            env.get(&uppercase.to_ascii_lowercase()).map(String::as_str),
            Some(value)
        );
    }
}
