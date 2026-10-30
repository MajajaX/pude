use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, LOCATION};
use reqwest::redirect::Policy;
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Read;
use std::net::{IpAddr, SocketAddr};
use std::path::{Component, Path};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

pub const MAX_PLUGIN_TOTAL_BYTES: u64 = 25 * 1024 * 1024;
pub const MAX_PLUGIN_INSTALLED_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_PLUGIN_ENTRIES: usize = 256;
pub const MAX_PLUGIN_DEPTH: usize = 16;
pub const MAX_PLUGIN_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_INSTALLED_PLUGINS: usize = 100;
pub const MAX_PLUGIN_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_PLUGIN_NETWORK_DOMAINS: usize = 32;
pub const MAX_NETWORK_URL_BYTES: usize = 8 * 1024;
pub const MAX_NETWORK_REQUEST_BODY_BYTES: usize = 256 * 1024;
pub const MAX_NETWORK_RESPONSE_BODY_BYTES: usize = 900 * 1024;
pub const MAX_NETWORK_REQUEST_HEADERS: usize = 32;
pub const MAX_NETWORK_REQUEST_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_NETWORK_RESPONSE_HEADER_BYTES: usize = 8 * 1024;
pub const MAX_NETWORK_REDIRECTS: usize = 5;
pub const MAX_NETWORK_REQUESTS_PER_MINUTE: usize = 20;
pub const MAX_NETWORK_IN_FLIGHT: usize = 4;
pub const NETWORK_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const NETWORK_AUTHORIZATION_LIFETIME: Duration = Duration::from_secs(30);

const MAX_NETWORK_AUTHORIZATIONS: usize = 256;
const ALLOWED_METHODS: [&str; 7] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

#[derive(Debug, Default)]
pub struct PluginTreeBudget {
    entries: usize,
    bytes: u64,
}

impl PluginTreeBudget {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn check_directory(&mut self, relative: &Path) -> Result<(), String> {
        self.record_entry(relative)?;
        Ok(())
    }

    pub fn check_file(&mut self, relative: &Path, size: u64) -> Result<(), String> {
        if size > MAX_PLUGIN_FILE_BYTES {
            return Err(format!(
                "Plugin files cannot exceed {} MiB.",
                MAX_PLUGIN_FILE_BYTES / (1024 * 1024)
            ));
        }
        let next_bytes = self
            .bytes
            .checked_add(size)
            .ok_or_else(|| "Plugin package size is too large.".to_string())?;
        if next_bytes > MAX_PLUGIN_TOTAL_BYTES {
            return Err("Plugin packages cannot exceed 25 MiB in total.".to_string());
        }
        self.record_entry(relative)?;
        self.bytes = next_bytes;
        Ok(())
    }

    fn record_entry(&mut self, relative: &Path) -> Result<(), String> {
        let depth = safe_relative_depth(relative)?;
        if depth > MAX_PLUGIN_DEPTH {
            return Err(format!(
                "Plugin package nesting cannot exceed {MAX_PLUGIN_DEPTH} levels."
            ));
        }
        let next_entries = self
            .entries
            .checked_add(1)
            .ok_or_else(|| "Plugin package contains too many entries.".to_string())?;
        if next_entries > MAX_PLUGIN_ENTRIES {
            return Err(format!(
                "Plugin packages cannot contain more than {MAX_PLUGIN_ENTRIES} files and folders."
            ));
        }
        self.entries = next_entries;
        Ok(())
    }
}

fn safe_relative_depth(relative: &Path) -> Result<usize, String> {
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err("Plugin paths must be non-empty relative paths.".to_string());
    }
    let mut depth = 0;
    for component in relative.components() {
        match component {
            Component::Normal(_) => depth += 1,
            _ => return Err("Plugin paths must not escape their package directory.".to_string()),
        }
    }
    Ok(depth)
}

pub fn validate_network_domains(domains: &[String]) -> Result<(), String> {
    if domains.len() > MAX_PLUGIN_NETWORK_DOMAINS {
        return Err(format!(
            "A plugin may declare at most {MAX_PLUGIN_NETWORK_DOMAINS} network domains."
        ));
    }
    let mut unique = std::collections::HashSet::new();
    for domain in domains {
        if !is_canonical_network_domain(domain) {
            return Err(format!("Plugin network domain is invalid: {domain}"));
        }
        if !unique.insert(domain) {
            return Err(format!("Plugin network domain is duplicated: {domain}"));
        }
    }
    Ok(())
}

