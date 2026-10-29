use crate::model::*;
use anyhow::{Context, Result, bail};
use scraper::{ElementRef, Html, Node, Selector};
use serde_json::{Value, json};
fn selector(css: &str) -> Selector {
    Selector::parse(css).expect("internal CSS selector")
}

fn first<'a>(element: ElementRef<'a>, css: &str) -> Option<ElementRef<'a>> {
    element.select(&selector(css)).next()
}

// Only called for one already bounded legacy message container. Grouping and
// date state live in the outer streaming scanner rather than a document DOM.
pub fn parse_row(fragment: &str, source: &str) -> Result<(Archive, bool)> {
    let document = Html::parse_fragment(fragment);
    let has_author_header = document
        .select(&selector(".chatlog__message-container .chatlog__author"))
        .next()
        .is_some();
    Ok((parse_legacy(&document, source)?, has_author_header))
}
// Recover visible text without including headers, reply previews, or media labels
// in the message body. Never use the lowercased data-content search attribute.
fn render_text(element: ElementRef<'_>, body: bool) -> String {
    fn walk(element: ElementRef<'_>, body: bool, output: &mut String) {
        let value = element.value();
        let classes = |name: &str| value.has_class(name, scraper::CaseSensitivity::CaseSensitive);
        if matches!(value.name(), "script" | "style" | "video" | "audio") {
            return;
        }
        if body
            && [
                "chatlog__author",
                "chatlog__timestamp",
                "reply-context",
                "reply-author",
                "embed",
                "chatlog__attachment-link",
            ]
            .iter()
            .any(|c| classes(c))
        {
            return;
        }
        if value.name() == "img" {
            if classes("custom-emoji") {
                output.push_str(value.attr("alt").unwrap_or(""));
            }
            return;
        }
        if value.name() == "br" {
            output.push('\n');
            return;
        }
        let block = matches!(value.name(), "pre" | "p" | "li") || classes("blockquote");
        if block && !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        for node in element.children() {
            if let Node::Text(text) = node.value() {
                output.push_str(text);
            } else if let Some(child) = ElementRef::wrap(node) {
                walk(child, body, output);
            }
        }
        if block && !output.ends_with('\n') {
            output.push('\n');
        }
    }
    let mut output = String::new();
    walk(element, body, &mut output);
    output.trim_matches(['\n', '\r']).to_owned()
}

