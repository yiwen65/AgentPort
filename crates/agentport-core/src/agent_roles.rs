//! Agent role definitions shared by the desktop UI and the MCP sidecar.
//!
//! A role is an instruction profile, not an execution policy. Agent selection,
//! permission, worktree, tools and Session lifecycle remain outside this model.

use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};

pub const MAX_ROLE_NAME_BYTES: usize = 120;
pub const MAX_ROLE_DESCRIPTION_BYTES: usize = 1_000;
pub const MAX_ROLE_INSTRUCTIONS_BYTES: usize = 16 * 1024;
pub const MAX_ROLE_OUTPUT_CONTRACT_BYTES: usize = 4 * 1024;

/// A persisted role and the immutable content copied into an MCP Session
/// snapshot at delegation time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRole {
    pub id: String,
    pub name: String,
    pub description: String,
    pub instructions: String,
    #[serde(default)]
    pub output_contract: Option<String>,
    pub enabled: bool,
    pub revision: u64,
    pub built_in: bool,
}

/// Editable role fields. The backend controls identity, enablement, revision
/// and built-in status so UI/MCP callers cannot bypass lifecycle rules.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoleDraft {
    pub name: String,
    pub description: String,
    pub instructions: String,
    #[serde(default)]
    pub output_contract: Option<String>,
}

pub fn validate_role_draft(draft: &AgentRoleDraft) -> Result<()> {
    validate_text("role name", &draft.name, MAX_ROLE_NAME_BYTES, false, true)?;
    validate_text(
        "role description",
        &draft.description,
        MAX_ROLE_DESCRIPTION_BYTES,
        true,
        false,
    )?;
    validate_text(
        "role instructions",
        &draft.instructions,
        MAX_ROLE_INSTRUCTIONS_BYTES,
        true,
        true,
    )?;
    if let Some(output_contract) = &draft.output_contract {
        if !output_contract.trim().is_empty() {
            validate_text(
                "role output contract",
                output_contract,
                MAX_ROLE_OUTPUT_CONTRACT_BYTES,
                true,
                true,
            )?;
        }
    }
    Ok(())
}

pub fn normalize_role_draft(draft: &AgentRoleDraft) -> AgentRoleDraft {
    AgentRoleDraft {
        name: draft.name.trim().to_string(),
        description: draft.description.trim().to_string(),
        instructions: draft.instructions.trim().to_string(),
        output_contract: draft.output_contract.as_ref().and_then(|value| {
            let value = value.trim().to_string();
            (!value.is_empty()).then_some(value)
        }),
    }
}

fn validate_text(
    field: &str,
    value: &str,
    max_bytes: usize,
    allow_newlines: bool,
    require_nonempty: bool,
) -> Result<()> {
    if require_nonempty && value.trim().is_empty() {
        return Err(CoreError::Validation(format!("{field} must not be empty")));
    }
    if value.len() > max_bytes {
        return Err(CoreError::Validation(format!(
            "{field} exceeds {max_bytes} bytes"
        )));
    }
    if value.contains('\0') || value.contains('\u{1b}') {
        return Err(CoreError::Validation(format!(
            "{field} must not contain NUL or ESC characters"
        )));
    }
    if !allow_newlines && value.chars().any(|c| c == '\n' || c == '\r') {
        return Err(CoreError::Validation(format!("{field} must be one line")));
    }
    if value
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
    {
        return Err(CoreError::Validation(format!(
            "{field} contains unsupported control characters"
        )));
    }
    Ok(())
}

/// Stable built-in ids are part of the MCP audit contract: existing Session
/// snapshots remain meaningful after a user edits or restores a preset.
pub fn builtin_roles() -> Vec<AgentRole> {
    vec![
        AgentRole {
            id: "role_researcher".into(),
            name: "Research & Analysis".into(),
            description: "调查背景、验证事实、比较方案并清晰记录不确定性。".into(),
            instructions: "Act as a research and analysis specialist. Decompose the task, verify claims against available evidence, distinguish facts from assumptions, compare viable options, and state important uncertainties before recommending a path.".into(),
            output_contract: Some("Return concise findings, evidence, trade-offs, and a recommended next step.".into()),
            enabled: true,
            revision: 1,
            built_in: true,
        },
        AgentRole {
            id: "role_implementer".into(),
            name: "Implementer".into(),
            description: "把已确认需求转化为最小、可验证的代码改动。".into(),
            instructions: "Act as a careful implementation engineer. Trace the existing design before editing, make the smallest complete change, preserve unrelated behavior, and verify the result with targeted tests or checks. Report files changed and any remaining limitations.".into(),
            output_contract: Some("Return the implementation result, validation evidence, and unresolved risks.".into()),
            enabled: true,
            revision: 1,
            built_in: true,
        },
        AgentRole {
            id: "role_reviewer".into(),
            name: "Reviewer".into(),
            description: "从正确性、安全性、回归和可维护性角度审查变更。".into(),
            instructions: "Act as an adversarial code reviewer. Look for concrete correctness, security, compatibility, performance, and maintainability problems. Prioritize actionable findings supported by the code, and do not rewrite code unless explicitly asked.".into(),
            output_contract: Some("Return findings ordered by severity with file and line evidence; say when no concrete issue is found.".into()),
            enabled: true,
            revision: 1,
            built_in: true,
        },
        AgentRole {
            id: "role_tester".into(),
            name: "Tester".into(),
            description: "设计并执行有针对性的验证，定位失败并区分产品问题与测试问题。".into(),
            instructions: "Act as a verification specialist. Define observable acceptance checks, reproduce failures when practical, choose the smallest meaningful tests first, and investigate failures to their first divergence. Do not declare success from an unrun check.".into(),
            output_contract: Some("Return commands run, actual results, coverage limits, and any follow-up required.".into()),
            enabled: true,
            revision: 1,
            built_in: true,
        },
        AgentRole {
            id: "role_documenter".into(),
            name: "Documenter".into(),
            description: "把技术行为、使用方式和限制写成准确、可执行的说明。".into(),
            instructions: "Act as a technical documentation specialist. Write for the intended reader, preserve exact behavior and constraints, prefer examples that can be followed, and call out prerequisites, failure modes, and limitations without inventing facts.".into(),
            output_contract: Some("Return the updated explanation or documentation outline and identify any facts that still need confirmation.".into()),
            enabled: true,
            revision: 1,
            built_in: true,
        },
    ]
}

pub fn builtin_role(id: &str) -> Option<AgentRole> {
    builtin_roles().into_iter().find(|role| role.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_roles_are_stable_and_enabled() {
        let roles = builtin_roles();
        assert_eq!(roles.len(), 5);
        assert!(roles.iter().all(|role| role.built_in && role.enabled));
        assert_eq!(roles[0].id, "role_researcher");
    }

    #[test]
    fn drafts_trim_optional_output_and_reject_control_input() {
        let draft = AgentRoleDraft {
            name: "  Role  ".into(),
            description: " description ".into(),
            instructions: " instructions\nwith detail ".into(),
            output_contract: Some("  output  ".into()),
        };
        validate_role_draft(&draft).unwrap();
        let normalized = normalize_role_draft(&draft);
        assert_eq!(normalized.name, "Role");
        assert_eq!(normalized.output_contract.as_deref(), Some("output"));
        assert!(validate_role_draft(&AgentRoleDraft {
            instructions: "bad\u{1b}".into(),
            ..draft
        })
        .is_err());
    }
}
