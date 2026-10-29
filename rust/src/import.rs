use crate::{META_LIMIT, RECORD_LIMIT, model::*, normalize::message};
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

// A token holds one record or metadata value, never its containing array.
#[derive(Default)]
struct Token {
    text: String,
    depth: usize,
    string: bool,
    escape: bool,
    started: bool,
    container: bool,
}
impl Token {
    fn push(&mut self, c: char, cap: usize) -> Result<(bool, bool), String> {
        if self.started
            && !self.string
            && self.depth == 0
            && !self.container
            && matches!(c, ',' | ']' | '}' | ' ' | '\n' | '\r' | '\t')
        {
            return Ok((false, true));
        }
        if self.text.len() + c.len_utf8() > cap {
            return Err(if cap == META_LIMIT {
                "Metadata exceeds 8 MiB"
            } else {
                "Message exceeds 16 MiB"
            }
            .into());
        }
        self.text.push(c);
        if !self.started {
            self.started = true;
            self.container = matches!(c, '{' | '[' | '"');
        }
        if self.string {
            if self.escape {
                self.escape = false
            } else if c == '\\' {
                self.escape = true
            } else if c == '"' {
                self.string = false;
                if self.depth == 0 {
                    return Ok((true, true));
                }
            }
        } else {
            match c {
                '"' => self.string = true,
                '{' | '[' => {
                    self.depth += 1;
                    if self.depth > 128 {
                        return Err("JSON nesting exceeds 128 levels".into());
                    }
                }
                '}' | ']' => {
                    if self.depth == 0 {
                        return Err("Unexpected JSON closing delimiter".into());
                    }
                    self.depth -= 1;
                    if self.depth == 0 {
                        return Ok((true, true));
                    }
                }
                _ => {}
            }
        }
        Ok((true, false))
    }
    fn value(self) -> Result<Value, String> {
        serde_json::from_str(&self.text).map_err(|e| format!("Invalid JSON: {e}"))
    }
}
struct JsonStream {
    state: u8,
    root_array: bool,
    allow_end: bool,
    key: String,
    token: Option<Token>,
    found: bool,
    metadata_bytes: usize,
    channel: Channel,
    file: String,
    index: usize,
    compact: bool,
}
impl JsonStream {
    fn new(channel: Channel, file: String) -> Self {
        Self {
            state: 0,
            root_array: false,
            allow_end: true,
            key: String::new(),
            token: None,
            found: false,
            metadata_bytes: 0,
            channel,
            file,
            index: 0,
            compact: false,
        }
    }
    fn complete(&mut self, t: Token, out: &mut Vec<Message>) -> Result<(), String> {
        let size = t.text.len();
        let v = t.value()?;
        match self.state {
            1 => {
                self.key = v.as_str().ok_or("JSON object key must be a string")?.into();
                self.state = 2;
            }
            3 => {
                self.metadata_bytes += size;
                if self.metadata_bytes > META_LIMIT {
                    return Err("Metadata exceeds 8 MiB".into());
                }
                if self.key == "channel" {
                    self.channel =
                        serde_json::from_value(v).map_err(|e| format!("Invalid channel: {e}"))?
                } else if self.key == "schema_version" && v != 1 {
                    return Err("Unsupported archive schema version".into());
                } else if self.key == "format" {
                    self.compact = matches!(v.as_str(), Some("compact" | "compact-cleaned"));
                }
                self.state = 4;
            }
            5 => {
                self.index += 1;
                out.push(if self.compact {
                    crate::compact::decode(v, &self.channel, &self.file, self.index)?
                } else {
                    message(v, &self.channel, &self.file, self.index, "json")?
                });
                self.state = 6;
            }
            _ => return Err("Invalid JSON state".into()),
        }
        Ok(())
    }
    fn feed(&mut self, input: &str, out: &mut Vec<Message>) -> Result<(), String> {
        for c in input.chars() {
            let mut again = true;
            while again {
                again = false;
                if let Some(mut t) = self.token.take() {
                    let cap = if self.state == 5 {
                        RECORD_LIMIT
                    } else {
                        META_LIMIT
                    };
                    let (consumed, done) = t.push(c, cap)?;
                    if done {
                        self.complete(t, out)?;
                        again = !consumed
                    } else {
                        self.token = Some(t)
                    }
                    continue;
                }
                if c.is_ascii_whitespace() || (self.state == 0 && c == '\u{feff}') {
                    continue;
                }
                match self.state {
                    0 => match c {
                        '[' => {
                            self.root_array = true;
                            self.found = true;
                            self.state = 5;
                        }
                        '{' => self.state = 1,
                        _ => return Err("Expected JSON array or archive object".into()),
                    },
                    1 => {
                        if c == '}' && self.allow_end {
                            self.state = 7
                        } else if c == '"' {
                            let mut t = Token::default();
                            t.push(c, META_LIMIT)?;
                            self.token = Some(t)
                        } else {
                            return Err("Expected object key".into());
                        }
                    }
                    2 => {
                        if c != ':' {
                            return Err("Expected colon after object key".into());
                        }
                        self.state = 3
                    }
                    3 => {
                        if self.key == "messages" {
                            if self.found {
                                return Err("Duplicate messages array".into());
                            }
                            if c != '[' {
                                return Err("messages must be an array".into());
                            }
                            self.found = true;
                            self.allow_end = true;
                            self.state = 5;
                        } else {
                            let mut t = Token::default();
                            let (_, done) = t.push(c, META_LIMIT)?;
                            if done {
                                self.complete(t, out)?
                            } else {
                                self.token = Some(t)
                            }
                        }
                    }
                    4 => match c {
                        ',' => {
                            self.state = 1;
                            self.allow_end = false;
                        }
                        '}' => self.state = 7,
                        _ => return Err("Expected comma or object end".into()),
                    },
                    5 => {
                        if c == ']' && self.allow_end {
                            self.state = if self.root_array { 7 } else { 4 }
                        } else if matches!(c, '{' | '"') {
                            let mut t = Token::default();
                            t.push(c, RECORD_LIMIT)?;
                            self.token = Some(t)
                        } else {
                            return Err("Expected message record".into());
                        }
                    }
                    6 => match c {
                        ',' => {
                            self.state = 5;
                            self.allow_end = false;
                        }
                        ']' => self.state = if self.root_array { 7 } else { 4 },
                        _ => return Err("Expected comma or messages end".into()),
                    },
                    7 => return Err("Unexpected data after JSON archive".into()),
                    _ => unreachable!(),
                }
            }
        }
        Ok(())
    }
    fn finish(&self) -> Result<(), String> {
        if self.state != 7 || self.token.is_some() {
            Err("Truncated JSON archive".into())
        } else if !self.found {
            Err("Archive has no messages array".into())
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct HtmlStream {
    tag: String,
    quote: Option<char>,
    in_tag: bool,
    script_kind: u8,
    script_tail: String,
    script_closing: bool,
    script_value: String,
    json: Option<JsonStream>,
    machine: bool,
    legacy: bool,
    row: String,
    row_depth: usize,
    row_tag: String,
    previous: Option<Author>,
    date: String,
    date_capture: String,
    date_depth: usize,
    recognized: bool,
    row_structured: bool,
    structured: bool,
    machine_records: bool,
    html_opened: bool,
    html_closed: bool,
    body_opened: bool,
    body_closed: bool,
}
fn attr(tag: &str, name: &str) -> Option<String> {
    // Parse just the bounded start tag, respecting quotes and whitespace.
    let fragment = scraper::Html::parse_fragment(tag);
    let selector = scraper::Selector::parse("*").unwrap();
    fragment
        .select(&selector)
        .find_map(|e| e.value().attr(name).map(str::to_owned))
}
fn tag_name(tag: &str) -> String {
    tag.trim_start_matches('<')
        .trim_start_matches('/')
        .split(|c: char| c.is_ascii_whitespace() || c == '>' || c == '/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}
fn classes(tag: &str, name: &str) -> bool {
    attr(tag, "class").is_some_and(|c| c.split_ascii_whitespace().any(|s| s == name))
}
impl HtmlStream {
    fn script_data(&mut self, s: &str, out: &mut Vec<Message>) -> Result<(), String> {
        if self.script_kind == 1 {
            self.json.as_mut().unwrap().feed(s, out)
        } else if matches!(self.script_kind, 2 | 3) {
            if self.script_value.len() + s.len()
                > if self.script_kind == 2 {
                    RECORD_LIMIT
                } else {
                    META_LIMIT
                }
            {
                return Err("HTML data exceeds bounded record/metadata limit".into());
            }
            self.script_value.push_str(s);
            Ok(())
        } else {
            Ok(())
        }
    }
    fn end_script(
        &mut self,
        ch: &mut Channel,
        file: &str,
        index: &mut usize,
        out: &mut Vec<Message>,
    ) -> Result<(), String> {
        match self.script_kind {
            1 => {
                let p = self.json.take().unwrap();
                p.finish()?;
                *ch = p.channel;
                *index = p.index;
            }
            2 => {
                let v: Value = serde_json::from_str(&self.script_value)
                    .map_err(|e| format!("Invalid archive-record: {e}"))?;
                *index += 1;
                out.push(message(v, ch, file, *index, "embedded_json")?);
            }
            3 => {
                let v: Value = serde_json::from_str(&self.script_value)
                    .map_err(|e| format!("Invalid archive metadata: {e}"))?;
                if !v.is_object() {
                    return Err("Archive metadata must be an object".into());
                }
                if v.get("schema_version").is_some_and(|v| v != 1) {
                    return Err("Unsupported archive metadata schema version".into());
                }
                self.machine_records = v["html"]["machine_data"].as_bool().unwrap_or(false);
                if let Some(c) = v.get("channel") {
                    *ch = serde_json::from_value(c.clone()).map_err(|e| e.to_string())?
                }
            }
            _ => {}
        }
        self.script_kind = 0;
        self.script_value.clear();
        self.script_tail.clear();
        self.script_closing = false;
        Ok(())
    }
    fn finish_row(
        &mut self,
        ch: &Channel,
        file: &str,
        index: &mut usize,
        out: &mut Vec<Message>,
    ) -> Result<(), String> {
        if self.row_structured {
            *index += 1;
            out.push(crate::visible_html::parse(&self.row, ch, file, *index)?);
            self.row.clear();
            return Ok(());
        }
        let wrapped = format!("<div class='chatlog'>{}</div>", self.row);
        let (archive, has_author_header) =
            crate::legacy::parse_row(&wrapped, file).map_err(|e| e.to_string())?;
        for mut m in archive.messages {
            if !has_author_header && m.author.id.is_none() {
                if let Some(a) = &self.previous {
                    m.author = a.clone()
                }
            } else {
                self.previous = Some(m.author.clone())
            }
            *index += 1;
            m.source.index = *index;
            m.channel_id = ch.id.clone();
            if m.timestamp_display
                .as_deref()
                .is_some_and(|s| !s.contains(&self.date))
                && !self.date.is_empty()
            {
                m.timestamp_display = Some(format!(
                    "{} {}",
                    self.date,
                    m.timestamp_display.as_deref().unwrap_or("")
                ));
            }
            out.push(m)
        }
        self.row.clear();
        Ok(())
    }
    fn tag_done(
        &mut self,
        ch: &mut Channel,
        file: &str,
        index: &mut usize,
        out: &mut Vec<Message>,
    ) -> Result<(), String> {
        let tag = std::mem::take(&mut self.tag);
        let name = tag_name(&tag);
        let closing = tag.starts_with("</");
        let void = matches!(
            name.as_str(),
            "img"
                | "br"
                | "hr"
                | "input"
                | "meta"
                | "link"
                | "source"
                | "wbr"
                | "area"
                | "base"
                | "embed"
                | "param"
                | "track"
                | "col"
        ) || tag.ends_with("/>");
        if name == "html" {
            if closing {
                self.html_closed = true
            } else {
                self.html_opened = true;
                self.html_closed = false;
            }
        }
        if name == "body" {
            if closing {
                self.body_closed = true
            } else {
                self.body_opened = true;
                self.body_closed = false;
            }
        }
        if self.row_depth > 0 {
            self.row.push_str(&tag);
            if name == self.row_tag {
                if closing {
                    self.row_depth -= 1
                } else if !void {
                    self.row_depth += 1
                }
            }
            if self.row.len() > RECORD_LIMIT {
                return Err("Legacy message exceeds 16 MiB".into());
            }
            if self.row_depth == 0 {
                self.finish_row(ch, file, index, out)?;
            }
            return Ok(());
        }
        if !closing
            && name == "article"
            && classes(&tag, "archive-message")
            && !self.machine_records
        {
            self.structured = true;
            self.machine = true;
            self.recognized = true;
            self.row_structured = true;
            self.row_depth = 1;
            self.row_tag = name;
            self.row = tag;
            return Ok(());
        }
        if self.legacy {
            if self.date_depth > 0 {
                if closing {
                    self.date_depth -= 1;
                } else if !void {
                    self.date_depth += 1;
                }
                if self.date_depth == 0 {
                    self.date = scraper::Html::parse_fragment(&self.date_capture)
                        .root_element()
                        .text()
                        .collect();
                    self.date_capture.clear()
                } else {
                    self.date_capture.push_str(&tag)
                }
                if self.date_capture.len() > META_LIMIT {
                    return Err("HTML date exceeds 8 MiB".into());
                }
                return Ok(());
            }
            if !closing && classes(&tag, "chatlog") {
                self.recognized = true;
            }
            if !closing && classes(&tag, "date-separator") {
                self.date_depth = 1;
                return Ok(());
            }
            if !closing && classes(&tag, "chatlog__message-container") {
                self.recognized = true;
                self.row_depth = 1;
                self.row_tag = name;
                self.row_structured = false;
                self.row = tag;
                return Ok(());
            }
        }
        if name == "script" && !closing {
            self.script_kind = if attr(&tag, "id").as_deref() == Some("discord-archive-data") {
                if self.machine {
                    return Err("Multiple archive data blocks".into());
                }
                self.json = Some(JsonStream::new(ch.clone(), file.into()));
                1
            } else if classes(&tag, "archive-record") {
                2
            } else if attr(&tag, "id").as_deref() == Some("archive-metadata") {
                3
            } else {
                4
            };
            if self.script_kind != 4 {
                self.machine = true;
            }
        }
        Ok(())
    }
    fn feed(
        &mut self,
        input: &str,
        ch: &mut Channel,
        file: &str,
        index: &mut usize,
        out: &mut Vec<Message>,
    ) -> Result<(), String> {
        // Script raw-text closes only at </script>, across arbitrary input boundaries.
        let mut chars = input.char_indices().peekable();
        while let Some((position, c)) = chars.next() {
            if self.script_kind != 0 {
                if self.script_tail.is_empty() && c != '<' {
                    let end = input[position..]
                        .find('<')
                        .map(|i| position + i)
                        .unwrap_or(input.len());
                    self.script_data(&input[position..end], out)?;
                    while chars.peek().is_some_and(|(i, _)| *i < end) {
                        chars.next();
                    }
                    continue;
                }
                self.script_tail.push(c);
                let close_prefix = self
                    .script_tail
                    .get(..8)
                    .is_some_and(|s| s.eq_ignore_ascii_case("</script"));
                if (self.script_closing || close_prefix)
                    && self.script_tail.len() >= 8
                    && (c.is_ascii_whitespace() || c == '>' || self.script_tail.len() == 8)
                {
                    self.script_closing = true;
                    if c == '>' {
                        self.end_script(ch, file, index, out)?;
                    } else if self.script_tail.len() > META_LIMIT {
                        return Err("HTML closing tag exceeds 8 MiB".into());
                    }
                    continue;
                }
                self.script_closing = false;
                let lower = self.script_tail.to_ascii_lowercase();
                if "</script>".starts_with(&lower) {
                    continue;
                }
                let keep = self
                    .script_tail
                    .rfind('<')
                    .filter(|i| {
                        "</script>".starts_with(&self.script_tail[*i..].to_ascii_lowercase())
                    })
                    .unwrap_or(self.script_tail.len());
                let data = self.script_tail[..keep].to_owned();
                let tail = self.script_tail[keep..].to_owned();
                self.script_tail = tail;
                self.script_data(&data, out)?;
                continue;
            }
            if self.in_tag {
                self.tag.push(c);
                if self.tag.len() > META_LIMIT {
                    return Err("HTML tag exceeds 8 MiB".into());
                }
                if let Some(q) = self.quote {
                    if c == q {
                        self.quote = None
                    }
                } else if c == '\'' || c == '"' {
                    self.quote = Some(c)
                } else if c == '>' {
                    self.in_tag = false;
                    self.tag_done(ch, file, index, out)?
                }
                continue;
            }
            if c == '<' {
                self.in_tag = true;
                self.tag.push(c)
            } else if self.row_depth > 0 {
                self.row.push(c);
                if self.row.len() > RECORD_LIMIT {
                    return Err("Legacy message exceeds 16 MiB".into());
                }
            } else if self.date_depth > 0 {
                self.date_capture.push(c);
                if self.date_capture.len() > META_LIMIT {
                    return Err("HTML date exceeds 8 MiB".into());
                }
            }
        }
        Ok(())
    }
    fn finish(&self) -> Result<(), String> {
        if self.script_kind != 0
            || self.in_tag
            || self.row_depth > 0
            || self.date_depth > 0
            || (self.html_opened && !self.html_closed)
            || (self.body_opened && !self.body_closed)
        {
            Err("Truncated HTML archive".into())
        } else if self.legacy && !self.recognized {
            Err("Not a recognized Discord Archiver HTML archive".into())
        } else {
            Ok(())
        }
    }
}

#[wasm_bindgen]
pub struct ArchiveImporter {
    kind: String,
    channel: Channel,
    file: String,
    index: usize,
    json: Option<JsonStream>,
    line: String,
    html: HtmlStream,
    finished: bool,
    failed: bool,
}
#[wasm_bindgen]
impl ArchiveImporter {
    #[wasm_bindgen(constructor)]
    pub fn new(kind: &str, channel_json: &str) -> Result<ArchiveImporter, String> {
        if !matches!(kind, "json" | "jsonl" | "html" | "legacy_html") {
            return Err("Unsupported import format".into());
        }
        let channel: Channel = serde_json::from_str(channel_json).map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_str(channel_json).map_err(|e| e.to_string())?;
        let file = v["source"].as_str().unwrap_or("import").to_owned();
        let json = (kind == "json").then(|| JsonStream::new(channel.clone(), file.clone()));
        Ok(Self {
            kind: kind.into(),
            channel,
            file,
            index: 0,
            json,
            line: String::new(),
            html: HtmlStream {
                legacy: kind == "legacy_html",
                ..Default::default()
            },
            finished: false,
            failed: false,
        })
    }
    pub fn feed(&mut self, chunk: &str) -> Result<String, String> {
        if self.finished || self.failed {
            return Err("Importer is closed".into());
        }
        let result = self.feed_inner(chunk);
        if result.is_err() {
            self.failed = true
        }
        result
    }
    pub fn finish(&mut self) -> Result<String, String> {
        if self.finished || self.failed {
            return Err("Importer is closed".into());
        }
        self.finished = true;
        let mut out = vec![];
        if let Some(p) = &self.json {
            p.finish()?;
            self.channel = p.channel.clone();
        } else if self.kind == "jsonl" {
            if !self.line.trim().is_empty() {
                self.parse_line(&mut out)?
            }
        } else {
            self.html.finish()?
        }
        self.output(out, true)
    }
}
impl ArchiveImporter {
    fn output(&self, out: Vec<Message>, end: bool) -> Result<String, String> {
        let mut v = json!({"messages":out,"channel":self.json.as_ref().map(|p|&p.channel).unwrap_or(&self.channel)});
        if end && self.kind == "html" && !self.html.machine {
            v["legacy_required"] = json!(true)
        }
        if end && self.kind == "legacy_html" {
            v["warnings"] = json!([
                "Legacy HTML cannot recover original Markdown, message IDs, reply target IDs, exact timestamps or timezone. Reply previews may be truncated and identical author names may merge."
            ])
        }
        if end && self.html.structured && !self.html.machine_records {
            v["warnings"] = json!([
                "Visible HTML preserves saved content, identities, timestamps, reply IDs and selected media. Other normalized fields require optional embedded machine data or full JSON."
            ]);
        }
        serde_json::to_string(&v).map_err(|e| e.to_string())
    }
    fn parse_line(&mut self, out: &mut Vec<Message>) -> Result<(), String> {
        let line = std::mem::take(&mut self.line);
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() {
            return Ok(());
        }
        let v = serde_json::from_str(line).map_err(|e| format!("Invalid JSONL record: {e}"))?;
        self.index += 1;
        out.push(message(v, &self.channel, &self.file, self.index, "jsonl")?);
        Ok(())
    }
    fn feed_inner(&mut self, chunk: &str) -> Result<String, String> {
        let mut out = vec![];
        if let Some(p) = &mut self.json {
            p.feed(chunk, &mut out)?;
        } else if self.kind == "jsonl" {
            for c in chunk.chars() {
                if c == '\n' {
                    self.parse_line(&mut out)?
                } else {
                    if self.line.len() + c.len_utf8() > RECORD_LIMIT {
                        return Err("JSONL message exceeds 16 MiB".into());
                    }
                    self.line.push(c)
                }
            }
        } else {
            self.html.feed(
                chunk,
                &mut self.channel,
                &self.file,
                &mut self.index,
                &mut out,
            )?
        }
        self.output(out, false)
    }
}
