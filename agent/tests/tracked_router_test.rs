//! Unit tests for TrackedRouter. Verifies the wrapper captures routes accurately
//! and merges nested sub-routers with the correct prefix.

use axum::routing::get;
use netstacks_agent::tracked_router::{RouteInfo, TrackedRouter};

async fn ok() -> &'static str {
    "ok"
}

#[test]
fn captures_single_route() {
    let (_router, routes) = TrackedRouter::<()>::new()
        .route("/health", get(ok))
        .into_inner_with_routes();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].path, "/health");
    assert_eq!(routes[0].methods, vec!["GET".to_string()]);
}

#[test]
fn captures_multi_method_route() {
    let (_router, routes) = TrackedRouter::<()>::new()
        .route("/items", get(ok).post(ok))
        .into_inner_with_routes();
    assert_eq!(routes.len(), 1);
    assert_eq!(routes[0].path, "/items");
    let mut methods = routes[0].methods.clone();
    methods.sort();
    assert_eq!(methods, vec!["GET".to_string(), "POST".to_string()]);
}

#[test]
fn captures_three_method_route() {
    let (_router, routes) = TrackedRouter::<()>::new()
        .route("/items/:id", get(ok).put(ok).delete(ok))
        .into_inner_with_routes();
    assert_eq!(routes.len(), 1);
    let mut methods = routes[0].methods.clone();
    methods.sort();
    assert_eq!(
        methods,
        vec!["DELETE".to_string(), "GET".to_string(), "PUT".to_string()]
    );
}

#[test]
fn nest_tracked_prefixes_paths() {
    let inner = TrackedRouter::<()>::new()
        .route("/list", get(ok))
        .route("/:id", get(ok));
    let (_router, routes) = TrackedRouter::<()>::new()
        .route("/health", get(ok))
        .nest_tracked("/items", inner)
        .into_inner_with_routes();
    let paths: std::collections::HashSet<String> =
        routes.iter().map(|r| r.path.clone()).collect();
    assert!(paths.contains("/health"));
    assert!(paths.contains("/items/list"));
    assert!(paths.contains("/items/:id"));
}

#[test]
fn route_info_serializes_to_json() {
    let info = RouteInfo {
        path: "/a".into(),
        methods: vec!["GET".into()],
    };
    let json = serde_json::to_string(&info).unwrap();
    assert!(json.contains("\"path\":\"/a\""));
    assert!(json.contains("\"methods\":[\"GET\"]"));
}
