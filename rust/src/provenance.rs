use serde_json::{Map, Value, json};

// Only bounded, known provenance fields cross the importer boundary. In
// particular, archive settings, arbitrary objects and token fields never do.
#[derive(Default)]
pub(crate) struct SourceMetadata {
    partial: Option<bool>,
    status: Option<String>,
    sources: Vec<Value>,
    source: Option<Value>,
    incomplete: bool,
}
fn incomplete_status(status: &str) -> bool {
    matches!(
        status,
        "paused"
            | "error"
            | "collecting"
            | "importing"
            | "running"
            | "stopped"
            | "cancelled"
            | "canceled"
            | "partial"
    )
}
fn descriptor(value: &Value) -> Result<Option<Value>, String> {
    let object = value
        .as_object()
        .ok_or("Source descriptor must be an object")?;
    let mut safe = Map::new();
    for key in ["name", "kind", "status", "file", "path"] {
        if let Some(value) = object.get(key) {
            let text = value
                .as_str()
                .ok_or_else(|| format!("Source {key} must be a string"))?;
            if !text.is_empty() {
                safe.insert(key.into(), json!(text));
            }
        }
    }
    if let Some(value) = object.get("partial") {
        safe.insert(
            "partial".into(),
            json!(value.as_bool().ok_or("Source partial must be a boolean")?),
        );
    }
    Ok((!safe.is_empty()).then_some(Value::Object(safe)))
}
impl SourceMetadata {
    fn observe(&mut self, value: &Value) {
        self.incomplete |=
            value["partial"] == true || value["status"].as_str().is_some_and(incomplete_status);
    }
    pub(crate) fn capture(&mut self, key: &str, value: &Value) -> Result<(), String> {
        match key {
            "partial" => {
                let partial = value.as_bool().ok_or("Archive partial must be a boolean")?;
                self.partial = Some(partial);
                self.incomplete |= partial;
            }
            "status" => {
                let status = value.as_str().ok_or("Archive status must be a string")?;
                self.incomplete |= incomplete_status(status);
                self.status = Some(status.into());
            }
            "sources" => {
                let sources = value.as_array().ok_or("Archive sources must be an array")?;
                let mut safe = Vec::new();
                for source in sources {
                    if let Some(value) = descriptor(source)? {
                        self.observe(&value);
                        safe.push(value);
                    }
                }
                self.sources = safe;
            }
            "source" => {
                let safe = if let Some(name) = value.as_str() {
                    (!name.is_empty()).then(|| json!({"name":name}))
                } else {
                    descriptor(value)?
                };
                if let Some(value) = &safe {
                    self.observe(value)
                }
                self.source = safe;
            }
            _ => {}
        }
        Ok(())
    }
    pub(crate) fn value(&self) -> Option<Value> {
        let mut out = Map::new();
        if self.incomplete || self.partial.is_some() {
            out.insert(
                "partial".into(),
                json!(self.incomplete || self.partial == Some(true)),
            );
        }
        if let Some(status) = &self.status {
            out.insert("status".into(), json!(status));
        }
        if !self.sources.is_empty() {
            out.insert("sources".into(), json!(self.sources));
        } else if let Some(source) = &self.source {
            out.insert("sources".into(), json!([source]));
        }
        (!out.is_empty()).then_some(Value::Object(out))
    }
}
