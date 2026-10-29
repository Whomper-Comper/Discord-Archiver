use crate::model::*;
use serde_json::{Map, Value, json};

pub fn legend() -> Value {
    json!({"i":"message ID (string)","h":"channel ID when different from document channel","a":"author tuple [ID or null,display name,username if saved]","t":"ISO timestamp, or saved display timestamp if ISO unavailable","c":"message content, preserving case and line breaks","r":"reply: i=target ID,h=channel,a=author tuple,c=saved preview,u=unavailable,x=truncated","m":"optional media: a=attachments,e=embeds","fidelity":"Compact records preserve content, identity and reply relationships. Use full format for reactions, mentions, edited timestamps and other original fields."})
}
pub fn tuple(a: &Author) -> Value {
    let mut v = vec![json!(a.id), json!(a.display_name)];
    if let Some(u) = a.username.as_ref().filter(|s| !s.is_empty()) {
        v.push(json!(u));
    }
    json!(v)
}
fn put(m: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(s) = value.as_ref().filter(|s| !s.is_empty()) {
        m.insert(key.into(), json!(s));
    }
}
pub fn encode(m: &Message, channel: Option<&str>, reply_text: bool) -> Value {
    let mut v = Map::new();
    put(&mut v, "i", &m.id);
    v.insert("a".into(), tuple(&m.author));
    v.insert("c".into(), json!(m.content));
    if m.channel_id.as_deref() != channel {
        put(&mut v, "h", &m.channel_id)
    }
    put(
        &mut v,
        "t",
        &m.timestamp.clone().or(m.timestamp_display.clone()),
    );
    if let Some(r) = &m.reply {
        let mut o = Map::new();
        put(&mut o, "i", &r.message_id);
        put(&mut o, "h", &r.channel_id);
        if let Some(a) = &r.author {
            o.insert("a".into(), tuple(a));
        }
        if reply_text || r.message_id.as_ref().is_none_or(|id| id.is_empty()) {
            put(&mut o, "c", &r.content)
        }
        if r.unavailable {
            o.insert("u".into(), json!(true));
        }
        if r.truncated {
            o.insert("x".into(), json!(true));
        }
        if !o.is_empty() {
            v.insert("r".into(), Value::Object(o));
        }
    }
    let mut media = Map::new();
    if !m.attachments.is_empty() {
        media.insert("a".into(), json!(m.attachments));
    }
    if !m.embeds.is_empty() {
        media.insert("e".into(), json!(m.embeds));
    }
    if !media.is_empty() {
        v.insert("m".into(), Value::Object(media));
    }
    Value::Object(v)
}
fn string(v: &Value, key: &str) -> Result<Option<String>, String> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(format!("Compact {key} must be a string")),
    }
}
fn boolean(v: &Value, key: &str) -> Result<bool, String> {
    match v.get(key) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(format!("Compact {key} must be a boolean")),
    }
}
fn author(v: &Value) -> Result<Author, String> {
    let a = v.as_array().ok_or("Compact author must be a tuple")?;
    if a.len() < 2
        || a.len() > 3
        || !a[1].is_string()
        || (!a[0].is_null() && !a[0].is_string())
        || a.get(2).is_some_and(|v| !v.is_string())
    {
        return Err("Invalid compact author tuple".into());
    }
    Ok(Author {
        id: a[0].as_str().map(str::to_owned),
        display_name: a[1].as_str().unwrap().into(),
        username: a.get(2).and_then(Value::as_str).map(str::to_owned),
        avatar_url: None,
        bot: None,
    })
}
fn media(v: &Value, key: &str) -> Result<Vec<Value>, String> {
    match v.get(key) {
        None => Ok(vec![]),
        Some(Value::Array(a)) if a.iter().all(Value::is_object) => Ok(a.clone()),
        _ => Err("Compact media must contain arrays of objects".into()),
    }
}
pub fn decode(v: Value, ch: &Channel, file: &str, index: usize) -> Result<Message, String> {
    if !v.is_object() {
        return Err("Compact message must be an object".into());
    }
    let content = v
        .get("c")
        .and_then(Value::as_str)
        .ok_or("Compact message requires string c")?
        .into();
    let author = author(v.get("a").ok_or("Compact message requires author a")?)?;
    let t = string(&v, "t")?;
    let iso = t
        .as_ref()
        .is_some_and(|t| t.len() >= 11 && t.as_bytes().get(4) == Some(&b'-') && t.contains('T'));
    let reply = match v.get("r") {
        None => None,
        Some(r) if r.is_object() => Some(Reply {
            message_id: string(r, "i")?,
            channel_id: string(r, "h")?,
            author: r.get("a").map(self::author).transpose()?,
            content: string(r, "c")?,
            unavailable: boolean(r, "u")?,
            truncated: boolean(r, "x")?,
        }),
        _ => return Err("Compact reply must be an object".into()),
    };
    let media_value = v.get("m").cloned().unwrap_or(json!({}));
    if !media_value.is_object() {
        return Err("Compact media must be an object".into());
    }
    Ok(Message {
        id: string(&v, "i")?,
        channel_id: string(&v, "h")?.or(ch.id.clone()),
        author,
        timestamp: if iso { t.clone() } else { None },
        timestamp_display: if iso { None } else { t },
        edited_timestamp: None,
        content,
        reply,
        attachments: media(&media_value, "a")?,
        embeds: media(&media_value, "e")?,
        mentions: vec![],
        reactions: vec![],
        custom_emoji_labels: vec![],
        source: MessageSource {
            file: file.into(),
            index,
            fidelity: "compact".into(),
        },
    })
}
