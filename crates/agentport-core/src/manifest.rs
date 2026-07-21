//! release-manifest.json generation (PRD ch.6 发布架构, ch.10 跨平台发布矩阵).
//! Records build platform, arch, distro snapshot, WebKitGTK, agent CLI versions,
//! test results and support tiers. Written at release time by scripts/; the
//! struct is versioned here so the schema stays reviewable.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SupportTier {
    Official,
    Community,
    Beta,
    Unverified,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformEntry {
    pub os: String, // macos | ubuntu | fedora | arch | appimage
    pub version_or_snapshot: String,
    pub arch: String, // universal | arm64 | x86_64
    pub tier: SupportTier,
    pub artifact: Option<String>,
    pub webview_version: Option<String>,
    pub webkitgtk_version: Option<String>,
    pub tested: Vec<String>, // e.g. ["install","launch","pty","ime","notify","uninstall"]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliEntry {
    pub agent: String,
    pub executable_path: String,
    pub version_text: String,
    pub capability_hash: String,
    pub exact_resume: bool,
    pub hook_status: String,
    pub verified_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestSummary {
    pub suite: String,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub evidence: String, // command + date, or CI link
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub manifest_version: u32,
    pub app_version: String,
    pub generated_at: DateTime<Utc>,
    pub delivery_scope: String, // "p0_p2"
    pub platforms: Vec<PlatformEntry>,
    pub agent_clis: Vec<AgentCliEntry>,
    pub tests: Vec<TestSummary>,
    pub known_limitations: Vec<String>,
}

impl ReleaseManifest {
    pub fn new(app_version: &str) -> Self {
        ReleaseManifest {
            manifest_version: MANIFEST_VERSION,
            app_version: app_version.into(),
            generated_at: Utc::now(),
            delivery_scope: crate::models::DELIVERY_SCOPE.into(),
            platforms: vec![],
            agent_clis: vec![],
            tests: vec![],
            known_limitations: vec![],
        }
    }
}
