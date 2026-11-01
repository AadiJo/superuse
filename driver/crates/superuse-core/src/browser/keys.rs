//! `browser_press_key`: one key press with modifiers, delivered to an
//! exactly-bound tab through trusted CDP `Input.dispatchKeyEvent` under focus
//! emulation, so it works while the tab or window is in the background.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use crate::protocol::ToolResult;
use crate::tool::{ProtectedResourceOwnership, Tool, ToolDef};
use crate::tool_args::ArgsExt;

use super::engine::BrowserEngine;
use super::platform::BrowserVisualActionKind;
use super::refusal::{BrowserRefusal, BrowserRefusalCode};
use super::session_schema as schema_session;
use super::tools::{
    browser_protected_resource_scope, browser_resource_ownership, enter_focus_emulation,
    quad_center, require_explicit_session, schema_ref, schema_tab_id, schema_target_id,
};

/// Named keys: (DOM `key`, DOM `code`, Windows virtual-key code, text).
const NAMED_KEYS: &[(&str, &str, i64, Option<&str>)] = &[
    ("Enter", "Enter", 13, Some("\r")),
    ("Tab", "Tab", 9, None),
    ("Escape", "Escape", 27, None),
    ("Backspace", "Backspace", 8, None),
    ("Delete", "Delete", 46, None),
    ("Insert", "Insert", 45, None),
    ("Home", "Home", 36, None),
    ("End", "End", 35, None),
    ("PageUp", "PageUp", 33, None),
    ("PageDown", "PageDown", 34, None),
    ("ArrowLeft", "ArrowLeft", 37, None),
    ("ArrowUp", "ArrowUp", 38, None),
    ("ArrowRight", "ArrowRight", 39, None),
    ("ArrowDown", "ArrowDown", 40, None),
    (" ", "Space", 32, Some(" ")),
];

const ALIASES: &[(&str, &str)] = &[
    ("esc", "Escape"),
    ("return", "Enter"),
    ("space", " "),
    ("spacebar", " "),
    ("del", "Delete"),
    ("up", "ArrowUp"),
    ("down", "ArrowDown"),
    ("left", "ArrowLeft"),
    ("right", "ArrowRight"),
    ("pgup", "PageUp"),
    ("pgdn", "PageDown"),
];

/// CDP modifier bits, in the order results report them.
const MODIFIERS: &[(&str, i64)] = &[("alt", 1), ("ctrl", 2), ("meta", 4), ("shift", 8)];

#[derive(Debug, PartialEq)]
struct KeySpec {
    key: String,
    code: String,
    virtual_key: i64,
    text: Option<String>,
}

/// Resolve a key name ("Enter", "ArrowDown", "F5", "a") to its CDP fields.
/// A letter keeps its case, and Shift makes it upper case; text is dropped
/// while Ctrl, Alt or Meta is held, so the press acts as a shortcut.
fn key_spec(name: &str, modifiers: i64) -> Result<KeySpec, String> {
    let lower = name.to_ascii_lowercase();
    let canonical = ALIASES
        .iter()
        .find(|(alias, _)| *alias == lower)
        .map_or(name, |(_, key)| *key);
    let mut spec = if let Some((key, code, virtual_key, text)) = NAMED_KEYS
        .iter()
        .find(|(key, ..)| key.eq_ignore_ascii_case(canonical))
    {
        KeySpec {
            key: (*key).to_owned(),
            code: (*code).to_owned(),
            virtual_key: *virtual_key,
            text: text.map(str::to_owned),
        }
    } else if let Some(n) = lower
        .strip_prefix('f')
        .and_then(|n| n.parse::<i64>().ok())
        .filter(|n| (1..=24).contains(n))
    {
        KeySpec {
            key: format!("F{n}"),
            code: format!("F{n}"),
            virtual_key: 111 + n,
            text: None,
        }
    } else {
        let mut chars = name.chars();
        let (Some(ch), None) = (chars.next(), chars.next()) else {
            return Err(format!(
                "unknown key {name:?}: use a single character or one of Enter, Tab, Escape, \
                 Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowLeft, ArrowUp, \
                 ArrowRight, ArrowDown, Space, F1-F24"
            ));
        };
        if ch.is_ascii_alphabetic() {
            let upper = ch.to_ascii_uppercase();
            let key = if modifiers & 8 != 0 { upper } else { ch };
            KeySpec {
                key: key.to_string(),
                code: format!("Key{upper}"),
                virtual_key: upper as i64,
                text: Some(key.to_string()),
            }
        } else if ch.is_ascii_digit() {
            KeySpec {
                key: ch.to_string(),
                code: format!("Digit{ch}"),
                virtual_key: ch as i64,
                text: Some(ch.to_string()),
            }
        } else {
            KeySpec {
                key: ch.to_string(),
                code: String::new(),
                virtual_key: 0,
                text: Some(ch.to_string()),
            }
        }
    };
    if modifiers & (1 | 2 | 4) != 0 {
        spec.text = None;
    }
    Ok(spec)
}

