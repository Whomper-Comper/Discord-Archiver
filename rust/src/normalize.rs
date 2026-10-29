use crate::{RECORD_LIMIT, model::*};
use serde_json::Value;
use wasm_bindgen::prelude::*;
pub(crate) fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn list(v: &Value, key: &str) -> Vec<Value> {
    v.get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
fn author(v: &Value) -> Author {
    let id = text(v, "id");
    let username = text(v, "username");
    Author {
        id: id.clone(),
        username: username.clone(),
        display_name: text(v, "display_name")
            .or_else(|| text(v, "global_name"))
            .or(username)
            .unwrap_or_else(|| "Unknown".into()),
        avatar_url: text(v, "avatar_url").or_else(|| {
            id.zip(text(v, "avatar"))
                .map(|(id, hash)| format!("https://cdn.discordapp.com/avatars/{id}/{hash}.png"))
        }),
        bot: v.get("bot").and_then(Value::as_bool),
    }
}
fn validate_fields(v: &Value, path: &str) -> Result<(), String> {
    if !v.is_object() {
        return Err("Message must be an object".into());
    }
    for k in [
        "id",
        "channel_id",
        "content",
        "timestamp",
        "timestamp_display",
        "edited_timestamp",
        "username",
        "global_name",
        "display_name",
        "avatar",
        "avatar_url",
        "message_id",
        "guild_id",
        "url",
        "filename",
        "content_type",
        "title",
        "description",
    ] {
        if v.get(k).is_some_and(|x| !x.is_null() && !x.is_string()) {
            return Err(format!("{path}.{k} must be a string or null"));
        }
    }
    for k in ["attachments", "embeds", "mentions", "reactions"] {
        if let Some(values) = v.get(k) {
            let values = values
                .as_array()
                .ok_or_else(|| format!("{path}.{k} must be an array"))?;
            for (i, child) in values.iter().enumerate() {
                validate_fields(child, &format!("{path}.{k}[{i}]"))?;
            }
        }
    }
    for key in [
        "author",
        "message_reference",
        "referenced_message",
        "image",
        "thumbnail",
        "video",
        "provider",
        "footer",
        "emoji",
    ] {
        if let Some(child) = v.get(key).filter(|v| !v.is_null()) {
            validate_fields(child, &format!("{path}.{key}"))?;
        }
    }
    if v.get("bot")
        .is_some_and(|v| !v.is_null() && !v.is_boolean())
    {
        return Err(format!("{path}.bot must be a boolean"));
    }
    if let Some(labels) = v.get("custom_emoji_labels")
        && !labels
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
    {
        return Err(format!(
            "{path}.custom_emoji_labels must be an array of strings"
        ));
    }
    Ok(())
}
pub(crate) fn message(
    v: Value,
    ch: &Channel,
    file: &str,
    index: usize,
    fidelity: &str,
) -> Result<Message, String> {
    if let Some(s) = v.as_str() {
        return Ok(Message {
            id: None,
            channel_id: ch.id.clone(),
            author: author(&Value::Null),
            timestamp: None,
            timestamp_display: None,
            edited_timestamp: None,
            content: s.into(),
            reply: None,
            attachments: vec![],
            embeds: vec![],
            mentions: vec![],
            reactions: vec![],
            custom_emoji_labels: vec![],
            source: MessageSource {
                file: file.into(),
                index,
                fidelity: fidelity.into(),
            },
        });
    }
    if v.get("source").is_some() && v["author"].get("display_name").is_some() {
        for key in ["attachments", "embeds", "mentions", "reactions"] {
            if !v
                .get(key)
                .and_then(Value::as_array)
                .is_some_and(|a| a.iter().all(Value::is_object))
            {
                return Err(format!("{key} must be an array of objects"));
            }
        }
        return serde_json::from_value(v).map_err(|e| format!("Invalid normalized record: {e}"));
    }
    validate_fields(&v, "message")?;
    if !v.get("author").is_some_and(Value::is_object)
        || !v.get("content").is_some_and(Value::is_string)
    {
        return Err("API message requires an author object and string content".into());
    }
    let reference = v.get("message_reference").filter(|x| x.is_object());
    let referenced = v.get("referenced_message").filter(|x| x.is_object());
    let reply = if let Some(r) = v.get("reply").filter(|r| !r.is_null()) {
        Some(serde_json::from_value(r.clone()).map_err(|e| format!("Invalid reply: {e}"))?)
    } else {
        (reference.is_some() || referenced.is_some()).then(|| Reply {
            message_id: reference
                .and_then(|r| text(r, "message_id"))
                .or_else(|| referenced.and_then(|r| text(r, "id"))),
            channel_id: reference.and_then(|r| text(r, "channel_id")),
            author: referenced.and_then(|r| r.get("author")).map(author),
            content: referenced.and_then(|r| text(r, "content")),
            unavailable: referenced.is_none(),
            truncated: false,
        })
    };
    Ok(Message {
        id: text(&v, "id"),
        channel_id: text(&v, "channel_id").or_else(|| ch.id.clone()),
        author: author(&v["author"]),
        timestamp: text(&v, "timestamp"),
        timestamp_display: text(&v, "timestamp_display"),
        edited_timestamp: text(&v, "edited_timestamp"),
        content: text(&v, "content").unwrap_or_default(),
        reply,
        attachments: list(&v, "attachments"),
        embeds: list(&v, "embeds"),
        mentions: list(&v, "mentions"),
        reactions: list(&v, "reactions"),
        custom_emoji_labels: v
            .get("custom_emoji_labels")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        source: MessageSource {
            file: file.into(),
            index,
            fidelity: fidelity.into(),
        },
    })
}
#[wasm_bindgen]
pub fn normalize_batch(raw_json: &str, channel_json: &str) -> Result<String, String> {
    let ch: Channel = serde_json::from_str(channel_json).map_err(|e| e.to_string())?;
    let v: Vec<Value> = serde_json::from_str(raw_json).map_err(|e| e.to_string())?;
    let file: Value = serde_json::from_str(channel_json).map_err(|e| e.to_string())?;
    let out: Result<Vec<_>, _> = v
        .into_iter()
        .enumerate()
        .map(|(i, v)| {
            if v.to_string().len() > RECORD_LIMIT {
                return Err("Message exceeds 16 MiB".into());
            }
            message(
                v,
                &ch,
                file["source"].as_str().unwrap_or("capture"),
                i + 1,
                "api",
            )
        })
        .collect();
    serde_json::to_string(&out?).map_err(|e| e.to_string())
}
