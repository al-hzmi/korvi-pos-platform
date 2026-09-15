mod device_identity;

use reqwest::{
    header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, RETRY_AFTER},
    redirect::Policy,
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, Runtime, State};

const API_ORIGIN: &str = env!("KORVI_NATIVE_API_ORIGIN");

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceBinding {
    tenant_id: String,
    device_enrollment_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStatus {
    #[serde(flatten)]
    identity: device_identity::DeviceIdentityInfo,
    binding: Option<DeviceBinding>,
}

struct NativeHttpState {
    client: Client,
    api_origin: Url,
    session: Mutex<Option<String>>,
    binding_path: PathBuf,
}

impl NativeHttpState {
    fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        let api_origin = parse_build_origin(API_ORIGIN, "KORVI_NATIVE_API_ORIGIN")?;
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(45))
            .user_agent(concat!("Korvi-Cashier/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("native HTTP client initialization failed: {error}"))?;
        let dir = app
            .path()
            .app_local_data_dir()
            .map_err(|e| format!("cannot resolve local data directory: {e}"))?;
        fs::create_dir_all(&dir).map_err(|e| format!("cannot create local data directory: {e}"))?;
        Ok(Self {
            client,
            api_origin,
            session: Mutex::new(None),
            binding_path: dir.join("device-binding.json"),
        })
    }
    fn binding(&self) -> Result<Option<DeviceBinding>, String> {
        if !self.binding_path.exists() {
            return Ok(None);
        }
        let bytes =
            fs::read(&self.binding_path).map_err(|e| format!("cannot read device binding: {e}"))?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "device binding is corrupt; explicit re-binding is required".into())
    }
    fn write_binding(&self, binding: &DeviceBinding) -> Result<(), String> {
        let bytes = serde_json::to_vec(binding)
            .map_err(|e| format!("cannot encode device binding: {e}"))?;
        let temp = self.binding_path.with_extension("json.tmp");
        fs::write(&temp, bytes).map_err(|e| format!("cannot write device binding: {e}"))?;
        fs::rename(temp, &self.binding_path)
            .map_err(|e| format!("cannot commit device binding: {e}"))
    }
}

fn parse_build_origin(value: &str, variable: &str) -> Result<Url, String> {
    let parsed =
        Url::parse(value).map_err(|_| format!("{variable} is not a valid absolute URL"))?;
    let loopback = matches!(
        parsed.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("::1")
    );
    if parsed.scheme() != "https" && !(cfg!(debug_assertions) && loopback) {
        return Err(format!("{variable} must use HTTPS outside debug builds"));
    }
    if parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
    {
        return Err(format!(
            "{variable} must be an origin without credentials, path, query or fragment"
        ));
    }
    Ok(parsed)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHttpRequest {
    path: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHttpResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCredentials {
    tenant_slug: String,
    email: String,
    password: String,
}

fn response(status: u16, body: Option<String>) -> NativeHttpResponse {
    NativeHttpResponse {
        status,
        headers: BTreeMap::new(),
        body,
    }
}
fn json_response(status: u16, value: Value) -> NativeHttpResponse {
    response(status, Some(value.to_string()))
}
fn api_url(state: &NativeHttpState, path: &str) -> Result<Url, String> {
    let url = state
        .api_origin
        .join(path.trim_start_matches('/'))
        .map_err(|_| "native transport could not construct API URL".to_string())?;
    if url.origin() != state.api_origin.origin() {
        return Err("native transport refused an API-origin escape".into());
    }
    Ok(url)
}
fn validate_cashier_path(path: &str) -> Result<(), String> {
    if path.starts_with("//")
        || path.contains("://")
        || path.contains('\\')
        || path.split('/').any(|part| part == ".." || part == ".")
        || path.contains('#')
    {
        return Err("native transport refused a non-Korvi API path".into());
    }
    let base = path.split('?').next().unwrap_or(path);
    let allowed = base == "/v1/products"
        || base == "/v1/terminals"
        || base == "/v1/sales"
        || base.starts_with("/v1/sales/")
        || base.starts_with("/v1/shifts/")
        || base.starts_with("/v1/returns/");
    if !allowed {
        return Err("installed Cashier refused a non-till API surface".into());
    }
    Ok(())
}
fn parse_method(method: &str) -> Result<Method, String> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        _ => Err("native transport refused an unsupported HTTP method".into()),
    }
}
async fn body_response(resp: reqwest::Response) -> Result<NativeHttpResponse, String> {
    let status = resp.status().as_u16();
    let mut headers = BTreeMap::new();
    for name in [CONTENT_TYPE, RETRY_AFTER] {
        if let Some(value) = resp.headers().get(&name).and_then(|v| v.to_str().ok()) {
            headers.insert(name.as_str().to_string(), value.to_string());
        }
    }
    let body = if status == 204 {
        None
    } else {
        Some(
            resp.text()
                .await
                .map_err(|e| format!("native response decoding failed: {e}"))?,
        )
    };
    Ok(NativeHttpResponse {
        status,
        headers,
        body,
    })
}

#[tauri::command]
fn device_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NativeHttpState>,
) -> Result<DeviceStatus, String> {
    Ok(DeviceStatus {
        identity: device_identity::identity(&app)?,
        binding: state.binding()?,
    })
}

#[tauri::command]
fn bind_device(
    state: State<'_, NativeHttpState>,
    tenant_id: String,
    device_enrollment_id: String,
) -> Result<(), String> {
    if tenant_id.len() != 36 || device_enrollment_id.len() != 36 {
        return Err("device binding requires canonical UUID identifiers".into());
    }
    state.write_binding(&DeviceBinding {
        tenant_id,
        device_enrollment_id,
    })
}

