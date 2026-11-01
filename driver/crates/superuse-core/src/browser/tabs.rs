//! Background tabs: `browser_open_tab` opens a tab in an exactly-bound browser
//! window without selecting it or activating the window, so an agent can work
//! beside the user's current page instead of navigating it away.
//! `browser_close_tab` closes only tabs the same session opened.
//!
//! Chromium's `Target.createTarget` has no window parameter. With
//! `background: true` it adds an unselected tab (`NEW_BACKGROUND_TAB`, window
//! shown inactive, no focus) to the profile's most recently active window. The
//! tool proves the tab landed in the bound window and otherwise closes it again
//! and refuses, so a tab never appears in a window the caller didn't bind.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::protocol::ToolResult;
use crate::tool::{ProtectedResourceOwnership, Tool, ToolDef};
use crate::tool_args::ArgsExt;

use super::engine::{protected_live_origin_scope, BrowserEngine};
use super::refusal::{BrowserRefusal, BrowserRefusalCode};
use super::session_schema as schema_session;
use super::store::TabRecord;
use super::tools::{
    browser_protected_resource_scope, browser_resource_ownership, is_loadable_page_url,
    require_explicit_session, schema_tab_id, schema_target_id,
};

/// Attest the bound window a new tab opens in. Bounded manifests admit the
/// call by the new tab's origin, the way they admit a navigation.
async fn browser_window_protected_resource_scope(
    engine: &BrowserEngine,
    args: &Value,
) -> Result<Option<Value>, String> {
    let session = args
        .get("session")
        .and_then(Value::as_str)
        .filter(|session| !session.is_empty())
        .ok_or_else(|| "the browser operation requires an explicit session".to_owned())?;
    let target_id = args
        .get("target_id")
        .and_then(Value::as_str)
        .filter(|target| !target.is_empty())
        .ok_or_else(|| "the browser operation requires an exact target_id".to_owned())?;
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| "browser_open_tab requires a URL".to_owned())?;
    let runtime_session = crate::tool::current_dispatch_authorization_context()
        .map(|context| context.runtime_session_key(session))
        .unwrap_or_else(|| session.to_owned());
    let validated = engine
        .revalidate_binding(&runtime_session, target_id)
        .await
        .map_err(|error| error.message)?;
    let origin = protected_live_origin_scope(url).map_err(|error| error.message)?;
    let target = validated.record;
    Ok(Some(json!({
        "kind": "authenticated_browser_window",
        "target_id": target_id,
        "pid": target.pid,
        "process_fingerprint": target.fingerprint,
        "binding_generation": target.generation,
        "cdp_window_id": target.cdp_window_id,
        // The document the new tab will show.
        "live_origin": origin,
        "requested_origin": origin,
        "action_class": "tab_open",
    })))
}

// ── browser_open_tab ─────────────────────────────────────────────────────────

pub struct BrowserOpenTabTool {
    def: ToolDef,
    engine: Arc<BrowserEngine>,
}

impl BrowserOpenTabTool {
    pub fn new(engine: Arc<BrowserEngine>) -> Self {
        let def = ToolDef {
            name: "browser_open_tab".into(),
            description: "Open a new tab in an exactly-bound browser window without \
                selecting it or activating the window, and return its tab_id in the \
                same binding (http/https/about URLs only). The user's current tab \
                stays selected. Chromium adds background tabs to the profile's most \
                recently active window: when that isn't the bound window, the tab is \
                closed again and the call refuses with browser_wrong_target_refused. \
                Close tabs you opened with browser_close_tab."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "target_id": schema_target_id(),
                    "url": { "type": "string", "description": "URL for the new tab (http:, https:, or about:)." },
                    "session": schema_session(),
                },
                "required": ["target_id", "url"],
                "additionalProperties": true
            }),
            read_only: false,
            destructive: false,
            idempotent: false,
            open_world: true,
        };
        Self { def, engine }
    }
}

#[async_trait]
impl Tool for BrowserOpenTabTool {
    fn def(&self) -> &ToolDef {
        &self.def
    }

    async fn protected_resource_ownership(
        &self,
        adapter_id: &str,
        args: &Value,
    ) -> ProtectedResourceOwnership {
        if adapter_id == "browser_bound_input" {
            browser_resource_ownership(&self.engine, args)
        } else {
            ProtectedResourceOwnership::UserOwned
        }
    }

    async fn protected_resource_scope(
        &self,
        adapter_id: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        if adapter_id == "browser_bound_input" {
            browser_window_protected_resource_scope(&self.engine, args).await
        } else {
            Ok(None)
        }
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        let (target_id, url) = match (args.require_str("target_id"), args.require_str("url")) {
            (Ok(target), Ok(url)) => (target, url),
            (Err(e), _) | (_, Err(e)) => return e,
        };
        let session = match require_explicit_session(&args) {
            Ok(s) => s,
            Err(e) => return e,
        };
        if !is_loadable_page_url(&url) {
            return ToolResult::error(format!(
                "browser_open_tab only accepts http/https/about URLs, got: {url}"
            ));
        }

        let validated = match self.engine.revalidate_binding(&session, &target_id).await {
            Ok(v) => v,
            Err(refusal) => return refusal.to_tool_result(),
        };
        let record = &validated.record;
        let Some(bound_window) = record.cdp_window_id else {
            return BrowserRefusal::new(
                BrowserRefusalCode::BrowserRouteUnavailable,
                "this binding is a single-page embedded browser with no tabs to add to",
            )
            .to_tool_result();
        };
        let conn = &validated.conn;

        let created = match conn
            .call(
                None,
                "Target.createTarget",
                json!({ "url": url, "background": true }),
            )
            .await
        {
            Ok(created) => created,
            Err(error) => {
                return BrowserRefusal::new(
                    BrowserRefusalCode::BrowserRouteUnavailable,
                    format!("the browser did not open a background tab: {error}"),
                )
                .to_tool_result()
            }
        };
        let Some(cdp_target_id) = created
            .get("targetId")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return ToolResult::error("Target.createTarget returned no targetId");
        };