/// Parse `modifiers` into the CDP bit mask and their canonical names.
fn parse_modifiers(args: &Value) -> Result<(i64, Vec<&'static str>), String> {
    let Some(values) = args.get("modifiers") else {
        return Ok((0, Vec::new()));
    };
    let values = values
        .as_array()
        .ok_or_else(|| "modifiers must be an array of strings".to_owned())?;
    let mut mask = 0;
    for value in values {
        let name = value
            .as_str()
            .ok_or_else(|| "modifiers must be an array of strings".to_owned())?
            .to_ascii_lowercase();
        let canonical = match name.as_str() {
            "control" => "ctrl",
            "cmd" | "command" | "win" | "super" => "meta",
            "option" => "alt",
            other => other,
        };
        let (_, bit) = MODIFIERS
            .iter()
            .find(|(modifier, _)| *modifier == canonical)
            .ok_or_else(|| format!("unknown modifier {name:?}: use alt, ctrl, meta or shift"))?;
        mask |= bit;
    }
    let names = MODIFIERS
        .iter()
        .filter(|(_, bit)| mask & bit != 0)
        .map(|(name, _)| *name)
        .collect();
    Ok((mask, names))
}

fn key_event(kind: &str, spec: &KeySpec, modifiers: i64) -> Value {
    let mut event = Map::new();
    event.insert("type".into(), json!(kind));
    event.insert("key".into(), json!(spec.key));
    if !spec.code.is_empty() {
        event.insert("code".into(), json!(spec.code));
    }
    if spec.virtual_key != 0 {
        event.insert("windowsVirtualKeyCode".into(), json!(spec.virtual_key));
        event.insert("nativeVirtualKeyCode".into(), json!(spec.virtual_key));
    }
    event.insert("modifiers".into(), json!(modifiers));
    if kind == "keyDown" {
        if let Some(text) = &spec.text {
            event.insert("text".into(), json!(text));
            event.insert("unmodifiedText".into(), json!(text));
        }
    }
    Value::Object(event)
}

pub struct BrowserPressKeyTool {
    def: ToolDef,
    engine: Arc<BrowserEngine>,
}

impl BrowserPressKeyTool {
    pub fn new(engine: Arc<BrowserEngine>) -> Self {
        let def = ToolDef {
            name: "browser_press_key".into(),
            description: "Press one key, optionally with modifiers, in an exactly-bound \
                tab: Enter, Tab, Escape, arrows, Backspace, Delete, Home/End, PageUp/PageDown, \
                F1-F24, Space, or a single character (\"a\" with modifiers [\"ctrl\"] selects \
                all). Trusted CDP key events under focus emulation, so it works while the \
                tab or window is in the background and never activates it. With ref, \
                that element is focused first; without it, the key goes to the page's \
                focused element."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "target_id": schema_target_id(),
                    "tab_id": schema_tab_id(),
                    "session": schema_session(),
                    "key": { "type": "string", "description": "Key name (Enter, Tab, Escape, ArrowDown, F5, ...) or one character." },
                    "modifiers": {
                        "type": "array",
                        "items": { "type": "string", "enum": ["alt", "ctrl", "meta", "shift"] },
                        "description": "Modifiers held during the press."
                    },
                    "ref": schema_ref(),
                },
                "required": ["target_id", "tab_id", "key"],
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
impl Tool for BrowserPressKeyTool {
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
            browser_protected_resource_scope(&self.engine, args, "browser_press_key").await
        } else {
            Ok(None)
        }
    }

