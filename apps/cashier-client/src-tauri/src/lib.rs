use reqwest::{
    header::{ACCEPT, CONTENT_TYPE, ORIGIN, RETRY_AFTER},
    redirect::Policy,
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, time::Duration};
use tauri::State;

const API_ORIGIN: &str = env!("KORVI_NATIVE_API_ORIGIN");
const WEB_ORIGIN: &str = env!("KORVI_NATIVE_WEB_ORIGIN");

struct NativeHttpState {
    client: Client,
    api_origin: Url,
    web_origin: String,
}

impl NativeHttpState {
    fn new() -> Result<Self, String> {
        let api_origin = parse_build_origin(API_ORIGIN, "KORVI_NATIVE_API_ORIGIN")?;
        let web_origin = parse_build_origin(WEB_ORIGIN, "KORVI_NATIVE_WEB_ORIGIN")?;
        let client = Client::builder()
            .cookie_store(true)
            .redirect(Policy::none())
            .timeout(Duration::from_secs(45))
            .user_agent(concat!("Korvi-Cashier/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("native HTTP client initialization failed: {error}"))?;

        Ok(Self {
            client,
            api_origin,
            web_origin: web_origin.origin().ascii_serialization(),
        })
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

fn validate_relative_api_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/v1/")
        || path.starts_with("//")
        || path.contains("://")
        || path.contains('\\')
        || path.split('/').any(|part| part == ".." || part == ".")
        || path.contains('#')
    {
        return Err("native transport refused a non-Korvi API path".into());
    }
    Ok(())
}

fn parse_method(method: &str) -> Result<Method, String> {
    match method.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PATCH" => Ok(Method::PATCH),
        _ => Err("native transport refused an unsupported HTTP method".into()),
    }
}

#[tauri::command]
async fn http_request(
    state: State<'_, NativeHttpState>,
    request: NativeHttpRequest,
) -> Result<NativeHttpResponse, String> {
    validate_relative_api_path(&request.path)?;
    let method = parse_method(&request.method)?;
    if method == Method::GET && request.body.is_some() {
        return Err("native transport refused a GET request body".into());
    }

    for header in request.headers.keys() {
        if !header.eq_ignore_ascii_case("accept") && !header.eq_ignore_ascii_case("content-type") {
            return Err("native transport refused a WebView-controlled authority header".into());
        }
    }

    let url = state
        .api_origin
        .join(request.path.trim_start_matches('/'))
        .map_err(|_| "native transport could not construct API URL".to_string())?;
    if url.origin() != state.api_origin.origin() {
        return Err("native transport refused an API-origin escape".into());
    }

    let mut builder = state
        .client
        .request(method.clone(), url)
        .header(ACCEPT, "application/json");
    if method != Method::GET {
        builder = builder.header(ORIGIN, &state.web_origin);
    }
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

    let response = builder
        .send()
        .await
        .map_err(|error| format!("native network request failed: {error}"))?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    for name in [CONTENT_TYPE, RETRY_AFTER] {
        if let Some(value) = response
            .headers()
            .get(&name)
            .and_then(|value| value.to_str().ok())
        {
            headers.insert(name.as_str().to_string(), value.to_string());
        }
    }
    let body = if status == 204 {
        None
    } else {
        Some(
            response
                .text()
                .await
                .map_err(|error| format!("native response decoding failed: {error}"))?,
        )
    };

    Ok(NativeHttpResponse {
        status,
        headers,
        body,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state =
        NativeHttpState::new().expect("Korvi Cashier native origin configuration is invalid");
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![http_request])
        .run(tauri::generate_context!())
        .expect("Korvi Cashier runtime failed");
}
