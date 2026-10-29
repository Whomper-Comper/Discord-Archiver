use archive_engine::{ArchiveExporter, ArchiveImporter, normalize_batch};
use serde_json::{Value, json};
fn channel() -> String {
    json!({"id":"chan","name":"General","source":"fixture"}).to_string()
}
fn raw() -> Value {
    json!({"id":"1234567890123456789","author":{"id":"42","username":"User","global_name":"Display"},"content":"Hello 😀 <:blob:123> https://a/img.png https://a/file.zip","timestamp":"2026-10-28T00:00:00Z","attachments":[{"url":"https://a/a.png","content_type":"image/png"},{"url":"https://a/a.zip"}],"message_reference":{"message_id":"1"}})
}
fn normalized() -> String {
    normalize_batch(&json!([raw()]).to_string(), &channel()).unwrap()
}
fn stream(kind: &str, input: &str) -> Result<Vec<Value>, String> {
    let mut p = ArchiveImporter::new(kind, &channel())?;
    let mut out = vec![];
    for c in input.chars() {
        out.extend(
            serde_json::from_str::<Value>(&p.feed(&c.to_string())?).unwrap()["messages"]
                .as_array()
                .unwrap()
                .clone(),
        );
    }
    out.extend(
        serde_json::from_str::<Value>(&p.finish()?).unwrap()["messages"]
            .as_array()
            .unwrap()
            .clone(),
    );
    Ok(out)
}
fn export(format: &str, options: Value) -> String {
    let mut e = ArchiveExporter::new(
        format,
        &options.to_string(),
        &json!({"channel":{"id":"chan","name":"General"},"status":"paused"}).to_string(),
    )
    .unwrap();
    let mut s = e.begin().unwrap();
    s += &e.push(&normalized()).unwrap();
    s += &e.finish().unwrap();
    assert_eq!(e.count(), 1);
    s
}
#[test]
fn normalization_preserves_strings_and_reply() {
    let v: Value = serde_json::from_str(&normalized()).unwrap();
    assert_eq!(v[0]["id"], "1234567890123456789");
    assert_eq!(v[0]["author"]["display_name"], "Display");
    assert_eq!(v[0]["channel_id"], "chan");
    assert_eq!(v[0]["reply"]["unavailable"], true);
    assert_eq!(
        serde_json::from_str::<Value>(&normalize_batch(&v.to_string(), &channel()).unwrap())
            .unwrap(),
        v
    );
}
#[test]
fn incremental_json_array_document_jsonl() {
    let a = json!([raw(), raw()]);
    assert_eq!(stream("json", &a.to_string()).unwrap().len(), 2);
    let d = json!({"channel":{"id":"c","name":"C"},"other":{"nested":[1,2]},"messages":a,"message_count":2});
    let m = stream("json", &d.to_string()).unwrap();
    assert_eq!(m.len(), 2);
    assert_eq!(m[0]["channel_id"], "c");
    assert_eq!(
        stream("jsonl", &format!("{}\r\n{}", raw(), raw()))
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn rejects_truncation_and_malformed() {
    for bad in [
        "[",
        "[{}",
        "[{},]",
        "{\"messages\":[{}]",
        "[{}]garbage",
        "{\"x\":1}",
    ] {
        assert!(stream("json", bad).is_err(), "{bad}");
    }
    assert!(stream("jsonl", "{\"bad\"").is_err());
}
#[test]
fn embedded_global_html_and_missing_marker() {
    let input = format!(
        "<html><script id='discord-archive-data' type='application/json'>{}</script></html>",
        json!({"schema_version":1,"channel":{"id":"c","name":"C"},"messages":[raw()]})
    );
    assert_eq!(stream("html", &input).unwrap().len(), 1);
    let mut p = ArchiveImporter::new("html", &channel()).unwrap();
    p.feed("<html>old</html>").unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&p.finish().unwrap()).unwrap()["legacy_required"],
        true
    );
    assert!(stream("html", "<script id='discord-archive-data'>{\"messages\":[").is_err());
}
#[test]
fn all_export_formats_and_html_roundtrip() {
    for f in ["full", "cleaned", "messages"] {
        let v: Value = serde_json::from_str(&export(f, json!({}))).unwrap();
        if f == "messages" {
            assert!(v[0].is_string());
        } else {
            assert_eq!(v["schema_version"], 1);
            assert_eq!(v["message_count"], 1);
            assert_eq!(v["status"], "paused");
        }
    }
    for f in ["jsonl", "cleaned-jsonl"] {
        assert!(serde_json::from_str::<Value>(export(f, json!({})).trim()).is_ok());
    }
    assert!(export("text", json!({})).contains("Hello"));
    assert!(export("csv", json!({})).contains("Display"));
    let html = export("html", json!({}));
    assert_eq!(stream("html", &html).unwrap().len(), 1);
}
#[test]
fn cleaned_filters_and_media() {
    let v: Value = serde_json::from_str(&export("cleaned", json!({}))).unwrap();
    let m = &v["messages"][0];
    assert!(!m["content"].as_str().unwrap().contains('😀'));
    assert!(!m["content"].as_str().unwrap().contains("img.png"));
    assert!(m["content"].as_str().unwrap().contains("file.zip"));
    assert_eq!(m["attachments"].as_array().unwrap().len(), 1);
    let mut e =
        ArchiveExporter::new("full", &json!({"user_key":"id:other"}).to_string(), "{}").unwrap();
    let s = e.begin().unwrap() + &e.push(&normalized()).unwrap() + &e.finish().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&s).unwrap()["message_count"],
        0
    );
}
#[test]
fn csv_and_html_injection_defenses() {
    let n=normalize_batch(&json!([{"content":"=SUM(1,2)\n</script><img src=x>","author":{"username":"+evil"},"attachments":[{"url":"javascript:alert(1)"}]}]).to_string(),&channel()).unwrap();
    for f in ["csv", "html"] {
        let mut e = ArchiveExporter::new(f, "{}", "{}").unwrap();
        let out = e.begin().unwrap() + &e.push(&n).unwrap() + &e.finish().unwrap();
        if f == "csv" {
            assert!(out.contains("'=SUM"));
            assert!(out.contains("'+evil"));
        } else {
            assert!(!out.contains("href=\"javascript:"));
            assert!(out.contains("&lt;/script&gt;"));
            assert_eq!(stream("html", &out).unwrap().len(), 1);
        }
    }
}
#[test]
fn legacy_grouping_custom_unknown_emoji() {
    let html = "<div class='chatlog'><div class='date-separator'>Oct 28</div><div class='chatlog__message-container'><div><img class='chatlog__avatar' src='https://cdn.discordapp.com/avatars/42/x.png'></div><div><span class='chatlog__author'>Display</span><span class='chatlog__timestamp'>10:00</span>Hello<img class='custom-emoji' alt=':unknown_custom:'></div></div><div class='chatlog__message-container'><div>10:01</div><div>Second</div></div></div>";
    let messages = stream("legacy_html", html).unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["author"]["id"], "42");
    assert_eq!(messages[1]["author"]["display_name"], "Display");
    assert_eq!(messages[0]["custom_emoji_labels"][0], ":unknown_custom:");
    let mut e = ArchiveExporter::new("cleaned-jsonl", "{}", "{}").unwrap();
    e.begin().unwrap();
    let out = e.push(&json!(messages).to_string()).unwrap();
    assert!(!out.contains(":unknown_custom:"));
}
#[test]
fn record_and_metadata_caps() {
    let mut p = ArchiveImporter::new("json", &channel()).unwrap();
    let head = "{\"metadata\":\"";
    p.feed(head).unwrap();
    assert!(p.feed(&"x".repeat(8 * 1024 * 1024 + 1)).is_err());
    let mut p = ArchiveImporter::new("json", &channel()).unwrap();
    p.feed("[{\"content\":\"").unwrap();
    assert!(p.feed(&"x".repeat(16 * 1024 * 1024 + 1)).is_err());
}