fn is_canonical_network_domain(domain: &str) -> bool {
    if domain.is_empty()
        || domain.len() > 253
        || domain != domain.to_ascii_lowercase()
        || domain.ends_with('.')
        || domain.parse::<IpAddr>().is_ok()
        || domain.split('.').count() < 2
    {
        return false;
    }
    let blocked_suffixes = [
        ".localhost",
        ".local",
        ".internal",
        ".test",
        ".invalid",
        ".example",
        ".onion",
        ".home.arpa",
    ];
    if blocked_suffixes
        .iter()
        .any(|suffix| domain.ends_with(suffix))
    {
        return false;
    }
    domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.as_bytes()[0].is_ascii_alphanumeric()
            && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPluginManifest {
    id: String,
    version: String,
    api_version: String,
    permissions: Vec<String>,
    #[serde(default)]
    network_domains: Vec<String>,
}

#[derive(Debug, Clone)]
struct NetworkAuthorization {
    plugin_id: String,
    plugin_version: String,
    workspace: String,
    domain: String,
    expires_at: Instant,
}

fn take_authorization(
    authorizations: &mut HashMap<String, NetworkAuthorization>,
    token: &str,
    now: Instant,
) -> Result<NetworkAuthorization, String> {
    let grant = authorizations
        .remove(token)
        .ok_or_else(|| "Plugin network authorization is invalid or expired.".to_string())?;
    if grant.expires_at <= now {
        return Err("Plugin network authorization is invalid or expired.".to_string());
    }
    Ok(grant)
}

static NETWORK_AUTHORIZATIONS: OnceLock<Mutex<HashMap<String, NetworkAuthorization>>> =
    OnceLock::new();
static NETWORK_LIMITER: OnceLock<Mutex<NetworkLimiterState>> = OnceLock::new();
static NETWORK_GATE: OnceLock<Mutex<()>> = OnceLock::new();
static TLS_PROVIDER_INSTALLED: OnceLock<()> = OnceLock::new();

// reqwest is built with rustls-no-provider, so the crypto provider must be
// installed explicitly before the first TLS connection. Doing it lazily on the
// first network use (instead of at startup) keeps app launch cheap. If another
// dependency already installed a provider, install_default returns Err and we
// keep that one.
pub(crate) fn ensure_tls_provider_installed() {
    TLS_PROVIDER_INSTALLED.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn authorization_store() -> &'static Mutex<HashMap<String, NetworkAuthorization>> {
    NETWORK_AUTHORIZATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn network_gate() -> &'static Mutex<()> {
    NETWORK_GATE.get_or_init(|| Mutex::new(()))
}

struct ActiveNetworkRequest {
    plugin_id: String,
    workspace: String,
    authorization_token: String,
    abort_handle: Option<tokio::task::AbortHandle>,
}

#[derive(Default)]
struct NetworkLimiterState {
    request_times: HashMap<String, VecDeque<Instant>>,
    in_flight: HashMap<String, usize>,
    active_requests: HashMap<String, ActiveNetworkRequest>,
}

struct NetworkRequestPermit {
    plugin_id: String,
    request_id: String,
}

impl Drop for NetworkRequestPermit {
    fn drop(&mut self) {
        let limiter = NETWORK_LIMITER.get_or_init(|| Mutex::new(NetworkLimiterState::default()));
        if let Ok(mut limiter) = limiter.lock() {
            if let Some(request) = limiter.active_requests.remove(&self.request_id) {
                if let Some(abort_handle) = request.abort_handle {
                    abort_handle.abort();
                }
            }
            if let Some(count) = limiter.in_flight.get_mut(&self.plugin_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    limiter.in_flight.remove(&self.plugin_id);
                }
            }
        }
    }
}

fn acquire_network_permit(
    plugin_id: &str,
    workspace: &str,
    authorization_token: &str,
) -> Result<NetworkRequestPermit, String> {
    let limiter = NETWORK_LIMITER.get_or_init(|| Mutex::new(NetworkLimiterState::default()));
    let mut limiter = limiter
        .lock()
        .map_err(|_| "Plugin network limiter is unavailable.".to_string())?;
    let now = Instant::now();
    if limiter
        .in_flight
        .get(plugin_id)
        .copied()
        .unwrap_or_default()
        >= MAX_NETWORK_IN_FLIGHT
    {
        return Err("Plugin network concurrency limit was reached.".to_string());
    }
    {
        let requests = limiter
            .request_times
            .entry(plugin_id.to_string())
            .or_default();
        while requests
            .front()
            .is_some_and(|started| now.duration_since(*started) >= Duration::from_secs(60))
        {
            requests.pop_front();
        }
        if requests.len() >= MAX_NETWORK_REQUESTS_PER_MINUTE {
            return Err("Plugin network request rate limit was reached.".to_string());
        }
        requests.push_back(now);
    }
    let in_flight = limiter.in_flight.entry(plugin_id.to_string()).or_default();
    *in_flight += 1;
    let request_id = Uuid::new_v4().to_string();
    limiter.active_requests.insert(
        request_id.clone(),
        ActiveNetworkRequest {
            plugin_id: plugin_id.to_string(),
            workspace: workspace.to_string(),
            authorization_token: authorization_token.to_string(),
            abort_handle: None,
        },
    );
    Ok(NetworkRequestPermit {
        plugin_id: plugin_id.to_string(),
        request_id,
    })
}

fn attach_network_abort_handle(
    request_id: &str,
    abort_handle: tokio::task::AbortHandle,
) -> Result<(), String> {
    let mut limiter = NETWORK_LIMITER
        .get_or_init(|| Mutex::new(NetworkLimiterState::default()))
        .lock()
        .map_err(|_| "Plugin network limiter is unavailable.".to_string())?;
    let request = limiter
        .active_requests
        .get_mut(request_id)
        .ok_or_else(|| "Plugin network request was cancelled.".to_string())?;
    request.abort_handle = Some(abort_handle);
    Ok(())
}

