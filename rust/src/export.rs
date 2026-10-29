use crate::{META_LIMIT, RECORD_LIMIT, clean::clean_message, model::Message};
use serde::Deserialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
#[derive(Deserialize)]
#[serde(default)]
struct Options {
    user_key: Option<String>,
    skip_empty: bool,
    include_media: bool,
    pretty: bool,
    html_quality: String,
    include_machine_data: bool,
    include_reply_text: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            user_key: None,
            skip_empty: false,
            include_media: true,
            pretty: false,
            html_quality: "compact".into(),
            include_machine_data: false,
            include_reply_text: false,
        }
    }
}
pub(crate) fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
fn script(s: &str) -> String {
    s.replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}
fn csv(s: &str) -> String {
    let trimmed = s.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let guard = trimmed.starts_with(['=', '+', '-', '@']) || s.starts_with(['\t', '\r', '\n']);
    format!(
        "\"{}{}\"",
        if guard { "'" } else { "" },
        s.replace('"', "\"\"")
    )
}
pub(crate) fn safe_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && !url.chars().any(|c| c.is_control())
}
fn sanitize_metadata(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.retain(|k, _| !k.to_ascii_lowercase().contains("token"));
            for child in m.values_mut() {
                sanitize_metadata(child)
            }
        }
        Value::Array(a) => {
            for child in a {
                sanitize_metadata(child)
            }
        }
        _ => {}
    }
}
pub(crate) fn link(url: &str, label: &str) -> String {
    if safe_url(url) {
        format!(
            "<a href=\"{}\" rel=\"noopener noreferrer\">{}</a>",
            html(url),
            html(label)
        )
    } else {
        html(label)
    }
}
#[wasm_bindgen]
pub struct ArchiveExporter {
    format: String,
    options: Options,
    metadata: Value,
    count: u32,
    begun: bool,
    finished: bool,
}
#[wasm_bindgen]
impl ArchiveExporter {
    #[wasm_bindgen(constructor)]
    pub fn new(
        format: &str,
        options_json: &str,
        metadata_json: &str,
    ) -> Result<ArchiveExporter, String> {
        if !matches!(
            format,
            "full"
                | "cleaned"
                | "messages"
                | "jsonl"
                | "cleaned-jsonl"
                | "csv"
                | "text"
                | "html"
                | "compact"
                | "compact-cleaned"
        ) {
            return Err("Unsupported export format".into());
        }
        if metadata_json.len() > META_LIMIT {
            return Err("Metadata exceeds 8 MiB".into());
        }
        let options: Options = serde_json::from_str(options_json).map_err(|e| e.to_string())?;
        if !matches!(
            options.html_quality.as_str(),
            "compact" | "standard" | "rich"
        ) {
            return Err("Unsupported HTML quality".into());
        }
        let mut metadata: Value = serde_json::from_str(metadata_json).map_err(|e| e.to_string())?;
        if !metadata.is_object() {
            return Err("Metadata must be an object".into());
        }
        sanitize_metadata(&mut metadata);
        if let Some(m) = metadata.as_object_mut() {
            for key in ["messages", "message_count", "schema_version"] {
                m.remove(key);
            }
            m.entry("sources").or_insert(json!([]));
            m.insert("schema_version".into(), json!(1));
            if matches!(format, "compact" | "compact-cleaned") {
                m.retain(|_, v| {
                    !v.is_null() && v != &json!([]) && v != &json!({}) && v != &json!("")
                });
                m.insert("format".into(), json!(format));
                m.insert("legend".into(), crate::compact::legend());
            }
            if format == "html" {
                m.insert("html".into(),json!({"quality":options.html_quality,"machine_data":options.include_machine_data,"fidelity":if options.include_machine_data{"Exact normalized records embedded"}else{"Visible content, identities, timestamps, reply IDs and selected media only; other fields require machine data or full JSON"}}));
            }
        }
        Ok(Self {
            format: format.into(),
            options,
            metadata,
            count: 0,
            begun: false,
            finished: false,
        })
    }
    pub fn count(&self) -> u32 {
        self.count
    }
    pub fn begin(&mut self) -> Result<String, String> {
        if self.begun || self.finished {
            return Err("Exporter already started".into());
        }
        self.begun = true;
        Ok(match self.format.as_str(){
            "full"|"cleaned"|"compact"|"compact-cleaned"=>{let mut s=if self.options.pretty{serde_json::to_string_pretty(&self.metadata)}else{serde_json::to_string(&self.metadata)}.map_err(|e|e.to_string())?;s.pop();s+=if self.options.pretty{",\n\"messages\": [\n"}else{",\"messages\":["};s},
            "messages"=>"[".into(),
            "csv"=>"id,channel_id,author_id,author,username,timestamp,content,reply_message_id,reply_author,reply_content,attachments\r\n".into(),
            "html"=>{let name=self.metadata["channel"]["name"].as_str().unwrap_or("Discord archive");format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{}</title><style>body{{font:16px system-ui;max-width:1000px;margin:2rem auto;padding:0 1rem;background:#15171b;color:#eee}}a{{color:#8ac3ff}}img{{max-width:100%;max-height:420px;object-fit:contain}}.message{{padding:1rem 0;border-bottom:1px solid #444}}time{{color:#bbb}}.content{{white-space:pre-wrap;overflow-wrap:anywhere}}blockquote,aside{{border-left:3px solid #888;padding-left:1rem}}input{{font:inherit;padding:.6rem;width:90%}}</style></head><body><h1>{}</h1><p>Archive status: {}</p><input id=\"search\" placeholder=\"Search messages\" aria-label=\"Search messages\"><script type=\"application/json\" id=\"archive-metadata\">{}</script>\n",html(name),html(name),html(self.metadata["status"].as_str().unwrap_or("unknown")),script(&self.metadata.to_string()))},_=>String::new()
        })
    }
    pub fn push(&mut self, batch_json: &str) -> Result<String, String> {
        if !self.begun || self.finished {
            return Err("Exporter is not open".into());
        }
        let messages: Vec<Message> = serde_json::from_str(batch_json)
            .map_err(|e| format!("Invalid normalized batch: {e}"))?;
        let mut out = String::new();
        for m in messages {
            if serde_json::to_string(&m).map_err(|e| e.to_string())?.len() > RECORD_LIMIT {
                return Err("Message exceeds 16 MiB".into());
            }
            if self
                .options
                .user_key
                .as_ref()
                .is_some_and(|key| *key != m.author.key())
            {
                continue;
            }
            let mut m = if matches!(
                self.format.as_str(),
                "cleaned" | "cleaned-jsonl" | "compact-cleaned"
            ) {
                clean_message(&m)
            } else {
                m
            };
            if !self.options.include_media {
                m.attachments.clear();
                m.embeds.clear();
                m.author.avatar_url = None;
                if let Some(r) = &mut m.reply
                    && let Some(a) = &mut r.author
                {
                    a.avatar_url = None
                }
            }
            if self.options.skip_empty && m.content.trim().is_empty() {
                continue;
            }
            let serialized = if self.options.pretty
                && !matches!(self.format.as_str(), "jsonl" | "cleaned-jsonl")
            {
                serde_json::to_string_pretty(&m)
            } else {
                serde_json::to_string(&m)
            }
            .map_err(|e| e.to_string())?;
            match self.format.as_str() {
                "full" | "cleaned" => {
                    if self.count > 0 {
                        out.push(',');
                        if self.options.pretty {
                            out.push('\n')
                        }
                    }
                    out += &serialized;
                }
                "compact" | "compact-cleaned" => {
                    if self.count > 0 {
                        out.push(',');
                        if self.options.pretty {
                            out.push('\n')
                        }
                    }
                    let record = crate::compact::encode(
                        &m,
                        self.metadata["channel"]["id"].as_str(),
                        self.options.include_reply_text,
                    );
                    out += &if self.options.pretty {
                        serde_json::to_string_pretty(&record)
                    } else {
                        serde_json::to_string(&record)
                    }
                    .map_err(|e| e.to_string())?;
                }
                "messages" => {
                    if self.count > 0 {
                        out.push(',')
                    }
                    out += &serde_json::to_string(&m.content).map_err(|e| e.to_string())?;
                }
                "jsonl" | "cleaned-jsonl" => {
                    out += &serialized;
                    out.push('\n');
                }
                "text" => {
                    if self.count > 0 {
                        out += "\n\n"
                    }
                    out += &m.content;
                }
                "csv" => {
                    let a = m
                        .attachments
                        .iter()
                        .filter_map(|a| a["url"].as_str())
                        .collect::<Vec<_>>()
                        .join(" ");
                    let r = m.reply.as_ref();
                    let cells = [
                        m.id.as_deref().unwrap_or(""),
                        m.channel_id.as_deref().unwrap_or(""),
                        m.author.id.as_deref().unwrap_or(""),
                        &m.author.display_name,
                        m.author.username.as_deref().unwrap_or(""),
                        m.timestamp
                            .as_deref()
                            .or(m.timestamp_display.as_deref())
                            .unwrap_or(""),
                        &m.content,
                        r.and_then(|r| r.message_id.as_deref()).unwrap_or(""),
                        r.and_then(|r| r.author.as_ref())
                            .map(|a| a.display_name.as_str())
                            .unwrap_or(""),
                        r.and_then(|r| r.content.as_deref()).unwrap_or(""),
                        &a,
                    ];
                    out += &cells.iter().map(|s| csv(s)).collect::<Vec<_>>().join(",");
                    out += "\r\n";
                }
                "html" => {
                    out += &crate::visible_html::render(
                        &m,
                        &self.options.html_quality,
                        self.options.include_reply_text,
                    );
                    if self.options.include_machine_data {
                        out += &format!(
                            "<script type=\"application/json\" class=\"archive-record\">{}</script>\n",
                            script(&serialized)
                        );
                    }
                }
                _ => unreachable!(),
            }
            self.count = self.count.checked_add(1).ok_or("Export count overflow")?;
        }
        Ok(out)
    }
    pub fn finish(&mut self) -> Result<String, String> {
        if !self.begun || self.finished {
            return Err("Exporter is not open".into());
        }
        self.finished = true;
        Ok(match self.format.as_str(){"full"|"cleaned"|"compact"|"compact-cleaned"=>format!("],\"message_count\":{}}}\n",self.count),"messages"=>"]\n".into(),"html"=>"<script>document.getElementById('search').addEventListener('input',function(){const q=this.value.toLowerCase();document.querySelectorAll('.message').forEach(m=>m.hidden=!m.textContent.toLowerCase().includes(q));});</script></body></html>\n".into(),_=>String::new()})
    }
}
