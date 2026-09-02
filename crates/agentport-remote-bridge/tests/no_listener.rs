#[test]
fn production_sources_have_no_network_listener_code_path() {
    let sources = [
        include_str!("../src/lib.rs"),
        include_str!("../src/main.rs"),
        include_str!("../Cargo.toml"),
    ]
    .join("\n");
    for forbidden in [
        "TcpListener",
        "UdpSocket",
        "UnixListener",
        "tokio::net",
        "std::net",
        "axum",
        "hyper",
    ] {
        assert!(
            !sources.contains(forbidden),
            "stdio bridge unexpectedly contains network primitive {forbidden}"
        );
    }
}