fn cancel_network_requests(plugin_id: &str, workspace: Option<&str>) -> Result<(), String> {
    let limiter = NETWORK_LIMITER
        .get_or_init(|| Mutex::new(NetworkLimiterState::default()))
        .lock()
        .map_err(|_| "Plugin network limiter is unavailable.".to_string())?;
    for request in limiter.active_requests.values() {
        if request.plugin_id == plugin_id
            && workspace.is_none_or(|workspace| request.workspace == workspace)
        {
            if let Some(abort_handle) = &request.abort_handle {
                abort_handle.abort();
            }
        }
    }
    Ok(())
}

fn cancel_network_request_by_token(
    authorization_token: &str,
    workspace: &str,
) -> Result<(), String> {
    if authorization_token.is_empty() || authorization_token.len() > 64 {
        return Err("Plugin network authorization is invalid or expired.".to_string());
    }
    if workspace.is_empty() || workspace.len() > 4096 || workspace.contains('\0') {
        return Err("Plugin network workspace is invalid.".to_string());
    }
    let request_workspace =
        canonical_workspace(workspace).unwrap_or_else(|_| workspace.to_string());
    let _gate = network_gate()
        .lock()
        .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
    {
        let mut authorizations = authorization_store()
            .lock()
            .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
        if authorizations
            .get(authorization_token)
            .is_some_and(|grant| grant.workspace != request_workspace)
        {
            return Err(
                "Plugin network authorization belongs to a different workspace.".to_string(),
            );
        }
        authorizations.remove(authorization_token);
    }
    let limiter = NETWORK_LIMITER.get_or_init(|| Mutex::new(NetworkLimiterState::default()));
    let limiter = limiter
        .lock()
        .map_err(|_| "Plugin network limiter is unavailable.".to_string())?;
    for request in limiter.active_requests.values() {
        if request.authorization_token == authorization_token
            && request.workspace == request_workspace
        {
            if let Some(abort_handle) = &request.abort_handle {
                abort_handle.abort();
            }
        }
    }
    Ok(())
}

pub fn revoke_plugin_network_requests(
    plugin_id: &str,
    workspace: Option<&str>,
) -> Result<(), String> {
    if !validate_plugin_id(plugin_id) {
        return Err("Plugin identifier is invalid.".to_string());
    }
    let canonical_workspace = workspace
        .map(|workspace| canonical_workspace(workspace).unwrap_or_else(|_| workspace.to_string()));
    let _gate = network_gate()
        .lock()
        .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
    {
        let mut authorizations = authorization_store()
            .lock()
            .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
        authorizations.retain(|_, grant| {
            grant.plugin_id != plugin_id
                || canonical_workspace
                    .as_deref()
                    .is_some_and(|workspace| grant.workspace != workspace)
        });
    }
    cancel_network_requests(plugin_id, canonical_workspace.as_deref())
}

