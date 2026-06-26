//! TrackedRouter — thin wrapper around axum::Router that records every route
//! registration so the agent can introspect its own surface at runtime via
//! `GET /api/dev/routes`.
//!
//! Captures (path, methods) per `.route()` call. `nest_tracked()` merges another
//! tracked router and prepends the nesting prefix to every captured path so the
//! aggregated list reflects the full URL surface.

use axum::routing::{MethodRouter, Router};
use serde::Serialize;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
pub struct RouteInfo {
    pub path: String,
    pub methods: Vec<String>,
}

pub struct TrackedRouter<S = ()> {
    inner: Router<S>,
    routes: Arc<Mutex<Vec<RouteInfo>>>,
}

impl<S> TrackedRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    pub fn new() -> Self {
        Self {
            inner: Router::new(),
            routes: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Register a route. Captures (path, methods) into the internal log.
    /// Methods are inferred from the MethodRouter's debug repr (axum 0.7 doesn't
    /// expose a public accessor) — see `infer_methods()`.
    pub fn route(self, path: &str, method_router: MethodRouter<S>) -> Self {
        let methods = infer_methods(&method_router);
        self.routes.lock().unwrap_or_else(|e| e.into_inner()).push(RouteInfo {
            path: path.to_string(),
            methods,
        });
        Self {
            inner: self.inner.route(path, method_router),
            routes: self.routes,
        }
    }

    /// Nest another TrackedRouter and merge its captured routes with the prefix.
    pub fn nest_tracked(self, prefix: &str, other: TrackedRouter<S>) -> Self {
        let (other_router, other_routes) = other.into_inner_with_routes();
        {
            let mut log = self.routes.lock().unwrap_or_else(|e| e.into_inner());
            for r in other_routes {
                log.push(RouteInfo {
                    path: format!("{}{}", prefix, r.path),
                    methods: r.methods,
                });
            }
        }
        Self {
            inner: self.inner.nest(prefix, other_router),
            routes: self.routes,
        }
    }

    /// Apply state to the wrapped router. Captured routes carry over unchanged.
    pub fn with_state<S2>(self, state: S) -> TrackedRouter<S2>
    where
        S2: Clone + Send + Sync + 'static,
    {
        TrackedRouter {
            inner: self.inner.with_state(state),
            routes: self.routes,
        }
    }

    /// Consume self, returning the inner Router and the captured routes.
    pub fn into_inner_with_routes(self) -> (Router<S>, Vec<RouteInfo>) {
        let routes = std::mem::take(&mut *self.routes.lock().unwrap_or_else(|e| e.into_inner()));
        (self.inner, routes)
    }

    /// Snapshot of every route captured so far. Only useful for the
    /// /api/dev/routes endpoint, so it shares that endpoint's cfg gate.
    #[cfg(any(debug_assertions, feature = "dev-routes"))]
    pub fn captured_routes(&self) -> Vec<RouteInfo> {
        self.routes.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl<S> Default for TrackedRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    fn default() -> Self {
        Self::new()
    }
}

/// Infer HTTP methods from a MethodRouter. Axum 0.7 doesn't expose this publicly,
/// so we use the Debug impl as a workaround. The Debug output for axum 0.7's
/// MethodRouter looks like:
///   `MethodRouter { get: BoxedHandler, head: None, ..., allow_header: Bytes(b"GET,HEAD,POST,...") }`
/// Set methods read `<method>: BoxedHandler`; unset read `<method>: None`. We
/// scan for `<method>: BoxedHandler` for each HTTP verb.
///
/// This is brittle — if axum changes the Debug format, the wrapper's unit tests
/// catch it (they assert against every common verb). Update the needle and re-run.
fn infer_methods<S>(router: &MethodRouter<S>) -> Vec<String> {
    let dbg = format!("{:?}", router);
    let mut methods = Vec::new();
    for m in &["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"] {
        let needle = format!("{}: BoxedHandler", m.to_lowercase());
        if dbg.contains(&needle) {
            methods.push(m.to_string());
        }
    }
    if methods.is_empty() {
        // Fallback: include ANY so the route is at least surfaced; spec test will catch this.
        methods.push("ANY".to_string());
    }
    methods
}

// Global route registry — only compiled when the dev-routes endpoint
// is also compiled (debug builds, or when the `dev-routes` feature is
// enabled). Outside of that, no one reads the registry, so writing to
// it would be a pure side-effect with no purpose.
#[cfg(any(debug_assertions, feature = "dev-routes"))]
mod registry {
    use super::RouteInfo;
    use std::sync::OnceLock;

    /// Populated once at startup by main.rs after all routes are composed.
    /// Read by the /api/dev/routes handler in `dev.rs`.
    pub static REGISTERED_ROUTES: OnceLock<Vec<RouteInfo>> = OnceLock::new();

    pub fn set_global_routes(routes: Vec<RouteInfo>) {
        let _ = REGISTERED_ROUTES.set(routes);
    }

    pub fn get_global_routes() -> Vec<RouteInfo> {
        REGISTERED_ROUTES.get().cloned().unwrap_or_default()
    }
}

#[cfg(any(debug_assertions, feature = "dev-routes"))]
pub use registry::{get_global_routes, set_global_routes};