#[test]
fn filtering_empty_after_clean_and_media_off() {
    let n=normalize_batch(&json!([{"author":{"id":"42","username":"A"},"content":"😀 <:x:1>","attachments":[{"url":"https://a/video.mp4"}]},{"author":{"username":"Name"},"content":"Keep :unknown_shortcode: ©","embeds":[{"title":"Title"}]}]).to_string(),&channel()).unwrap();
    let mut e = ArchiveExporter::new(
        "cleaned",
        &json!({"skip_empty":true,"include_media":false,"pretty":true}).to_string(),
        "{}",
    )
    .unwrap();
    let out = e.begin().unwrap() + &e.push(&n).unwrap() + &e.finish().unwrap();
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["message_count"], 1);
    assert_eq!(v["messages"][0]["content"], "Keep :unknown_shortcode: ©");
    assert_eq!(v["messages"][0]["embeds"], json!([]));
    let mut e = ArchiveExporter::new(
        "messages",
        &json!({"user_key":"name:Name"}).to_string(),
        "{}",
    )
    .unwrap();
    let out = e.begin().unwrap() + &e.push(&n).unwrap() + &e.finish().unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&out)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn chunk_boundaries_nested_quotes_and_trailing_metadata() {
    let mut r = raw();
    r["content"] = json!("😀 \\\" { [ ] } \n café 雪");
    r["embeds"] = json!([{"title":"{}]", "fields":[{"name":"a","value":"b"}]}]);
    let input = format!(
        "{{\"messages\":[{},{}],\"channel\":{{\"id\":\"late\",\"name\":\"Late\"}},\"status\":\"paused\"}}",
        r, r
    );
    let result = stream("json", &input).unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!(result[0]["content"], r["content"]);
    for bad in [
        "[{}{}]",
        "{\"messages\":[],}",
        "{\"messages\":[],\"messages\":[]}",
        "[1]",
        "[{\"content\":42}]",
        "[{\"author\":{\"id\":42}}]",
    ] {
        assert!(stream("json", bad).is_err(), "{bad}");
    }
}
#[test]
fn exporter_lifecycle_and_metadata_token_removal() {
    let mut e=ArchiveExporter::new("full","{}",&json!({"status":"paused","source":{"file":"capture","token":"SECRET"},"settings":{"authToken":"SECRET","batchSize":100}}).to_string()).unwrap();
    assert!(e.push("[]").is_err());
    let out = e.begin().unwrap() + &e.finish().unwrap();
    assert!(!out.contains("SECRET"));
    assert!(out.contains("batchSize"));
    assert!(e.finish().is_err());
    assert!(e.begin().is_err());
    assert!(ArchiveExporter::new("bad", "{}", "{}").is_err());
}
#[test]
fn html_truncated_record_and_per_record_channel() {
    let html = format!(
        "<script id='archive-metadata' type='application/json'>{{\"channel\":{{\"id\":\"META\",\"name\":\"Meta\"}}}}</script><script class='archive-record' type='application/json'>{}</script>",
        raw()
    );
    let v = stream("html", &html).unwrap();
    assert_eq!(v[0]["channel_id"], "META");
    assert!(stream("html", "<script class='archive-record'>{\"id\":").is_err());
    assert!(
        stream(
            "legacy_html",
            "<div class='chatlog'><div class='chatlog__message-container'><div>a</div><div>b"
        )
        .is_err()
    );
}
#[test]
fn html_script_close_allows_whitespace_and_case() {
    let input = format!(
        "<SCRIPT ID='discord-archive-data'>{{\"messages\":[{}]}}</ScRiPt \n >",
        raw()
    );
    assert_eq!(stream("html", &input).unwrap().len(), 1);
}
#[test]
fn legacy_date_markup_obeys_metadata_cap() {
    let mut p = ArchiveImporter::new("legacy_html", &channel()).unwrap();
    p.feed("<div class='chatlog'><div class='date-separator'>")
        .unwrap();
    assert!(p.feed(&"<b></b>".repeat(1_200_000)).is_err());
}
#[test]
fn malformed_api_nested_references_and_arrays_are_rejected() {
    let base = json!({"author":{"id":"42","username":"User"},"content":"ok"});
    for (key, value) in [
        ("message_reference", json!(42)),
        ("referenced_message", json!("lost")),
        ("message_reference", json!({"message_id":42})),
        ("referenced_message", json!({"id":42})),
        ("referenced_message", json!({"author":{"id":42}})),
        ("attachments", json!([42])),
        ("embeds", json!([{"image":42}])),
        ("mentions", json!(["name"])),
        ("reactions", json!([{"emoji":"broken"}])),
    ] {
        let mut v = base.clone();
        v[key] = value;
        assert!(
            normalize_batch(&json!([v]).to_string(), &channel()).is_err(),
            "accepted malformed {key}"
        );
    }
    for value in [
        json!({"content":"no author"}),
        json!({"author":{"username":"User"}}),
    ] {
        assert!(normalize_batch(&json!([value]).to_string(), &channel()).is_err());
    }
    for input in [
        "{\"schema_version\":2,\"messages\":[]}",
        "{\"messages\":[],\"schema_version\":2}",
        "{\"messages\":[],\"channel\":42}",
    ] {
        assert!(stream("json", input).is_err());
    }
}
#[test]
fn normalized_records_also_reject_nonobject_array_entries() {
    let mut values: Value = serde_json::from_str(&normalized()).unwrap();
    values[0]["attachments"] = json!([42]);
    assert!(normalize_batch(&values.to_string(), &channel()).is_err());
}

