//! Dev-only endpoints. Compiled in only when `debug_assertions` is set
//! (i.e. non-release builds) OR when the `dev-routes` feature is enabled.
//!
//! Currently exposes `GET /api/dev/routes` for the test suite's coverage-drift check.

#![cfg(any(debug_assertions, feature = "dev-routes"))]

use crate::tracked_router::{get_global_routes, RouteInfo};
use axum::Json;

pub async fn routes_handler() -> Json<Vec<RouteInfo>> {
    Json(get_global_routes())
}