#[tauri::command]
async fn native_login<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, NativeHttpState>,
    credentials: NativeCredentials,
) -> Result<NativeHttpResponse, String> {
    let binding = state
        .binding()?
        .ok_or_else(|| "installed Cashier is not bound to a Platform enrollment".to_string())?;
    let challenge_resp = state.client.post(api_url(&state, "/v1/native-auth/challenge")?)
        .header(ACCEPT, "application/json").json(&json!({"tenantId": binding.tenant_id, "deviceEnrollmentId": binding.device_enrollment_id})).send().await
        .map_err(|e| format!("native challenge request failed: {e}"))?;
    if !challenge_resp.status().is_success() {
        return body_response(challenge_resp).await;
    }
    let challenge: Value = challenge_resp
        .json()
        .await
        .map_err(|e| format!("native challenge decoding failed: {e}"))?;
    let challenge_id = challenge
        .get("challengeId")
        .and_then(Value::as_str)
        .ok_or("challenge omitted id")?;
    let signing_payload = challenge
        .get("signingPayload")
        .and_then(Value::as_str)
        .ok_or("challenge omitted signing payload")?;
    let signature = device_identity::sign(&app, signing_payload)?;
    let login_resp = state
        .client
        .post(api_url(&state, "/v1/native-auth/login")?)
        .header(ACCEPT, "application/json")
        .json(&json!({
            "tenantId": binding.tenant_id, "deviceEnrollmentId": binding.device_enrollment_id,
            "challengeId": challenge_id, "tenantSlug": credentials.tenant_slug,
            "email": credentials.email, "password": credentials.password, "signature": signature
        }))
        .send()
        .await
        .map_err(|e| format!("native login request failed: {e}"))?;
    let status = login_resp.status().as_u16();
    let value: Value = login_resp.json().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        return Ok(json_response(status, value));
    }
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .ok_or("native login omitted session token")?
        .to_owned();
    let principal = value
        .get("principal")
        .cloned()
        .ok_or("native login omitted principal")?;
    *state
        .session
        .lock()
        .map_err(|_| "native session state poisoned")? = Some(token);
    Ok(json_response(status, principal))
}

#[tauri::command]
async fn native_me(state: State<'_, NativeHttpState>) -> Result<NativeHttpResponse, String> {
    let token = state
        .session
        .lock()
        .map_err(|_| "native session state poisoned")?
        .clone();
    let Some(token) = token else {
        return Ok(json_response(401, json!({"error":"unauthenticated"})));
    };
    let resp = state
        .client
        .get(api_url(&state, "/v1/native-auth/me")?)
        .header(AUTHORIZATION, format!("KorviNative {token}"))
        .header(ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("native session check failed: {e}"))?;
    let status = resp.status().as_u16();
    let value: Value = resp.json().await.unwrap_or(Value::Null);
    if status == 401 {
        *state
            .session
            .lock()
            .map_err(|_| "native session state poisoned")? = None;
    }
    if !(200..300).contains(&status) {
        return Ok(json_response(status, value));
    }
    Ok(json_response(
        status,
        value
            .get("principal")
            .cloned()
            .ok_or("native session omitted principal")?,
    ))
}

#[tauri::command]
async fn native_logout(state: State<'_, NativeHttpState>) -> Result<NativeHttpResponse, String> {
    let token = state
        .session
        .lock()
        .map_err(|_| "native session state poisoned")?
        .take();
    if let Some(token) = token {
        let _ = state
            .client
            .post(api_url(&state, "/v1/native-auth/logout")?)
            .header(AUTHORIZATION, format!("KorviNative {token}"))
            .send()
            .await;
    }
    Ok(response(204, None))
}

#[tauri::command]
async fn http_request(
    state: State<'_, NativeHttpState>,
    request: NativeHttpRequest,
) -> Result<NativeHttpResponse, String> {
    validate_cashier_path(&request.path)?;
    let method = parse_method(&request.method)?;
    if method == Method::GET && request.body.is_some() {
        return Err("native transport refused a GET request body".into());
    }
    for header in request.headers.keys() {
        if !header.eq_ignore_ascii_case("accept") && !header.eq_ignore_ascii_case("content-type") {
            return Err("native transport refused a WebView-controlled authority header".into());
        }
    }
    let token = state
        .session
        .lock()
        .map_err(|_| "native session state poisoned")?
        .clone();
    let Some(token) = token else {
        return Ok(json_response(401, json!({"error":"unauthenticated"})));
    };
    let mut builder = state
        .client
        .request(method.clone(), api_url(&state, &request.path)?)
        .header(ACCEPT, "application/json")
        .header(AUTHORIZATION, format!("KorviNative {token}"));
    if let Some(content_type) = request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value)
    {
        if content_type != "application/json" {
            return Err("native transport accepts JSON request bodies only".into());
        }
        builder = builder.header(CONTENT_TYPE, "application/json");
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("native network request failed: {e}"))?;
    if resp.status().as_u16() == 401 {
        *state
            .session
            .lock()
            .map_err(|_| "native session state poisoned")? = None;
    }
    body_response(resp).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_korvi_device_identity::init());
    builder
        .setup(|app| {
            let state = NativeHttpState::new(app.handle()).map_err(std::io::Error::other)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            device_status,
            bind_device,
            native_login,
            native_me,
            native_logout,
            http_request
        ])
        .run(tauri::generate_context!())
        .expect("Korvi Cashier runtime failed");
}