#[test]
fn compact_short_records_are_smaller_and_roundtrip_semantics() {
    let raws:Vec<Value>=(0..30).map(|i|json!({"id":format!("12345678901234567{i:02}"),"channel_id":"chan","author":{"id":"42","username":"User","global_name":"Display"},"content":format!("MiXeD 雪 {i}"),"timestamp":"2026-10-29T00:00:00Z","message_reference":{"message_id":"TARGET"},"referenced_message":{"id":"TARGET","author":{"id":"9","username":"Other"},"content":"Reply preview"}})).collect();
    let n = normalize_batch(&json!(raws).to_string(), &channel()).unwrap();
    let render = |format: &str, options: Value| {
        let mut e=ArchiveExporter::new(format,&options.to_string(),&json!({"channel":{"id":"chan","name":"General"},"source":"fixture.json","status":"paused"}).to_string()).unwrap();
        e.begin().unwrap() + &e.push(&n).unwrap() + &e.finish().unwrap()
    };
    let full = render("full", json!({}));
    let compact = render("compact", json!({}));
    assert!(
        compact.len() * 2 < full.len(),
        "compact {} full {}",
        compact.len(),
        full.len()
    );
    let v: Value = serde_json::from_str(&compact).unwrap();
    assert_eq!(v["format"], "compact");
    assert!(v["legend"]["a"].is_string());
    assert_eq!(v["status"], "paused");
    assert_eq!(v["messages"][0]["a"], json!(["42", "Display", "User"]));
    assert!(v["messages"][0].get("source").is_none());
    assert!(v["messages"][0]["r"].get("c").is_none());
    let imported = stream("json", &compact).unwrap();
    assert_eq!(imported.len(), 30);
    assert_eq!(imported[0]["id"], raws[0]["id"]);
    assert_eq!(imported[0]["content"], raws[0]["content"]);
    assert_eq!(imported[0]["reply"]["message_id"], "TARGET");
    assert_eq!(imported[0]["author"]["display_name"], "Display");
    let detailed = render("compact", json!({"include_reply_text":true}));
    assert_eq!(
        stream("json", &detailed).unwrap()[0]["reply"]["content"],
        "Reply preview"
    );
}
#[test]
fn compact_cleaned_and_legacy_reply_preview_keep_meaning() {
    let mut values: Value = serde_json::from_str(&normalized()).unwrap();
    values[0]["reply"] = json!({"message_id":null,"channel_id":null,"author":{"id":null,"username":null,"display_name":"Legacy","avatar_url":null,"bot":null},"content":"Preview MiXeD 😀","unavailable":false,"truncated":true});
    for format in ["compact", "compact-cleaned"] {
        let mut e = ArchiveExporter::new(
            format,
            "{}",
            &json!({"channel":{"id":"chan","name":"General"}}).to_string(),
        )
        .unwrap();
        let s = e.begin().unwrap() + &e.push(&values.to_string()).unwrap() + &e.finish().unwrap();
        let imported = stream("json", &s).unwrap();
        assert!(
            imported[0]["reply"]["content"]
                .as_str()
                .unwrap()
                .contains("Preview MiXeD")
        );
        assert_eq!(imported[0]["reply"]["truncated"], true);
        if format == "compact-cleaned" {
            assert!(!imported[0]["content"].as_str().unwrap().contains('😀'));
            assert_eq!(imported[0]["attachments"].as_array().unwrap().len(), 1);
        }
    }
}
#[test]
fn html_quality_without_machine_records_roundtrips_identity() {
    let mut values: Value = serde_json::from_str(&normalized()).unwrap();
    values[0]["author"]["display_name"] = json!("A & \"<Person>\"");
    values[0]["reply"]["content"] = json!("Preview");
    for quality in ["compact", "standard", "rich"] {
        let mut e = ArchiveExporter::new(
            "html",
            &json!({"html_quality":quality,"include_machine_data":false}).to_string(),
            &json!({"channel":{"id":"chan","name":"General"},"status":"paused"}).to_string(),
        )
        .unwrap();
        let s = e.begin().unwrap() + &e.push(&values.to_string()).unwrap() + &e.finish().unwrap();
        assert!(!s.contains("class=\"archive-record\""));
        assert!(!s.contains("\"source\":{\"file\""));
        let imported = stream("html", &s).unwrap();
        assert_eq!(imported.len(), 1);
        for key in ["id", "channel_id", "content", "timestamp"] {
            assert_eq!(imported[0][key], values[0][key]);
        }
        assert_eq!(
            imported[0]["author"]["display_name"],
            values[0]["author"]["display_name"]
        );
        assert_eq!(imported[0]["author"]["id"], "42");
        assert_eq!(imported[0]["reply"]["message_id"], "1");
        if quality != "compact" {
            assert!(s.contains("loading=\"lazy\""));
        }
    }
    let mut e = ArchiveExporter::new(
        "html",
        &json!({"include_machine_data":true,"html_quality":"rich"}).to_string(),
        "{}",
    )
    .unwrap();
    let s = e.begin().unwrap() + &e.push(&values.to_string()).unwrap() + &e.finish().unwrap();
    let imported = stream("html", &s).unwrap();
    assert_eq!(imported.len(), 1);
    assert_eq!(imported[0], values[0]);
}
#[test]
fn html_rejects_cutoff_between_complete_rows_and_invalid_metadata_schema() {
    let machine = format!(
        "<html><body><script class='archive-record'>{}</script>",
        raw()
    );
    assert!(stream("html", &machine).is_err());
    assert!(stream("html", &(machine + "</body>")).is_err());
    let legacy = "<html><body><div class='chatlog'><div class='chatlog__message-container'><div></div><div><span class='chatlog__author'>A</span>Hi</div></div></div>";
    assert!(stream("legacy_html", legacy).is_err());
    assert_eq!(
        stream("legacy_html", &(legacy.to_owned() + "</body></html>"))
            .unwrap()
            .len(),
        1
    );
    assert!(
        stream(
            "html",
            "<script id='archive-metadata'>{\"schema_version\":99}</script>"
        )
        .is_err()
    );
    assert!(stream("html", "<script id='archive-metadata'>[]</script>").is_err());
}
#[test]
fn compact_preserves_explicit_reply_channel_id_and_display_timestamp() {
    let mut records: Value = serde_json::from_str(&normalized()).unwrap();
    records[0]["timestamp"] = Value::Null;
    records[0]["timestamp_display"] = json!("Oct 29 10:15");
    records[0]["reply"]["channel_id"] = json!("chan");
    let mut e = ArchiveExporter::new(
        "compact",
        "{}",
        &json!({"channel":{"id":"chan","name":"General"}}).to_string(),
    )
    .unwrap();
    let out = e.begin().unwrap() + &e.push(&records.to_string()).unwrap() + &e.finish().unwrap();
    let imported = stream("json", &out).unwrap();
    assert_eq!(imported[0]["reply"]["channel_id"], "chan");
    assert_eq!(imported[0]["timestamp_display"], "Oct 29 10:15");
}
#[test]
fn legacy_literal_unknown_author_is_not_grouped_into_previous_identity() {
    let input = "<div class='chatlog'><div class='chatlog__message-container'><div><img class='chatlog__avatar' src='https://cdn.discordapp.com/avatars/1/a.png'></div><div><span class='chatlog__author'>First</span>One</div></div><div class='chatlog__message-container'><div><img class='chatlog__avatar' src='https://cdn.discordapp.com/avatars/2/b.png'></div><div><span class='chatlog__author'>Unknown</span>Two</div></div><div class='chatlog__message-container'><div>10:01</div><div>Grouped</div></div></div>";
    let records = stream("legacy_html", input).unwrap();
    assert_eq!(records.len(), 3);
    assert_eq!(records[0]["author"]["id"], "1");
    for record in &records[1..] {
        assert_eq!(record["author"]["id"], "2");
        assert_eq!(record["author"]["display_name"], "Unknown");
    }
}

