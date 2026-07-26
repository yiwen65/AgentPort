mod support;

use agentport_core::git::{GitRunOptions, GitRunner};
use support::mock_repo::MockRepo;

#[test]
fn runner_writes_stdin_and_reports_bounded_output() {
    let fixture = MockRepo::new();
    let runner = GitRunner::default();
    let input = vec![b'x'; 16 * 1024];

    let oid = runner
        .run_with_options(
            Some(fixture.root()),
            ["hash-object", "-w", "--stdin"],
            GitRunOptions {
                input: Some(input),
                max_stdout: 128,
                max_stderr: 128,
                ..GitRunOptions::default()
            },
        )
        .unwrap()
        .require_success()
        .unwrap()
        .stdout_lossy();

    let output = runner
        .run_with_options(
            Some(fixture.root()),
            ["cat-file", "blob", oid.trim()],
            GitRunOptions {
                max_stdout: 1024,
                max_stderr: 128,
                read_only: true,
                ..GitRunOptions::default()
            },
        )
        .unwrap()
        .require_success()
        .unwrap();

    assert_eq!(output.stdout.len(), 1024);
    assert!(output.stdout_truncated);
    assert!(!output.stderr_truncated);
}