fn canonical_workspace(workspace: &str) -> Result<String, String> {
    if workspace.is_empty() || workspace.len() > 4096 || workspace.contains('\0') {
        return Err("Plugin network workspace is invalid.".to_string());
    }
    let canonical = fs::canonicalize(workspace)
        .map_err(|_| "Plugin network workspace is unavailable.".to_string())?;
    if !canonical.is_dir() {
        return Err("Plugin network workspace must be a directory.".to_string());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

fn validate_plugin_id(plugin_id: &str) -> bool {
    !plugin_id.is_empty()
        && plugin_id.len() <= 128
        && plugin_id != "."
        && plugin_id != ".."
        && plugin_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
}

fn installed_plugin_manifest(
    app: &AppHandle,
    plugin_id: &str,
    expected_version: &str,
) -> Result<InstalledPluginManifest, String> {
    if !validate_plugin_id(plugin_id) {
        return Err("Plugin identifier is invalid.".to_string());
    }
    if expected_version.is_empty() || expected_version.len() > 128 {
        return Err("Plugin version is invalid.".to_string());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "Unable to locate plugin storage.".to_string())?;
    let plugins_root = app_data_dir.join("plugins");
    let root_metadata = fs::symlink_metadata(&plugins_root)
        .map_err(|_| "Unable to access plugin storage.".to_string())?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("Plugin storage must be a regular application directory.".to_string());
    }
    let canonical_app_data = fs::canonicalize(&app_data_dir)
        .map_err(|_| "Unable to locate plugin storage.".to_string())?;
    let canonical_root = fs::canonicalize(&plugins_root)
        .map_err(|_| "Unable to access plugin storage.".to_string())?;
    if !canonical_root.starts_with(&canonical_app_data) {
        return Err("Plugin storage is outside application data.".to_string());
    }
    let plugin_root = fs::canonicalize(plugins_root.join(plugin_id))
        .map_err(|_| "Plugin is not installed.".to_string())?;
    if !plugin_root.starts_with(&canonical_root) || !plugin_root.is_dir() {
        return Err("Plugin is outside the application plugin directory.".to_string());
    }
    let manifest_path = plugin_root.join("plugin.json");
    let metadata = fs::symlink_metadata(&manifest_path)
        .map_err(|_| "Plugin manifest is unavailable.".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Plugin manifest must be a regular file.".to_string());
    }
    let canonical_manifest = fs::canonicalize(&manifest_path)
        .map_err(|_| "Plugin manifest is unavailable.".to_string())?;
    if !canonical_manifest.starts_with(&plugin_root) {
        return Err("Plugin manifest is outside the installed plugin.".to_string());
    }
    if metadata.len() > MAX_PLUGIN_MANIFEST_BYTES as u64 {
        return Err("Plugin manifest exceeds the 64 KiB limit.".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(canonical_manifest)
        .map_err(|_| "Plugin manifest is unavailable.".to_string())?
        .take(MAX_PLUGIN_MANIFEST_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Plugin manifest is unavailable.".to_string())?;
    if bytes.len() > MAX_PLUGIN_MANIFEST_BYTES {
        return Err("Plugin manifest exceeds the 64 KiB limit.".to_string());
    }
    let manifest: InstalledPluginManifest =
        serde_json::from_slice(&bytes).map_err(|_| "Plugin manifest is invalid.".to_string())?;
    if manifest.id != plugin_id
        || manifest.version != expected_version
        || manifest.api_version != "2"
    {
        return Err("Plugin installation changed during this request.".to_string());
    }
    if !manifest
        .permissions
        .iter()
        .any(|permission| permission == "network")
    {
        return Err("Plugin has not declared the network permission.".to_string());
    }
    validate_network_domains(&manifest.network_domains)?;
    Ok(manifest)
}

#[tauri::command]
pub async fn plugin_network_authorize(
    app: AppHandle,
    plugin_id: String,
    plugin_version: String,
    workspace: String,
    domain: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        authorize_network_domain(&app, plugin_id, plugin_version, &workspace, domain)
    })
    .await
    .map_err(|error| format!("Unable to authorize the plugin network request. {error}"))?
}

fn authorize_network_domain(
    app: &AppHandle,
    plugin_id: String,
    plugin_version: String,
    workspace: &str,
    domain: String,
) -> Result<String, String> {
    let _gate = network_gate()
        .lock()
        .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
    let manifest = installed_plugin_manifest(app, &plugin_id, &plugin_version)?;
    if !is_canonical_network_domain(&domain)
        || !manifest
            .network_domains
            .iter()
            .any(|declared| declared == &domain)
    {
        return Err("Plugin has not declared this HTTPS domain.".to_string());
    }
    let workspace = canonical_workspace(workspace)?;
    let token = Uuid::new_v4().to_string();
    let mut authorizations = authorization_store()
        .lock()
        .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
    authorizations.retain(|_, grant| grant.expires_at > Instant::now());
    if authorizations.len() >= MAX_NETWORK_AUTHORIZATIONS {
        return Err("Too many temporary plugin network authorizations are active.".to_string());
    }
    authorizations.insert(
        token.clone(),
        NetworkAuthorization {
            plugin_id,
            plugin_version,
            workspace,
            domain,
            expires_at: Instant::now() + NETWORK_AUTHORIZATION_LIFETIME,
        },
    );
    Ok(token)
}

#[tauri::command]
pub async fn plugin_network_revoke(
    plugin_id: String,
    workspace: Option<String>,
) -> Result<(), String> {
    // SB-02: the revocation path canonicalizes the workspace path (blocking
    // filesystem work), so it runs on the blocking thread pool.
    tauri::async_runtime::spawn_blocking(move || {
        revoke_plugin_network_requests(&plugin_id, workspace.as_deref())
    })
    .await
    .map_err(|error| format!("Unable to revoke plugin network requests. {error}"))?
}

#[tauri::command]
pub async fn plugin_network_cancel(
    authorization_token: String,
    workspace: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        cancel_network_request_by_token(&authorization_token, &workspace)
    })
    .await
    .map_err(|error| format!("Unable to cancel the plugin network request. {error}"))?
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginNetworkRequest {
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNetworkResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

#[tauri::command]
pub async fn plugin_network_request(
    app: AppHandle,
    authorization_token: String,
    workspace: String,
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
) -> Result<PluginNetworkResponse, String> {
    if authorization_token.is_empty() || authorization_token.len() > 64 {
        return Err("Plugin network authorization is invalid or expired.".to_string());
    }
    let request = PluginNetworkRequest {
        url,
        method,
        headers,
        body,
    };
    let (task, permit) = tauri::async_runtime::spawn_blocking(move || {
        start_network_request(&app, &workspace, &authorization_token, request)
    })
    .await
    .map_err(|error| format!("Unable to start the plugin network request. {error}"))??;
    let response = match task.await {
        Ok(response) => response,
        Err(error) if error.is_cancelled() => {
            Err("Plugin network request was cancelled.".to_string())
        }
        Err(_) => Err("Plugin network request failed unexpectedly.".to_string()),
    };
    drop(permit);
    response
}

fn start_network_request(
    app: &AppHandle,
    workspace: &str,
    authorization_token: &str,
    request: PluginNetworkRequest,
) -> Result<
    (
        tokio::task::JoinHandle<Result<PluginNetworkResponse, String>>,
        NetworkRequestPermit,
    ),
    String,
> {
    let _gate = network_gate()
        .lock()
        .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
    let grant = {
        let mut authorizations = authorization_store()
            .lock()
            .map_err(|_| "Plugin network authorization is unavailable.".to_string())?;
        take_authorization(&mut authorizations, authorization_token, Instant::now())?
    };
    if canonical_workspace(workspace)? != grant.workspace {
        return Err("Plugin network authorization belongs to a different workspace.".to_string());
    }
    let manifest = installed_plugin_manifest(app, &grant.plugin_id, &grant.plugin_version)?;
    if !manifest
        .network_domains
        .iter()
        .any(|declared| declared == &grant.domain)
    {
        return Err("Plugin network domain approval is no longer valid.".to_string());
    }
    let permit = acquire_network_permit(&grant.plugin_id, &grant.workspace, authorization_token)?;
    let task = tokio::spawn(async move { perform_network_request(request, grant).await });
    if let Err(error) = attach_network_abort_handle(&permit.request_id, task.abort_handle()) {
        task.abort();
        return Err(error);
    }
    Ok((task, permit))
}

fn validate_request_method(method: &str) -> Result<Method, String> {
    if !ALLOWED_METHODS.contains(&method) {
        return Err("Plugin network method is not allowed.".to_string());
    }
    Method::from_bytes(method.as_bytes())
        .map_err(|_| "Plugin network method is invalid.".to_string())
}

fn validate_request_headers(input: &BTreeMap<String, String>) -> Result<HeaderMap, String> {
    if input.len() > MAX_NETWORK_REQUEST_HEADERS {
        return Err("Plugin network request contains too many headers.".to_string());
    }
    let mut headers = HeaderMap::new();
    let mut normalized_names = HashSet::new();
    let mut total_bytes = 0usize;
    for (name, value) in input {
        if name.len() > 128 || value.len() > 8 * 1024 {
            return Err("Plugin network request header exceeds its size limit.".to_string());
        }
        total_bytes = total_bytes
            .checked_add(name.len())
            .and_then(|size| size.checked_add(value.len()))
            .ok_or_else(|| "Plugin network request headers are too large.".to_string())?;
        if total_bytes > MAX_NETWORK_REQUEST_HEADER_BYTES {
            return Err("Plugin network request headers exceed the 16 KiB limit.".to_string());
        }
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| "Plugin network request contains an invalid header name.".to_string())?;
        let normalized = header_name.as_str();
        if !normalized_names.insert(normalized.to_string()) {
            return Err("Plugin network request contains duplicate headers.".to_string());
        }
        let blocked = matches!(
            normalized,
            "host"
                | "connection"
                | "proxy-connection"
                | "keep-alive"
                | "transfer-encoding"
                | "te"
                | "trailer"
                | "upgrade"
                | "content-length"
                | "cookie"
                | "origin"
                | "referer"
                | "accept-encoding"
                | "forwarded"
        ) || normalized.starts_with("proxy-")
            || normalized.starts_with("sec-")
            || normalized.starts_with("x-forwarded-");
        if blocked {
            return Err("Plugin network request contains a restricted header.".to_string());
        }
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| "Plugin network request contains an invalid header value.".to_string())?;
        headers.insert(header_name, header_value);
    }
    Ok(headers)
}