fn import_finish_metadata(kind: &str, input: &str) -> Value {
    let mut importer = ArchiveImporter::new(kind, &channel()).unwrap();
    for scalar in input.chars() {
        let response: Value =
            serde_json::from_str(&importer.feed(&scalar.to_string()).unwrap()).unwrap();
        assert!(response.get("source_metadata").is_none());
    }
    serde_json::from_str(&importer.finish().unwrap()).unwrap()
}
#[test]
fn source_metadata_roundtrips_partial_history_without_settings_or_tokens() {
    let metadata = json!({"channel":{"id":"chan","name":"General"},"status":"ready","partial":true,"source":{"kind":"import","name":"current.json","token":"SECRET"},"sources":[{"kind":"capture","name":"original","status":"paused","partial":true,"settings":{"token":"SECRET"},"token":"SECRET"}],"settings":{"token":"SECRET"}});
    for format in ["full", "compact", "html"] {
        let mut e = ArchiveExporter::new(format, "{}", &metadata.to_string()).unwrap();
        let input = e.begin().unwrap() + &e.push(&normalized()).unwrap() + &e.finish().unwrap();
        let finish = import_finish_metadata(if format == "html" { "html" } else { "json" }, &input);
        let sm = &finish["source_metadata"];
        assert_eq!(sm["partial"], true);
        assert_eq!(sm["status"], "ready");
        assert_eq!(
            sm["sources"],
            json!([{"kind":"capture","name":"original","status":"paused","partial":true}])
        );
        assert!(!sm.to_string().contains("settings"));
        assert!(!sm.to_string().contains("SECRET"));
    }
    let global = format!(
        "<script id='discord-archive-data'>{{\"messages\":[{}],\"status\":\"paused\",\"source\":{{\"kind\":\"capture\",\"name\":\"Old capture\"}}}}</script>",
        raw()
    );
    let sm = import_finish_metadata("html", &global)["source_metadata"].clone();
    assert_eq!(sm["status"], "paused");
    assert_eq!(sm["partial"], true);
    assert_eq!(sm["sources"][0]["name"], "Old capture");
}
#[test]
fn source_metadata_rejects_malformed_known_types_and_tracks_nested_partial() {
    for bad in [
        json!({"partial":"true"}),
        json!({"status":false}),
        json!({"sources":{}}),
        json!({"sources":[42]}),
        json!({"sources":[{"name":42}]}),
        json!({"sources":[{"partial":"true"}]}),
        json!({"sources":[{"status":42}]}),
        json!({"source":42}),
    ] {
        let mut v = bad;
        v["messages"] = json!([]);
        assert!(stream("json", &v.to_string()).is_err(), "accepted {v}");
        let html = format!("<script id='archive-metadata'>{}</script>", v);
        assert!(stream("html", &html).is_err(), "accepted html {v}");
    }
    let sm=import_finish_metadata("json","{\"partial\":false,\"status\":\"ready\",\"sources\":[{\"name\":\"old\",\"status\":\"paused\"}],\"messages\":[]}")["source_metadata"].clone();
    assert_eq!(sm["partial"], true);
    assert_eq!(sm["sources"][0]["status"], "paused");
    let empty = import_finish_metadata("json", "[]");
    assert!(empty.get("source_metadata").is_none());
}
