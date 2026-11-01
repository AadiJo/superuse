//! `browser_select`: choose an option of a native `<select>` in an
//! exactly-bound tab, in the background.
//!
//! A closed `<select>` renders its options in a browser-owned popup, so option
//! refs have no layout box and a trusted click can't reach them. This sets the
//! option the way Playwright's `selectOption` does: mark it selected, then fire
//! the `input` and `change` events a user's choice fires. The events are
//! untrusted (`isTrusted` is false) and the result says so. It needs only
//! `DOM.resolveNode` and `Runtime.callFunctionOn`, both inside the
//! existing-profile CDP method policy, and never `Runtime.enable`.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::protocol::ToolResult;
use crate::tool::{ProtectedResourceOwnership, Tool, ToolDef};
use crate::tool_args::ArgsExt;

use super::engine::BrowserEngine;
use super::platform::BrowserVisualActionKind;
use super::refusal::{BrowserRefusal, BrowserRefusalCode};
use super::session_schema as schema_session;
use super::store::BrowserActionKind;
use super::tools::{
    browser_protected_resource_scope, browser_resource_ownership, quad_center,
    require_explicit_session, schema_tab_id, schema_target_id,
};

// `this` is the ref's node: a <select>, or an <option> of one. `wanted` is the
// option's value or visible label, or null to choose the referenced option.
const SELECT_OPTION: &str = "function(wanted) { \
    const select = (this instanceof HTMLOptionElement) ? this.closest('select') : this; \
    if (!(select instanceof HTMLSelectElement)) return { error: 'not_select' }; \
    if (select.disabled) return { error: 'disabled' }; \
    const options = Array.from(select.options); \
    const norm = (s) => String(s).replace(/\\s+/g, ' ').trim(); \
    let match = null; \
    if (wanted === null) { \
        if (!(this instanceof HTMLOptionElement)) return { error: 'option_required' }; \
        match = this; \
    } else { \
        match = options.find((o) => o.value === wanted) \
            || options.find((o) => norm(o.label) === norm(wanted)) \
            || options.find((o) => norm(o.label).toLowerCase() === norm(wanted).toLowerCase()) \
            || null; \
    } \
    if (!match) return { error: 'not_found', options: options.slice(0, 50).map((o) => o.label) }; \
    const group = match.parentElement; \
    if (match.disabled || (group instanceof HTMLOptGroupElement && group.disabled)) \
        return { error: 'option_disabled' }; \
    const before = select.value; \
    if (select.multiple) { for (const o of options) o.selected = (o === match); } \
    else { match.selected = true; } \
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true })); \
    select.dispatchEvent(new Event('change', { bubbles: true })); \
    return { value: select.value, label: match.label, index: match.index, \
        changed: before !== select.value }; \
}";

pub struct BrowserSelectTool {
    def: ToolDef,
    engine: Arc<BrowserEngine>,
}

impl BrowserSelectTool {
    pub fn new(engine: Arc<BrowserEngine>) -> Self {
        let def = ToolDef {
            name: "browser_select".into(),
            description: "Choose an option of a native <select> in an exactly-bound tab, in \
                the background. ref is the select (refs that declare \"select\"), with \
                option naming the choice by value or visible label; or ref is one of its \
                options, with option omitted. Marks the option selected and fires the \
                input and change events a user's choice fires; the events are synthetic \
                (isTrusted false). Returns the select's new value."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "target_id": schema_target_id(),
                    "tab_id": schema_tab_id(),
                    "session": schema_session(),
                    "ref": {
                        "type": "string",
                        "description": "Ref of the <select>, or of one of its options, from get_browser_state."
                    },
                    "option": {
                        "type": "string",
                        "description": "Option value, else visible label (whitespace-normalized, then case-insensitive). Required when ref is the select."
                    },
                },
                "required": ["target_id", "tab_id", "ref"],
                "additionalProperties": true
            }),
            read_only: false,
            destructive: false,
            idempotent: true,
            open_world: true,
        };
        Self { def, engine }
    }
}

