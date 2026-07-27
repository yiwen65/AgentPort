use agentport_core::db::Db;
use agentport_core::models::{CommitAiProvider, CommitAiSettings};

#[test]
fn commit_ai_settings_default_and_roundtrip_without_secret_values() {
    let db = Db::open_memory().unwrap();
    assert_eq!(
        db.load_commit_ai_settings().unwrap(),
        CommitAiSettings::default()
    );

    let configured = CommitAiSettings {
        provider: CommitAiProvider::Anthropic,
        base_url: "https://example.test/anthropic".into(),
        model: "claude-compatible".into(),
        api_key_secret_ref_id: Some("sec_reference_only".into()),
    };
    db.save_commit_ai_settings(&configured).unwrap();
    assert_eq!(db.load_commit_ai_settings().unwrap(), configured);
    assert_eq!(
        serde_json::to_string(&CommitAiProvider::OpenAi).unwrap(),
        "\"openai\""
    );
}