fn parse_network_url(value: &str, allowed_domain: &str) -> Result<Url, String> {
    if value.is_empty() || value.len() > MAX_NETWORK_URL_BYTES {
        return Err("Plugin network URL is missing or too long.".to_string());
    }
    let mut url = Url::parse(value).map_err(|_| "Plugin network URL is invalid.".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return Err(
            "Plugin network requests require credential-free HTTPS on port 443.".to_string(),
        );
    }
    let domain = url
        .host_str()
        .ok_or_else(|| "Plugin network URL must use a DNS hostname.".to_string())?;
    if !is_canonical_network_domain(domain) || domain != allowed_domain {
        return Err("Plugin network URL is outside the approved domain.".to_string());
    }
    url.set_fragment(None);
    Ok(url)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => {
            let octets = address.octets();
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_multicast()
                || address.is_unspecified()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192
                    && ((octets[1] == 0 && (octets[2] == 0 || octets[2] == 2))
                        || (octets[1] == 88 && octets[2] == 99)))
                || (octets[0] == 198 && (18..=19).contains(&octets[1]))
                || (octets[0] == 198 && octets[1] == 51 && octets[2] == 100)
                || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
                || octets[0] >= 224)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            let global_unicast = segments[0] & 0xe000 == 0x2000;
            let special_purpose = (segments[0] == 0x2001 && segments[1] <= 0x01ff)
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || segments[0] == 0x2002
                || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
                || (segments[0] == 0x0064 && segments[1] == 0xff9b);
            !(address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_unique_local()
                || address.is_unicast_link_local()
                || !global_unicast
                || special_purpose
                || address.to_ipv4_mapped().is_some())
        }
    }
}

async fn resolve_public_addresses(
    domain: &str,
    remaining: Duration,
) -> Result<Vec<SocketAddr>, String> {
    let lookup = tokio::time::timeout(remaining, tokio::net::lookup_host((domain, 443)))
        .await
        .map_err(|_| "Plugin network request timed out during DNS lookup.".to_string())?
        .map_err(|_| "Plugin network domain could not be resolved.".to_string())?;
    let mut addresses = Vec::new();
    for address in lookup {
        if !is_public_ip(address.ip()) {
            return Err(
                "Plugin network domain resolved to a private or reserved address.".to_string(),
            );
        }
        let pinned = SocketAddr::new(address.ip(), 443);
        if !addresses.contains(&pinned) {
            addresses.push(pinned);
        }
    }
    if addresses.is_empty() {
        return Err("Plugin network domain did not resolve to a public address.".to_string());
    }
    Ok(addresses)
}

