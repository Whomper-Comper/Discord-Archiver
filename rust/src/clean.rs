use crate::model::Message;
use regex::{Captures, Regex};
use serde_json::Value;
use std::sync::LazyLock;
use unicode_segmentation::UnicodeSegmentation;

static CUSTOM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<a?:[a-zA-Z0-9_]+:\d+>").unwrap());
static SHORTCODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":([a-zA-Z0-9_+\-]+):").unwrap());
static MARKDOWN_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[[^\]\n]*\]\((https?://[^\s)]+)\)").unwrap());
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s<>()]+").unwrap());

pub fn is_image_url(url: &str) -> bool {
    let base = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches([',', '.', ';', '!', '"', '\''])
        .to_ascii_lowercase();
    [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".tiff", ".tif", ".ico",
        ".heic",
    ]
    .iter()
    .any(|extension| base.ends_with(extension))
        || (base.contains("cdn.discordapp.com/emojis/")
            || base.contains("media.discordapp.net/emojis/"))
}

pub fn clean_text(text: &str) -> String {
    let custom = CUSTOM.replace_all(text, "");
    let shortcodes = SHORTCODE.replace_all(&custom, |caps: &Captures<'_>| {
        if emojis::get_by_shortcode(&caps[1]).is_some() {
            String::new()
        } else {
            caps[0].to_owned()
        }
    });
    let links = MARKDOWN_LINK.replace_all(&shortcodes, |caps: &Captures<'_>| {
        if caps[0].starts_with('!') || is_image_url(&caps[1]) {
            String::new()
        } else {
            caps[0].to_owned()
        }
    });
    let urls = URL.replace_all(&links, |caps: &Captures<'_>| {
        if is_image_url(&caps[0]) {
            String::new()
        } else {
            caps[0].to_owned()
        }
    });
    urls.graphemes(true)
        .filter(|g| {
            // Bare copyright/trademark symbols commonly occur as ordinary text.
            matches!(*g, "©" | "®" | "™") || emojis::get(g).is_none()
        })
        .collect()
}

fn clean_with_labels(text: &str, labels: &[String]) -> String {
    let mut text = text.to_owned();
    for label in labels {
        text = text.replace(label, "");
    }
    clean_text(&text)
}

fn clean_value(value: &mut Value, labels: &[String]) {
    match value {
        Value::String(s) => *s = clean_with_labels(s, labels),
        Value::Array(values) => values.iter_mut().for_each(|v| clean_value(v, labels)),
        Value::Object(map) => {
            map.retain(|key, _| {
                !matches!(
                    key.as_str(),
                    "image" | "thumbnail" | "icon_url" | "proxy_icon_url" | "avatar" | "avatar_url"
                )
            });
            for child in map.values_mut() {
                clean_value(child, labels);
            }
        }
        _ => {}
    }
}

pub fn clean_message(message: &Message) -> Message {
    let mut message = message.clone();
    message.content = clean_with_labels(&message.content, &message.custom_emoji_labels);
    message.author.avatar_url = None;
    if let Some(reply) = &mut message.reply {
        if let Some(text) = &mut reply.content {
            *text = clean_with_labels(text, &message.custom_emoji_labels);
        }
        if let Some(author) = &mut reply.author {
            author.avatar_url = None;
        }
    }
    message.attachments.retain(|a| {
        a["kind"] != "image"
            && !a["content_type"]
                .as_str()
                .is_some_and(|s| s.starts_with("image/"))
            && !a["url"].as_str().is_some_and(is_image_url)
    });
    for embed in &mut message.embeds {
        clean_value(embed, &message.custom_emoji_labels);
    }
    message.reactions.clear();
    message.custom_emoji_labels.clear();
    message
}