        let landed_in = conn
            .call(
                None,
                "Browser.getWindowForTarget",
                json!({ "targetId": cdp_target_id }),
            )
            .await
            .ok()
            .and_then(|window| window.get("windowId").and_then(Value::as_i64));
        if landed_in != Some(bound_window) {
            let closed = conn
                .call(
                    None,
                    "Target.closeTarget",
                    json!({ "targetId": cdp_target_id }),
                )
                .await
                .is_ok();
            return BrowserRefusal::new(
                BrowserRefusalCode::BrowserWrongTargetRefused,
                if closed {
                    "the browser put the new tab in another window (its most recently \
                     active one), so it was closed again; bind that window, or have the \
                     user switch to the bound window, and retry"
                } else {
                    "the browser put the new tab in another window (its most recently \
                     active one) and it could not be closed again"
                },
            )
            .with_detail(json!({ "closed": closed, "retryable": false }))
            .to_tool_result();
        }

        let tab_id = self.engine.store.mint_tab_id();
        let tab = TabRecord {
            tab_id: tab_id.clone(),
            cdp_target_id: cdp_target_id.clone(),
            title: String::new(),
            url: url.clone(),
            // Opened unselected; the user may select it later.
            active: Some(false),
            generation: record.generation,
            snapshots: Default::default(),
        };
        self.engine
            .store
            .update_target(&session, &target_id, |target| {
                target.tabs.insert(tab_id.clone(), tab);
            });
        self.engine
            .store
            .record_opened_tab(&session, record.pid, &cdp_target_id);

        ToolResult::text(format!(
            "opened {tab_id} in the background of {target_id} at {url}; the user's selected tab is unchanged"
        ))
        .with_structured(json!({
            "status": "ok",
            "target_id": target_id,
            "tab_id": tab_id,
            "url": url,
            "active": false,
        }))
    }
}

// ── browser_close_tab ────────────────────────────────────────────────────────

pub struct BrowserCloseTabTool {
    def: ToolDef,
    engine: Arc<BrowserEngine>,
}

impl BrowserCloseTabTool {
    pub fn new(engine: Arc<BrowserEngine>) -> Self {
        let def = ToolDef {
            name: "browser_close_tab".into(),
            description: "Close a tab this session opened with browser_open_tab. Every \
                other tab, including all of the user's own tabs, is refused with \
                browser_action_unavailable. Closing an unselected tab leaves the \
                user's selected tab and the window untouched."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "target_id": schema_target_id(),
                    "tab_id": schema_tab_id(),
                    "session": schema_session(),
                },
                "required": ["target_id", "tab_id"],
                "additionalProperties": true
            }),
            read_only: false,
            destructive: false,
            idempotent: false,
            open_world: false,
        };
        Self { def, engine }
    }
}

#[async_trait]
impl Tool for BrowserCloseTabTool {
    fn def(&self) -> &ToolDef {
        &self.def
    }

    async fn protected_resource_ownership(
        &self,
        adapter_id: &str,
        args: &Value,
    ) -> ProtectedResourceOwnership {
        if adapter_id == "browser_bound_input" {
            browser_resource_ownership(&self.engine, args)
        } else {
            ProtectedResourceOwnership::UserOwned
        }
    }

    async fn protected_resource_scope(
        &self,
        adapter_id: &str,
        args: &Value,
    ) -> Result<Option<Value>, String> {
        if adapter_id == "browser_bound_input" {
            browser_protected_resource_scope(&self.engine, args, "browser_close_tab").await
        } else {
            Ok(None)
        }
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        let (target_id, tab_id) = match (args.require_str("target_id"), args.require_str("tab_id"))
        {
            (Ok(t), Ok(tab)) => (t, tab),
            (Err(e), _) | (_, Err(e)) => return e,
        };
        let session = match require_explicit_session(&args) {
            Ok(s) => s,
            Err(e) => return e,
        };

        let _mutation = match self
            .engine
            .lock_mutation(&session, &target_id, &tab_id)
            .await
        {
            Ok(guard) => guard,
            Err(refusal) => return refusal.to_tool_result(),
        };
        let validated = match self
            .engine
            .revalidate_for_mutation(&session, &target_id, Some(&tab_id))
            .await
        {
            Ok(v) => v,
            Err(refusal) => return refusal.to_tool_result(),
        };
        let pid = validated.record.pid;
        let cdp_target_id = validated.tab.cdp_target_id.clone();
        if !self.engine.store.opened_tab(&session, pid, &cdp_target_id) {
            return BrowserRefusal::new(
                BrowserRefusalCode::BrowserActionUnavailable,
                "browser_close_tab closes only tabs this session opened with browser_open_tab",
            )
            .to_tool_result();
        }

        match validated
            .conn
            .call(
                None,
                "Target.closeTarget",
                json!({ "targetId": cdp_target_id }),
            )
            .await
        {
            Ok(_) => {
                self.engine
                    .store
                    .forget_closed_tab(&session, pid, &cdp_target_id);
                ToolResult::text(format!("closed {tab_id}")).with_structured(json!({
                    "status": "ok",
                    "target_id": target_id,
                    "tab_id": tab_id,
                    "closed": true,
                }))
            }
            Err(error) => ToolResult::error(format!("Target.closeTarget failed: {error}")),
        }
    }
}
