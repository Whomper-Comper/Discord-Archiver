use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Channel {
    pub id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Author {
    pub id: Option<String>,
    pub username: Option<String>,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bot: Option<bool>,
}

impl Author {
    pub fn key(&self) -> String {
        match &self.id {
            Some(id) => format!("id:{id}"),
            None => format!("name:{}", self.display_name),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reply {
    pub message_id: Option<String>,
    pub channel_id: Option<String>,
    pub author: Option<Author>,
    pub content: Option<String>,
    pub unavailable: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageSource {
    pub file: String,
    pub index: usize,
    pub fidelity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: Option<String>,
    pub channel_id: Option<String>,
    pub author: Author,
    pub timestamp: Option<String>,
    pub timestamp_display: Option<String>,
    pub edited_timestamp: Option<String>,
    pub content: String,
    pub reply: Option<Reply>,
    pub attachments: Vec<Value>,
    pub embeds: Vec<Value>,
    pub mentions: Vec<Value>,
    pub reactions: Vec<Value>,
    #[serde(default)]
    pub custom_emoji_labels: Vec<String>,
    pub source: MessageSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Archive {
    pub source: String,
    pub channel: Channel,
    pub fidelity: String,
    pub warnings: Vec<String>,
    pub messages: Vec<Message>,
}
