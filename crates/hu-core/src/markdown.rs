//! Markdown as HTML, for the preview. Whatever HTML the text has of its own
//! is kept only as far as it cannot run anything: the preview is part of the
//! app's page, from which a script could do anything a command can.

use std::collections::HashMap;
use std::io;
use std::path::Path;

use base64::Engine;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

use crate::document::Document;
use crate::problem::Problem;

/// The largest text previewed: it is read and parsed whole.
pub const MAX_PREVIEW: u64 = 16 << 20;
/// The largest image a preview shows.
pub const MAX_IMAGE: u64 = 32 << 20;
/// Before every `id` of the HTML, so that none can be taken for one of the app's.
pub const ID_PREFIX: &str = "md-";

/// GitHub's alerts (`> [!NOTE]`), the only classes kept.
const ALERTS: [&str; 5] = [
    "markdown-alert-note",
    "markdown-alert-tip",
    "markdown-alert-important",
    "markdown-alert-warning",
    "markdown-alert-caution",
];

/// The document's current text as HTML.
pub fn preview(doc: &Document) -> io::Result<String> {
    let len = doc.len();
    if len > MAX_PREVIEW {
        return Err(too_large(len, MAX_PREVIEW));
    }
    Ok(to_html(&doc.copy_text(0, len)?))
}

/// GitHub's flavour: tables, task lists, footnotes, strikethrough, alerts, and
/// headings that links can go to.
pub fn to_html(text: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_GFM;
    let mut html = String::new();
    pulldown_cmark::html::push_html(
        &mut html,
        with_heading_ids(Parser::new_ext(text, options)).into_iter(),
    );
    clean(&html)
}

/// An image file as a `data:` URL, for a preview to show.
pub fn image_data(path: &Path) -> io::Result<String> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let kind = match extension.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{}: not an image", path.display()),
            ));
        }
    };
    let len = std::fs::metadata(path)?.len();
    if len > MAX_IMAGE {
        return Err(too_large(len, MAX_IMAGE));
    }
    let bytes = std::fs::read(path)?;
    Ok(format!(
        "data:{kind};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// A link for the browser or the mail program, rather than to a file.
pub fn is_web_link(url: &str) -> bool {
    let url = url.to_ascii_lowercase();
    ["http://", "https://", "mailto:"]
        .iter()
        .any(|scheme| url.starts_with(scheme))
}

fn too_large(len: u64, limit: u64) -> io::Error {
    Problem::TooLargeToPreview {
        size_mb: len.div_ceil(1 << 20),
        limit_mb: limit >> 20,
    }
    .into()
}

/// Gives each heading an `id` from its text, as GitHub does: `## Load steps`
/// is `#load-steps`, and the second of that name `#load-steps-1`.
fn with_heading_ids<'a>(events: impl Iterator<Item = Event<'a>>) -> Vec<Event<'a>> {
    let mut out = Vec::new();
    let mut heading = None;
    let mut text = String::new();
    let mut taken = HashMap::new();
    for event in events {
        match &event {
            Event::Start(Tag::Heading { .. }) => {
                heading = Some(out.len());
                text.clear();
            }
            Event::Text(part) | Event::Code(part) if heading.is_some() => text.push_str(part),
            Event::End(TagEnd::Heading(_)) => {
                if let Some(Event::Start(Tag::Heading { id, .. })) =
                    heading.take().map(|at| &mut out[at])
                {
                    *id = Some(unique(slug(&text), &mut taken).into());
                }
            }
            _ => {}
        }
        out.push(event);
    }
    out
}

fn slug(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            '-' | '_' => Some(c),
            c if c.is_whitespace() => Some('-'),
            c if c.is_alphanumeric() => Some(c),
            _ => None,
        })
        .collect()
}

fn unique(slug: String, taken: &mut HashMap<String, usize>) -> String {
    let count = taken.entry(slug.clone()).or_insert(0);
    let id = if *count == 0 {
        slug
    } else {
        format!("{slug}-{count}")
    };
    *count += 1;
    id
}

/// Keeps what HTML can show, and nothing that runs: no scripts, styles,
/// frames, forms, event handlers or `javascript:` links. Task list boxes stay,
/// never to be ticked here.
fn clean(html: &str) -> String {
    ammonia::Builder::default()
        .add_generic_attributes(["id", "align"])
        .id_prefix(Some(ID_PREFIX))
        .add_tags(["input"])
        .add_tag_attributes("input", ["type", "checked"])
        .set_tag_attribute_value("input", "disabled", "")
        .add_allowed_classes("blockquote", ALERTS)
        // How a table's columns are aligned, and nothing else of a style.
        .add_tag_attributes("th", ["style"])
        .add_tag_attributes("td", ["style"])
        .filter_style_properties(["text-align"].into())
        .attribute_filter(|element, attribute, value| match (element, attribute) {
            ("input", "type") if value != "checkbox" => None,
            _ => Some(value.into()),
        })
        .clean(html)
        .to_string()
}

#[cfg(test)]
mod tests;