    async fn invoke(&self, args: Value) -> ToolResult {
        let (target_id, tab_id, key_name) = match (
            args.require_str("target_id"),
            args.require_str("tab_id"),
            args.require_str("key"),
        ) {
            (Ok(t), Ok(tab), Ok(key)) => (t, tab, key),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
        };
        let session = match require_explicit_session(&args) {
            Ok(s) => s,
            Err(e) => return e,
        };
        let (modifiers, modifier_names) = match parse_modifiers(&args) {
            Ok(parsed) => parsed,
            Err(e) => return ToolResult::error(e),
        };
        let spec = match key_spec(&key_name, modifiers) {
            Ok(spec) => spec,
            Err(e) => return ToolResult::error(e),
        };
        let ext_ref = args.opt_str("ref");

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
        let conn = &validated.conn;

        // Focus: the ref's element (in its own frame session), or whatever the
        // page already has focused.
        let (cdp_session, frame_kind) = match &ext_ref {
            Some(r) => {
                let entry = match self
                    .engine
                    .store
                    .resolve_ref(&session, &target_id, &tab_id, r)
                {
                    Ok(entry) => entry,
                    Err(refusal) => return refusal.to_tool_result(),
                };
                if entry.semantic && entry.actions.is_empty() {
                    return BrowserRefusal::new(
                        BrowserRefusalCode::BrowserActionUnavailable,
                        format!("semantic ref {r} declares no action, so it can't take keys"),
                    )
                    .to_tool_result();
                }
                let cdp = match self
                    .engine
                    .frame_session_for_mutation(
                        &session,
                        &target_id,
                        &tab_id,
                        &validated,
                        &entry.frame,
                    )
                    .await
                {
                    Ok(s) => s,
                    Err(refusal) => return refusal.to_tool_result(),
                };
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
                                BrowserVisualActionKind::Type,
                            )
                            .await;
                    }
                }
                if let Err(detail) =
                    enter_focus_emulation(conn, &cdp, entry.backend_node_id, &object_id).await
                {
                    return BrowserRefusal::new(
                        BrowserRefusalCode::BrowserInputTrustUnavailable,
                        format!("the ref could not take keyboard focus: {detail}"),
                    )
                    .to_tool_result();
                }
                (cdp, Some(entry.frame.kind.as_str()))
            }
            None => {
                let cdp = validated.cdp_session.clone();
                if let Err(error) = conn
                    .call(
                        Some(&cdp),
                        "Emulation.setFocusEmulationEnabled",
                        json!({ "enabled": true }),
                    )
                    .await
                {
                    return BrowserRefusal::new(
                        BrowserRefusalCode::BrowserInputTrustUnavailable,
                        format!("the tab could not enter CDP focus emulation: {error}"),
                    )
                    .to_tool_result();
                }
                for _ in 0..20 {
                    let focused = conn
                        .call(
                            Some(&cdp),
                            "Runtime.evaluate",
                            json!({ "expression": "document.hasFocus()", "returnByValue": true }),
                        )
                        .await
                        .ok()
                        .and_then(|result| {
                            result.pointer("/result/value").and_then(Value::as_bool)
                        });
                    if focused == Some(true) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                (cdp, None)
            }
        };

        let down_kind = if spec.text.is_some() {
            "keyDown"
        } else {
            "rawKeyDown"
        };
        let mut delivery = conn
            .call(
                Some(&cdp_session),
                "Input.dispatchKeyEvent",
                key_event(down_kind, &spec, modifiers),
            )
            .await
            .map(|_| ());
        if delivery.is_ok() {
            delivery = conn
                .call(
                    Some(&cdp_session),
                    "Input.dispatchKeyEvent",
                    key_event("keyUp", &spec, modifiers),
                )
                .await
                .map(|_| ());
        }
        let cleanup = conn
            .call(
                Some(&cdp_session),
                "Emulation.setFocusEmulationEnabled",
                json!({ "enabled": false }),
            )
            .await;
        if let Err(error) = delivery.and(cleanup.map(|_| ())) {
            return BrowserRefusal::new(
                BrowserRefusalCode::BrowserInputIncomplete,
                format!("the key press was not fully delivered: {error}"),
            )
            .with_detail(json!({ "retryable": false }))
            .to_tool_result();
        }

        let key_label = if spec.key == " " {
            "Space"
        } else {
            spec.key.as_str()
        };
        let chord = modifier_names
            .iter()
            .copied()
            .chain(std::iter::once(key_label))
            .collect::<Vec<_>>()
            .join("+");
        ToolResult::text(format!("pressed {chord} in {tab_id}")).with_structured(json!({
            "status": "ok",
            "target_id": target_id,
            "tab_id": tab_id,
            "key": spec.key,
            "modifiers": modifier_names,
            "ref": ext_ref,
            "frame": frame_kind,
        }))
    }
}