#[async_trait]
impl Tool for BrowserSelectTool {
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
            browser_protected_resource_scope(&self.engine, args, "browser_select").await
        } else {
            Ok(None)
        }
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        let (target_id, tab_id, ext_ref) = match (
            args.require_str("target_id"),
            args.require_str("tab_id"),
            args.require_str("ref"),
        ) {
            (Ok(t), Ok(tab), Ok(r)) => (t, tab, r),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
        };
        let session = match require_explicit_session(&args) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let wanted = args.opt_str("option");

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
        let entry = match self
            .engine
            .store
            .resolve_ref(&session, &target_id, &tab_id, &ext_ref)
        {
            Ok(entry) => entry,
            Err(refusal) => return refusal.to_tool_result(),
        };
        if entry.semantic && !entry.actions.contains(&BrowserActionKind::Select) {
            return BrowserRefusal::new(
                BrowserRefusalCode::BrowserActionUnavailable,
                format!("semantic ref {ext_ref} is not a <select> or one of its options"),
            )
            .to_tool_result();
        }
        let cdp = match self
            .engine
            .frame_session_for_mutation(&session, &target_id, &tab_id, &validated, &entry.frame)
            .await
        {
            Ok(s) => s,
            Err(refusal) => return refusal.to_tool_result(),
        };
        let conn = &validated.conn;
        let object_id = conn
            .call(
                Some(&cdp),
                "DOM.resolveNode",
                json!({ "backendNodeId": entry.backend_node_id }),
            )
            .await
            .ok()
            .and_then(|resolved| {
                resolved
                    .pointer("/object/objectId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let Some(object_id) = object_id else {
            return BrowserRefusal::new(
                BrowserRefusalCode::BrowserRefStale,
                "the ref's node no longer resolves in the live page",
            )
            .to_tool_result();
        };

        // A closed select's options have no box; the select itself usually does.
        if let Ok(box_model) = conn
            .call(
                Some(&cdp),
                "DOM.getBoxModel",
                json!({ "backendNodeId": entry.backend_node_id }),
            )
            .await
        {
            if let Some((x, y)) = quad_center(&box_model) {
                self.engine
                    .visualize_browser_action(
                        &session,
                        &validated,
                        &cdp,
                        x,
                        y,
                        BrowserVisualActionKind::Click,
                    )
                    .await;
            }
        }

        let outcome = match conn
            .call(
                Some(&cdp),
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "functionDeclaration": SELECT_OPTION,
                    "arguments": [{ "value": wanted }],
                    "returnByValue": true,
                }),
            )
            .await
        {
            Ok(result) => result
                .pointer("/result/value")
                .cloned()
                .unwrap_or(Value::Null),
            Err(error) => {
                return ToolResult::error(format!("selecting the option failed: {error}"))
            }
        };
        if let Some(error) = outcome.get("error").and_then(Value::as_str) {
            if error == "option_required" {
                return ToolResult::error(
                    "ref is the <select> itself: pass option with the value or label to choose",
                );
            }
            let message = match error {
                "not_select" => "the ref is not a <select> or one of its options",
                "disabled" => "the <select> is disabled",
                "option_disabled" => "that option is disabled",
                _ => "no option of the <select> has that value or label",
            };
            return BrowserRefusal::new(BrowserRefusalCode::BrowserActionUnavailable, message)
                .with_detail(json!({ "options": outcome.get("options") }))
                .to_tool_result();
        }

        let value = outcome.get("value").cloned().unwrap_or(Value::Null);
        let label = outcome.get("label").cloned().unwrap_or(Value::Null);
        ToolResult::text(format!(
            "selected {} in {tab_id}; value is now {}",
            label.as_str().unwrap_or("?"),
            value
        ))
        .with_structured(json!({
            "status": "ok",
            "route": "dom_event",
            "target_id": target_id,
            "tab_id": tab_id,
            "ref": ext_ref,
            "frame": entry.frame.kind.as_str(),
            "value": value,
            "label": label,
            "index": outcome.get("index"),
            "changed": outcome.get("changed"),
            "events_trusted": false,
        }))
    }
}
