use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOptionsError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOptionsEnvelope {
    pub labels: Vec<String>,
    pub assignees: Vec<TaskOption>,
    pub branches: Vec<TaskOption>,
    pub reviewers: Vec<TaskOption>,
    pub error: Option<TaskOptionsError>,
}

impl TaskOptionsEnvelope {
    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            labels: Vec::new(),
            assignees: Vec::new(),
            branches: Vec::new(),
            reviewers: Vec::new(),
            error: Some(TaskOptionsError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}