fn parse_legacy(document: &Html, source: &str) -> Result<Archive> {
    let has_chatlog = document.select(&selector(".chatlog")).next().is_some();
    let mut messages = Vec::new();
    let mut previous_author: Option<Author> = None;
    let mut date = String::new();
    let mut missing_author = false;
    for row in document.select(&selector(".date-separator, .chatlog__message-container")) {
        if row
            .value()
            .has_class("date-separator", scraper::CaseSensitivity::CaseSensitive)
        {
            date = render_text(row, false);
            continue;
        }
        let cells: Vec<_> = row.children().filter_map(ElementRef::wrap).collect();
        let body = cells
            .get(1)
            .copied()
            .context("Legacy message has no body cell")?;
        let current_author = first(body, ".chatlog__author")
            .map(|name| {
                let avatar_url = first(row, ".chatlog__avatar")
                    .and_then(|a| a.value().attr("src"))
                    .map(str::to_owned);
                let id = avatar_url
                    .as_ref()
                    .and_then(|url| url.split("/avatars/").nth(1))
                    .and_then(|tail| tail.split('/').next())
                    .filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
                    // Default avatar URLs end in 0.png rather than an ID/path pair.
                    .map(str::to_owned);
                Author {
                    id,
                    username: None,
                    display_name: render_text(name, false),
                    avatar_url,
                    bot: None,
                }
            })
            .or_else(|| previous_author.clone())
            .unwrap_or_else(|| {
                missing_author = true;
                Author {
                    display_name: "Unknown".into(),
                    ..Default::default()
                }
            });
        let timestamp_display = if let Some(time) = first(body, ".chatlog__timestamp") {
            Some(render_text(time, false))
        } else {
            cells.first().map(|cell| {
                format!("{} {}", date, render_text(*cell, false))
                    .trim()
                    .to_owned()
            })
        };
        let reply = first(body, ".reply-context").map(|context| {
            let reply_author = first(context, ".reply-author").map(|a| Author {
                display_name: render_text(a, false)
                    .trim_start_matches(['↪', ' '])
                    .to_owned(),
                ..Default::default()
            });
            let mut content = String::new();
            for child in context.children() {
                if let Node::Text(text) = child.value() {
                    content.push_str(text);
                } else if let Some(element) = ElementRef::wrap(child)
                    && !element
                        .value()
                        .has_class("reply-author", scraper::CaseSensitivity::CaseSensitive)
                {
                    content.push_str(&render_text(element, false));
                }
            }
            Reply {
                message_id: None,
                channel_id: None,
                author: reply_author,
                content: Some(content),
                unavailable: false,
                truncated: true,
            }
        });
        let mut attachments = Vec::new();
        for media in body.select(&selector(
            ".chatlog__attachment-img, .chatlog__attachment-link, video, audio",
        )) {
            let v = media.value();
            let url = v.attr("src").or_else(|| v.attr("href")).unwrap_or("");
            let kind = match v.name() {
                "img" => "image",
                "video" => "video",
                "audio" => "audio",
                _ => "file",
            };
            let filename = v.attr("alt").map(str::to_owned).or_else(|| {
                (v.name() == "a").then(|| {
                    render_text(media, false)
                        .trim_start_matches(['📎', ' '])
                        .to_owned()
                })
            });
            attachments.push(json!({"url":url,"filename":filename,"kind":kind}));
        }
        let mut embeds = Vec::new();
        for embed in body.select(&selector(".embed")) {
            let mut fields = serde_json::Map::new();
            for (class, key) in [
                (".embed-provider", "provider"),
                (".embed-author", "author"),
                (".embed-title", "title"),
                (".embed-description", "description"),
                (".embed-footer", "footer"),
            ] {
                if let Some(element) = first(embed, class) {
                    fields.insert(key.into(), json!(render_text(element, false)));
                    if key == "title"
                        && let Some(url) = element.value().attr("href")
                    {
                        fields.insert("url".into(), json!(url));
                    }
                }
            }
            for (class, key) in [(".embed-image", "image"), (".embed-thumbnail", "thumbnail")] {
                if let Some(url) = first(embed, class).and_then(|e| e.value().attr("src")) {
                    fields.insert(key.into(), json!({"url":url}));
                }
            }
            embeds.push(Value::Object(fields));
        }
        let custom_emoji_labels = body
            .select(&selector("img.custom-emoji"))
            .filter_map(|e| e.value().attr("alt"))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        previous_author = Some(current_author.clone());
        messages.push(Message {
            id: None,
            channel_id: None,
            author: current_author,
            timestamp: None,
            timestamp_display,
            edited_timestamp: None,
            content: render_text(body, true),
            reply,
            attachments,
            embeds,
            mentions: vec![],
            reactions: vec![],
            custom_emoji_labels,
            source: MessageSource {
                file: source.into(),
                index: messages.len() + 1,
                fidelity: "legacy_html".into(),
            },
        });
    }
    if !has_chatlog && messages.is_empty() {
        bail!("This HTML is not a recognized Discord Archiver export");
    }
    let mut warnings = vec![
        "Legacy HTML: original Markdown, message IDs, reply target IDs, exact timestamps and timezone cannot be recovered. Rendered message text retains capitalization.".into(),
        "Reply previews may be truncated to 120 characters. Legacy author names without IDs can merge different people with identical display names.".into(),
    ];
    if missing_author {
        warnings.push("A grouped message had no preceding author; it is labeled Unknown.".into());
    }
    let name = document
        .select(&selector("title"))
        .next()
        .map(|e| render_text(e, false).trim_start_matches('#').to_owned());
    Ok(Archive {
        source: source.into(),
        channel: Channel { id: None, name },
        fidelity: "legacy_html".into(),
        warnings,
        messages,
    })
}
