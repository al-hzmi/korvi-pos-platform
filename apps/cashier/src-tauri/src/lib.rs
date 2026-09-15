use std::collections::BTreeMap;

use reqwest::{header, Client, Method, Url};
use serde::{Deserialize, Serialize};
use tauri::State;

const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:3001";
const DEFAULT_WEB_ORIGIN: &str = "http://localhost:3000";
const MAX_REQUEST_BODY_BYTES: usize = 512 * 1024;

struct ApiState {
    client: Client,
    base_url: Url,
    web_origin: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApiRequest {
    path: String,
    method: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    status: u16,
    headers: BTreeMap<String, String>,
    body: String,
}

fn allowed_request(method: &Method, path: &str) -> bool {
    match (method, path.split('?').next().unwrap_or(path)) {
        (&Method::GET, "/v1/auth/me")
        | (&Method::POST, "/v1/auth/login")
        | (&Method::POST, "/v1/auth/logout")
        | (&Method::GET, "/v1/terminals")
        | (&Method::GET, "/v1/products")
        | (&Method::GET, "/v1/shifts/current")
        | (&Method::POST, "/v1/shifts/open")
        | (&Method::POST, "/v1/sales") => true,
        _ => false,
    }
}

fn checked_base_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Korvi API base URL is invalid.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Korvi API base URL contains unsupported authority data.".to_owned());
    }
    if !cfg!(debug_assertions) && url.scheme() != "https" {
        return Err("Production Korvi Cashier requires an HTTPS API base URL.".to_owned());
    }
    Ok(url)
}

fn checked_web_origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| "Korvi web origin is invalid.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Korvi web origin must be an exact HTTP(S) origin.".to_owned());
    }
    if !cfg!(debug_assertions) && url.scheme() != "https" {
        return Err("Production Korvi Cashier requires an HTTPS web origin.".to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

fn initial_state() -> Result<ApiState, String> {
    let api_base = option_env!("KORVI_API_BASE_URL").unwrap_or(DEFAULT_API_BASE_URL);
    let web_origin = option_env!("KORVI_WEB_ORIGIN").unwrap_or(DEFAULT_WEB_ORIGIN);
    let source_sha = option_env!("KORVI_SOURCE_SHA").unwrap_or("development");

    let client = Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(format!("KorviCashier/{} source/{source_sha}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "Unable to initialize Korvi native HTTP client.".to_owned())?;

    Ok(ApiState {
        client,
        base_url: checked_base_url(api_base)?,
        web_origin: checked_web_origin(web_origin)?,
    })
}

#[tauri::command]
async fn api_request(state: State<'_, ApiState>, request: ApiRequest) -> Result<ApiResponse, String> {
    if !request.path.starts_with("/v1/")
        || request.path.contains("://")
        || request.path.contains("..")
        || request.path.contains('#')
    {
        return Err("Native transport refused a non-canonical Korvi API path.".to_owned());
    }

    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| "Native transport refused an invalid HTTP method.".to_owned())?;
    if !allowed_request(&method, &request.path) {
        return Err("Native transport refused a non-cashier API capability.".to_owned());
    }

    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES)
    {
        return Err("Native transport refused an oversized request body.".to_owned());
    }

    let url = state
        .base_url
        .join(&request.path)
        .map_err(|_| "Native transport refused an invalid Korvi API path.".to_owned())?;
    if url.origin() != state.base_url.origin() {
        return Err("Native transport refused a cross-origin API request.".to_owned());
    }

    let mut builder = state
        .client
        .request(method.clone(), url)
        .header(header::ACCEPT, "application/json");

    if method != Method::GET && method != Method::HEAD {
        builder = builder.header(header::ORIGIN, &state.web_origin);
    }
    if let Some(content_type) = request.headers.get("content-type") {
        if content_type != "application/json" {
            return Err("Native transport only accepts JSON command bodies.".to_owned());
        }
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|_| "Korvi API network request failed.".to_owned())?;
    let status = response.status().as_u16();
    let mut headers = BTreeMap::new();
    if let Some(content_type) = response.headers().get(header::CONTENT_TYPE) {
        if let Ok(content_type) = content_type.to_str() {
            headers.insert("content-type".to_owned(), content_type.to_owned());
        }
    }
    let body = response
        .text()
        .await
        .map_err(|_| "Korvi API response body could not be read.".to_owned())?;

    Ok(ApiResponse {
        status,
        headers,
        body,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = initial_state().expect("Korvi Cashier native transport configuration is invalid");
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![api_request])
        .run(tauri::generate_context!())
        .expect("error while running Korvi Cashier");
}
