use agentport_core::git::GitContextLocator;
use agentport_core::models::{CommitAiLanguage, CommitAiProvider};
use agentport_remote_protocol::CommitAiConfigSaveParams;
use agentport_service::{CoreService, RemoteService, ServiceError};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::AppState;

type CommandResult<T> = std::result::Result<T, CommitAiCommandError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitAiCommandError {
    code: &'static str,
    message: String,
    recoverable: bool,
}

impl From<ServiceError> for CommitAiCommandError {
    fn from(error: ServiceError) -> Self {
        let (code, recoverable) = match &error {
            ServiceError::InvalidRequest | ServiceError::NotExecutedCore(_) => ("validation", true),
            ServiceError::CommitAiOutcomeUnknown => ("unknown", true),
            ServiceError::Core(_) | ServiceError::CommitAi(_) => ("request", true),
            _ => ("internal", false),
        };
        Self {
            code,
            message: error.to_string(),
            recoverable,
        }
    }
}

async fn run_service(
    paths: agentport_core::paths::AppPaths,
    method: &'static str,
    params: Value,
) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let service = CoreService::open(paths)?;
        service.extended_facade(method, params)
    })
    .await
    .map_err(|_| CommitAiCommandError {
        code: "internal",
        message: "commit AI worker stopped".into(),
        recoverable: false,
    })?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn get_commit_ai_config(state: State<'_, AppState>) -> CommandResult<Value> {
    run_service(state.paths.clone(), "commit_ai.config.get", json!({})).await
}

#[tauri::command]
pub async fn save_commit_ai_config(
    state: State<'_, AppState>,
    provider: CommitAiProvider,
    base_url: String,
    model: String,
    api_key: Option<String>,
    language: CommitAiLanguage,
) -> CommandResult<Value> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let service = CoreService::open(paths)?;
        service.save_commit_ai_config(CommitAiConfigSaveParams::new(
            match provider {
                CommitAiProvider::OpenAi => "openai".into(),
                CommitAiProvider::Anthropic => "anthropic".into(),
            },
            base_url,
            model,
            api_key,
            match language {
                CommitAiLanguage::Zh => "zh".into(),
                CommitAiLanguage::En => "en".into(),
            },
        ))
    })
    .await
    .map_err(|_| CommitAiCommandError {
        code: "internal",
        message: "commit AI worker stopped".into(),
        recoverable: false,
    })?
    .map_err(Into::into)
}

#[tauri::command]
pub async fn clear_commit_ai_api_key(state: State<'_, AppState>) -> CommandResult<Value> {
    run_service(state.paths.clone(), "commit_ai.key.clear", json!({})).await
}

#[tauri::command]
pub async fn generate_git_commit_message(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
) -> CommandResult<Value> {
    run_service(
        state.paths.clone(),
        "commit_ai.generate",
        json!({
            "locator": locator,
            "expectedCheckoutId": expected_checkout_id,
            "expectedStatusToken": expected_status_token,
        }),
    )
    .await
}
