use crate::export::{html, link, safe_url};
use crate::model::*;
use scraper::{ElementRef, Html, Selector};
use serde_json::json;
fn data(out: &mut String, key: &str, value: Option<&str>) {
    if let Some(v) = value.filter(|v| !v.is_empty()) {
        out.push_str(&format!(" data-{key}=\"{}\"", html(v)))
    }
}
fn image(url: &str, label: &str) -> String {
    if safe_url(url) {
        format!(
            "<img src=\"{}\" alt=\"{}\" loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\">",
            html(url),
            html(label)
        )
    } else {
        String::new()
    }
}
fn author(out: &mut String, a: &Author, class: &str) {
    out.push_str(&format!("<b class=\"{class}\""));
    data(out, "id", a.id.as_deref());
    data(out, "username", a.username.as_deref());
    out.push('>');
    out.push_str(&html(&a.display_name));
    out.push_str("</b>")
}
pub fn render(m: &Message, quality: &str, reply_text: bool) -> String {
    let mut out = String::from("<article class=\"message archive-message\"");
    data(&mut out, "id", m.id.as_deref());
    data(&mut out, "channel-id", m.channel_id.as_deref());
    out.push_str("><header>");
    if quality == "rich"
        && let Some(url) = &m.author.avatar_url
    {
        out.push_str(&image(url, "Avatar"))
    }
    author(&mut out, &m.author, "archive-author");
    if let Some(t) = m.timestamp.as_ref().or(m.timestamp_display.as_ref()) {
        out.push_str(&format!(
            " <time class=\"archive-time\" data-kind=\"{}\">{}</time>",
            if m.timestamp.is_some() {
                "iso"
            } else {
                "display"
            },
            html(t)
        ))
    }
    out.push_str("</header>");
    if let Some(r) = &m.reply {
        out.push_str("<blockquote class=\"archive-reply\"");
        data(&mut out, "id", r.message_id.as_deref());
        data(&mut out, "channel-id", r.channel_id.as_deref());
        if r.unavailable {
            data(&mut out, "unavailable", Some("true"))
        }
        if r.truncated {
            data(&mut out, "truncated", Some("true"))
        }
        out.push('>');
        if let Some(a) = &r.author {
            author(&mut out, a, "archive-reply-author");
            out.push_str(": ")
        } else if let Some(id) = &r.message_id {
            out.push_str(&format!("Reply to {}", html(id)))
        }
        if (reply_text || r.message_id.as_ref().is_none_or(|id| id.is_empty()))
            && let Some(c) = &r.content
        {
            out.push_str(&format!(
                "<span class=\"archive-reply-content\">{}</span>",
                html(c)
            ))
        }
        out.push_str("</blockquote>")
    }
    out.push_str(&format!(
        "<div class=\"archive-content content\">{}</div>",
        html(&m.content)
    ));
    for a in &m.attachments {
        if let Some(url) = a["url"].as_str() {
            if !safe_url(url) {
                continue;
            }
            let label = a["filename"].as_str().unwrap_or(url);
            out.push_str("<p><a class=\"archive-attachment\"");
            data(&mut out, "kind", a["kind"].as_str());
            data(&mut out, "content-type", a["content_type"].as_str());
            out.push_str(&format!(
                " href=\"{}\" rel=\"noopener noreferrer\">{}</a>",
                html(url),
                html(label)
            ));
            if quality != "compact"
                && (a["kind"] == "image"
                    || a["content_type"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("image/"))
                    || crate::clean::is_image_url(url))
            {
                out.push_str(&image(url, label))
            }
            out.push_str("</p>")
        }
    }
    if quality != "compact" {
        for e in &m.embeds {
            out.push_str("<aside class=\"archive-embed\">");
            if let Some(s) = e["title"].as_str() {
                out.push_str("<div class=\"archive-embed-title\">");
                if let Some(url) = e["url"].as_str() {
                    out.push_str(&link(url, s))
                } else {
                    out.push_str(&html(s))
                }
                out.push_str("</div>")
            }
            if let Some(s) = e["description"].as_str() {
                out.push_str(&format!(
                    "<div class=\"archive-embed-description content\">{}</div>",
                    html(s)
                ))
            }
            if quality == "rich" {
                for key in ["image", "thumbnail", "video"] {
                    if let Some(url) = e[key]["url"].as_str()
                        && safe_url(url)
                    {
                        out.push_str(&format!(
                            "<p class=\"archive-embed-media\" data-kind=\"{key}\">{}</p>",
                            link(url, key)
                        ));
                        if key != "video" {
                            out.push_str(&image(url, key))
                        }
                    }
                }
            }
            out.push_str("</aside>")
        }
    }
    out.push_str("</article>\n");
    out
}
fn select<'a>(e: ElementRef<'a>, css: &str) -> Option<ElementRef<'a>> {
    e.select(&Selector::parse(css).unwrap()).next()
}
fn text(e: ElementRef<'_>) -> String {
    e.text().collect()
}
fn attribute(e: ElementRef<'_>, key: &str) -> Option<String> {
    e.value().attr(key).map(str::to_owned)
}
fn parse_author(e: ElementRef<'_>) -> Author {
    Author {
        id: attribute(e, "data-id"),
        username: attribute(e, "data-username"),
        display_name: text(e),
        avatar_url: None,
        bot: None,
    }
}
pub fn parse(fragment: &str, ch: &Channel, file: &str, index: usize) -> Result<Message, String> {
    let doc = Html::parse_fragment(fragment);
    let row = doc
        .select(&Selector::parse(".archive-message").unwrap())
        .next()
        .ok_or("Missing HTML archive row")?;
    let name = select(row, ".archive-author").ok_or("HTML archive row has no author")?;
    let content = select(row, ".archive-content").ok_or("HTML archive row has no content")?;
    let time = select(row, ".archive-time");
    let iso = time.is_some_and(|e| e.value().attr("data-kind") == Some("iso"));
    let t = time.map(text);
    let reply = select(row, ".archive-reply").map(|r| Reply {
        message_id: attribute(r, "data-id"),
        channel_id: attribute(r, "data-channel-id"),
        author: select(r, ".archive-reply-author").map(parse_author),
        content: select(r, ".archive-reply-content").map(text),
        unavailable: r.value().attr("data-unavailable") == Some("true"),
        truncated: r.value().attr("data-truncated") == Some("true"),
    });
    let mut attachments = vec![];
    for e in row.select(&Selector::parse(".archive-attachment").unwrap()) {
        if let Some(url) = e.value().attr("href").filter(|u| safe_url(u)) {
            let mut a = json!({"url":url,"filename":text(e)});
            for (key, attr) in [("kind", "data-kind"), ("content_type", "data-content-type")] {
                if let Some(s) = e.value().attr(attr) {
                    a[key] = json!(s)
                }
            }
            attachments.push(a)
        }
    }
    let mut embeds = vec![];
    for e in row.select(&Selector::parse(".archive-embed").unwrap()) {
        let mut v = json!({});
        if let Some(t) = select(e, ".archive-embed-title") {
            v["title"] = json!(text(t));
            if let Some(a) = select(t, "a")
                && let Some(url) = a.value().attr("href").filter(|u| safe_url(u))
            {
                v["url"] = json!(url)
            }
        }
        if let Some(d) = select(e, ".archive-embed-description") {
            v["description"] = json!(text(d));
        }
        for m in e.select(&Selector::parse(".archive-embed-media").unwrap()) {
            if let Some(kind) = m
                .value()
                .attr("data-kind")
                .filter(|k| matches!(*k, "image" | "thumbnail" | "video"))
                && let Some(a) = select(m, "a")
                && let Some(url) = a.value().attr("href").filter(|u| safe_url(u))
            {
                v[kind] = json!({"url":url})
            }
        }
        embeds.push(v)
    }
    Ok(Message {
        id: attribute(row, "data-id"),
        channel_id: attribute(row, "data-channel-id").or(ch.id.clone()),
        author: parse_author(name),
        timestamp: if iso { t.clone() } else { None },
        timestamp_display: if iso { None } else { t },
        edited_timestamp: None,
        content: text(content),
        reply,
        attachments,
        embeds,
        mentions: vec![],
        reactions: vec![],
        custom_emoji_labels: vec![],
        source: MessageSource {
            file: file.into(),
            index,
            fidelity: "visible_html".into(),
        },
    })
}
