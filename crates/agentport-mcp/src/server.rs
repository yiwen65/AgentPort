//! Request dispatch: `initialize`, `tools/list`, `tools/call` and the
//! notification/error paths of MCP.

use serde_json::{json, Value};

use crate::ops::ToolFailure;
use crate::protocol::{
    failure, initialize_result, parse_line, success, IncomingMessage, RpcError, INVALID_PARAMS,
    METHOD_NOT_FOUND,
};
use crate::tools::{Toolbox, TOOLS};

pub struct Server {
    toolbox: Toolbox,
    version: String,
}

impl Server {
    pub fn new(toolbox: Toolbox, version: impl Into<String>) -> Server {
        Server {
            toolbox,
            version: version.into(),
        }
    }

    pub fn toolbox(&self) -> &Toolbox {
        &self.toolbox
    }

    /// Handle one raw message line. `None` means "no response required"
    /// (notifications), which the transport must not answer.
    pub fn handle_line(&mut self, line: &str) -> Option<Value> {
        match parse_line(line) {
            Ok(message) => self.handle_message(message),
            // A message that cannot be parsed has no id we can echo.
            Err(error) => Some(failure(&Value::Null, error)),
        }
    }

    fn handle_message(&mut self, message: IncomingMessage) -> Option<Value> {
        let Some(id) = message.response_id() else {
            // notifications/initialized, notifications/cancelled: nothing to do.
            return None;
        };
        let result = match message.method.as_str() {
            "initialize" => Ok(initialize_result(message.params.as_ref(), &self.version)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({
                "tools": self.toolbox.tool_definitions()
            })),
            "tools/call" => self.call_tool(message.params.as_ref()),
            other => Err(RpcError::new(
                METHOD_NOT_FOUND,
                format!("method not found: {other}"),
            )),
        };
        Some(match result {
            Ok(value) => success(&id, value),
            Err(error) => failure(&id, error),
        })
    }

    fn call_tool(&mut self, params: Option<&Value>) -> Result<Value, RpcError> {
        let Some(params) = params else {
            return Err(RpcError::new(INVALID_PARAMS, "tools/call requires params"));
        };
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return Err(RpcError::new(INVALID_PARAMS, "missing tool name"));
        };
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        // Tool failures are results, not protocol errors: the model must be able
        // to read the reason and adapt, and every client surfaces isError alike.
        Ok(match self.toolbox.call(name, &arguments) {
            Ok(value) => tool_result(value, false),
            Err(failure) => tool_result(error_value(&failure), true),
        })
    }
}

fn error_value(failure: &ToolFailure) -> Value {
    json!({ "error": { "code": failure.code, "message": failure.message } })
}

fn tool_result(value: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into());
    // `structuredContent` would need a declared outputSchema; the JSON text is
    // the single contract, identical for humans reading the log and the model.
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PARSE_ERROR;

    #[test]
    fn tools_list_matches_the_registry() {
        let tools = TOOLS;
        assert!(tools.iter().any(|tool| tool.name == "create_session"));
        assert!(tools.iter().any(|tool| tool.name == "wait_for_task"));
        // Guardrails must not reappear as tools.
        assert!(!tools.iter().any(|tool| tool.name == "send_input"));
        assert!(!tools.iter().any(|tool| tool.name.contains("git")));

        let mut server = Server::new(crate::tools::test_support::toolbox(), "0.0.0");
        let response = server
            .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
            .unwrap();
        let definitions = response["result"]["tools"].as_array().unwrap();
        let create = definitions
            .iter()
            .find(|tool| tool["name"] == "create_session")
            .unwrap();
        assert!(create["description"].as_str().unwrap().contains("role_test"));
        assert!(create["description"].as_str().unwrap().contains("Test Role"));
    }

    #[test]
    fn parse_errors_are_reported_with_a_null_id() {
        let mut server = Server::new(crate::tools::test_support::toolbox(), "0.0.0");
        let response = server.handle_line("{nope").unwrap();
        assert_eq!(response["error"]["code"], PARSE_ERROR);
        assert!(response["id"].is_null());
    }

    #[test]
    fn notifications_are_never_answered() {
        let mut server = Server::new(crate::tools::test_support::toolbox(), "0.0.0");
        assert!(server
            .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .is_none());
    }

    #[test]
    fn null_id_requests_are_answered() {
        // JSON-RPC allows "id": null; a notification omits the member entirely.
        let mut server = Server::new(crate::tools::test_support::toolbox(), "0.0.0");
        let response = server
            .handle_line(r#"{"jsonrpc":"2.0","id":null,"method":"ping"}"#)
            .unwrap();
        assert!(response["id"].is_null());
        assert_eq!(response["result"], json!({}));
    }

    #[test]
    fn wrong_jsonrpc_version_is_rejected() {
        let mut server = Server::new(crate::tools::test_support::toolbox(), "0.0.0");
        let response = server
            .handle_line(r#"{"jsonrpc":"1.0","id":3,"method":"ping"}"#)
            .unwrap();
        assert_eq!(response["error"]["code"], crate::protocol::INVALID_REQUEST);
    }

    #[test]
    fn unknown_methods_are_protocol_errors() {
        let mut server = Server::new(crate::tools::test_support::toolbox(), "0.0.0");
        let response = server
            .handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"resources/list"}"#)
            .unwrap();
        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn tools_call_without_a_name_is_invalid_params() {
        let mut server = Server::new(crate::tools::test_support::toolbox(), "0.0.0");
        let response = server
            .handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}"#)
            .unwrap();
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tool name"));
    }
}