async fn perform_network_request(
    request: PluginNetworkRequest,
    grant: NetworkAuthorization,
) -> Result<PluginNetworkResponse, String> {
    ensure_tls_provider_installed();
    if request.url.len() > MAX_NETWORK_URL_BYTES {
        return Err("Plugin network URL is missing or too long.".to_string());
    }
    let mut url = parse_network_url(&request.url, &grant.domain)?;
    let mut method = validate_request_method(&request.method)?;
    let mut body = request.body;
    if body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_NETWORK_REQUEST_BODY_BYTES)
    {
        return Err("Plugin network request body exceeds the 256 KiB limit.".to_string());
    }
    if body.is_some() && matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        return Err("This plugin network method cannot include a request body.".to_string());
    }
    let headers = validate_request_headers(&request.headers)?;
    let deadline = Instant::now() + NETWORK_REQUEST_TIMEOUT;
    let mut pinned_client: Option<(Vec<SocketAddr>, reqwest::Client)> = None;

    for redirect_count in 0..=MAX_NETWORK_REDIRECTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Plugin network request timed out.".to_string());
        }
        let domain = url
            .host_str()
            .ok_or_else(|| "Plugin network URL must use a DNS hostname.".to_string())?
            .to_string();
        if domain != grant.domain {
            return Err("Plugin network redirect left the approved domain.".to_string());
        }
        let addresses = resolve_public_addresses(&domain, remaining).await?;
        let client = match &pinned_client {
            Some((pinned_addresses, client)) if *pinned_addresses == addresses => client.clone(),
            _ => {
                let client = reqwest::Client::builder()
                    .https_only(true)
                    .no_proxy()
                    .redirect(Policy::none())
                    .timeout(NETWORK_REQUEST_TIMEOUT)
                    .resolve_to_addrs(&domain, &addresses)
                    .user_agent("pude-plugin-network/1")
                    .build()
                    .map_err(|_| "Unable to create the plugin network client.".to_string())?;
                pinned_client = Some((addresses, client.clone()));
                client
            }
        };
        let mut builder = client
            .request(method.clone(), url.clone())
            .headers(headers.clone());
        if let Some(body) = &body {
            builder = builder.body(body.clone());
        }
        let mut response = tokio::time::timeout(remaining, builder.send())
            .await
            .map_err(|_| "Plugin network request timed out.".to_string())?
            .map_err(|_| "Plugin network request failed.".to_string())?;
        if is_redirect(response.status()) {
            if redirect_count == MAX_NETWORK_REDIRECTS {
                return Err("Plugin network request exceeded the redirect limit.".to_string());
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.len() <= MAX_NETWORK_URL_BYTES)
                .ok_or_else(|| "Plugin network redirect location is invalid.".to_string())?;
            let next_url = url
                .join(location)
                .map_err(|_| "Plugin network redirect location is invalid.".to_string())?;
            let next_url = parse_network_url(next_url.as_str(), &grant.domain)?;
            if next_url.host_str() != Some(grant.domain.as_str()) {
                return Err("Plugin network redirect left the approved domain.".to_string());
            }
            if (response.status() == StatusCode::SEE_OTHER && method != Method::HEAD)
                || (matches!(
                    response.status(),
                    StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND
                ) && method == Method::POST)
            {
                method = Method::GET;
                body = None;
            }
            url = next_url;
            continue;
        }

        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > MAX_NETWORK_RESPONSE_BODY_BYTES as u64)
        {
            return Err("Plugin network response exceeds the 900 KiB limit.".to_string());
        }
        let status = response.status().as_u16();
        let response_headers = selected_response_headers(response.headers());
        let mut bytes = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Plugin network request timed out.".to_string());
            }
            let chunk = tokio::time::timeout(remaining, response.chunk())
                .await
                .map_err(|_| "Plugin network request timed out.".to_string())?
                .map_err(|_| "Plugin network response failed.".to_string())?;
            let Some(chunk) = chunk else { break };
            if bytes.len().saturating_add(chunk.len()) > MAX_NETWORK_RESPONSE_BODY_BYTES {
                return Err("Plugin network response exceeds the 900 KiB limit.".to_string());
            }
            bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(bytes)
            .map_err(|_| "Plugin network response must contain UTF-8 text.".to_string())?;
        let response = PluginNetworkResponse {
            status,
            headers: response_headers,
            body,
        };
        if serde_json::to_vec(&response)
            .map_err(|_| "Plugin network response could not be encoded.".to_string())?
            .len()
            > 1024 * 1024
        {
            return Err("Plugin network response exceeds the 1 MiB message limit.".to_string());
        }
        return Ok(response);
    }
    Err("Plugin network request exceeded the redirect limit.".to_string())
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    )
}

fn selected_response_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    let mut selected = BTreeMap::new();
    let mut total_bytes = 0usize;
    for name in [
        "content-type",
        "etag",
        "last-modified",
        "retry-after",
        "x-request-id",
    ] {
        let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) else {
            continue;
        };
        if value.len() > 1024 {
            continue;
        }
        total_bytes = total_bytes.saturating_add(name.len() + value.len());
        if total_bytes > MAX_NETWORK_RESPONSE_HEADER_BYTES {
            break;
        }
        selected.insert(name.to_string(), value.to_string());
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_network_permit, attach_network_abort_handle, authorization_store,
        canonical_workspace, is_canonical_network_domain, is_public_ip, parse_network_url,
        plugin_network_cancel, revoke_plugin_network_requests, take_authorization,
        validate_network_domains, NetworkAuthorization, PluginTreeBudget, MAX_INSTALLED_PLUGINS,
        MAX_NETWORK_REQUEST_BODY_BYTES, MAX_PLUGIN_DEPTH, MAX_PLUGIN_ENTRIES,
        MAX_PLUGIN_FILE_BYTES, MAX_PLUGIN_INSTALLED_BYTES, MAX_PLUGIN_TOTAL_BYTES,
    };
    use std::collections::HashMap;
    use std::net::IpAddr;
    use std::path::Path;
    use std::str::FromStr;
    use std::time::{Duration, Instant};
    use uuid::Uuid;

    #[test]
    fn package_limits_bound_depth_entries_files_and_total_bytes() {
        let mut budget = PluginTreeBudget::new();
        assert!(budget.check_directory(Path::new("assets/icons")).is_ok());
        assert!(budget
            .check_file(Path::new("index.js"), MAX_PLUGIN_FILE_BYTES)
            .is_ok());
        assert!(budget
            .check_file(Path::new("oversized.js"), MAX_PLUGIN_FILE_BYTES + 1)
            .is_err());
        assert!(budget
            .check_directory(
                &Path::new("a")
                    .join("b")
                    .join("c")
                    .join("d")
                    .join("e")
                    .join("f")
                    .join("g")
                    .join("h")
                    .join("i")
                    .join("j")
                    .join("k")
                    .join("l")
                    .join("m")
                    .join("n")
                    .join("o")
                    .join("p")
                    .join("q")
            )
            .is_err());

        let mut entries = PluginTreeBudget::new();
        for index in 0..MAX_PLUGIN_ENTRIES {
            assert!(entries
                .check_file(Path::new(&format!("{index}.js")), 0)
                .is_ok());
        }
        assert!(entries.check_file(Path::new("overflow.js"), 0).is_err());

        let mut bytes = PluginTreeBudget::new();
        for index in 0..25 {
            assert!(bytes
                .check_file(Path::new(&format!("{index}.js")), 1024 * 1024)
                .is_ok());
        }
        assert!(bytes.check_file(Path::new("over-total.js"), 1).is_err());
        const _: () = assert!(MAX_PLUGIN_INSTALLED_BYTES > MAX_PLUGIN_TOTAL_BYTES);
        const _: () = assert!(MAX_INSTALLED_PLUGINS > 0);
        assert_eq!(MAX_PLUGIN_DEPTH, 16);
        assert_eq!(MAX_NETWORK_REQUEST_BODY_BYTES, 256 * 1024);
    }

    #[test]
    fn package_paths_must_remain_relative() {
        let mut budget = PluginTreeBudget::new();
        assert!(budget.check_file(Path::new("../escape.js"), 1).is_err());
        assert!(budget.check_file(Path::new("/absolute.js"), 1).is_err());
        assert!(budget.check_file(Path::new(""), 1).is_err());
    }

    #[test]
    fn network_domains_are_exact_canonical_dns_names() {
        assert!(is_canonical_network_domain("api.example.com"));
        assert!(validate_network_domains(&["api.example.com".to_string()]).is_ok());
        for invalid in [
            "API.example.com",
            "api.example.com.",
            "*.example.com",
            "localhost.local",
            "metadata.internal",
            "127.0.0.1",
            "api.example.com:443",
            "https://api.example.com",
            "-bad.example.com",
            "bad-.example.com",
        ] {
            assert!(!is_canonical_network_domain(invalid), "{invalid}");
        }
        assert!(validate_network_domains(&[
            "api.example.com".to_string(),
            "api.example.com".to_string()
        ])
        .is_err());
    }

    #[test]
    fn network_url_must_be_https_credential_free_and_same_domain() {
        assert!(parse_network_url("https://api.example.com/v1", "api.example.com").is_ok());
        for invalid in [
            "http://api.example.com/v1",
            "https://user@api.example.com/v1",
            "https://api.example.com:444/v1",
            "https://127.0.0.1/v1",
            "https://other.example.com/v1",
        ] {
            assert!(
                parse_network_url(invalid, "api.example.com").is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn dns_targets_must_be_public_unicast_addresses() {
        for blocked in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.88.99.1",
            "198.18.0.1",
            "198.51.100.2",
            "224.0.0.1",
            "::1",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
            "2001:1::1",
            "2002:c000:201::1",
            "3fff::1",
            "64:ff9b::c000:201",
            "::ffff:127.0.0.1",
        ] {
            assert!(
                !is_public_ip(IpAddr::from_str(blocked).unwrap()),
                "{blocked}"
            );
        }
        for allowed in [
            "1.1.1.1",
            "8.8.8.8",
            "192.0.3.1",
            "192.0.78.1",
            "2606:4700:4700::1111",
        ] {
            assert!(
                is_public_ip(IpAddr::from_str(allowed).unwrap()),
                "{allowed}"
            );
        }
    }

    #[test]
    fn network_tasks_can_be_spawned_from_the_blocking_pool() {
        let value = tauri::async_runtime::block_on(async {
            let task = tauri::async_runtime::spawn_blocking(|| tokio::spawn(async { 7 }))
                .await
                .unwrap();
            task.await.unwrap()
        });
        assert_eq!(value, 7);
    }

    #[test]
    fn network_authorizations_are_short_lived_and_single_use() {
        let now = Instant::now();
        let grant = NetworkAuthorization {
            plugin_id: "pude.example".to_string(),
            plugin_version: "1.0.0".to_string(),
            workspace: "/workspace".to_string(),
            domain: "api.example.com".to_string(),
            expires_at: now + Duration::from_secs(30),
        };
        let mut authorizations = HashMap::from([("one-use".to_string(), grant)]);
        assert!(take_authorization(&mut authorizations, "one-use", now).is_ok());
        assert!(take_authorization(&mut authorizations, "one-use", now).is_err());

        authorizations.insert(
            "expired".to_string(),
            NetworkAuthorization {
                plugin_id: "pude.example".to_string(),
                plugin_version: "1.0.0".to_string(),
                workspace: "/workspace".to_string(),
                domain: "api.example.com".to_string(),
                expires_at: now,
            },
        );
        assert!(take_authorization(&mut authorizations, "expired", now).is_err());
        assert!(authorizations.is_empty());
    }

    #[test]
    fn revoking_plugin_network_access_cancels_active_requests() {
        let plugin_id = format!("test.cancel-{}", Uuid::new_v4().simple());
        let workspace = canonical_workspace(&std::env::temp_dir().to_string_lossy()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let permit = acquire_network_permit(&plugin_id, &workspace, "test-token").unwrap();
            let task = tokio::spawn(std::future::pending::<()>());
            attach_network_abort_handle(&permit.request_id, task.abort_handle()).unwrap();

            revoke_plugin_network_requests(&plugin_id, Some(&workspace)).unwrap();

            assert!(task.await.unwrap_err().is_cancelled());
            drop(permit);
        });
    }

    #[test]
    fn workspace_revocation_still_cancels_when_the_root_was_removed() {
        let plugin_id = format!("test.cancel-removed-{}", Uuid::new_v4().simple());
        let workspace = std::env::temp_dir()
            .join(format!("pude-missing-{}", Uuid::new_v4().simple()))
            .to_string_lossy()
            .into_owned();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let permit = acquire_network_permit(&plugin_id, &workspace, "test-token").unwrap();
            let task = tokio::spawn(std::future::pending::<()>());
            attach_network_abort_handle(&permit.request_id, task.abort_handle()).unwrap();

            revoke_plugin_network_requests(&plugin_id, Some(&workspace)).unwrap();

            assert!(task.await.unwrap_err().is_cancelled());
            drop(permit);
        });
    }

    #[test]
    fn one_request_token_cancels_only_its_active_request() {
        let plugin_id = format!("test.cancel-one-{}", Uuid::new_v4().simple());
        let workspace = canonical_workspace(&std::env::temp_dir().to_string_lossy()).unwrap();
        let first_token = Uuid::new_v4().to_string();
        let second_token = Uuid::new_v4().to_string();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let first_permit =
                acquire_network_permit(&plugin_id, &workspace, &first_token).unwrap();
            let second_permit =
                acquire_network_permit(&plugin_id, &workspace, &second_token).unwrap();
            let first_task = tokio::spawn(std::future::pending::<()>());
            let second_task = tokio::spawn(std::future::pending::<()>());
            attach_network_abort_handle(&first_permit.request_id, first_task.abort_handle())
                .unwrap();
            attach_network_abort_handle(&second_permit.request_id, second_task.abort_handle())
                .unwrap();

            plugin_network_cancel(first_token, workspace.clone())
                .await
                .unwrap();

            assert!(first_task.await.unwrap_err().is_cancelled());
            assert!(!second_task.is_finished());
            revoke_plugin_network_requests(&plugin_id, Some(&workspace)).unwrap();
            assert!(second_task.await.unwrap_err().is_cancelled());
            drop(first_permit);
            drop(second_permit);
        });
    }

    #[test]
    fn cancelling_an_unused_network_token_removes_its_authorization() {
        let workspace = canonical_workspace(&std::env::temp_dir().to_string_lossy()).unwrap();
        let token = Uuid::new_v4().to_string();
        authorization_store().lock().unwrap().insert(
            token.clone(),
            NetworkAuthorization {
                plugin_id: "pude.test-cancel-unused".to_string(),
                plugin_version: "1.0.0".to_string(),
                workspace: workspace.clone(),
                domain: "api.example.com".to_string(),
                expires_at: Instant::now() + Duration::from_secs(30),
            },
        );

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            plugin_network_cancel(token.clone(), workspace)
                .await
                .unwrap();
        });

        assert!(!authorization_store().lock().unwrap().contains_key(&token));
    }
}
